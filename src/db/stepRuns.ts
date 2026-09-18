import type { Db, StepRunRow } from "./schema.ts";

export type { StepRunRow, StepRunStatus } from "./schema.ts";

export function listStepRuns(db: Db, taskId: string): Promise<StepRunRow[]> {
  return db.selectFrom("step_runs").selectAll().where("task_id", "=", taskId).orderBy("id")
    .execute();
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
