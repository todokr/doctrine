// spec 3 章は PrFact を core/src/tracker/tracker.ts に置くと書いているが、
// IntakeDetail.processes でアプリへ渡るので shared に置く。tracker.ts はここから import する。
export type PrFact = {
  number: number;
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  baseRef: string;
  mergedAt: string | null;
  mergeCommit: string | null;
};

export type ProcessStatus =
  // 入力待ち。missing は揃っていない入力の成果物の id
  | { state: "waiting"; missing: string[] }
  // 着手可能
  | { state: "ready"; blockedBy: "revising" | "paused" | "no_sub_issue" | null }
  // 実行中
  | { state: "running"; taskId: string }
  // PR レビュー中
  | { state: "pr_open"; taskId: string; pr: PrFact }
  // マージ済み
  | { state: "merged"; taskId: string; pr: PrFact }
  // あなたの番
  | { state: "your_turn" }
  // 完了（人）
  | { state: "done"; note: string; at: string }
  // 要確認
  | { state: "needs_attention"; taskId: string; reason: "task_stopped" | "no_pr" | "pr_closed" };

/** プロセスの id と状態の組。IntakeDetail.processes の元になる。 */
export type ProcessStatusEntry = { id: string } & ProcessStatus;
