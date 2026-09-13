import type { Db, StepRunStatus, TaskRow, TaskState } from "./schema.ts";

/** DBに残す出力の上限。ログ本文はファイル、DBは末尾だけ。 */
export const OUTPUT_TAIL_BYTES = 8192;

export type StepBoundary = {
  taskId: string;
  /**
   * 指定すると、タスクがこの状態のときだけ書く。違えば何も書かずに
   * StateConflictError を投げる（トランザクションごと巻き戻る）。
   *
   * 「状態を読んで判断し、書く」経路は、読んでから書くまでの間に await がある限り、
   * その隙に task.cancel / task.pause などが別の状態を書き得る。読んだ値を
   * ここに渡すと、その確認が書き込みと同じトランザクションの中で行われるので、
   * 後から来た書き込みを黙って上書きしない。
   */
  requireState?: TaskState;
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
  /** ステップ開始時（agent ステップのみ）: そのロールのセッションを記録する。 */
  sessionUpsert?: { role: string; session_id: string };
  outputs?: { step_id: string; stdout: string; stderr: string; exit_code: number | null };
};

/** requireState と実際の状態が食い違った。書き込みは一切起きていない。 */
export class StateConflictError extends Error {
  constructor(
    readonly taskId: string,
    readonly expected: TaskState,
    readonly actual: TaskState | null,
  ) {
    super(`タスク ${taskId} の状態が変わっています（想定: ${expected}、実際: ${actual ?? "タスクなし"}）`);
    this.name = "StateConflictError";
  }
}

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
 *
 * トランザクションの間は接続を占有する（dialect.ts）ので、この関数の途中に
 * 他の非同期処理のクエリが割り込むことはない。
 */
export function commitStepBoundary(db: Db, b: StepBoundary): Promise<number | null> {
  return db.transaction().execute(async (trx) => {
    let stepRunId: number | null = null;

    const updated = await trx.updateTable("tasks")
      .set({ ...b.taskPatch, updated_at: new Date().toISOString() })
      .where("id", "=", b.taskId)
      .$if(b.requireState !== undefined, (q) => q.where("state", "=", b.requireState!))
      .executeTakeFirstOrThrow();
    if (b.requireState !== undefined && updated.numUpdatedRows === 0n) {
      const actual = await trx.selectFrom("tasks").select("state")
        .where("id", "=", b.taskId).executeTakeFirst();
      throw new StateConflictError(b.taskId, b.requireState, actual?.state ?? null);
    }

    if (b.stepRun) {
      const s = b.stepRun;
      const inserted = await trx.insertInto("step_runs")
        .values({
          task_id: b.taskId, step_id: s.step_id, attempt: s.attempt, status: s.status,
          exit_code: s.exit_code, started_at: s.started_at, ended_at: s.ended_at, log_path: s.log_path,
          cost_usd: s.cost_usd ?? null, num_turns: s.num_turns ?? null, duration_ms: s.duration_ms ?? null,
        })
        .executeTakeFirstOrThrow();
      stepRunId = Number(inserted.insertId);
    }

    if (b.stepRunUpdate) {
      const u = b.stepRunUpdate;
      await trx.updateTable("step_runs")
        .set({
          status: u.status, exit_code: u.exit_code, ended_at: u.ended_at,
          cost_usd: u.cost_usd ?? null, num_turns: u.num_turns ?? null, duration_ms: u.duration_ms ?? null,
        })
        .where("id", "=", u.id)
        .execute();
      stepRunId = u.id;
    }

    if (b.sessionUpsert) {
      const s = b.sessionUpsert;
      await trx.insertInto("task_sessions")
        .values({ task_id: b.taskId, role: s.role, session_id: s.session_id })
        .onConflict((oc) => oc.columns(["task_id", "role"]).doUpdateSet((eb) => ({
          session_id: eb.ref("excluded.session_id"),
        })))
        .execute();
    }

    if (b.outputs) {
      const o = b.outputs;
      await trx.insertInto("step_outputs")
        .values({
          task_id: b.taskId, step_id: o.step_id,
          stdout: tail(o.stdout), stderr: tail(o.stderr), exit_code: o.exit_code,
        })
        .onConflict((oc) => oc.columns(["task_id", "step_id"]).doUpdateSet((eb) => ({
          stdout: eb.ref("excluded.stdout"),
          stderr: eb.ref("excluded.stderr"),
          exit_code: eb.ref("excluded.exit_code"),
        })))
        .execute();
    }
    return stepRunId;
  });
}
