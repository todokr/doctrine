import type { PermissionDenial, StepRunDenials } from "../../../shared/protocol.ts";
import type { Db, StepRunStatus, TaskRow, TaskState } from "./schema.ts";

/** DBに残す出力の上限。ログ本文はファイル、DBは末尾だけ。 */
export const OUTPUT_TAIL_BYTES = 8192;

/** 1回の実行について残す拒否の件数。超えた分は捨て、件数だけ total に残す。 */
export const MAX_DENIALS = 20;
/** 拒否1件の入力に残す文字列の長さ。コマンドは先頭が要るので、tail() と違い先頭側を残す。 */
export const DENIAL_VALUE_CHARS = 2000;

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
  taskPatch: Partial<
    Pick<
      TaskRow,
      | "state"
      | "current_step_id"
      | "attempt_counts"
      | "worktree_path"
      | "claude_session_id"
      | "child_pid"
      | "child_started_at"
      | "resumed"
      | "pending_feed"
      | "rate_limited_until"
      | "waiting_until"
    >
  >;
  /** ステップ開始時: status "running" / ended_at null で挿入し、返り値の id を持っておく。 */
  stepRun?: {
    step_id: string;
    attempt: number;
    status: StepRunStatus;
    exit_code: number | null;
    started_at: string;
    ended_at: string | null;
    log_path: string;
    cost_usd?: number | null;
    num_turns?: number | null;
    duration_ms?: number | null;
    /** approval ステップのみ。suspended に入った時点の worktree 全体のツリー。 */
    review_tree?: string | null;
    /** status が "bounced" のときだけ渡す（差し戻し先のステップid）。 */
    goto_step_id?: string | null;
  };
  /**
   * poll の待ちから戻ったとき: 閉じた waiting の行を running に戻して使い直す。
   * 待ちの1周に1行にするため、新しい行は足さない。
   */
  stepRunReopen?: { id: number };
  /** ステップ終了時: 開始時の行を同じトランザクションで更新する。 */
  stepRunUpdate?: {
    id: number;
    status: StepRunStatus;
    exit_code: number | null;
    ended_at: string;
    cost_usd?: number | null;
    num_turns?: number | null;
    duration_ms?: number | null;
    /** status が "bounced" のときだけ渡す（差し戻し先のステップid）。 */
    goto_step_id?: string | null;
    /** 権限で拒否された操作。空・未指定なら列は NULL。DB に入れる前にここで削る。 */
    permission_denials?: PermissionDenial[];
  };
  /** ステップ開始時（agent ステップのみ）: そのロールのセッションを記録する。 */
  sessionUpsert?: { role: string; session_id: string };
  /**
   * そのロールの会話の記録を取り消す。最初の呼び出しが上限で弾かれたときだけ使う
   * （会話が作られたか分からないので、次は新しい session id で start し直す）。
   */
  sessionDelete?: { role: string };
  /**
   * ステップの出力。この境界で立てた（または閉じた）step_run に紐づく。
   * step_run も stepRunUpdate も無いのに outputs だけ渡すのは呼び出し側のバグ。
   */
  outputs?: { last_stdout: string; last_stderr: string; exit_code: number | null };
};

/** requireState と実際の状態が食い違った。書き込みは一切起きていない。 */
export class StateConflictError extends Error {
  constructor(
    readonly taskId: string,
    readonly expected: TaskState,
    readonly actual: TaskState | null,
  ) {
    super(
      `タスク ${taskId} の状態が変わっています（想定: ${expected}、実際: ${
        actual ?? "タスクなし"
      }）`,
    );
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

function head(s: string): string {
  return s.length > DENIAL_VALUE_CHARS ? s.slice(0, DENIAL_VALUE_CHARS) : s;
}

/** step_runs.permission_denials に入る文字列（形は protocol の StepRunDenials）。 */
export function denialsColumn(denials: PermissionDenial[]): string | null {
  if (denials.length === 0) return null;
  const kept: StepRunDenials = {
    total: denials.length,
    denials: denials.slice(0, MAX_DENIALS).map((d) => ({
      ...d,
      input: Object.fromEntries(
        Object.entries(d.input).map(([k, v]) => [k, typeof v === "string" ? head(v) : v]),
      ),
    })),
  };
  return JSON.stringify(kept);
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
          task_id: b.taskId,
          step_id: s.step_id,
          attempt: s.attempt,
          status: s.status,
          exit_code: s.exit_code,
          started_at: s.started_at,
          ended_at: s.ended_at,
          log_path: s.log_path,
          cost_usd: s.cost_usd ?? null,
          num_turns: s.num_turns ?? null,
          duration_ms: s.duration_ms ?? null,
          review_tree: s.review_tree ?? null,
          goto_step_id: s.goto_step_id ?? null,
        })
        .executeTakeFirstOrThrow();
      stepRunId = Number(inserted.insertId);
    }

    if (b.stepRunReopen) {
      // started_at は戻さない: この行が指す attempt は最初に waiting へ入ったときに始まっている。
      await trx.updateTable("step_runs")
        .set({ status: "running", ended_at: null, exit_code: null })
        .where("id", "=", b.stepRunReopen.id)
        .execute();
      stepRunId = b.stepRunReopen.id;
    }

    if (b.stepRunUpdate) {
      const u = b.stepRunUpdate;
      await trx.updateTable("step_runs")
        .set({
          status: u.status,
          exit_code: u.exit_code,
          ended_at: u.ended_at,
          cost_usd: u.cost_usd ?? null,
          num_turns: u.num_turns ?? null,
          duration_ms: u.duration_ms ?? null,
          goto_step_id: u.goto_step_id ?? null,
          permission_denials: denialsColumn(u.permission_denials ?? []),
        })
        .where("id", "=", u.id)
        .execute();
      stepRunId = u.id;
    }

    if (b.sessionUpsert) {
      const s = b.sessionUpsert;
      await trx.insertInto("task_sessions")
        .values({ task_id: b.taskId, role: s.role, session_id: s.session_id })
        .onConflict((oc) =>
          oc.columns(["task_id", "role"]).doUpdateSet((eb) => ({
            session_id: eb.ref("excluded.session_id"),
          }))
        )
        .execute();
    }

    if (b.sessionDelete) {
      await trx.deleteFrom("task_sessions")
        .where("task_id", "=", b.taskId)
        .where("role", "=", b.sessionDelete.role)
        .execute();
    }

    if (b.outputs) {
      if (stepRunId === null) {
        throw new Error(
          "outputs は step_run と一緒にしか書けません（どの実行の出力か決められません）",
        );
      }
      const o = b.outputs;
      await trx.insertInto("step_outputs")
        .values({
          step_run_id: stepRunId,
          last_stdout: tail(o.last_stdout),
          last_stderr: tail(o.last_stderr),
          exit_code: o.exit_code,
        })
        .onConflict((oc) =>
          oc.column("step_run_id").doUpdateSet((eb) => ({
            last_stdout: eb.ref("excluded.last_stdout"),
            last_stderr: eb.ref("excluded.last_stderr"),
            exit_code: eb.ref("excluded.exit_code"),
          }))
        )
        .execute();
    }
    return stepRunId;
  });
}
