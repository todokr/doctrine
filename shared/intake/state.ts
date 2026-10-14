/** Intake の状態と遷移は 2026-09-21-intake-core-design.md 5 章。 */
export type IntakeState =
  | "investigating"
  | "answering"
  | "decomposing"
  | "reviewing"
  | "active"
  | "needs_attention"
  | "completed"
  | "canceled";

export type IntakeRunPurpose = "investigate" | "decompose" | "revise";

export type IntakeRunStatus =
  | "queued"
  | "running"
  | "success"
  | "failed"
  | "rate_limited"
  | "interrupted";

/** 取り込みの種類（spec 2026-10-14-intake-execution-design.md 4.2）。direct は PFD を作らずタスクを 1 本流す。 */
export type IntakeMode = "plan" | "direct";
