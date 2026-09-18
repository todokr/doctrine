import { afterEach, test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { join } from "@std/path";
import { openDb } from "../../src/db/migrate.ts";
import { getTask, insertProject, insertTask } from "../../src/db/tasks.ts";
import { commitStepBoundary } from "../../src/db/boundary.ts";
import { parseWorkflow } from "../../src/workflow/schema.ts";
import { buildTaskContext } from "../../src/core/taskContext.ts";
import type { Db } from "../../src/db/schema.ts";
import type { StepRunStatus } from "../../src/db/stepRuns.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => Deno.remove(d, { recursive: true })));
});

const WORKFLOW = parseWorkflow(`
name: f
steps:
  - id: implement
    type: agent
    prompt: "p"
  - id: test
    type: command
    run: "true"
  - id: review
    type: approval
    title: "見て"
    review:
      files:
        - .doctrine-out/plan.md
`).workflow;

async function fixture(worktree: string | null = null): Promise<Db> {
  const db = await openDb(":memory:");
  const pid = await insertProject(db, {
    path: "/repo",
    default_workflow: "f",
    max_concurrent: 1,
    base_branch: "main",
    setup: null,
  });
  await insertTask(db, {
    id: "t1",
    project_id: pid,
    title: "T",
    prompt: "在庫の引当を冪等にして",
    workflow_name: "f",
    branch: "b",
    priority: 2,
  });
  await db.updateTable("tasks").set({ worktree_path: worktree }).where("id", "=", "t1").execute();
  return db;
}

/** ステップ実行を1件書いて、その step_run_id を返す。 */
async function run(
  db: Db,
  o: {
    stepId: string;
    status: StepRunStatus;
    attempt?: number;
    startedAt?: string;
    endedAt?: string | null;
    reviewTree?: string | null;
    outputs?: { last_stdout: string; last_stderr: string; exit_code: number | null };
  },
): Promise<number> {
  const id = await commitStepBoundary(db, {
    taskId: "t1",
    taskPatch: {},
    stepRun: {
      step_id: o.stepId,
      attempt: o.attempt ?? 1,
      status: o.status,
      exit_code: o.outputs?.exit_code ?? null,
      started_at: o.startedAt ?? "2026-09-19T00:00:00.000Z",
      ended_at: o.endedAt ?? "2026-09-19T00:01:00.000Z",
      log_path: o.stepId === "review" ? "" : "/logs/x.log",
      review_tree: o.reviewTree ?? null,
    },
    outputs: o.outputs,
  });
  return id!;
}

test("元の指示をそのまま返す", async () => {
  const db = await fixture();
  const ctx = await buildTaskContext(db, (await getTask(db, "t1"))!, WORKFLOW);
  assert.equal(ctx.prompt, "在庫の引当を冪等にして");
});

test("直近の command の結果と、直近の agent の最後の発言を返す", async () => {
  const db = await fixture();
  await run(db, {
    stepId: "implement",
    status: "success",
    outputs: { last_stdout: "1回目の実装です", last_stderr: "", exit_code: 0 },
  });
  await run(db, {
    stepId: "test",
    status: "failed",
    outputs: { last_stdout: "", last_stderr: "3 failing", exit_code: 1 },
  });
  await run(db, {
    stepId: "implement",
    status: "success",
    attempt: 2,
    outputs: { last_stdout: "テストの失敗を直しました", last_stderr: "", exit_code: 0 },
  });
  await run(db, {
    stepId: "test",
    status: "success",
    attempt: 2,
    outputs: { last_stdout: "12 passed", last_stderr: "", exit_code: 0 },
  });

  const ctx = await buildTaskContext(db, (await getTask(db, "t1"))!, WORKFLOW);
  assert.deepEqual(ctx.lastCommand, {
    stepId: "test",
    exitCode: 0,
    stdout: "12 passed",
    stderr: "",
  });
  assert.equal(ctx.lastAgentMessage, "テストの失敗を直しました");
});

test("command も agent も1つも無ければ null", async () => {
  const db = await fixture();
  const ctx = await buildTaskContext(db, (await getTask(db, "t1"))!, WORKFLOW);
  assert.equal(ctx.lastCommand, null);
  assert.equal(ctx.lastAgentMessage, null);
});

test("レビューは古い順に、状態ごとに違う形で返る", async () => {
  const db = await fixture();
  await run(db, {
    stepId: "review",
    status: "failed",
    attempt: 1,
    startedAt: "2026-09-19T01:00:00.000Z",
    endedAt: "2026-09-19T02:00:00.000Z",
    reviewTree: "a".repeat(40),
    outputs: { last_stdout: "1回目の指摘", last_stderr: "", exit_code: 1 },
  });
  await run(db, {
    stepId: "review",
    status: "awaiting",
    attempt: 2,
    startedAt: "2026-09-19T03:00:00.000Z",
    endedAt: null,
    reviewTree: "b".repeat(40),
  });

  const { reviews } = await buildTaskContext(db, (await getTask(db, "t1"))!, WORKFLOW);
  assert.equal(reviews.length, 2);

  assert.deepEqual(reviews[0], {
    stepRunId: reviews[0].stepRunId,
    stepId: "review",
    attempt: 1,
    status: "rejected",
    startedAt: "2026-09-19T01:00:00.000Z",
    endedAt: "2026-09-19T02:00:00.000Z",
    reviewTree: "a".repeat(40),
    comment: "1回目の指摘",
  });

  assert.equal(reviews[1].status, "awaiting");
  assert.equal("endedAt" in reviews[1], false, "待機中の回に決定時刻のキーは無い");
  assert.equal("comment" in reviews[1], false, "待機中の回にコメントのキーは無い");
});

test("承認された回は approved で、コメントのキーを持たない", async () => {
  const db = await fixture();
  await run(db, {
    stepId: "review",
    status: "success",
    outputs: { last_stdout: "", last_stderr: "", exit_code: 0 },
  });
  const { reviews } = await buildTaskContext(db, (await getTask(db, "t1"))!, WORKFLOW);
  assert.equal(reviews[0].status, "approved");
  assert.equal("comment" in reviews[0], false);
  assert.equal(reviews[0].endedAt, "2026-09-19T00:01:00.000Z");
});

test("外から閉じられた回は interrupted", async () => {
  const db = await fixture();
  await run(db, { stepId: "review", status: "interrupted" });
  const { reviews } = await buildTaskContext(db, (await getTask(db, "t1"))!, WORKFLOW);
  assert.equal(reviews[0].status, "interrupted");
  assert.equal("comment" in reviews[0], false);
});

test("approval の行に想定外の status があれば例外にする", async () => {
  const db = await fixture();
  await run(db, { stepId: "review", status: "degraded" });
  await assert.rejects(
    async () => buildTaskContext(db, (await getTask(db, "t1"))!, WORKFLOW),
    /想定外/,
  );
});

test("承認待ちで宣言があれば、宣言されたファイルの中身が返る", async () => {
  const root = await Deno.makeTempDir({ prefix: "doctrine-taskctx-" });
  dirs.push(root);
  const wt = join(root, "wt");
  await Deno.mkdir(join(wt, ".doctrine-out"), { recursive: true });
  await Deno.writeTextFile(join(wt, ".doctrine-out", "plan.md"), "# 計画\n");

  const db = await fixture(wt);
  await db.updateTable("tasks").set({ state: "suspended", current_step_id: "review" })
    .where("id", "=", "t1").execute();
  await run(db, { stepId: "review", status: "awaiting", endedAt: null });

  const { reviewFiles } = await buildTaskContext(db, (await getTask(db, "t1"))!, WORKFLOW);
  assert.equal(reviewFiles.length, 1);
  assert.equal(reviewFiles[0].status, "ok");
  if (reviewFiles[0].status !== "ok") throw new Error("unreachable");
  assert.equal(reviewFiles[0].content, "# 計画\n");
});

test("承認待ちでなければ reviewFiles は空", async () => {
  const db = await fixture("/tmp");
  const { reviewFiles } = await buildTaskContext(db, (await getTask(db, "t1"))!, WORKFLOW);
  assert.deepEqual(reviewFiles, []);
});

test("ワークフロー定義が引けなくても、経緯は返る", async () => {
  const db = await fixture();
  await db.updateTable("tasks").set({ state: "suspended", current_step_id: "review" })
    .where("id", "=", "t1").execute();
  await run(db, {
    stepId: "review",
    status: "failed",
    outputs: { last_stdout: "直して", last_stderr: "", exit_code: 1 },
  });
  await run(db, {
    stepId: "test",
    status: "success",
    outputs: { last_stdout: "ok", last_stderr: "", exit_code: 0 },
  });

  const ctx = await buildTaskContext(db, (await getTask(db, "t1"))!, null);
  assert.equal(ctx.prompt, "在庫の引当を冪等にして");
  assert.equal(ctx.reviews.length, 1, "current_step_id と同じ step_id の行を拾う");
  assert.equal(ctx.reviews[0].status, "rejected");
  assert.equal(ctx.lastCommand, null, "種別が分からないので候補にしない");
  assert.equal(ctx.lastAgentMessage, null);
  assert.deepEqual(ctx.reviewFiles, []);
});
