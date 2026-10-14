// Execution のビューの導出。副作用を持たない（テストは execution.test.ts）
import type { IntakeProcessView, IntakeSummary } from "../../shared/protocol.ts";
import type { RailNode } from "../../shared/rail.ts";
import { isClosedIntake, visibleIntakes } from "./intake";
import type { PfdView } from "./pfd";
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

/** 図のプロセスごとの人の番（spec 6.3）。task_ids は古い順なので、末尾がいまのタスク */
export function attentionProcessIds(processes: readonly IntakeProcessView[], tasks: readonly Task[]): Set<string> {
  const ids = new Set<string>();
  for (const p of processes) {
    if (p.state === "your_turn" || p.state === "needs_attention") ids.add(p.id);
    const current = p.task_ids.at(-1);
    if (current !== undefined && tasks.some((t) => t.id === current && t.state === "suspended")) ids.add(p.id);
  }
  return ids;
}

export function firstAttentionKey(view: PfdView): string | null {
  return view.nodes.find((n) => n.attention)?.key ?? null;
}

export function railsOf(processes: readonly IntakeProcessView[]): Record<string, RailNode[] | null> {
  return Object.fromEntries(processes.map((p) => [p.id, p.rail]));
}
