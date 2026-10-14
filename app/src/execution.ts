// Execution のビューの導出。副作用を持たない（テストは execution.test.ts）
import type { IntakeSummary } from "../../shared/protocol.ts";
import { isClosedIntake, visibleIntakes } from "./intake";
import type { Task, WorkspaceFilter } from "./types";

export type ExecutionSection = "active" | "closed";

/** Execution の一覧に並ぶか。承認後と改訂中と終端。承認前に中止したものも終端に入る */
export function inExecution(i: IntakeSummary): boolean {
  return i.state === "active" || i.revising || isClosedIntake(i.state);
}

export function executionSection(i: IntakeSummary): ExecutionSection {
  return isClosedIntake(i.state) ? "closed" : "active";
}

/**
 * 人の番があるか。needs_human は承認前の判断も含むので active のときだけ見る。
 * タスクの承認待ちは needs_human に入らないので、タスクの一覧から足す
 */
export function isExecutionAttention(i: IntakeSummary, tasks: readonly Task[]): boolean {
  if (!inExecution(i) || executionSection(i) === "closed") return false;
  return (i.state === "active" && i.needs_human) ||
    tasks.some((t) => t.intake?.id === i.id && t.state === "suspended");
}

/** Rail の点。絞り込みに関係なく全 workspace を数える */
export function countExecutionAttention(intakes: readonly IntakeSummary[], tasks: readonly Task[]): number {
  return intakes.filter((i) => isExecutionAttention(i, tasks)).length;
}

/** サイドバーの描画も j/k もこの順を使う */
export function executionOrder(
  intakes: IntakeSummary[],
  tasks: readonly Task[],
  workspace: WorkspaceFilter,
  closed: boolean,
): IntakeSummary[] {
  const rows = visibleIntakes(intakes, workspace)
    .filter((i) => inExecution(i) && (executionSection(i) === "closed") === closed);
  const recent = (a: IntakeSummary, b: IntakeSummary) => Date.parse(b.updated_at) - Date.parse(a.updated_at);
  if (closed) return rows.sort(recent);
  const rank = (i: IntakeSummary) => (isExecutionAttention(i, tasks) ? 0 : 1);
  return rows.sort((a, b) => rank(a) - rank(b) || recent(a, b));
}
