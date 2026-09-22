/** poll ステップの終了コードの意味（spec 2026-09-22-merge-wait-design.md 3 章）。 */
export const POLL_WAIT = 75;
export const POLL_ABANDON = 2;

export type PollVerdict = "done" | "wait" | "abandon" | "failed";

export function pollVerdict(exitCode: number | null): PollVerdict {
  if (exitCode === 0) return "done";
  if (exitCode === POLL_WAIT) return "wait";
  if (exitCode === POLL_ABANDON) return "abandon";
  return "failed";
}
