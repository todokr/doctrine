import { afterEach, beforeEach, test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/db/migrate.ts";
import { getTask } from "../../src/db/tasks.ts";
import { listStepRuns } from "../../src/db/stepRuns.ts";
import { createHandler, type DaemonContext, tick } from "../../src/daemon/handlers.ts";
import { createMockAdapter } from "../../src/adapter/mock.ts";
import { createWarningLog } from "../../src/daemon/warnings.ts";
import { loadWorkflowFromDisk, taskWorkflow } from "../../src/workflow/load.ts";
import { recoverOnStartup } from "../../src/domain/recovery.ts";
import { commitStepBoundary } from "../../src/db/boundary.ts";
import { buildWorkflowLookup } from "../../src/daemon/main.ts";
import { makeRepo, tickWhenIdle, until } from "../helpers/repo.ts";
import { fakeTracker } from "../helpers/tracker.ts";
import { noopWatcher } from "../helpers/watcher.ts";
import type { TaskGuide } from "../../../shared/protocol.ts";

const NOOP_CONN = { follow() {}, unfollow() {}, isFollowing: () => false };

let root: string;
let repo: string;
const contexts: DaemonContext[] = [];

const LOOP = "name: feature\nsteps:\n" +
  '  - id: noop\n    type: command\n    run: "echo hi"\n' +
  "  - id: review\n    type: approval\n    title: 見て\n" +
  "    onReject:\n      goto: noop\n      maxAttempts: 5\n" +
  '  - id: after\n    type: command\n    run: "true"\n';

const CHANGED = "name: feature\nsteps:\n" +
  '  - id: other\n    type: command\n    run: "false"\n' +
  "  - id: review\n    type: approval\n    title: 見て\n";

const GUIDE_CHANGED = "name: feature\nsteps:\n" +
  "  - id: write-guide\n    type: guide\n    session: guide\n" +
  "  - id: review\n    type: approval\n    title: 見て\n";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "doctrine-workflow-pin-"));
  repo = await makeRepo(root, {
    "README.md": "x\n",
    ".doctrine/project.yaml": "defaultWorkflow: feature\nmaxConcurrent: 1\nbaseBranch: main\n",
    ".doctrine/workflows/feature.yaml": LOOP,
  });
  process.env.DOCTRINE_STATE_DIR = join(root, "state");
});
afterEach(async () => {
  await until(() =>
    contexts.every((c) =>
      c.running.size === 0 && c.runningIntakeRuns.size === 0 && c.intakeWatcher.idle()
    )
  );
  contexts.length = 0;
  await rm(root, { recursive: true, force: true });
  delete process.env.DOCTRINE_STATE_DIR;
});

async function context(): Promise<DaemonContext> {
  const db = await openDb(":memory:");
  const ctx: DaemonContext = {
    db,
    adapter: createMockAdapter({ result: { ok: true, text: "done" } }),
    logRoot: join(root, "logs"),
    globalLimit: 4,
    broadcast: () => {},
    warnings: createWarningLog({ broadcast: () => {}, write: () => {} }),
    loadWorkflow: loadWorkflowFromDisk,
    workflowOf: (t, p) => taskWorkflow(t, p, loadWorkflowFromDisk),
    running: new Set(),
    tracker: fakeTracker(),
    runningIntakeRuns: new Set(),
    intakeWatcher: noopWatcher(),
  };
  contexts.push(ctx);
  return ctx;
}

/** feature.yaml を書き換え、project.yaml に setup を足して project.update を通す。 */
async function changeDefinition(h: ReturnType<typeof createHandler>): Promise<void> {
  await writeFile(join(repo, ".doctrine", "workflows", "feature.yaml"), CHANGED);
  await writeFile(
    join(repo, ".doctrine", "project.yaml"),
    "defaultWorkflow: feature\nmaxConcurrent: 1\nbaseBranch: main\nsetup: echo late\n",
  );
  await h("project.update", { path: repo }, NOOP_CONN);
}

test("作成後に YAML と setup を変えても、tick は作成時の定義で始める", async () => {
  const ctx = await context();
  const h = createHandler(ctx);
  await h("project.add", { path: repo }, NOOP_CONN);
  const t = await h(
    "task.create",
    { project: repo, title: "T", prompt: "p" },
    NOOP_CONN,
  ) as { id: string };
  await changeDefinition(h);

  await tick(ctx);
  await until(async () => (await getTask(ctx.db, t.id))?.state === "suspended");
  await until(() => ctx.running.size === 0);

  const task = (await getTask(ctx.db, t.id))!;
  assert.equal(task.current_step_id, "review");
  const runs = await listStepRuns(ctx.db, t.id);
  assert.deepEqual(runs.map((r) => r.step_id), ["noop", "review"]);
});

test("作成後に goto を消しても、却下は作成時の onReject で noop へ戻る", async () => {
  const ctx = await context();
  const h = createHandler(ctx);
  await h("project.add", { path: repo }, NOOP_CONN);
  const t = await h(
    "task.create",
    { project: repo, title: "T", prompt: "p" },
    NOOP_CONN,
  ) as { id: string };
  await tick(ctx);
  await until(async () => (await getTask(ctx.db, t.id))?.state === "suspended");
  await until(() => ctx.running.size === 0);
  await changeDefinition(h);

  await h("task.reject", { task_id: t.id, comment: "だめ" }, NOOP_CONN);

  const task = (await getTask(ctx.db, t.id))!;
  assert.equal(task.state, "queued");
  assert.equal(task.current_step_id, "noop");
});

test("作成後にステップを消しても、承認は作成時の定義の次のステップへ進む", async () => {
  const ctx = await context();
  const h = createHandler(ctx);
  await h("project.add", { path: repo }, NOOP_CONN);
  const t = await h(
    "task.create",
    { project: repo, title: "T", prompt: "p" },
    NOOP_CONN,
  ) as { id: string };
  await tick(ctx);
  await until(async () => (await getTask(ctx.db, t.id))?.state === "suspended");
  await until(() => ctx.running.size === 0);
  await changeDefinition(h);

  await h("task.approve", { task_id: t.id }, NOOP_CONN);

  assert.equal((await getTask(ctx.db, t.id))!.state, "queued");
  assert.equal((await getTask(ctx.db, t.id))!.current_step_id, "after");

  await tickWhenIdle(ctx);
  await until(async () => (await getTask(ctx.db, t.id))?.state === "completed");
});

test("承認待ちからの再開でも作成時の定義で進む", async () => {
  const ctx = await context();
  const h = createHandler(ctx);
  await h("project.add", { path: repo }, NOOP_CONN);
  const t = await h(
    "task.create",
    { project: repo, title: "T", prompt: "p" },
    NOOP_CONN,
  ) as { id: string };
  await tick(ctx);
  await until(async () => (await getTask(ctx.db, t.id))?.state === "suspended");
  await until(() => ctx.running.size === 0);
  await changeDefinition(h);

  await h("task.resume", { task_id: t.id }, NOOP_CONN);
  await tickWhenIdle(ctx);
  await until(async () => (await getTask(ctx.db, t.id))?.state === "suspended");
  await until(() => ctx.running.size === 0);

  const task = (await getTask(ctx.db, t.id))!;
  assert.equal(task.current_step_id, "review");
  const runs = await listStepRuns(ctx.db, t.id);
  assert.deepEqual(runs.map((r) => r.step_id), ["noop", "review", "review"]);

  await h("task.approve", { task_id: t.id }, NOOP_CONN);
  assert.equal((await getTask(ctx.db, t.id))!.current_step_id, "after");
});

test("起動時の復帰は作成時の定義でステップの種別を決める", async () => {
  const ctx = await context();
  const h = createHandler(ctx);
  await writeFile(
    join(repo, ".doctrine", "workflows", "feature.yaml"),
    "name: feature\nsteps:\n" +
      "  - id: impl\n    type: agent\n    prompt: やって\n" +
      "  - id: review\n    type: approval\n    title: 見て\n",
  );
  await h("project.add", { path: repo }, NOOP_CONN);
  const t = await h(
    "task.create",
    { project: repo, title: "T", prompt: "p" },
    NOOP_CONN,
  ) as { id: string };

  // ディスクの定義を、impl を command にしたものへ書き換える。
  await writeFile(
    join(repo, ".doctrine", "workflows", "feature.yaml"),
    "name: feature\nsteps:\n" +
      '  - id: impl\n    type: command\n    run: "true"\n' +
      "  - id: review\n    type: approval\n    title: 見て\n",
  );
  await commitStepBoundary(ctx.db, {
    taskId: t.id,
    taskPatch: { state: "running", current_step_id: "impl" },
  });

  const results = await recoverOnStartup(
    ctx.db,
    { startTimeOf: () => Promise.resolve(null), kill: () => {} },
    buildWorkflowLookup(ctx.db, ctx.workflowOf),
  );
  assert.deepEqual(results, [{ taskId: t.id, outcome: "recovered", action: "resume-agent" }]);
});

test("task.get は作成時の定義の steps を返す", async () => {
  const ctx = await context();
  const h = createHandler(ctx);
  await h("project.add", { path: repo }, NOOP_CONN);
  const t = await h(
    "task.create",
    { project: repo, title: "T", prompt: "p" },
    NOOP_CONN,
  ) as { id: string };
  await changeDefinition(h);

  const got = await h("task.get", { task_id: t.id }, NOOP_CONN) as {
    steps: { id: string }[] | null;
  };
  assert.deepEqual(got.steps?.map((s) => s.id), ["noop", "review", "after"]);
});

test("task.context は作成時の定義でステップの種別を読む", async () => {
  const ctx = await context();
  const h = createHandler(ctx);
  await h("project.add", { path: repo }, NOOP_CONN);
  const t = await h(
    "task.create",
    { project: repo, title: "T", prompt: "p" },
    NOOP_CONN,
  ) as { id: string };
  await tick(ctx);
  await until(async () => (await getTask(ctx.db, t.id))?.state === "suspended");
  await until(() => ctx.running.size === 0);
  await changeDefinition(h);

  const got = await h("task.context", { task_id: t.id }, NOOP_CONN) as {
    lastCommand: { stepId: string; stdout: string } | null;
    reviews: unknown[];
  };
  assert.equal(got.lastCommand?.stepId, "noop");
  assert.equal(got.lastCommand?.stdout, "hi\n");
  assert.equal(got.reviews.length, 1);
});

test("task.guide は作成時の定義にガイドステップが無ければ、ディスクに足されても none を返す", async () => {
  const ctx = await context();
  const h = createHandler(ctx);
  await h("project.add", { path: repo }, NOOP_CONN);
  const t = await h(
    "task.create",
    { project: repo, title: "T", prompt: "p" },
    NOOP_CONN,
  ) as { id: string };
  await tick(ctx);
  await until(async () => (await getTask(ctx.db, t.id))?.state === "suspended");
  await until(() => ctx.running.size === 0);
  await writeFile(join(repo, ".doctrine", "workflows", "feature.yaml"), GUIDE_CHANGED);

  const res = await h("task.guide", { task_id: t.id }, NOOP_CONN) as TaskGuide;
  assert.deepEqual(res, { status: "none" });
});

test("新しく作るタスクは書き換えた後の定義と setup を使う", async () => {
  const ctx = await context();
  const h = createHandler(ctx);
  await h("project.add", { path: repo }, NOOP_CONN);
  const a = await h(
    "task.create",
    { project: repo, title: "A", prompt: "p" },
    NOOP_CONN,
  ) as { id: string };
  await changeDefinition(h);
  const b = await h(
    "task.create",
    { project: repo, title: "B", prompt: "p" },
    NOOP_CONN,
  ) as { id: string };

  const gotA = await h("task.get", { task_id: a.id }, NOOP_CONN) as {
    steps: { id: string }[] | null;
  };
  const gotB = await h("task.get", { task_id: b.id }, NOOP_CONN) as {
    steps: { id: string }[] | null;
  };
  assert.deepEqual(gotA.steps?.map((s) => s.id), ["noop", "review", "after"]);
  assert.deepEqual(gotB.steps?.map((s) => s.id), ["setup", "other", "review"]);

  const bRow = (await getTask(ctx.db, b.id))!;
  assert.equal(bRow.workflow_yaml, CHANGED);
  assert.equal(bRow.workflow_setup, "echo late");
});

test("task.create は検証した YAML の中身と project の setup を保存する", async () => {
  await writeFile(
    join(repo, ".doctrine", "project.yaml"),
    "defaultWorkflow: feature\nmaxConcurrent: 1\nbaseBranch: main\nsetup: echo first\n",
  );
  const ctx = await context();
  const h = createHandler(ctx);
  await h("project.add", { path: repo }, NOOP_CONN);
  const t = await h(
    "task.create",
    { project: repo, title: "T", prompt: "p" },
    NOOP_CONN,
  ) as { id: string };

  const row = (await getTask(ctx.db, t.id))!;
  assert.equal(row.workflow_yaml, LOOP);
  assert.equal(row.workflow_setup, "echo first");
});
