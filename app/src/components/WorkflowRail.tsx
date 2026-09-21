import type { TaskDetail } from "../../../shared/protocol.ts";
import { buildRail, laneY, NODE_H, NODE_W, ROW_TOP } from "../rail";
import type { RailStatus } from "../rail";

/** ノードの塗り分け。TaskView の RUN_PILL と同じ対応で、pending は muted。 */
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

export function WorkflowRail({ detail }: { detail: TaskDetail }) {
  const rail = buildRail(detail.steps, detail.stepRuns, detail.task);
  if (!rail) return null;

  const centerOf = (i: number) => rail.nodes[i].x + NODE_W / 2;
  const bottom = ROW_TOP + NODE_H;

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
        <defs>
          <marker id="wr-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M0,0 L10,5 L0,10 z" className="wr-arrowhead" />
          </marker>
        </defs>
        {rail.nodes.slice(1).map((n, i) => (
          <line
            key={n.id}
            x1={rail.nodes[i].x + NODE_W}
            y1={ROW_TOP + NODE_H / 2}
            x2={n.x}
            y2={ROW_TOP + NODE_H / 2}
            className="wr-edge"
            markerEnd="url(#wr-arrow)"
          />
        ))}
        {rail.arcs.map((a) => {
          const y = laneY(a.lane);
          const x1 = centerOf(a.fromIndex);
          const x2 = centerOf(a.toIndex) - a.lane * ARRIVE_SHIFT;
          return (
            <g key={a.from} className="wr-arc">
              <path
                d={`M${x1},${bottom} V${y} H${x2} V${bottom + 2}`}
                className="wr-back"
                markerEnd="url(#wr-arrow)"
              />
              <text x={(x1 + x2) / 2} y={y - 4} textAnchor="middle" className="wr-arclbl">
                {`→ ${a.to} ${a.used}/${a.maxAttempts}`}
              </text>
            </g>
          );
        })}
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
