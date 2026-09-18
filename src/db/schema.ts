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
  | "completed"
  | "failed"
  | "canceled";

export type StepRunStatus =
  | "running"
  | "awaiting"
  | "success"
  | "failed"
  | "degraded"
  | "interrupted";

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
}

export interface StepOutputsTable {
  step_run_id: number;
  stdout: string;
  stderr: string;
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
