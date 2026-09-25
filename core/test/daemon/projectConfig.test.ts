import { afterEach, beforeEach, test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { openDb } from "../../src/db/migrate.ts";
import { createHandler, type DaemonContext } from "../../src/daemon/handlers.ts";
import { createMockAdapter } from "../../src/adapter/mock.ts";
import { createWarningLog } from "../../src/daemon/warnings.ts";
import { parseProjectConfig } from "../../src/workflow/project.ts";
import { loadWorkflowFromDisk, taskWorkflow } from "../../src/workflow/load.ts";
import { WorkflowValidationError } from "../../src/workflow/schema.ts";
import type { ProjectConfig, ProjectSummary, ServerEvent } from "../../../shared/protocol.ts";
import { makeRepo } from "../helpers/repo.ts";
import { constTrackerOf, fakeTracker } from "../helpers/tracker.ts";
import { noopWatcher } from "../helpers/watcher.ts";

const runGit = promisify(execFile);

const NOOP_CONN = { follow() {}, unfollow() {}, isFollowing: () => false };
const HEADER_YAML =
  "# 設定のヘッダー\ndefaultWorkflow: feature # 既定のワークフロー\nmaxConcurrent: 1\nbaseBranch: main\n";
const APPROVAL_WORKFLOW = (name: string) =>
  `name: ${name}\nsteps:\n  - id: review\n    type: approval\n    title: 見て\n`;

let root: string;
let repo: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "doctrine-projectconfig-"));
  repo = await makeRepo(root, {
    "README.md": "x\n",
    ".doctrine/project.yaml": HEADER_YAML,
    ".doctrine/workflows/feature.yaml": APPROVAL_WORKFLOW("feature"),
    ".doctrine/workflows/other.yaml": APPROVAL_WORKFLOW("other"),
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
    trackerOf: constTrackerOf(fakeTracker()),
    runningIntakeRuns: new Set(),
    intakeWatcher: noopWatcher(),
  };
  return ctx;
}

test("project.config.get は project.yaml の設定を返す", async () => {
  const ctx = await context();
  const h = createHandler(ctx);
  await h("project.add", { path: repo }, NOOP_CONN);
  const cfg = await h("project.config.get", { project: repo }, NOOP_CONN) as ProjectConfig;
  assert.deepEqual(cfg, {
    defaultWorkflow: "feature",
    maxConcurrent: 1,
    baseBranch: "main",
    tracker: { kind: "github" },
  });
});

test("project.config.save は project.yaml と projects の行の両方を変え、コメントを残す", async () => {
  const ctx = await context();
  const h = createHandler(ctx);
  await h("project.add", { path: repo }, NOOP_CONN);

  const result = await h("project.config.save", {
    project: repo,
    config: { defaultWorkflow: "other", maxConcurrent: 3, baseBranch: "develop", setup: "pnpm i" },
  }, NOOP_CONN) as ProjectSummary;

  assert.equal(result.default_workflow, "other");
  assert.equal(result.max_concurrent, 3);
  assert.equal(result.base_branch, "develop");
  assert.equal(result.setup, "pnpm i");

  const list = await h("project.list", {}, NOOP_CONN) as ProjectSummary[];
  assert.equal(list[0].default_workflow, "other");
  assert.equal(list[0].max_concurrent, 3);
  assert.equal(list[0].base_branch, "develop");
  assert.equal(list[0].setup, "pnpm i");

  const text = await readFile(join(repo, ".doctrine", "project.yaml"), "utf8");
  assert(text.includes("# 設定のヘッダー"));
  assert(text.includes("# 既定のワークフロー"));
  assert.deepEqual(parseProjectConfig(text), {
    defaultWorkflow: "other",
    maxConcurrent: 3,
    baseBranch: "develop",
    setup: "pnpm i",
    tracker: { kind: "github" },
  });

  const entries = await readdir(join(repo, ".doctrine"));
  assert(!entries.some((e) => e.endsWith(".tmp")));

  const { stdout } = await runGit(
    "git",
    ["-C", repo, "log", "--oneline"],
  );
  assert.equal(stdout.trim().split("\n").length, 1);
});

test("project.config.save で setup を空にすると project.yaml から setup のキーが消え、行の setup が null になる", async () => {
  const ctx = await context();
  const h = createHandler(ctx);
  await h("project.add", { path: repo }, NOOP_CONN);

  await h("project.config.save", {
    project: repo,
    config: { defaultWorkflow: "feature", maxConcurrent: 1, baseBranch: "main", setup: "pnpm i" },
  }, NOOP_CONN);

  const result = await h("project.config.save", {
    project: repo,
    config: { defaultWorkflow: "feature", maxConcurrent: 1, baseBranch: "main", setup: "" },
  }, NOOP_CONN) as ProjectSummary;

  assert.equal(result.setup, null);
  const text = await readFile(join(repo, ".doctrine", "project.yaml"), "utf8");
  assert(!text.includes("setup:"));
});

test("project.config.save は project.yaml の tracker を残す", async () => {
  const ctx = await context();
  const h = createHandler(ctx);
  await h("project.add", { path: repo }, NOOP_CONN);
  await writeFile(
    join(repo, ".doctrine", "project.yaml"),
    HEADER_YAML + "tracker:\n  kind: linear\n  team: ENG\n",
  );

  await h("project.config.save", {
    project: repo,
    config: { defaultWorkflow: "other", maxConcurrent: 2, baseBranch: "main" },
  }, NOOP_CONN);

  const text = await readFile(join(repo, ".doctrine", "project.yaml"), "utf8");
  assert.deepEqual(parseProjectConfig(text).tracker, { kind: "linear", team: "ENG" });
});

test("project.config.save は maxConcurrent が0なら書かずにエラーを返す", async () => {
  const ctx = await context();
  const h = createHandler(ctx);
  await h("project.add", { path: repo }, NOOP_CONN);
  const before = await readFile(join(repo, ".doctrine", "project.yaml"), "utf8");

  await assert.rejects(
    () =>
      h("project.config.save", {
        project: repo,
        config: { defaultWorkflow: "feature", maxConcurrent: 0, baseBranch: "main" },
      }, NOOP_CONN),
    WorkflowValidationError,
  );

  const after = await readFile(join(repo, ".doctrine", "project.yaml"), "utf8");
  assert.equal(after, before);
  const list = await h("project.list", {}, NOOP_CONN) as ProjectSummary[];
  assert.equal(list[0].max_concurrent, 1);
});

test("project.config.save は存在しない defaultWorkflow なら書かずにエラーを返す", async () => {
  const ctx = await context();
  const h = createHandler(ctx);
  await h("project.add", { path: repo }, NOOP_CONN);
  const before = await readFile(join(repo, ".doctrine", "project.yaml"), "utf8");

  await assert.rejects(
    () =>
      h("project.config.save", {
        project: repo,
        config: { defaultWorkflow: "nope", maxConcurrent: 1, baseBranch: "main" },
      }, NOOP_CONN),
    /defaultWorkflow/,
  );

  const after = await readFile(join(repo, ".doctrine", "project.yaml"), "utf8");
  assert.equal(after, before);
  const list = await h("project.list", {}, NOOP_CONN) as ProjectSummary[];
  assert.equal(list[0].default_workflow, "feature");
});

test("project.config.save は未登録のプロジェクトを拒む", async () => {
  const ctx = await context();
  const h = createHandler(ctx);
  await assert.rejects(
    () =>
      h("project.config.save", {
        project: join(root, "nope"),
        config: { defaultWorkflow: "feature", maxConcurrent: 1, baseBranch: "main" },
      }, NOOP_CONN),
    /未登録/,
  );
});
