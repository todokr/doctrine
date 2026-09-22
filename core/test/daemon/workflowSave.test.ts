import { afterEach, beforeEach, test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { readdir, readFile, rm } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { openDb } from "../../src/db/migrate.ts";
import { createHandler, type DaemonContext } from "../../src/daemon/handlers.ts";
import { createMockAdapter } from "../../src/adapter/mock.ts";
import { createWarningLog } from "../../src/daemon/warnings.ts";
import { loadWorkflowFromDisk, taskWorkflow } from "../../src/workflow/load.ts";
import { parseWorkflow } from "../../src/workflow/schema.ts";
import type { ServerEvent, WorkflowDetail, WorkflowSaveResult } from "../../../shared/protocol.ts";
import { makeRepo } from "../helpers/repo.ts";
import { fakeTracker } from "../helpers/tracker.ts";
import { noopWatcher } from "../helpers/watcher.ts";

const runGit = promisify(execFile);

const NOOP_CONN = { follow() {}, unfollow() {}, isFollowing: () => false };
const PROJECT_YAML = "defaultWorkflow: default\nmaxConcurrent: 1\nbaseBranch: main\n";

async function repoDefaultYaml(): Promise<string> {
  return await readFile(
    new URL("../../../.doctrine/workflows/default.yaml", import.meta.url),
    "utf8",
  );
}

let root: string;
let repo: string;
let defaultYaml: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "doctrine-workflowsave-"));
  defaultYaml = await repoDefaultYaml();
  repo = await makeRepo(root, {
    "README.md": "x\n",
    ".doctrine/project.yaml": PROJECT_YAML,
    ".doctrine/workflows/default.yaml": defaultYaml,
  });
  process.env.DOCTRINE_STATE_DIR = join(root, "state");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  delete process.env.DOCTRINE_STATE_DIR;
});

async function context(events: ServerEvent[] = []): Promise<DaemonContext> {
  const db = await openDb(":memory:");
  const ctx: DaemonContext = {
    db,
    adapter: createMockAdapter({ result: { ok: true, text: "done" } }),
    logRoot: join(root, "logs"),
    globalLimit: 4,
    configPath: join(root, "state", "config.json"),
    broadcast: (ev) => events.push(ev),
    warnings: createWarningLog({ broadcast: (ev) => events.push(ev), write: () => {} }),
    loadWorkflow: loadWorkflowFromDisk,
    workflowOf: (t, p) => taskWorkflow(t, p, loadWorkflowFromDisk),
    running: new Set(),
    tracker: fakeTracker(),
    runningIntakeRuns: new Set(),
    intakeWatcher: noopWatcher(),
  };
  return ctx;
}

test("workflow.save は変更を作業ツリーのファイルに書き、コメントを残し、コミットしない", async () => {
  const ctx = await context();
  const h = createHandler(ctx);
  await h("project.add", { path: repo }, NOOP_CONN);

  const result = await h("workflow.save", {
    project: repo,
    name: "default",
    changes: [{ id: "implement", model: "claude-opus-5", prompt: "新しいプロンプト\n" }],
  }, NOOP_CONN) as WorkflowSaveResult;

  assert(result.ok);
  assert(result.warnings.length >= 1);

  const text = await readFile(join(repo, ".doctrine", "workflows", "default.yaml"), "utf8");
  const { workflow: before } = parseWorkflow(defaultYaml);
  const { workflow: after } = parseWorkflow(text);
  const implementAfter = after.steps.find((s) => s.id === "implement");
  assert.equal((implementAfter as { model?: string }).model, "claude-opus-5");
  assert.equal((implementAfter as { prompt?: string }).prompt, "新しいプロンプト\n");

  for (const stepBefore of before.steps) {
    if (stepBefore.id === "implement") continue;
    const stepAfter = after.steps.find((s) => s.id === stepBefore.id);
    assert.deepEqual(stepAfter, stepBefore);
  }

  const commentLines = (t: string) => t.split("\n").filter((l) => l.trim().startsWith("#"));
  assert.deepEqual(commentLines(text), commentLines(defaultYaml));

  const entries = await readdir(join(repo, ".doctrine", "workflows"));
  assert(!entries.some((e) => e.endsWith(".tmp")));

  const { stdout } = await runGit("git", ["-C", repo, "log", "--oneline"]);
  assert.equal(stdout.trim().split("\n").length, 1);

  const status = await runGit("git", ["-C", repo, "status", "--porcelain"]);
  assert.equal(status.stdout.trim(), "M .doctrine/workflows/default.yaml");

  const got = await h(
    "workflow.get",
    { project: repo, name: "default" },
    NOOP_CONN,
  ) as WorkflowDetail;
  assert(got.ok);
  const implementStep = got.steps.find((s) => s.id === "implement");
  assert.equal((implementStep as { model?: string | null }).model, "claude-opus-5");
});

test("workflow.save は goto に存在しないステップを入れると書かずにエラーを返す", async () => {
  const ctx = await context();
  const h = createHandler(ctx);
  await h("project.add", { path: repo }, NOOP_CONN);

  const before = await readFile(join(repo, ".doctrine", "workflows", "default.yaml"), "utf8");

  const result = await h("workflow.save", {
    project: repo,
    name: "default",
    changes: [{ id: "verify", branch: { goto: "nowhere" } }],
  }, NOOP_CONN) as WorkflowSaveResult;

  assert(!result.ok);
  assert.deepEqual(
    result.issues.find((i) => i.stepId === "verify"),
    {
      stepId: "verify",
      field: "branch.goto",
      message: 'ステップ "verify" の goto が存在しないステップを指しています: nowhere',
    },
  );

  const after = await readFile(join(repo, ".doctrine", "workflows", "default.yaml"), "utf8");
  assert.equal(after, before);

  const status = await runGit("git", ["-C", repo, "status", "--porcelain"]);
  assert.equal(status.stdout.trim(), "");
});

test("workflow.save は gh pr create を含む run に警告を返す", async () => {
  const events: ServerEvent[] = [];
  const ctx = await context(events);
  const h = createHandler(ctx);
  await h("project.add", { path: repo }, NOOP_CONN);

  const result = await h("workflow.save", {
    project: repo,
    name: "default",
    changes: [{ id: "verify", run: "gh pr create --fill" }],
  }, NOOP_CONN) as WorkflowSaveResult;

  assert(result.ok);
  assert(result.warnings.some((w) => w.includes('ステップ "verify"')));
  assert.deepEqual(ctx.warnings.recent(), []);
});

test("workflow.save は無いワークフロー・不正な名前・未登録のプロジェクト・changes の欠落を断る", async () => {
  const ctx = await context();
  const h = createHandler(ctx);
  await h("project.add", { path: repo }, NOOP_CONN);

  await assert.rejects(
    () => h("workflow.save", { project: repo, name: "nope", changes: [] }, NOOP_CONN),
  );

  await assert.rejects(
    () => h("workflow.save", { project: repo, name: "../project", changes: [] }, NOOP_CONN),
    /ワークフロー名が不正です/,
  );

  await assert.rejects(
    () =>
      h("workflow.save", { project: join(root, "nope"), name: "default", changes: [] }, NOOP_CONN),
    /未登録/,
  );

  await assert.rejects(
    () => h("workflow.save", { project: repo, name: "default" }, NOOP_CONN),
    /changes は必須です/,
  );
});
