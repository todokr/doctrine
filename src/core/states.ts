import type { TaskState } from "../db/tasks.ts";

const TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  queued: ["running", "paused", "canceled"],
  running: ["suspended", "paused", "completed", "failed", "canceled", "queued"],
  suspended: ["queued", "canceled", "failed"],
  paused: ["queued", "canceled"],
  completed: [],
  failed: [],
  canceled: [],
};

export class InvalidTransitionError extends Error {
  constructor(from: TaskState, to: TaskState) {
    super(`不正な状態遷移です: ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export function canTransition(from: TaskState, to: TaskState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: TaskState, to: TaskState): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

/** 全体枠の理由はマシン負荷とAPIコスト。人を待っている間は何も消費していない。 */
export function holdsGlobalSlot(s: TaskState): boolean {
  return s === "running";
}

/**
 * プロジェクト枠の理由は同一リポジトリでのマージ困難。
 * suspended / paused のタスクは worktree とブランチを生かしたままなので、理由が消えていない。
 */
export function holdsProjectSlot(s: TaskState): boolean {
  return s === "running" || s === "suspended" || s === "paused";
}

export function isTerminal(s: TaskState): boolean {
  return s === "completed" || s === "failed" || s === "canceled";
}
