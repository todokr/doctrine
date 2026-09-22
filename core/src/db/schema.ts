import type { Generated, Kysely, Selectable } from "kysely";
import type {
  IntakeRunPurpose,
  IntakeRunStatus,
  IntakeState,
} from "../../../shared/intake/state.ts";

/**
 * テーブルの形の唯一の定義（TypeScript 側）。クエリはすべてこの型に対して
 * 型検査される。DDL はマイグレーション（migrations.ts）が持ち、両者の整合は
 * test/db/migrate.test.ts が実DBの列集合と突き合わせて確かめる。
 *
 * Generated<> は「INSERT で省略できる（DEFAULT / AUTOINCREMENT がある）」列。
 */

export type TaskState =
  | "queued"
  | "running"
  | "suspended"
  | "paused"
  /** 利用上限に当たり、resetsAt まで待っている（2026-09-19-rate-limit-wait-design.md）。 */
  | "rate_limited"
  /** PR のマージを待っている（2026-09-22-merge-wait-design.md 3章）。 */
  | "waiting"
  | "completed"
  | "failed"
  | "canceled";

export type StepRunStatus =
  | "running"
  | "awaiting"
  | "success"
  | "failed"
  | "interrupted"
  /** 利用上限で打ち切られた実行。同じ会話で再開されるので失敗ではない。 */
  | "rate_limited"
  /** poll ステップが「まだ」と答えた待ちの1周（2026-09-22-merge-wait-design.md 3章）。 */
  | "waiting"
  /** 非0で終わった（却下された）が onFailure / onReject の goto で前のステップへ戻った。 */
  | "bounced";

export type { IntakeRunPurpose, IntakeRunStatus, IntakeState };

export type IntakeCommentTarget = "artifact" | "process" | "whole";

export type PrState = "OPEN" | "MERGED" | "CLOSED";

export interface ProjectsTable {
  id: Generated<number>;
  path: string;
  default_workflow: string;
  max_concurrent: Generated<number>;
  base_branch: Generated<string>;
  setup: string | null;
}

export interface TasksTable {
  id: string;
  project_id: number;
  title: string;
  prompt: string;
  workflow_name: string;
  state: TaskState;
  current_step_id: string | null;
  attempt_counts: Generated<string>;
  branch: string;
  worktree_path: string | null;
  claude_session_id: string | null;
  child_pid: number | null;
  child_started_at: string | null;
  pending_feed: string | null;
  /** state が rate_limited の間だけ入る、再開してよい時刻（ISO 8601）。 */
  rate_limited_until: string | null;
  /** state が waiting の間だけ入る、次に確かめる時刻（ISO 8601）。 */
  waiting_until: string | null;
  priority: Generated<number>;
  resumed: Generated<number>;
  created_at: string;
  updated_at: string;
  /** intake_id と intake_process_id は両方 null か両方非 null（0009 の CHECK）。 */
  intake_id: string | null;
  intake_process_id: string | null;
  /** このタスクが実装する sub-issue の URL。 */
  issue_url: string | null;
  parent_issue_url: string | null;
  /** 作成時のワークフロー YAML の中身。NULL は 0011 より前に作られた行で、ディスクの YAML で進む。 */
  workflow_yaml: string | null;
  /** 作成時の projects.setup。workflow_yaml が非 NULL の行で NULL なら、作成時に setup が無かった。 */
  workflow_setup: string | null;
}

export interface TaskSessionsTable {
  task_id: string;
  role: string;
  session_id: string;
}

export interface StepRunsTable {
  id: Generated<number>;
  task_id: string;
  step_id: string;
  attempt: number;
  status: StepRunStatus;
  exit_code: number | null;
  started_at: string;
  ended_at: string | null;
  log_path: string;
  cost_usd: number | null;
  num_turns: number | null;
  duration_ms: number | null;
  /** approval ステップで suspended に入った時点の worktree 全体のツリー（5章）。 */
  review_tree: string | null;
  /**
   * 差し戻し先のステップid。status が bounced の行では必ず非 null、それ以外の
   * status では常に null（「分岐しなかった」ことをこの null が表す）。この対応は
   * DB の CHECK 制約でも固めてある（0005_step_run_bounced）。
   */
  goto_step_id: string | null;
  /**
   * 権限で拒否された操作（JSON 文字列の { total, denials }）。拒否が無かった実行は NULL。
   * success / failed / rate_limited のどの行にも入り得る。
   */
  permission_denials: string | null;
}

/**
 * ステップ実行1回ぶんの出力。`last_` はこの行が最後という意味ではなく、
 * テンプレート変数 `{{ steps.<id>.last_stdout }}` がステップの**最新の実行**の
 * 行を引く、という読み出し側の規約を指す。
 */
export interface StepOutputsTable {
  step_run_id: number;
  last_stdout: string;
  last_stderr: string;
  exit_code: number | null;
}

export interface RateLimitSamplesTable {
  id: Generated<number>;
  observed_at: string;
  window: string;
  utilization: number;
  resets_at: string | null;
}

/**
 * JSON の列（attention_reason・questions・answers・pfd・replies・output・issues）は
 * 文字列のまま持つ。中身の型は shared/intake/ が定義し、この層は形を知らない。
 */
export interface IntakesTable {
  id: string;
  project_id: number;
  issue_url: string;
  issue_node_id: string;
  issue_title: string;
  state: IntakeState;
  /** 0/1。1 は承認済みの計画があり、改訂の中にいること。 */
  revising: Generated<number>;
  attention_reason: string | null;
  dispatch_paused: Generated<number>;
  worktree_path: string | null;
  claude_session_id: string | null;
  child_pid: number | null;
  child_started_at: string | null;
  rate_limited_until: string | null;
  /** 今の改訂の最初の revise 実行。改訂中でなければ null。 */
  revision_run_id: number | null;
  created_at: string;
  updated_at: string;
  ended_at: string | null;
}

export interface IntakeRunsTable {
  id: Generated<number>;
  intake_id: string;
  purpose: IntakeRunPurpose;
  attempt: number;
  status: IntakeRunStatus;
  /** queued の間は null。 */
  started_at: string | null;
  ended_at: string | null;
  log_path: string;
  cost_usd: number | null;
  num_turns: number | null;
  duration_ms: number | null;
  /** 検証を通った出力の JSON。 */
  output: string | null;
  /** 検証に落ちた理由（string[] の JSON）。 */
  issues: string | null;
  permission_denials: string | null;
}

export interface IntakeQuestionSetsTable {
  id: Generated<number>;
  intake_id: string;
  run_id: number;
  questions: string;
  /** 回答前は null。 */
  answers: string | null;
  created_at: string;
  answered_at: string | null;
}

export interface IntakeDraftsTable {
  id: Generated<number>;
  intake_id: string;
  /** Intake ごとに 1 から。 */
  seq: number;
  run_id: number;
  /** 正規化した PFD の JSON。書いたら変えない。 */
  pfd: string;
  /** pfd の文字列の SHA-256（16 進）。 */
  hash: string;
  /** コメントへの返答の JSON。無ければ "[]"。 */
  replies: string;
  created_at: string;
}

export interface IntakeCommentsTable {
  id: Generated<number>;
  intake_id: string;
  draft_id: number;
  target_kind: IntakeCommentTarget;
  /** whole のときだけ null（0009 の CHECK）。 */
  target_id: string | null;
  body: string;
  /** 改訂の開始コメントだけが、その改訂の最初の実行を指す。差し戻しのコメントは null。 */
  run_id: number | null;
  created_at: string;
}

export interface IntakeApprovalsTable {
  id: Generated<number>;
  intake_id: string;
  draft_id: number;
  hash: string;
  approved_at: string;
}

export interface IntakeProcessesTable {
  intake_id: string;
  process_id: string;
  sub_issue_url: string | null;
  sub_issue_node_id: string | null;
  /** sub-issue の本文を最後に揃えた内容のハッシュ。 */
  sub_issue_hash: string | null;
  sub_issue_closed: Generated<number>;
  current_task_id: string | null;
  human_note: string | null;
  human_done_at: string | null;
  /** 改訂で計画から消えた時刻。行は消さない。 */
  retired_at: string | null;
}

export interface PrObservationsTable {
  task_id: string;
  pr_number: number;
  pr_url: string;
  state: PrState;
  base_ref: string;
  merged_at: string | null;
  merge_commit: string | null;
  observed_at: string;
}

export interface Database {
  projects: ProjectsTable;
  tasks: TasksTable;
  step_runs: StepRunsTable;
  step_outputs: StepOutputsTable;
  task_sessions: TaskSessionsTable;
  rate_limit_samples: RateLimitSamplesTable;
  intakes: IntakesTable;
  intake_runs: IntakeRunsTable;
  intake_question_sets: IntakeQuestionSetsTable;
  intake_drafts: IntakeDraftsTable;
  intake_comments: IntakeCommentsTable;
  intake_approvals: IntakeApprovalsTable;
  intake_processes: IntakeProcessesTable;
  pr_observations: PrObservationsTable;
}

export type Db = Kysely<Database>;

export type ProjectRow = Selectable<ProjectsTable>;
export type TaskRow = Selectable<TasksTable>;
export type StepRunRow = Selectable<StepRunsTable>;
export type RateLimitRow = Selectable<RateLimitSamplesTable>;
export type IntakeRow = Selectable<IntakesTable>;
export type IntakeRunRow = Selectable<IntakeRunsTable>;
export type IntakeQuestionSetRow = Selectable<IntakeQuestionSetsTable>;
export type IntakeDraftRow = Selectable<IntakeDraftsTable>;
export type IntakeCommentRow = Selectable<IntakeCommentsTable>;
export type IntakeApprovalRow = Selectable<IntakeApprovalsTable>;
export type IntakeProcessRow = Selectable<IntakeProcessesTable>;
export type PrObservationRow = Selectable<PrObservationsTable>;
