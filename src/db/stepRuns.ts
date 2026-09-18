import type { Db, StepRunRow } from "./schema.ts";

export type { StepRunRow, StepRunStatus } from "./schema.ts";

export function listStepRuns(db: Db, taskId: string): Promise<StepRunRow[]> {
  return db.selectFrom("step_runs").selectAll().where("task_id", "=", taskId).orderBy("id")
    .execute();
}

export function getStepRun(db: Db, id: number): Promise<StepRunRow | undefined> {
  return db.selectFrom("step_runs").selectAll().where("id", "=", id).executeTakeFirst();
}

/** 変数展開に渡す形（exitCode は文字列。テンプレートは文字列しか返さない）。 */
export async function getStepOutputs(
  db: Db,
  taskId: string,
): Promise<Record<string, { stdout: string; stderr: string; exitCode: string }>> {
  const rows = await db.selectFrom("step_outputs")
    .select(["step_id", "stdout", "stderr", "exit_code"])
    .where("task_id", "=", taskId)
    .execute();
  const out: Record<string, { stdout: string; stderr: string; exitCode: string }> = {};
  for (const r of rows) {
    out[r.step_id] = { stdout: r.stdout, stderr: r.stderr, exitCode: String(r.exit_code ?? "") };
  }
  return out;
}
