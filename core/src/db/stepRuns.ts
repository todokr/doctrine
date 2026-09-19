import type { Db, StepRunRow } from "./schema.ts";

export type { StepRunRow, StepRunStatus } from "./schema.ts";

export function listStepRuns(db: Db, taskId: string): Promise<StepRunRow[]> {
  return db.selectFrom("step_runs").selectAll().where("task_id", "=", taskId).orderBy("id")
    .execute();
}

/** そのステップの直前の実行。ステップ開始時に「上限待ちからのやり直しか」を見るのに使う。 */
export function lastStepRunFor(
  db: Db,
  taskId: string,
  stepId: string,
): Promise<StepRunRow | undefined> {
  return db.selectFrom("step_runs").selectAll()
    .where("task_id", "=", taskId)
    .where("step_id", "=", stepId)
    .orderBy("id", "desc")
    .executeTakeFirst();
}

export function getStepRun(db: Db, id: number): Promise<StepRunRow | undefined> {
  return db.selectFrom("step_runs").selectAll().where("id", "=", id).executeTakeFirst();
}

/**
 * 承認待ちのステップ実行（approval が suspended に入った時点で立てた行）。
 * タスクが suspended なら、**開いている** awaiting 行がちょうど1件ある。
 *
 * 同じ (task_id, step_id) に閉じた行が何行あってもよい。task.resume は suspended の
 * タスクを queued に戻すので、同じ approval ステップに入り直すと「interrupted で
 * 閉じた行 + 新しい awaiting 行」になる（閉じるのは handlers.ts の
 * closeAwaitingStepRun）。開いている行は常に最新なので id desc で取る。
 */
export function getAwaitingStepRun(
  db: Db,
  taskId: string,
  stepId: string,
): Promise<StepRunRow | undefined> {
  return db.selectFrom("step_runs").selectAll()
    .where("task_id", "=", taskId)
    .where("step_id", "=", stepId)
    .where("status", "=", "awaiting")
    .orderBy("id desc")
    .executeTakeFirst();
}

/**
 * 「前回レビュー以降」の基準点。直近の**差し戻された** approval の step_run と、
 * その時点の worktree のツリーを返す。
 *
 * 差し戻しは「review_tree を持つ行が failed で閉じられたもの」として引く。
 * status に rejected は無く、approval の却下は exit_code 1 の failed として
 * 閉じられる（engine.ts の applyApproval）。review_tree が入るのは approval の
 * awaiting 行だけなので、この2条件で差し戻しだけが取れる。復旧が付ける
 * interrupted は差し戻しではないので failed の条件で外れる。
 *
 * 承認された回（success）は基準にしない。承認済みを基準にすると、その後の
 * ステップの成果がレビュー対象から丸ごと消える。「前回レビュー以降」が意味を
 * 持つのは、差し戻してやり直させたときだけである。
 */
export async function lastRejectedReview(
  db: Db,
  taskId: string,
): Promise<{ step_run_id: number; review_tree: string } | undefined> {
  const row = await db.selectFrom("step_runs")
    .select(["id", "review_tree"])
    .where("task_id", "=", taskId)
    .where("status", "=", "failed")
    .where("review_tree", "is not", null)
    .orderBy("id", "desc")
    .executeTakeFirst();
  if (!row?.review_tree) return undefined;
  return { step_run_id: row.id, review_tree: row.review_tree };
}

/**
 * 変数展開に渡す形（exitCode は文字列。テンプレートは文字列しか返さない）。
 *
 * step_outputs は実行1回ごとに1行あるので、ステップidごとに**最新の実行**
 * （= 最大の step_run_id）の行を選ぶ。{{ steps.<id>.last_stdout }} の意味は
 * 履歴が増えても変わらない。
 */
export async function getStepOutputs(
  db: Db,
  taskId: string,
): Promise<Record<string, { last_stdout: string; last_stderr: string; exitCode: string }>> {
  const rows = await db.selectFrom("step_outputs")
    .innerJoin("step_runs", "step_runs.id", "step_outputs.step_run_id")
    .select([
      "step_runs.step_id",
      "step_runs.id as step_run_id",
      "step_outputs.last_stdout",
      "step_outputs.last_stderr",
      "step_outputs.exit_code",
    ])
    .where("step_runs.task_id", "=", taskId)
    .orderBy("step_runs.id")
    .execute();
  const out: Record<string, { last_stdout: string; last_stderr: string; exitCode: string }> = {};
  // id の昇順に上書きするので、最後に残るのが最新の実行。
  for (const r of rows) {
    out[r.step_id] = {
      last_stdout: r.last_stdout,
      last_stderr: r.last_stderr,
      exitCode: String(r.exit_code ?? ""),
    };
  }
  return out;
}

/**
 * そのタスクのステップ出力を step_run_id 引きで返す。listStepRuns と突き合わせて
 * 「どの実行の出力か」を解く側（taskContext）が使う。
 */
export async function listStepOutputs(
  db: Db,
  taskId: string,
): Promise<Map<number, { last_stdout: string; last_stderr: string; exit_code: number | null }>> {
  const rows = await db.selectFrom("step_outputs")
    .innerJoin("step_runs", "step_runs.id", "step_outputs.step_run_id")
    .select([
      "step_outputs.step_run_id",
      "step_outputs.last_stdout",
      "step_outputs.last_stderr",
      "step_outputs.exit_code",
    ])
    .where("step_runs.task_id", "=", taskId)
    .execute();
  return new Map(
    rows.map((r) => [r.step_run_id, {
      last_stdout: r.last_stdout,
      last_stderr: r.last_stderr,
      exit_code: r.exit_code,
    }]),
  );
}
