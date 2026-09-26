import { type KeyboardEvent, useId } from "react";
import type {
  StepRun,
  StepView,
  TaskSummary,
  WorkflowStepDetail,
} from "../../../shared/protocol.ts";
import {
  buildDefinitionRail,
  buildRail,
  laneY,
  NODE_H,
  NODE_W,
  type RailNode,
  ROW_TOP,
} from "../rail";
import { RUN_TONE, toneClass } from "../tone";

/** `useId()` の記号（«r0» など）は url(#…) の中で WebKit が解決しないことがあるので、英数字だけにする */
const useSvgId = (name: string) =>
  `${name}-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;

/** 同じノードに着く矢印が縦に重ならないよう、外側のレーンほど左へずらす幅。 */
const ARRIVE_SHIFT = 4;

/**
 * marker・隣接ノード間の辺・戻りの弧を描く。タスク画面の実行状態付きレールと、
 * 定義だけの図の両方から使う（弧の形はどちらも from/to/fromIndex/toIndex/lane を持つ）。
 */
function RailEdges<
  A extends {
    from: string;
    to: string;
    fromIndex: number;
    toIndex: number;
    lane: number;
  },
>(
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
        <marker
          id={arrowId}
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto"
        >
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
            <text
              x={(x1 + x2) / 2}
              y={y - 4}
              textAnchor="middle"
              className="wr-arclbl"
            >
              {arcLabel(a)}
            </text>
          </g>
        );
      })}
    </>
  );
}

/**
 * approval のステップは、まだ来ていないうちはアンバーの破線（gate）、止まっているときは
 * awaiting の human で実線になる。済んだ後は success の ok。
 */
const nodeClass = (n: RailNode) =>
  [
    "wf-step",
    toneClass(RUN_TONE[n.status]),
    n.type === "approval" && n.status === "pending" && "gate",
    n.unknown && "unknown",
    n.current && "now",
  ]
    .filter(Boolean)
    .join(" ");

const LEGEND: { tone: Parameters<typeof toneClass>[0]; word: string }[] = [
  { tone: "ok", word: "済み" },
  { tone: "run", word: "実行中" },
  { tone: "danger", word: "失敗・差し戻し" },
  { tone: "human", word: "人の承認" },
  { tone: "idle", word: "未実行" },
];

export function WorkflowRail(
  { detail, legend }: {
    detail: { steps: StepView[] | null; stepRuns: StepRun[]; task: Pick<TaskSummary, "current_step_id"> };
    legend: boolean;
  },
) {
  const nodes = buildRail(detail.steps, detail.stepRuns, detail.task);
  if (!nodes) return null;
  return (
    <div className="wf">
      <div className="wf-scroll">
        <ol
          className="wf-steps"
          aria-label={`ワークフロー: ${nodes.map((n) => n.id).join(" → ")}`}
        >
          {nodes.map((n) => (
            <li
              key={n.id}
              className={nodeClass(n)}
              aria-current={n.current ? "step" : undefined}
              title={n.title}
            >
              <span className="bar" />
              <span className="nm">{n.id}</span>
            </li>
          ))}
        </ol>
      </div>
      {legend && (
        <div className="wf-legend">
          {LEGEND.map((l) => (
            <span key={l.word} className={toneClass(l.tone)}>
              <i aria-hidden="true" />
              {l.word}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** ワークフローの定義（種類ごとの見出し用の文字列）。 */
const KIND_LABEL: Record<WorkflowStepDetail["type"], string> = {
  command: "command",
  agent: "agent",
  approval: "approval",
  guide: "guide",
  poll: "poll",
};

/**
 * ワークフローの定義だけを、WorkflowRail と同じ描き方で図にする。実行の状態
 * （塗り分け・試行回数・aria-current）は一切持たず、種類とステップを選ぶ操作を持つ。
 */
export function WorkflowDefinitionRail(
  props: {
    steps: WorkflowStepDetail[];
    selected: string | null;
    onSelect: (stepId: string) => void;
  },
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
        aria-label={`ワークフローの定義: ${
          rail.nodes.map((n) => n.id).join(" → ")
        }`}
      >
        <RailEdges
          nodes={rail.nodes}
          arcs={rail.arcs}
          arrowId={arrowId}
          arcLabel={(a) =>
            `→ ${a.to} 最大 ${a.maxAttempts} 回${a.implicit ? "（既定）" : ""}`}
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
            <text x={n.x + 4} y={ROW_TOP - 3} className="wr-kind">
              {KIND_LABEL[n.type]}
            </text>
            <text
              x={n.x + NODE_W / 2}
              y={ROW_TOP + NODE_H / 2 + 4}
              textAnchor="middle"
              className="wr-id"
            >
              {n.id}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}
