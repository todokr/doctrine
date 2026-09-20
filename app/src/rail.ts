// task.get の steps / stepRuns / current_step_id を、ワークフローレールが描ける
// ノードと戻り矢印の形に組み立てる。副作用を持たない（テストは rail.test.ts）
//
// ワークフローは steps[] の一列と goto による後戻りだけで、座標は添字で決まる。
// レイアウトを解く余地が無いので、ここは計算ではなく導出だけをする。
import type { StepRun, StepView, TaskSummary } from "../../shared/protocol.ts";

export const NODE_W = 120;
export const NODE_H = 34;
export const GAP = 28;
/** ノードの上の余白。試行回数のバッジがノードの角からはみ出す分。 */
export const ROW_TOP = 12;
/** ノード列（バッジの余白と下の余白を含む）の高さ。戻り矢印のレーンはこの下から始まる。 */
export const BODY_H = ROW_TOP + NODE_H + 4;
export const LANE_H = 22;

/** 「まだ実行していない」は step_runs に対応する値が無いので、ここで足す。 */
export type RailStatus = StepRun["status"] | "pending";

export type RailNode = {
  id: string;
  /** steps に無く末尾に生やしたノードは種別が分からないので null。 */
  type: StepView["type"] | null;
  /** approval だけが持つ。ラベルには出さず、補助テキストへ回す。 */
  title?: string;
  status: RailStatus;
  /** 最後の run の attempt。run が1件も無ければ 0（バッジは出さない）。 */
  attempt: number;
  /** current_step_id と一致するステップ。 */
  current: boolean;
  /** steps に無い step_id / current_step_id を末尾に生やしたノード（破線で描く）。 */
  unknown: boolean;
  /** SVG 座標。ノードの左端。 */
  x: number;
};

export type RailArc = {
  from: string;
  to: string;
  fromIndex: number;
  toIndex: number;
  /** 内側から 0。またぐステップ数の昇順で割り当てる。 */
  lane: number;
  /** 始点ステップの bounced の件数。 */
  used: number;
  maxAttempts: number;
};

export type Rail = { nodes: RailNode[]; arcs: RailArc[]; width: number; height: number };

/** レーン lane の水平線の y。 */
export const laneY = (lane: number): number => BODY_H + lane * LANE_H + LANE_H / 2;

/**
 * steps が null（ワークフロー YAML が読めない）なら null。帯は描かず、履歴リストだけにする。
 *
 * steps に無い step_id（YAML が編集されて列がずれた）は、stepRuns にあるものも
 * current_step_id も末尾に生やす。黙って落とすと、いま止まっているステップが図から消える。
 */
export function buildRail(
  steps: StepView[] | null,
  stepRuns: StepRun[],
  task: Pick<TaskSummary, "current_step_id">,
): Rail | null {
  if (steps === null) return null;

  const known = new Set(steps.map((s) => s.id));
  const extra: string[] = [];
  for (const id of [...stepRuns.map((r) => r.step_id), task.current_step_id]) {
    if (id !== null && !known.has(id)) {
      known.add(id);
      extra.push(id);
    }
  }

  // stepRuns は id の昇順で届くので、step_id ごとの末尾がそのステップの最後の run。
  const runsOf = new Map<string, StepRun[]>();
  for (const r of stepRuns) runsOf.set(r.step_id, [...(runsOf.get(r.step_id) ?? []), r]);

  const nodes: RailNode[] = [
    ...steps.map((s) => ({ id: s.id, type: s.type, title: s.title, unknown: false })),
    ...extra.map((id) => ({ id, type: null, title: undefined, unknown: true })),
  ].map(({ title, ...n }, i) => {
    const last = runsOf.get(n.id)?.at(-1);
    return {
      ...n,
      ...(title !== undefined && { title }),
      status: last?.status ?? "pending",
      attempt: last?.attempt ?? 0,
      current: n.id === task.current_step_id,
      x: i * (NODE_W + GAP),
    };
  });

  const index = new Map(nodes.map((n, i) => [n.id, i]));
  const arcs: RailArc[] = [];
  for (const [fromIndex, step] of steps.entries()) {
    const toIndex = step.branch && index.get(step.branch.goto);
    if (!step.branch || toIndex === undefined) continue;
    arcs.push({
      from: step.id,
      to: step.branch.goto,
      fromIndex,
      toIndex,
      lane: 0,
      used: (runsOf.get(step.id) ?? []).filter((r) => r.status === "bounced").length,
      maxAttempts: step.branch.maxAttempts,
    });
  }
  const span = (a: RailArc) => Math.abs(a.fromIndex - a.toIndex);
  [...arcs].sort((a, b) => span(a) - span(b) || a.fromIndex - b.fromIndex)
    .forEach((a, lane) => {
      a.lane = lane;
    });

  const width = nodes.length === 0 ? 0 : nodes[nodes.length - 1].x + NODE_W;
  return { nodes, arcs, width, height: BODY_H + (arcs.length === 0 ? 0 : arcs.length * LANE_H) };
}
