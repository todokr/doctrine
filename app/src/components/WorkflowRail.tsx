import { useId, type KeyboardEvent } from "react";
import type { TaskDetail, WorkflowStepDetail } from "../../../shared/protocol.ts";
import { buildDefinitionRail, buildRail, laneY, NODE_H, NODE_W, ROW_TOP } from "../rail";
import type { RailStatus } from "../rail";

/** `useId()` の記号（«r0» など）は url(#…) の中で WebKit が解決しないことがあるので、英数字だけにする */
const useSvgId = (name: string) => `${name}-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;

/** ノードの塗り分け。model.ts の RUN_PILL と同じ対応で、pending は muted。 */
const STATUS_CLASS: Record<RailStatus, string> = {
  running: "wr-run",
  awaiting: "wr-attn",
  success: "wr-ok",
  failed: "wr-danger",
  interrupted: "wr-muted",
  bounced: "wr-muted",
  rate_limited: "wr-muted",
  pending: "wr-muted",
};

/** 同じノードに着く矢印が縦に重ならないよう、外側のレーンほど左へずらす幅。 */
const ARRIVE_SHIFT = 4;

/**
 * marker・隣接ノード間の辺・戻りの弧を描く。タスク画面の実行状態付きレールと、
 * 定義だけの図の両方から使う（弧の形はどちらも from/to/fromIndex/toIndex/lane を持つ）。
 */
function RailEdges<A extends { from: string; to: string; fromIndex: number; toIndex: number; lane: number }>(
  props: {
    nodes: { id: string; x: number }[];
    arcs: A[];
    arrowId: string;
    arcLabel: (arc: A) => string;
  },
) {
  const { nodes, arcs, arrowId, arcLabel } = props;
  const centerOf = (i: number) => nodes[i].x + NODE_W / 2;
  const bottom = ROW_TOP + NODE_H;

  return (
    <>
      <defs>
        <marker id={arrowId} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0,0 L10,5 L0,10 z" className="wr-arrowhead" />
        </marker>
      </defs>
      {nodes.slice(1).map((n, i) => (
        <line
          key={n.id}
          x1={nodes[i].x + NODE_W}
          y1={ROW_TOP + NODE_H / 2}
          x2={n.x}
          y2={ROW_TOP + NODE_H / 2}
          className="wr-edge"
          markerEnd={`url(#${arrowId})`}
        />
      ))}
      {arcs.map((a) => {
        const y = laneY(a.lane);
        const x1 = centerOf(a.fromIndex);
        const x2 = centerOf(a.toIndex) - a.lane * ARRIVE_SHIFT;
        return (
          <g key={a.from} className="wr-arc">
            <path
              d={`M${x1},${bottom} V${y} H${x2} V${bottom + 2}`}
              className="wr-back"
              markerEnd={`url(#${arrowId})`}
            />
            <text x={(x1 + x2) / 2} y={y - 4} textAnchor="middle" className="wr-arclbl">
              {arcLabel(a)}
            </text>
          </g>
        );
      })}
    </>
  );
}

export function WorkflowRail({ detail }: { detail: TaskDetail }) {
  const rail = buildRail(detail.steps, detail.stepRuns, detail.task);
  if (!rail) return null;

  return (
    <div className="wr-scroll">
      <svg
        className="wr"
        width={rail.width}
        height={rail.height}
        viewBox={`0 0 ${rail.width} ${rail.height}`}
        role="img"
        aria-label={`ワークフロー: ${rail.nodes.map((n) => n.id).join(" → ")}`}
      >
        <RailEdges
          nodes={rail.nodes}
          arcs={rail.arcs}
          arrowId="wr-arrow"
          arcLabel={(a) => `→ ${a.to} ${a.used}/${a.maxAttempts}`}
        />
        {rail.nodes.map((n) => (
          <g
            key={n.id}
            className={`wr-node ${STATUS_CLASS[n.status]}${n.unknown ? " unknown" : ""}`}
            aria-current={n.current ? "step" : undefined}
          >
            {n.title && <title>{n.title}</title>}
            <rect x={n.x} y={ROW_TOP} width={NODE_W} height={NODE_H} rx={7} />
            <text x={n.x + NODE_W / 2} y={ROW_TOP + NODE_H / 2 + 4} textAnchor="middle" className="wr-id">
              {n.id}
            </text>
            {n.attempt > 1 && (
              <g className="wr-badge">
                <rect x={n.x + NODE_W - 22} y={ROW_TOP - 8} width={26} height={15} rx={7.5} />
                <text x={n.x + NODE_W - 9} y={ROW_TOP + 3} textAnchor="middle">{`×${n.attempt}`}</text>
              </g>
            )}
          </g>
        ))}
      </svg>
    </div>
  );
}

/** ワークフローの定義（種類ごとの見出し用の文字列）。 */
const KIND_LABEL: Record<WorkflowStepDetail["type"], string> = {
  command: "command",
  agent: "agent",
  approval: "approval",
  guide: "guide",
};

/**
 * ワークフローの定義だけを、WorkflowRail と同じ描き方で図にする。実行の状態
 * （塗り分け・試行回数・aria-current）は一切持たず、種類とステップを選ぶ操作を持つ。
 */
export function WorkflowDefinitionRail(
  props: { steps: WorkflowStepDetail[]; selected: string | null; onSelect: (stepId: string) => void },
) {
  const { steps, selected, onSelect } = props;
  const arrowId = useSvgId("wr-def-arrow");
  const rail = buildDefinitionRail(steps);

  const onKey = (id: string) => (e: KeyboardEvent<SVGGElement>) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    // Space は既定でスクロールする
    e.preventDefault();
    onSelect(id);
  };

  return (
    <div className="wr-scroll">
      <svg
        className="wr"
        width={rail.width}
        height={rail.height}
        viewBox={`0 0 ${rail.width} ${rail.height}`}
        role="group"
        aria-label={`ワークフローの定義: ${rail.nodes.map((n) => n.id).join(" → ")}`}
      >
        <RailEdges
          nodes={rail.nodes}
          arcs={rail.arcs}
          arrowId={arrowId}
          arcLabel={(a) => `→ ${a.to} 最大 ${a.maxAttempts} 回${a.implicit ? "（既定）" : ""}`}
        />
        {rail.nodes.map((n) => (
          <g
            key={n.id}
            className={`wr-node wr-def${selected === n.id ? " selected" : ""}`}
            role="button"
            tabIndex={0}
            aria-pressed={selected === n.id}
            aria-label={`${KIND_LABEL[n.type]} ${n.id}`}
            onClick={() => onSelect(n.id)}
            onKeyDown={onKey(n.id)}
          >
            {n.title && <title>{n.title}</title>}
            <rect x={n.x} y={ROW_TOP} width={NODE_W} height={NODE_H} rx={7} />
            <text x={n.x + 4} y={ROW_TOP - 3} className="wr-kind">{KIND_LABEL[n.type]}</text>
            <text x={n.x + NODE_W / 2} y={ROW_TOP + NODE_H / 2 + 4} textAnchor="middle" className="wr-id">
              {n.id}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}
