import type { TaskState } from "../db/tasks.ts";

const TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  /** ワークフローが読めなければ、ステップを1つも実行せずに failed になれる。running を経由すると、ステップ実行を記録することになり嘘になる。 */
  queued: ["running", "paused", "canceled", "failed"],
  running: [
    "suspended",
    "paused",
    "completed",
    "failed",
    "canceled",
    "queued",
    "rate_limited",
    "waiting",
  ],
  /** 解放（tick）と task.resume が queued へ戻す。paused / canceled は人の操作、failed は tick の例外経路。 */
  rate_limited: ["queued", "paused", "canceled", "failed"],
  /** poll ステップが「まだ」と答えた。解放（tick）と task.resume が queued へ戻す。 */
  waiting: ["queued", "paused", "canceled", "failed"],
  /** 最後のステップが approval で、承認されて次のステップが無いとき completed になる。
      queued を経由させて次に何も無いことをスケジューラに発見させるのは、
      待つ理由が無いのに一瞬枠を再取得させ、実態のない queued を記録することになる。 */
  suspended: ["queued", "canceled", "failed", "completed"],
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
 * suspended / paused / rate_limited / waiting のタスクは worktree とブランチを生かしたままなので、理由が消えていない。
 */
export function holdsProjectSlot(s: TaskState): boolean {
  return s === "running" || s === "suspended" || s === "paused" || s === "rate_limited" ||
    s === "waiting";
}

export function isTerminal(s: TaskState): boolean {
  return s === "completed" || s === "failed" || s === "canceled";
}
