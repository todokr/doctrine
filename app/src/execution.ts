// Execution のビューの導出。副作用を持たない（テストは execution.test.ts）
import type { IntakeProcessView, IntakeSummary } from "../../shared/protocol.ts";
import type { RailNode } from "../../shared/rail.ts";
import { isClosedIntake, visibleIntakes } from "./intake";
import { type PfdView, parsePfdKey, pfdKey } from "./pfd";
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

/** s.sel のタスクがこの Intake のものなら、そのプロセスの図のキー。パネルの外から開いたタスクのノードを選び直すのに使う */
export function processKeyOfTask(tasks: readonly Task[], sel: string | null, intakeId: string): string | null {
  const t = sel === null ? undefined : tasks.find((x) => x.id === sel);
  return t?.intake?.id === intakeId ? pfdKey("process", t.intake.processId) : null;
}

export type PanelContent =
  /** 成果物・タスクの無いプロセス・完了した人のプロセス・一覧にまだ無いタスクのプロセス */
  | { kind: "element"; key: string }
  | { kind: "human"; key: string; processId: string }
  | { kind: "review"; key: string; processId: string; taskId: string }
  /** attention はいまのタスクを見ていて、プロセスが needs_attention（理由と再投入を上に出す） */
  | { kind: "task"; key: string; processId: string; taskId: string; attention: boolean };

/** 下のパネルに出すもの（spec 6.5）。key が図に無ければ（改訂で消えた・Intake を切り替えた）null で閉じる */
export function panelContentOf(o: {
  key: string | null;
  keys: ReadonlySet<string>;
  processes: readonly IntakeProcessView[];
  tasks: readonly Task[];
  /** いま選んでいるタスク（s.sel）。そのプロセスの task_ids に無ければ使わない */
  chosenTaskId: string | null;
}): PanelContent | null {
  if (o.key === null || !o.keys.has(o.key)) return null;
  const key = o.key;
  const parsed = parsePfdKey(key);
  if (parsed?.kind !== "process") return { kind: "element", key };
  const view = o.processes.find((p) => p.id === parsed.id);
  if (!view) return { kind: "element", key };
  if (view.state === "your_turn") return { kind: "human", key, processId: view.id };
  const current = view.task_ids.at(-1);
  const taskId = o.chosenTaskId !== null && view.task_ids.includes(o.chosenTaskId) ? o.chosenTaskId : current;
  const task = taskId === undefined ? undefined : o.tasks.find((t) => t.id === taskId);
  // 投入の直後は task.list の取り直しがまだで、タスクが一覧に無いことがある
  if (!task) return { kind: "element", key };
  if (task.state === "suspended") return { kind: "review", key, processId: view.id, taskId: task.id };
  return { kind: "task", key, processId: view.id, taskId: task.id, attention: view.state === "needs_attention" && task.id === current };
}

export const PANEL_MIN = 160;
export const PANEL_DEFAULT = 360;
/** 図の分として、パネルの上に残す高さ */
const PANEL_ROOM_TOP = 120;
const PANEL_KEY = "doctrine.execution.panelHeight";

export function clampPanelHeight(h: number, room: number): number {
  const max = Math.max(PANEL_MIN, room - PANEL_ROOM_TOP);
  return Math.min(max, Math.max(PANEL_MIN, Math.round(h)));
}

/** プライベートウィンドウなどでは localStorage に触るだけで投げる */
export function panelStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readPanelHeight(storage: Pick<Storage, "getItem"> | null): number {
  try {
    const v = Number(storage?.getItem(PANEL_KEY) ?? Number.NaN);
    return Number.isFinite(v) && v > 0 ? v : PANEL_DEFAULT;
  } catch {
    return PANEL_DEFAULT;
  }
}

export function writePanelHeight(storage: Pick<Storage, "setItem"> | null, h: number): void {
  try {
    storage?.setItem(PANEL_KEY, String(Math.round(h)));
  } catch {
    // 覚えられなくても、いまの高さは効いている
  }
}
