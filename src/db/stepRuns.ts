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
 * タスクが suspended なら、この行がちょうど1件ある。
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
 * （= 最大の step_run_id）の行を選ぶ。{{ steps.<id>.stdout }} の意味は
 * 履歴が増えても変わらない。
 */
export async function getStepOutputs(
  db: Db,
  taskId: string,
): Promise<Record<string, { stdout: string; stderr: string; exitCode: string }>> {
  const rows = await db.selectFrom("step_outputs")
    .innerJoin("step_runs", "step_runs.id", "step_outputs.step_run_id")
    .select([
      "step_runs.step_id",
      "step_runs.id as step_run_id",
      "step_outputs.stdout",
      "step_outputs.stderr",
      "step_outputs.exit_code",
    ])
    .where("step_runs.task_id", "=", taskId)
    .orderBy("step_runs.id")
    .execute();
  const out: Record<string, { stdout: string; stderr: string; exitCode: string }> = {};
  // id の昇順に上書きするので、最後に残るのが最新の実行。
  for (const r of rows) {
    out[r.step_id] = { stdout: r.stdout, stderr: r.stderr, exitCode: String(r.exit_code ?? "") };
  }
  return out;
}
