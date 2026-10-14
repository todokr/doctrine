import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { openDb } from "../../src/db/migrate.ts";
import { getTask } from "../../src/db/tasks.ts";
import { createHandler, type DaemonContext, tick } from "../../src/daemon/handlers.ts";
import { createWarningLog } from "../../src/daemon/warnings.ts";
import { loadWorkflowFromDisk, taskWorkflow } from "../../src/workflow/load.ts";
import { createMockAdapter, type MockAdapter } from "../../src/adapter/mock.ts";
import type { AgentRun } from "../../src/adapter/types.ts";
import { defaultWorkflowYamlFor } from "../../src/workflow/scaffold.ts";
import type { SetupPolicy, TaskSummary } from "../../../shared/protocol.ts";
import { makeRepo, tickWhenIdle, until } from "../helpers/repo.ts";
import { constTrackerOf, fakeTracker } from "../helpers/tracker.ts";
import { noopWatcher } from "../helpers/watcher.ts";

const NOOP_CONN = { follow() {}, unfollow() {}, isFollowing: () => false };
const WAIT_MS = 30_000;

const POLICY: SetupPolicy = {
  plan: true,
  agentReview: true,
  guide: false,
  approval: "after_implement",
  pr: "branch_only",
  sync: false,
  models: { plan: "p", implement: "i", review: "r", guide: "g" },
};

const DRAFTED =
  'name: default\nsteps:\n  - id: verify\n    type: command\n    run: "deno task test"\n';

let root: string;
const contexts: DaemonContext[] = [];

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "doctrine-setup-task-")));
  process.env.DOCTRINE_STATE_DIR = join(root, "state");
});
afterEach(async () => {
  await until(() => contexts.every((c) => c.running.size === 0), WAIT_MS);
  contexts.length = 0;
  await rm(root, { recursive: true, force: true });
  delete process.env.DOCTRINE_STATE_DIR;
});

/**
 * draft のエージェントの代わり。呼ばれた回ごとに draft(cwd, n) で worktree に書いてから、
 * モックの結果を返す。
 */
function draftingAdapter(draft: (cwd: string, n: number) => Promise<void>): MockAdapter {
  const mock = createMockAdapter({ result: { ok: true, text: "書きました" } });
  let n = 0;
  const wrap = (run: AgentRun, cwd: string): AgentRun => {
    const i = n++;
    return { ...run, result: draft(cwd, i).then(() => run.result) };
  };
  return {
    calls: mock.calls,
    start: (prompt, opts) => wrap(mock.start(prompt, opts), opts.cwd),
    resume: (id, prompt, opts) => wrap(mock.resume(id, prompt, opts), opts.cwd),
  };
}

async function writeOut(cwd: string, yaml: string): Promise<void> {
  await mkdir(join(cwd, ".doctrine-out"), { recursive: true });
  await writeFile(join(cwd, ".doctrine-out", "default.yaml"), yaml);
  await writeFile(join(cwd, ".doctrine-out", "setup-notes.md"), "verify は deno task test\n");
}

async function context(adapter: MockAdapter) {
  const db = await openDb(":memory:");
  const ctx: DaemonContext = {
    db,
    adapter,
    logRoot: join(root, "logs"),
    globalLimit: 4,
    configPath: join(root, "config.json"),
    broadcast: () => {},
    loadWorkflow: loadWorkflowFromDisk,
    workflowOf: (t, p) => taskWorkflow(t, p, loadWorkflowFromDisk),
    running: new Set(),
    trackerOf: constTrackerOf(fakeTracker()),
    runningIntakeRuns: new Set(),
    intakeWatcher: noopWatcher(),
    warnings: createWarningLog({ broadcast: () => {}, write: () => {} }),
  };
  contexts.push(ctx);
  return { ctx, handler: createHandler(ctx) };
}

/** workspace.yaml と雛形の default.yaml を持つリポジトリを作り、setup のタスクを 1 つ作る。 */
async function startSetupTask(adapter: MockAdapter, dir = "ws") {
  const repo = await makeRepo(join(root, dir), {
    "README.md": "x\n",
    ".doctrine/workspace.yaml": "projects:\n  app: .\n",
    ".doctrine/project.yaml": "defaultWorkflow: default\nmaxConcurrent: 1\nbaseBranch: main\n",
    ".doctrine/workflows/default.yaml": defaultWorkflowYamlFor("main"),
  });
  const { ctx, handler } = await context(adapter);
  const w = await handler("workspace.add", { path: repo }, NOOP_CONN) as { id: number };
  const [t] = await handler(
    "workspace.setup",
    { workspace: w.id, projects: ["app"], policy: POLICY },
    NOOP_CONN,
  ) as TaskSummary[];
  await tick(ctx);
  return { repo, ctx, handler, taskId: t.id };
}

async function stateOf(ctx: DaemonContext, id: string) {
  return (await getTask(ctx.db, id))?.state;
}

async function approveToCompletion(
  ctx: DaemonContext,
  handler: ReturnType<typeof createHandler>,
  taskId: string,
): Promise<void> {
  await until(async () => await stateOf(ctx, taskId) === "suspended", WAIT_MS, "承認待ち");
  assert.equal((await getTask(ctx.db, taskId))?.current_step_id, "review");
  await handler("task.approve", { task_id: taskId }, NOOP_CONN);
  await tickWhenIdle(ctx);
  await until(async () => await stateOf(ctx, taskId) === "completed", WAIT_MS, "completed");
  await until(
    async () => (await getTask(ctx.db, taskId))?.worktree_path === null,
    WAIT_MS,
    "worktree が消える",
  );
}

test("draft → validate → review（承認）→ apply で元リポジトリの default.yaml が置き換わり、worktree が消える", async () => {
  const adapter = draftingAdapter((cwd) => writeOut(cwd, DRAFTED));
  const { repo, ctx, handler, taskId } = await startSetupTask(adapter);

  await approveToCompletion(ctx, handler, taskId);

  assert.equal(
    await readFile(join(repo, ".doctrine", "workflows", "default.yaml"), "utf8"),
    DRAFTED,
  );
  assert.equal(adapter.calls.length, 1);
  assert.equal(adapter.calls[0].opts.permissionMode, "acceptEdits");
});

test("draft が .doctrine-out/ の外を書き換えると validate が落ち、feed に書き換えたパスが入る", async () => {
  const adapter = draftingAdapter(async (cwd, n) => {
    await writeFile(join(cwd, "README.md"), n === 0 ? "changed\n" : "x\n");
    await writeOut(cwd, DRAFTED);
  });
  const { ctx, taskId } = await startSetupTask(adapter);

  await until(async () => await stateOf(ctx, taskId) === "suspended", WAIT_MS, "承認待ち");
  assert.equal(adapter.calls.length, 2);
  assert.match(adapter.calls[1].prompt, /\.doctrine-out\/ の外が書き換えられています/);
  assert.match(adapter.calls[1].prompt, /README\.md/);
});

test("プロジェクトのパスに空白があっても apply が正しい場所に書く", async () => {
  const adapter = draftingAdapter((cwd) => writeOut(cwd, DRAFTED));
  const { repo, ctx, handler, taskId } = await startSetupTask(adapter, "my dir");
  assert.ok(repo.includes(" "));

  await approveToCompletion(ctx, handler, taskId);

  assert.equal(
    await readFile(join(repo, ".doctrine", "workflows", "default.yaml"), "utf8"),
    DRAFTED,
  );
});

test("ウィザードの流れ: .doctrine/ の無いリポジトリで init 付きの workspace.add から apply まで通る", async () => {
  // ウィザードが置いた .doctrine/ は未追跡なので、コミット済みの main から切った worktree には無い
  const inWorktree: boolean[] = [];
  const adapter = draftingAdapter(async (cwd) => {
    inWorktree.push(await access(join(cwd, ".doctrine")).then(() => true, () => false));
    await writeOut(cwd, DRAFTED);
  });
  const repo = await makeRepo(join(root, "fresh"), { "README.md": "x\n" });
  const { ctx, handler } = await context(adapter);

  const added = await handler(
    "workspace.add",
    { path: repo, projects: { app: "." }, tracker: { kind: "github" } },
    NOOP_CONN,
  ) as { id: number; projects: { name: string; path: string }[]; created: string[] };
  // app の setupTargets と同じ突き合わせ
  const targets = added.projects
    .filter((p) => added.created.includes(`${p.path}/.doctrine/workflows/default.yaml`))
    .map((p) => p.name);
  assert.deepEqual(targets, ["app"]);

  const [t] = await handler(
    "workspace.setup",
    { workspace: added.id, projects: targets, policy: POLICY },
    NOOP_CONN,
  ) as TaskSummary[];
  await tick(ctx);
  await approveToCompletion(ctx, handler, t.id);

  assert.deepEqual(inWorktree, [false]);
  assert.equal(
    await readFile(join(repo, ".doctrine", "workflows", "default.yaml"), "utf8"),
    DRAFTED,
  );
});
