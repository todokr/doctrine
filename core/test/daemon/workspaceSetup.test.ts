import { afterEach, beforeEach, test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/db/migrate.ts";
import { getTask, listTasks } from "../../src/db/tasks.ts";
import { createHandler, type DaemonContext } from "../../src/daemon/handlers.ts";
import { createMockAdapter } from "../../src/adapter/mock.ts";
import { createWarningLog } from "../../src/daemon/warnings.ts";
import { loadWorkflowFromDisk, taskWorkflow } from "../../src/workflow/load.ts";
import { setupPrompt, setupWorkflowYaml } from "../../src/workflow/setupWorkflow.ts";
import { makeRepo } from "../helpers/repo.ts";
import { constTrackerOf, fakeTracker } from "../helpers/tracker.ts";
import { noopWatcher } from "../helpers/watcher.ts";
import type { SetupPolicy, TaskSummary } from "../../../shared/protocol.ts";

const NOOP_CONN = { follow() {}, unfollow() {}, isFollowing: () => false };

const POLICY: SetupPolicy = {
  plan: false,
  agentReview: true,
  guide: true,
  approval: "after_implement",
  pr: "branch_only",
  sync: false,
  models: { plan: "p-model", implement: "i-model", review: "r-model", guide: "g-model" },
};

let root: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "doctrine-ws-setup-")));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function context(): Promise<DaemonContext> {
  return openDb(":memory:").then((db) => ({
    db,
    adapter: createMockAdapter({ result: { ok: true, text: "done" } }),
    logRoot: join(root, "logs"),
    globalLimit: 4,
    configPath: join(root, "config.json"),
    broadcast: () => {},
    warnings: createWarningLog({ broadcast: () => {}, write: () => {} }),
    loadWorkflow: loadWorkflowFromDisk,
    workflowOf: (t, p) => taskWorkflow(t, p, loadWorkflowFromDisk),
    running: new Set(),
    trackerOf: constTrackerOf(fakeTracker()),
    runningIntakeRuns: new Set(),
    intakeWatcher: noopWatcher(),
  }));
}

async function repoAt(name: string, projectYaml: string): Promise<string> {
  return await makeRepo(join(root, name), {
    "README.md": "x\n",
    ".doctrine/project.yaml": projectYaml,
    ".doctrine/workflows/feature.yaml":
      "name: feature\nsteps:\n  - id: review\n    type: approval\n    title: 見て\n",
  });
}

/** a（baseBranch: main）と b（baseBranch: develop、setup あり）を束ねた workspace を登録する。 */
async function registerWorkspace(h: ReturnType<typeof createHandler>): Promise<number> {
  await repoAt("a", "defaultWorkflow: feature\nmaxConcurrent: 1\nbaseBranch: main\n");
  await repoAt(
    "b",
    "defaultWorkflow: feature\nmaxConcurrent: 1\nbaseBranch: develop\nsetup: pnpm install\n",
  );
  const tp = join(root, "tp");
  await mkdir(join(tp, ".doctrine"), { recursive: true });
  await writeFile(
    join(tp, ".doctrine", "workspace.yaml"),
    "projects:\n  a: ../a/repo\n  b: ../b/repo\n",
  );
  const w = await h("workspace.add", { path: tp }, NOOP_CONN) as { id: number };
  return w.id;
}

test("対象プロジェクトごとにタスクを 1 つ作る", async () => {
  const ctx = await context();
  const h = createHandler(ctx);
  const workspace = await registerWorkspace(h);

  const tasks = await h(
    "workspace.setup",
    { workspace, projects: ["a", "b"], policy: POLICY },
    NOOP_CONN,
  ) as TaskSummary[];

  assert.equal(tasks.length, 2);
  assert.deepEqual(tasks.map((t) => t.title), ["a のワークフローを作る", "b のワークフローを作る"]);
  assert.ok(tasks.every((t) => t.workflow_name === "setup"));
  assert.equal(tasks[0].prompt, setupPrompt(POLICY, "main"));
  assert.equal(tasks[1].prompt, setupPrompt(POLICY, "develop"));
  assert.equal((await listTasks(ctx.db)).length, 2);
});

test("タスクは同梱ワークフローを pin し、setup を差し込まない", async () => {
  const ctx = await context();
  const h = createHandler(ctx);
  const workspace = await registerWorkspace(h);

  const [t] = await h(
    "workspace.setup",
    { workspace, projects: ["b"], policy: POLICY },
    NOOP_CONN,
  ) as TaskSummary[];

  const row = (await getTask(ctx.db, t.id))!;
  assert.equal(row.workflow_yaml, setupWorkflowYaml());
  assert.equal(row.workflow_setup, null);
  assert.equal(row.state, "queued");
});

test("workspace に無いプロジェクト名なら何も作らずに投げる", async () => {
  const ctx = await context();
  const h = createHandler(ctx);
  const workspace = await registerWorkspace(h);

  await assert.rejects(
    h("workspace.setup", { workspace, projects: ["a", "nope"], policy: POLICY }, NOOP_CONN),
    new RegExp(`workspace ${workspace} にプロジェクト nope はありません`),
  );
  assert.equal((await listTasks(ctx.db)).length, 0);
});

test("branch_only で sync: true なら投げる", async () => {
  const ctx = await context();
  const h = createHandler(ctx);
  const workspace = await registerWorkspace(h);

  await assert.rejects(
    h(
      "workspace.setup",
      { workspace, projects: ["a"], policy: { ...POLICY, pr: "branch_only", sync: true } },
      NOOP_CONN,
    ),
    /sync/,
  );
  assert.equal((await listTasks(ctx.db)).length, 0);
});
