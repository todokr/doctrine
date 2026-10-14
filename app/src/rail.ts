// 設定画面の「ワークフローの定義の図」の寸法と組み立て。副作用を持たない（テストは rail.test.ts）
import type { WorkflowStepDetail } from "../../shared/protocol.ts";

// 以下の寸法と補助は、設定画面の「ワークフローの定義の図」（buildDefinitionRail）だけが使う。
// タスク画面の帯（shared/rail.ts の buildRail）は CSS で並べるので座標を持たない。
export const NODE_W = 120;
export const NODE_H = 34;
export const GAP = 28;
/** ノードの上の余白。試行回数のバッジがノードの角からはみ出す分。 */
export const ROW_TOP = 12;
/** ノード列（バッジの余白と下の余白を含む）の高さ。戻り矢印のレーンはこの下から始まる。 */
export const BODY_H = ROW_TOP + NODE_H + 4;
export const LANE_H = 22;

/** レーン lane の水平線の y。 */
export const laneY = (lane: number): number =>
  BODY_H + lane * LANE_H + LANE_H / 2;

/** 弧をまたぐステップ数の昇順（同数なら fromIndex の昇順）で内側から 0,1,2… に振る。 */
function assignLanes(
  arcs: { fromIndex: number; toIndex: number; lane: number }[],
): void {
  const span = (a: { fromIndex: number; toIndex: number }) =>
    Math.abs(a.fromIndex - a.toIndex);
  [...arcs].sort((a, b) => span(a) - span(b) || a.fromIndex - b.fromIndex)
    .forEach((a, lane) => {
      a.lane = lane;
    });
}

/** 帯の幅・高さ。幅は最後のノードの右端、高さは弧が無ければ BODY_H、あればレーン分を足す。 */
function railSize(
  lastNodeX: number | null,
  arcCount: number,
): { width: number; height: number } {
  const width = lastNodeX === null ? 0 : lastNodeX + NODE_W;
  return { width, height: BODY_H + (arcCount === 0 ? 0 : arcCount * LANE_H) };
}

/** ワークフローの定義だけから作るノード。実行の状態（status / attempt / current）は持たない。 */
export type DefinitionNode = {
  id: string;
  type: WorkflowStepDetail["type"];
  /** approval だけが持つ。 */
  title?: string;
  x: number;
};

/** 定義の戻りの弧。使用回数（used）は持たない。 */
export type DefinitionArc = {
  from: string;
  to: string;
  fromIndex: number;
  toIndex: number;
  lane: number;
  maxAttempts: number;
  /** guide の既定の分岐（YAML に書かれていない）なら true。 */
  implicit: boolean;
};

export type DefinitionRail = {
  nodes: DefinitionNode[];
  arcs: DefinitionArc[];
  width: number;
  height: number;
};

/**
 * ワークフローの定義（workflow.get の steps）だけから帯を組み立てる。
 * 実行の状態を持たないので、steps に無い goto 先の弧は作らない（buildRail と同じ）。
 */
export function buildDefinitionRail(
  steps: WorkflowStepDetail[],
): DefinitionRail {
  const nodes: DefinitionNode[] = steps.map((s, i) => ({
    id: s.id,
    type: s.type,
    ...(s.type === "approval" && { title: s.title }),
    x: i * (NODE_W + GAP),
  }));

  const index = new Map(nodes.map((n, i) => [n.id, i]));
  const arcs: DefinitionArc[] = [];
  for (const [fromIndex, step] of steps.entries()) {
    if (!step.branch) continue;
    const toIndex = index.get(step.branch.goto);
    if (toIndex === undefined) continue;
    arcs.push({
      from: step.id,
      to: step.branch.goto,
      fromIndex,
      toIndex,
      lane: 0,
      maxAttempts: step.branch.maxAttempts,
      implicit: step.branch.implicit,
    });
  }
  assignLanes(arcs);

  const { width, height } = railSize(
    nodes.length === 0 ? null : nodes[nodes.length - 1].x,
    arcs.length,
  );
  return { nodes, arcs, width, height };
}
