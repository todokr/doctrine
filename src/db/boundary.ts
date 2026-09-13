import type { DatabaseSync } from "node:sqlite";
import type { TaskRow } from "./tasks.ts";
import type { StepRunStatus } from "./stepRuns.ts";

/** DBに残す出力の上限。ログ本文はファイル、DBは末尾だけ。 */
export const OUTPUT_TAIL_BYTES = 8192;

export type StepBoundary = {
  taskId: string;
  taskPatch: Partial<Pick<TaskRow,
    "state" | "current_step_id" | "attempt_counts" | "worktree_path" |
    "claude_session_id" | "child_pid" | "child_started_at" | "resumed" | "pending_feed">>;
  /** ステップ開始時: status "running" / ended_at null で挿入し、返り値の id を持っておく。 */
  stepRun?: {
    step_id: string; attempt: number; status: StepRunStatus; exit_code: number | null;
    started_at: string; ended_at: string | null; log_path: string;
    cost_usd?: number | null; num_turns?: number | null; duration_ms?: number | null;
  };
  /** ステップ終了時: 開始時の行を同じトランザクションで更新する。 */
  stepRunUpdate?: {
    id: number; status: StepRunStatus; exit_code: number | null; ended_at: string;
    cost_usd?: number | null; num_turns?: number | null; duration_ms?: number | null;
  };
  outputs?: { step_id: string; stdout: string; stderr: string; exit_code: number | null };
};

function tail(s: string): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= OUTPUT_TAIL_BYTES) return s;
  let start = buf.length - OUTPUT_TAIL_BYTES;
  // UTF-8 continuation bytes are 10xxxxxx; walk forward to the next code-point start
  // so the tail never begins mid-character (which would decode to U+FFFD).
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
  return buf.subarray(start).toString("utf8");
}

/**
 * タスクの更新・ステップ実行記録・出力を1トランザクションで書く。
 * 落ちて失うのは最大1ステップ分、という保証がここに乗っている。
 */
export function commitStepBoundary(db: DatabaseSync, b: StepBoundary): number | null {
  db.exec("BEGIN IMMEDIATE");
  let stepRunId: number | null = null;
  try {
    const patch = { ...b.taskPatch };
    const keys = Object.keys(patch);
    const sets = [...keys.map((k) => `${k} = ?`), "updated_at = ?"];
    const values = [...keys.map((k) => (patch as Record<string, unknown>)[k]), new Date().toISOString()];
    db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`)
      .run(...(values as (string | number | null)[]), b.taskId);

    if (b.stepRun) {
      const s = b.stepRun;
      const inserted = db.prepare(
        `INSERT INTO step_runs (task_id, step_id, attempt, status, exit_code,
                                started_at, ended_at, log_path, cost_usd, num_turns, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(b.taskId, s.step_id, s.attempt, s.status, s.exit_code,
            s.started_at, s.ended_at, s.log_path,
            s.cost_usd ?? null, s.num_turns ?? null, s.duration_ms ?? null);
      stepRunId = Number(inserted.lastInsertRowid);
    }

    if (b.stepRunUpdate) {
      const u = b.stepRunUpdate;
      db.prepare(
        `UPDATE step_runs SET status = ?, exit_code = ?, ended_at = ?,
                              cost_usd = ?, num_turns = ?, duration_ms = ?
         WHERE id = ?`,
      ).run(u.status, u.exit_code, u.ended_at,
            u.cost_usd ?? null, u.num_turns ?? null, u.duration_ms ?? null, u.id);
      stepRunId = u.id;
    }

    if (b.outputs) {
      const o = b.outputs;
      db.prepare(
        `INSERT INTO step_outputs (task_id, step_id, stdout, stderr, exit_code)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (task_id, step_id) DO UPDATE SET
           stdout = excluded.stdout, stderr = excluded.stderr, exit_code = excluded.exit_code`,
      ).run(b.taskId, o.step_id, tail(o.stdout), tail(o.stderr), o.exit_code);
    }
    db.exec("COMMIT");
    return stepRunId;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
