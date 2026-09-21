import type { Pfd, Process } from "../../../../shared/intake/pfd.ts";
import type { PrFact, ProcessStatusEntry } from "../../../../shared/intake/processStatus.ts";
import type { TaskState } from "../../db/tasks.ts";

/** intake_processes の 1 行と、そこから引いたタスクと PR の事実。 */
export type ProcessProgress = {
  /** current_task_id のタスク。投入前は null。 */
  task: { id: string; state: TaskState } | null;
  /** そのタスクについて見張りが最後に観測した PR。未観測・PR 無しは null。 */
  pr: PrFact | null;
  subIssueUrl: string | null;
  /** 人のプロセスの完了の記録。 */
  humanDone: { note: string; at: string } | null;
};

export type StatusInput = {
  pfd: Pfd;
  baseBranch: string;
  revising: boolean;
  dispatchPaused: boolean;
  /** プロセスの id ごと。無いプロセスはすべて null として扱う。 */
  progress: ReadonlyMap<string, ProcessProgress>;
};

const noProgress: ProcessProgress = { task: null, pr: null, subIssueUrl: null, humanDone: null };

// 入力の成果物を見ずに決まる状態。決まらなければ null
function settledState(
  process: Process,
  progress: ProcessProgress,
  baseBranch: string,
): ProcessStatusEntry | null {
  const id = process.id;
  if (process.actor === "human") {
    return progress.humanDone ? { id, state: "done", ...progress.humanDone } : null;
  }
  const { task, pr } = progress;
  if (!task) return null;
  const taskId = task.id;
  if (pr) {
    if (pr.state === "MERGED" && pr.baseRef === baseBranch) {
      return { id, state: "merged", taskId, pr };
    }
    if (pr.state === "OPEN") return { id, state: "pr_open", taskId, pr };
    return { id, state: "needs_attention", taskId, reason: "pr_closed" };
  }
  if (task.state === "completed") {
    return { id, state: "needs_attention", taskId, reason: "no_pr" };
  }
  if (task.state === "failed" || task.state === "canceled") {
    return { id, state: "needs_attention", taskId, reason: "task_stopped" };
  }
  return { id, state: "running", taskId };
}

/** 外への問い合わせをしない。プロセスごとの状態を pfd.processes の順に返す。 */
export function computeProcessStatuses(input: StatusInput): ProcessStatusEntry[] {
  const { pfd } = input;
  const progressOf = (id: string) => input.progress.get(id) ?? noProgress;

  const settled = new Map<string, ProcessStatusEntry | null>(
    pfd.processes.map((p) => [p.id, settledState(p, progressOf(p.id), input.baseBranch)]),
  );

  // マージ済みのプロセスと完了した人のプロセスの出力だけが、given に加わる（PRD W-2）
  const available = new Set(pfd.artifacts.filter((a) => a.given).map((a) => a.id));
  for (const p of pfd.processes) {
    const state = settled.get(p.id)?.state;
    if (state === "merged" || state === "done") p.outputs.forEach((o) => available.add(o));
  }

  return pfd.processes.map((p) => {
    const decided = settled.get(p.id);
    if (decided) return decided;
    const missing = p.inputs.filter((i) => !available.has(i));
    if (missing.length > 0) return { id: p.id, state: "waiting", missing };
    if (p.actor === "human") return { id: p.id, state: "your_turn" };
    const blockedBy = input.revising
      ? "revising"
      : input.dispatchPaused
      ? "paused"
      : progressOf(p.id).subIssueUrl === null
      ? "no_sub_issue"
      : null;
    return { id: p.id, state: "ready", blockedBy };
  });
}
