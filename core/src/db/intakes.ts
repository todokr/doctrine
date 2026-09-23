import { sql } from "kysely";
import type {
  Db,
  IntakeApprovalRow,
  IntakeCommentRow,
  IntakeCommentTarget,
  IntakeDraftRow,
  IntakeProcessRow,
  IntakeQuestionSetRow,
  IntakeRow,
  IntakeRunPurpose,
  IntakeRunRow,
  IntakeRunStatus,
  IntakeState,
  PrObservationRow,
  TaskRow,
} from "./schema.ts";

export type {
  IntakeApprovalRow,
  IntakeCommentRow,
  IntakeCommentTarget,
  IntakeDraftRow,
  IntakeProcessRow,
  IntakeQuestionSetRow,
  IntakeRow,
  IntakeRunPurpose,
  IntakeRunRow,
  IntakeRunStatus,
  IntakeState,
  PrObservationRow,
  PrState,
} from "./schema.ts";

/**
 * JSON の列は呼び出し側が文字列にして渡す（この層は中身の形を知らない）。
 * 関数の中で db.transaction() を開かない。呼び出し側がトランザクションの trx を渡せるよう、
 * どの関数も 1 文で済む形にしてある。
 */

export type NewIntake = {
  id: string;
  project_id: number;
  issue_url: string;
  issue_node_id: string;
  issue_title: string;
};

/** state は investigating で作る（PRD 8 章の開始）。同じ Issue の終わっていない Intake があれば例外。 */
export async function insertIntake(db: Db, i: NewIntake): Promise<IntakeRow> {
  const now = new Date().toISOString();
  await db.insertInto("intakes")
    .values({ ...i, state: "investigating", created_at: now, updated_at: now })
    .execute();
  return (await getIntake(db, i.id))!;
}

export function getIntake(db: Db, id: string): Promise<IntakeRow | undefined> {
  return db.selectFrom("intakes").selectAll().where("id", "=", id).executeTakeFirst();
}

/** 終わっていない（completed / canceled 以外の）Intake。intake.start が同じ Issue の二重開始を断るのに使う。 */
export function findOpenIntakeByIssue(
  db: Db,
  issueUrl: string,
): Promise<IntakeRow | undefined> {
  return db.selectFrom("intakes").selectAll()
    .where("issue_url", "=", issueUrl)
    .where("state", "not in", ["completed", "canceled"])
    .executeTakeFirst();
}

/** includeClosed が false（既定）なら completed / canceled を除く。 */
export function listIntakes(
  db: Db,
  filter: { projectId?: number; includeClosed?: boolean } = {},
): Promise<IntakeRow[]> {
  return db.selectFrom("intakes").selectAll()
    .$if(filter.projectId !== undefined, (q) => q.where("project_id", "=", filter.projectId!))
    .$if(!filter.includeClosed, (q) => q.where("state", "not in", ["completed", "canceled"]))
    .orderBy("created_at").orderBy("id")
    .execute();
}

export type IntakePatch = Partial<
  Pick<
    IntakeRow,
    | "state"
    | "revising"
    | "attention_reason"
    | "dispatch_paused"
    | "worktree_path"
    | "claude_session_id"
    | "child_pid"
    | "child_started_at"
    | "rate_limited_until"
    | "revision_run_id"
    | "ended_at"
  >
>;

/** requireState と実際の状態が食い違った。書き込みは一切起きていない。 */
export class IntakeStateConflictError extends Error {
  constructor(
    readonly intakeId: string,
    readonly expected: IntakeState,
    readonly actual: IntakeState | null,
  ) {
    super(
      `Intake ${intakeId} の状態が変わっています（想定: ${expected}、実際: ${
        actual ?? "Intake なし"
      }）`,
    );
    this.name = "IntakeStateConflictError";
  }
}

/**
 * updated_at を進めて patch を書く。requireState を渡すと、その状態のときだけ書き、
 * 違えば何も書かずに IntakeStateConflictError を投げる（boundary.ts の requireState と同じ）。
 * 遷移の正しさは確かめない。呼び出し側が domain/intakeStates.ts の assertIntakeTransition で確かめる。
 */
export async function updateIntake(
  db: Db,
  id: string,
  patch: IntakePatch,
  opts: { requireState?: IntakeState } = {},
): Promise<void> {
  const { requireState } = opts;
  const updated = await db.updateTable("intakes")
    .set({ ...patch, updated_at: new Date().toISOString() })
    .where("id", "=", id)
    .$if(requireState !== undefined, (q) => q.where("state", "=", requireState!))
    .executeTakeFirstOrThrow();
  if (requireState !== undefined && updated.numUpdatedRows === 0n) {
    const actual = await db.selectFrom("intakes").select("state")
      .where("id", "=", id).executeTakeFirst();
    throw new IntakeStateConflictError(id, requireState, actual?.state ?? null);
  }
}

export type NewIntakeRun = {
  intake_id: string;
  purpose: IntakeRunPurpose;
  attempt: number;
  status: IntakeRunStatus;
  started_at: string | null;
  log_path: string;
};

export async function insertIntakeRun(db: Db, r: NewIntakeRun): Promise<number> {
  const inserted = await db.insertInto("intake_runs").values(r).executeTakeFirstOrThrow();
  return Number(inserted.insertId);
}

export type IntakeRunPatch = Partial<
  Pick<
    IntakeRunRow,
    | "status"
    | "started_at"
    | "ended_at"
    | "cost_usd"
    | "num_turns"
    | "duration_ms"
    | "output"
    | "issues"
    | "permission_denials"
  >
>;

export async function updateIntakeRun(db: Db, id: number, patch: IntakeRunPatch): Promise<void> {
  await db.updateTable("intake_runs").set(patch).where("id", "=", id).execute();
}

export function getIntakeRun(db: Db, id: number): Promise<IntakeRunRow | undefined> {
  return db.selectFrom("intake_runs").selectAll().where("id", "=", id).executeTakeFirst();
}

/** id の昇順。検証落ちの連続を数える側は新しい順に読み直す。 */
export function listIntakeRuns(db: Db, intakeId: string): Promise<IntakeRunRow[]> {
  return db.selectFrom("intake_runs").selectAll().where("intake_id", "=", intakeId)
    .orderBy("id").execute();
}

export async function insertQuestionSet(
  db: Db,
  q: { intake_id: string; run_id: number; questions: string; assumptions: string },
): Promise<number> {
  const inserted = await db.insertInto("intake_question_sets")
    .values({ ...q, created_at: new Date().toISOString() })
    .executeTakeFirstOrThrow();
  return Number(inserted.insertId);
}

/** 回答は一度だけ書く（追記だけの原則）。すでに回答があれば書かずに false を返す。 */
export async function answerQuestionSet(
  db: Db,
  id: number,
  reply: { answers: string; assumption_responses: string },
): Promise<boolean> {
  const updated = await db.updateTable("intake_question_sets")
    .set({ ...reply, answered_at: new Date().toISOString() })
    .where("id", "=", id)
    .where("answers", "is", null)
    .executeTakeFirstOrThrow();
  return updated.numUpdatedRows > 0n;
}

export function listQuestionSets(db: Db, intakeId: string): Promise<IntakeQuestionSetRow[]> {
  return db.selectFrom("intake_question_sets").selectAll().where("intake_id", "=", intakeId)
    .orderBy("id").execute();
}

/**
 * seq は Intake ごとの最大値 + 1 を同じ INSERT の副問い合わせで振る。読んでから書く 2 文に
 * すると、トランザクションを開かない作りでは同時の挿入と競合する。UNIQUE (intake_id, seq) が最後の砦。
 */
export async function insertDraft(
  db: Db,
  d: { intake_id: string; run_id: number; pfd: string; hash: string; replies: string },
): Promise<IntakeDraftRow> {
  const inserted = await db.insertInto("intake_drafts")
    .values({
      ...d,
      seq: sql<
        number
      >`(SELECT COALESCE(MAX(seq), 0) + 1 FROM intake_drafts WHERE intake_id = ${d.intake_id})`,
      created_at: new Date().toISOString(),
    })
    .executeTakeFirstOrThrow();
  return (await getDraft(db, Number(inserted.insertId)))!;
}

export function getDraft(db: Db, id: number): Promise<IntakeDraftRow | undefined> {
  return db.selectFrom("intake_drafts").selectAll().where("id", "=", id).executeTakeFirst();
}

/** seq が最大の案。承認で「最新の案か」を確かめるのに使う。 */
export function latestDraft(db: Db, intakeId: string): Promise<IntakeDraftRow | undefined> {
  return db.selectFrom("intake_drafts").selectAll().where("intake_id", "=", intakeId)
    .orderBy("seq", "desc").executeTakeFirst();
}

export function listDrafts(db: Db, intakeId: string): Promise<IntakeDraftRow[]> {
  return db.selectFrom("intake_drafts").selectAll().where("intake_id", "=", intakeId)
    .orderBy("seq").execute();
}

export type NewIntakeComment = {
  target_kind: IntakeCommentTarget;
  target_id: string | null;
  body: string;
};

/**
 * 差し戻し 1 回ぶんのコメントを 1 文でまとめて挿入する。空配列なら何もしない。
 * runId は改訂の開始コメントのときだけ、その改訂の最初の実行の id を渡す。
 */
export async function insertComments(
  db: Db,
  intakeId: string,
  draftId: number,
  comments: NewIntakeComment[],
  runId: number | null,
): Promise<void> {
  if (comments.length === 0) return;
  const now = new Date().toISOString();
  await db.insertInto("intake_comments")
    .values(
      comments.map((c) => ({
        ...c,
        intake_id: intakeId,
        draft_id: draftId,
        run_id: runId,
        created_at: now,
      })),
    )
    .execute();
}

export function listComments(db: Db, intakeId: string): Promise<IntakeCommentRow[]> {
  return db.selectFrom("intake_comments").selectAll().where("intake_id", "=", intakeId)
    .orderBy("id").execute();
}

export async function insertApproval(
  db: Db,
  a: { intake_id: string; draft_id: number; hash: string },
): Promise<number> {
  const inserted = await db.insertInto("intake_approvals")
    .values({ ...a, approved_at: new Date().toISOString() })
    .executeTakeFirstOrThrow();
  return Number(inserted.insertId);
}

export function latestApproval(
  db: Db,
  intakeId: string,
): Promise<IntakeApprovalRow | undefined> {
  return db.selectFrom("intake_approvals").selectAll().where("intake_id", "=", intakeId)
    .orderBy("id", "desc").executeTakeFirst();
}

/** 承認のときに案のプロセスを挿入する。空配列なら何もしない。 */
export async function insertProcesses(
  db: Db,
  intakeId: string,
  processIds: string[],
): Promise<void> {
  if (processIds.length === 0) return;
  await db.insertInto("intake_processes")
    .values(processIds.map((process_id) => ({ intake_id: intakeId, process_id })))
    .execute();
}

/** 改訂で案から消えたプロセスの行に retired_at を入れる。生きた行だけ。空配列なら何もしない。 */
export async function retireProcesses(
  db: Db,
  intakeId: string,
  processIds: string[],
  at: string,
): Promise<void> {
  if (processIds.length === 0) return;
  await db.updateTable("intake_processes").set({ retired_at: at })
    .where("intake_id", "=", intakeId)
    .where("process_id", "in", processIds)
    .where("retired_at", "is", null)
    .execute();
}

/** retired を含む。process_id の順。 */
export function listProcesses(db: Db, intakeId: string): Promise<IntakeProcessRow[]> {
  return db.selectFrom("intake_processes").selectAll().where("intake_id", "=", intakeId)
    .orderBy("process_id").execute();
}

export type IntakeProcessPatch = Partial<
  Pick<
    IntakeProcessRow,
    | "sub_issue_url"
    | "sub_issue_node_id"
    | "sub_issue_hash"
    | "sub_issue_closed"
    | "human_note"
    | "human_done_at"
    | "retired_at"
  >
>;

export async function updateProcess(
  db: Db,
  intakeId: string,
  processId: string,
  patch: IntakeProcessPatch,
): Promise<void> {
  await db.updateTable("intake_processes").set(patch)
    .where("intake_id", "=", intakeId)
    .where("process_id", "=", processId)
    .execute();
}

/**
 * 人のプロセスの完了を記録する。生きた行で、まだ記録が無いときだけ書く。
 * 書けなければ false（二重の記録・取りやめになった行）。
 */
export async function recordHumanDone(
  db: Db,
  intakeId: string,
  processId: string,
  o: { note: string; at: string },
): Promise<boolean> {
  const updated = await db.updateTable("intake_processes")
    .set({ human_note: o.note, human_done_at: o.at })
    .where("intake_id", "=", intakeId)
    .where("process_id", "=", processId)
    .where("human_done_at", "is", null)
    .where("retired_at", "is", null)
    .executeTakeFirstOrThrow();
  return updated.numUpdatedRows > 0n;
}

/**
 * current_task_id を expected から next へ置き換える比較付きの更新（二重投入の防止）。
 * 今の値が expected でなければ書かずに false を返す。expected が null なら IS NULL で比べる。
 */
export async function replaceCurrentTask(
  db: Db,
  intakeId: string,
  processId: string,
  expected: string | null,
  next: string,
): Promise<boolean> {
  const updated = await db.updateTable("intake_processes")
    .set({ current_task_id: next })
    .where("intake_id", "=", intakeId)
    .where("process_id", "=", processId)
    .where("current_task_id", expected === null ? "is" : "=", expected)
    .executeTakeFirstOrThrow();
  return updated.numUpdatedRows > 0n;
}

/** その Intake から投入されたタスクのうち、終端でないもの。再投入で current_task_id から外れたタスクも含む。 */
export function listLiveIntakeTasks(db: Db, intakeId: string): Promise<TaskRow[]> {
  return db.selectFrom("tasks").selectAll().where("intake_id", "=", intakeId)
    .where("state", "not in", ["completed", "failed", "canceled"])
    .orderBy("created_at").execute();
}

/** task_id ごとに最新の事実だけを持つ。observed_at は関数の中で入れる。 */
export async function upsertPrObservation(
  db: Db,
  o: Omit<PrObservationRow, "observed_at">,
): Promise<void> {
  await db.insertInto("pr_observations")
    .values({ ...o, observed_at: new Date().toISOString() })
    .onConflict((oc) =>
      oc.column("task_id").doUpdateSet((eb) => ({
        pr_number: eb.ref("excluded.pr_number"),
        pr_url: eb.ref("excluded.pr_url"),
        state: eb.ref("excluded.state"),
        base_ref: eb.ref("excluded.base_ref"),
        merged_at: eb.ref("excluded.merged_at"),
        merge_commit: eb.ref("excluded.merge_commit"),
        observed_at: eb.ref("excluded.observed_at"),
      }))
    )
    .execute();
}

export function getPrObservation(
  db: Db,
  taskId: string,
): Promise<PrObservationRow | undefined> {
  return db.selectFrom("pr_observations").selectAll().where("task_id", "=", taskId)
    .executeTakeFirst();
}
