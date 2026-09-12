import type { DatabaseSync } from "node:sqlite";

export type StepRunStatus = "running" | "success" | "failed" | "degraded";

export type StepRunRow = {
  id: number; task_id: string; step_id: string; attempt: number;
  status: StepRunStatus; exit_code: number | null;
  started_at: string; ended_at: string | null; log_path: string;
  cost_usd: number | null; num_turns: number | null; duration_ms: number | null;
};

export function listStepRuns(db: DatabaseSync, taskId: string): StepRunRow[] {
  return db.prepare("SELECT * FROM step_runs WHERE task_id = ? ORDER BY id")
    .all(taskId) as StepRunRow[];
}

export function getStepRun(db: DatabaseSync, id: number): StepRunRow | undefined {
  return db.prepare("SELECT * FROM step_runs WHERE id = ?").get(id) as StepRunRow | undefined;
}

/** 変数展開に渡す形（exitCode は文字列。テンプレートは文字列しか返さない）。 */
export function getStepOutputs(
  db: DatabaseSync, taskId: string,
): Record<string, { stdout: string; stderr: string; exitCode: string }> {
  const rows = db.prepare("SELECT step_id, stdout, stderr, exit_code FROM step_outputs WHERE task_id = ?")
    .all(taskId) as { step_id: string; stdout: string; stderr: string; exit_code: number | null }[];
  const out: Record<string, { stdout: string; stderr: string; exitCode: string }> = {};
  for (const r of rows) {
    out[r.step_id] = { stdout: r.stdout, stderr: r.stderr, exitCode: String(r.exit_code ?? "") };
  }
  return out;
}
