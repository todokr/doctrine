export type Request = { id: number; method: string; params?: Record<string, unknown> };

export type Response =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

export type ServerEvent =
  | { event: "task.stateChanged"; task_id: string; from: string; to: string }
  | { event: "stepRun.started"; task_id: string; step_run_id: number; step_id: string }
  | { event: "stepRun.finished"; task_id: string; step_run_id: number; step_id: string; status: string }
  | { event: "log.line"; task_id: string; step_run_id: number; line: string }
  | { event: "ratelimit.sample"; window: string; utilization: number; resets_at: string | null };
