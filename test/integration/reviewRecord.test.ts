import { afterEach, test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyApproval, runTask } from "../../src/core/engine.ts";
import { parseWorkflow } from "../../src/workflow/schema.ts";
import { openDb } from "../../src/db/migrate.ts";
import { getTask, insertProject, insertTask } from "../../src/db/tasks.ts";
import { listStepRuns } from "../../src/db/stepRuns.ts";
import { createWorktree } from "../../src/core/worktree.ts";
import { reviewRefName } from "../../src/core/reviewTree.ts";
import { createMockAdapter } from "../../src/adapter/mock.ts";
import { runCommand } from "../../src/util/exec.ts";
import { makeRepo } from "../helpers/repo.ts";
import type { Db } from "../../src/db/schema.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

const WORKFLOW = parseWorkflow(`
name: f
steps:
  - id: implement
    type: command
    run: "true"
  - id: review
    type: approval
    title: "見て"
    onReject:
      goto: implement
      maxAttempts: 5
`).workflow;

/** 本物の git worktree を持つ running のタスクを1件作る。 */
async function fixture(): Promise<{ db: Db; repo: string; worktree: string; logRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), "doctrine-review-"));
  roots.push(root);
  const repo = await makeRepo(root, { "a.txt": "1\n" });
  const worktree = await createWorktree({
    repoPath: repo,
    worktreePath: join(root, "wt"),
    branch: "doctrine/t1",
    baseBranch: "main",
  });
  const db = await openDb(":memory:");
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
    prompt: "P",
    workflow_name: "f",
    branch: "doctrine/t1",
    priority: 2,
  });
  await db.updateTable("tasks").set({ state: "running", worktree_path: worktree })
    .where("id", "=", "t1").execute();
  return { db, repo, worktree, logRoot: join(root, "logs") };
}

function deps(db: Db, logRoot: string) {
  return { db, adapter: createMockAdapter({ result: {} }), logRoot, globalLimit: 4 };
}

function resume(db: Db) {
  return db.updateTable("tasks").set({ state: "running" }).where("id", "=", "t1").execute();
}

test("2回差し戻した後、両方のコメントと時刻とそれぞれの待ち時間が DB から読める", async () => {
  const { db, logRoot } = await fixture();

  await runTask(db, "t1", WORKFLOW, deps(db, logRoot));
  await applyApproval(db, "t1", { approved: false, comment: "1回目: 命名が雑" }, WORKFLOW);
  await resume(db);
  await runTask(db, "t1", WORKFLOW, deps(db, logRoot));
  await applyApproval(db, "t1", { approved: false, comment: "2回目: テストが無い" }, WORKFLOW);

  const rows = await db.selectFrom("step_runs")
    .innerJoin("step_outputs", "step_outputs.step_run_id", "step_runs.id")
    .select([
      "step_runs.attempt",
      "step_runs.started_at",
      "step_runs.ended_at",
      "step_outputs.last_stdout",
    ])
    .where("step_runs.task_id", "=", "t1")
    .where("step_runs.step_id", "=", "review")
    .orderBy("step_runs.id")
    .execute();

  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.last_stdout), ["1回目: 命名が雑", "2回目: テストが無い"]);
  assert.deepEqual(rows.map((r) => r.attempt), [1, 2]);
  for (const r of rows) {
    assert.ok(r.ended_at !== null, "決まった時刻が残っていない");
    // 待ち時間 = ended_at - started_at。行ごとに引ける。
    assert.ok(Date.parse(r.ended_at!) - Date.parse(r.started_at) >= 0);
  }
});

test("差し戻し後の再レビューで、前回レビュー時点のツリーを引ける", async () => {
  const { db, repo, worktree, logRoot } = await fixture();

  // 1回目のレビュー時点の worktree（未追跡のファイルを含む）
  await writeFile(join(worktree, "first.txt"), "1回目\n");
  await runTask(db, "t1", WORKFLOW, deps(db, logRoot));
  const first = (await listStepRuns(db, "t1")).find((r) => r.step_id === "review")!;
  assert.ok(first.review_tree !== null, "1回目のツリーが記録されていない");

  await applyApproval(db, "t1", { approved: false, comment: "直して" }, WORKFLOW);
  await resume(db);

  // 差し戻し後に作業が進み、2回目のレビューへ
  await writeFile(join(worktree, "second.txt"), "2回目\n");
  await runTask(db, "t1", WORKFLOW, deps(db, logRoot));

  // 到達不能なオブジェクトが刈られても、参照があるので前回のツリーは生きている。
  await runCommand("git", ["-C", repo, "gc", "--prune=now"]);

  const { stdout } = await runCommand("git", [
    "-C",
    repo,
    "ls-tree",
    "-r",
    "--name-only",
    reviewRefName("t1", first.id),
  ]);
  const files = stdout.trim().split("\n").sort();
  assert.ok(files.includes("first.txt"), "前回レビュー時点のファイルが引けない");
  assert.ok(!files.includes("second.txt"), "前回レビュー時点に無かったファイルが混ざっている");
});

test("レビュー時点のツリーには未コミットの変更が入る", async () => {
  const { db, repo, worktree, logRoot } = await fixture();
  await writeFile(join(worktree, "a.txt"), "書き換えた\n"); // 追跡済み・未コミット

  await runTask(db, "t1", WORKFLOW, deps(db, logRoot));

  const run = (await listStepRuns(db, "t1")).find((r) => r.step_id === "review")!;
  const { stdout } = await runCommand("git", ["-C", repo, "show", `${run.review_tree}:a.txt`]);
  assert.equal(stdout, "書き換えた\n");
});

test("承認されたタスクも、そのレビュー時点のツリーを持つ", async () => {
  const { db, logRoot } = await fixture();
  await runTask(db, "t1", WORKFLOW, deps(db, logRoot));

  await applyApproval(db, "t1", { approved: true, comment: "" }, WORKFLOW);

  const run = (await listStepRuns(db, "t1")).find((r) => r.step_id === "review")!;
  assert.equal(run.status, "success");
  assert.ok(run.review_tree !== null);
  assert.equal((await getTask(db, "t1"))!.state, "completed");
});
