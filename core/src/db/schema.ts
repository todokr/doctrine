import type { Generated, Kysely, Selectable } from "kysely";

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
  | "completed"
  | "failed"
  | "canceled";

export type StepRunStatus =
  | "running"
  | "awaiting"
  | "success"
  | "failed"
  | "degraded"
  | "interrupted"
  /** 利用上限で打ち切られた実行。同じ会話で再開されるので失敗ではない。 */
  | "rate_limited"
  /** 非0で終わった（却下された）が onFailure / onReject の goto で前のステップへ戻った。 */
  | "bounced";

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
  priority: Generated<number>;
  resumed: Generated<number>;
  created_at: string;
  updated_at: string;
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
   * degraded の行だけとは限らない（失敗・上限打ち切りの実行にも入り得る）。
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

export interface Database {
  projects: ProjectsTable;
  tasks: TasksTable;
  step_runs: StepRunsTable;
  step_outputs: StepOutputsTable;
  task_sessions: TaskSessionsTable;
  rate_limit_samples: RateLimitSamplesTable;
}

export type Db = Kysely<Database>;

export type ProjectRow = Selectable<ProjectsTable>;
export type TaskRow = Selectable<TasksTable>;
export type StepRunRow = Selectable<StepRunsTable>;
export type RateLimitRow = Selectable<RateLimitSamplesTable>;
