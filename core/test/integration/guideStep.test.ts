import { afterEach, beforeEach, test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTask } from "../../src/domain/engine.ts";
import { collectGuideInputs } from "../../src/domain/guideInputs.ts";
import { GUIDE_RELPATH } from "../../src/domain/guideFile.ts";
import { ensureDoctrineOutExcluded } from "../../src/domain/worktree.ts";
import { createMockAdapter } from "../../src/adapter/mock.ts";
import { parseWorkflow } from "../../src/workflow/schema.ts";
import { openDb } from "../../src/db/migrate.ts";
import { getTask, insertProject, insertTask } from "../../src/db/tasks.ts";
import { getStepOutputs, listStepRuns } from "../../src/db/stepRuns.ts";
import { guideJsonSchema } from "../../../shared/guide/jsonSchema.ts";
import type { Db } from "../../src/db/schema.ts";
import { makeRepo } from "../helpers/repo.ts";

const run = promisify(execFile);
let root: string;
let repo: string;
let db: Db;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "doctrine-guide-step-"));
  repo = await makeRepo(root, { "README.md": "a\nb\nc\n" });
  // 呼ばないと、書き出した guide-hunks.json 自身が次の captureTree に混ざる。
  await ensureDoctrineOutExcluded(repo);
  await run("git", ["-C", repo, "switch", "-c", "work"]);
  await writeFile(join(repo, "README.md"), "a\nb\nc\nd\n");

  db = await openDb(":memory:");
  const pid = await insertProject(db, {
    path: repo,
    default_workflow: "f",
    max_concurrent: 1,
    base_branch: "main",
    setup: null,
  });
  await insertTask(db, {
    id: "t1",
    project_id: pid,
    title: "T",
    prompt: "README に d を足して",
    workflow_name: "f",
    branch: "doctrine/t1-t",
    priority: 2,
  });
  await db.updateTable("tasks").set({ state: "running", worktree_path: repo })
    .where("id", "=", "t1").execute();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const collect = () => collectGuideInputs({ worktreePath: repo, baseBranch: "main" });

const WORKFLOW = `
name: f
steps:
  - id: write-guide
    type: guide
    session: guide
`;

const ONE_SHOT = `
name: f
steps:
  - id: write-guide
    type: guide
    session: guide
    onFailure:
      goto: write-guide
      maxAttempts: 1
      feed: "{{ steps.write-guide.last_stderr }}"
`;

/** 最小の正しいガイド。location は与えられたものを 1 件だけ指す。 */
function guideAt(location: { path: string; hunk?: string }) {
  return {
    version: 1,
    why: "README に行を足す",
    what: [{ name: "README", summary: "d を足した", paths: ["README.md"] }],
    how: [{ body: "1 行足した" }],
    readingOrder: [{
      title: "README",
      body: "足した行",
      locations: [location],
      refs: { decisions: [], risks: [], tests: [], diagrams: [] },
    }],
    decisions: [],
    risks: [],
    tests: [],
    diagrams: [],
  };
}

async function validGuide() {
  const { hunks } = await collect();
  return guideAt({ path: hunks[0].path, hunk: hunks[0].id });
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function go(yaml: string, adapter: ReturnType<typeof createMockAdapter>) {
  const { workflow } = parseWorkflow(yaml);
  await runTask(db, "t1", workflow, {
    db,
    adapter,
    logRoot: join(root, "logs"),
    globalLimit: 4,
  });
}

test("1回目が壊れた出力でも、同じ会話に理由を戻して2回目で guide.json が書かれる", async () => {
  const good = await validGuide();
  const adapter = createMockAdapter({
    result: {},
    sequence: [{ structuredOutput: null }, { structuredOutput: good }],
  });
  await go(WORKFLOW, adapter);

  assert.equal((await getTask(db, "t1"))?.state, "completed");
  assert.deepEqual(adapter.calls.map((c) => c.kind), ["start", "resume"]);
  assert.equal(adapter.calls[0].sessionId, adapter.calls[1].sessionId);
  assert.match(adapter.calls[1].prompt, /構造化出力/);
  assert.deepEqual(adapter.calls[0].opts.jsonSchema, guideJsonSchema());

  const written = JSON.parse(await readFile(join(repo, GUIDE_RELPATH), "utf8"));
  assert.match(written.tree, /^[0-9a-f]{40}$/);
  assert.ok(!Number.isNaN(Date.parse(written.createdAt)));
  assert.deepEqual(written.guide, good);

  const runs = await listStepRuns(db, "t1");
  assert.deepEqual(runs.map((r) => [r.step_id, r.status]), [
    ["write-guide", "bounced"],
    ["write-guide", "success"],
  ]);
});

test("壊れた出力が続くと maxAttempts で failed になり、guide.json は書かれない", async () => {
  const adapter = createMockAdapter({ result: { structuredOutput: null } });
  await go(WORKFLOW, adapter);

  assert.equal((await getTask(db, "t1"))?.state, "failed");
  const runs = await listStepRuns(db, "t1");
  assert.equal(runs.filter((r) => r.step_id === "write-guide").length, 3);
  assert.equal(await exists(join(repo, GUIDE_RELPATH)), false);
});

test("スキーマは通るが存在しない hunk を指すガイドは失敗する", async () => {
  const bad = guideAt({ path: "README.md", hunk: "h_00000000000000" });
  const adapter = createMockAdapter({ result: { structuredOutput: bad } });
  await go(ONE_SHOT, adapter);

  assert.equal((await getTask(db, "t1"))?.state, "failed");
  assert.equal(await exists(join(repo, GUIDE_RELPATH)), false);
  const outputs = await getStepOutputs(db, "t1");
  assert.match(outputs["write-guide"].last_stderr, /h_00000000000000/);
});

test("実在する hunk id でも、パスが違えば失敗する", async () => {
  const { hunks } = await collect();
  const bad = guideAt({ path: "other.ts", hunk: hunks[0].id });
  const adapter = createMockAdapter({ result: { structuredOutput: bad } });
  await go(ONE_SHOT, adapter);

  assert.equal((await getTask(db, "t1"))?.state, "failed");
  assert.equal(await exists(join(repo, GUIDE_RELPATH)), false);
  const outputs = await getStepOutputs(db, "t1");
  assert.match(outputs["write-guide"].last_stderr, /other\.ts/);
});

test("hunk を省いた場所は、そのパスが diff にあれば通る", async () => {
  const adapter = createMockAdapter({
    result: { structuredOutput: guideAt({ path: "README.md" }) },
  });
  await go(WORKFLOW, adapter);
  assert.equal((await getTask(db, "t1"))?.state, "completed");
});

test("封筒の tree は hunk の一覧を作った時点のツリー", async () => {
  const good = await validGuide();
  const adapter = createMockAdapter({ result: { structuredOutput: good } });
  await go(WORKFLOW, adapter);

  const written = JSON.parse(await readFile(join(repo, GUIDE_RELPATH), "utf8"));
  // .doctrine-out/ はツリーに入らないので、書き込みの前後で変わらない。
  assert.equal(written.tree, (await collect()).tree);
});
