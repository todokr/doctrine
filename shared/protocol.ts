export type Request = { id: number; method: string; params?: Record<string, unknown> };

export type Response =
  | { id: number; ok: true; result: unknown }
  | { id: number | null; ok: false; error: string };

export type ServerEvent =
  | { event: "task.stateChanged"; task_id: string; from: string; to: string }
  | { event: "stepRun.started"; task_id: string; step_run_id: number; step_id: string }
  | {
    event: "stepRun.finished";
    task_id: string;
    step_run_id: number;
    step_id: string;
    status: string;
  }
  | { event: "log.line"; task_id: string; step_run_id: number; line: string }
  | {
    event: "task.cleanedUp";
    task_id: string;
    /** removed = worktree を消した / refused = 消さずに残した（理由は warning） */
    outcome: "removed" | "refused";
    worktree_path: string | null;
    warning?: string;
  }
  | { event: "daemon.warning"; at: string; message: string; task_id?: string }
  | { event: "ratelimit.sample"; window: string; utilization: number; resets_at: string | null };

export type TaskState =
  | "queued"
  | "running"
  | "suspended"
  | "paused"
  | "completed"
  | "failed"
  | "canceled";

/**
 * task.* が返すタスク1件。デーモンは DB の行をそのまま返すので実際には
 * これより多くの列が載るが、UI に見せてよいのはここに書いた分だけである。
 */
export type TaskSummary = {
  id: string;
  project_id: number;
  title: string;
  prompt: string;
  workflow_name: string;
  state: TaskState;
  current_step_id: string | null;
  branch: string;
  worktree_path: string | null;
  priority: number;
  created_at: string;
  updated_at: string;
};

/** task.list だけが has_degraded を持つ（approve / reject / cancel は行をそのまま返す）。 */
export type TaskListEntry = TaskSummary & { has_degraded: boolean };

/** task.get が返すステップ実行1回ぶん。step_runs の行のうち UI に見せる分。 */
export type StepRun = {
  id: number;
  step_id: string;
  attempt: number;
  status: "running" | "awaiting" | "success" | "failed" | "degraded" | "interrupted";
  exit_code: number | null;
  started_at: string;
  ended_at: string | null;
};

export type TaskDetail = { task: TaskSummary; stepRuns: StepRun[] };

export type TaskLogs = { step_run_id: number | null; log_path: string | null; lines: string[] };

/** daemon.warnings が返す1件。イベントの daemon.warning と同じ形。 */
export type Warning = { at: string; message: string; task_id?: string };

export type ProjectSummary = {
  id: number;
  path: string;
  default_workflow: string;
  max_concurrent: number;
  base_branch: string;
  setup: string | null;
};

/**
 * UI が呼ぶメソッドの表。増えたらここに足す。Rust の中継はこの表を知らない
 * （method を素通しするだけ）。
 */
export type Methods = {
  "task.list": { params: { project?: string; state?: TaskState }; result: TaskListEntry[] };
  "project.list": { params: Record<string, never>; result: ProjectSummary[] };
  "task.approve": { params: { task_id: string }; result: TaskSummary };
  "task.reject": { params: { task_id: string; comment: string }; result: TaskSummary };
  "task.cancel": { params: { task_id: string }; result: TaskSummary };
  "task.get": { params: { task_id: string }; result: TaskDetail };
  /**
   * step_run_id を省くと最新のステップ実行の末尾を返す。follow は接続の追従先を
   * 指定したタスクへ移し、false で追従をやめる（1接続につき1タスク）。
   */
  "task.logs": {
    params: { task_id: string; step_run_id?: number; tail?: number; follow?: boolean };
    result: TaskLogs;
  };
  "daemon.warnings": { params: Record<string, never>; result: Warning[] };
};

export type Method = keyof Methods;
export type ParamsOf<M extends Method> = Methods[M]["params"];
export type ResultOf<M extends Method> = Methods[M]["result"];
