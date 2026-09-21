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
