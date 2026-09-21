import { useId, type KeyboardEvent } from "react";
import { LOOK, type PfdNode, type PfdView } from "../pfd";

/** `useId()` の記号（«r0» など）は url(#…) の中で WebKit が解決しないことがあるので、英数字だけにする */
const useSvgId = (name: string) => `${name}-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;

const nodeClass = (n: PfdNode, selected: boolean) =>
  [
    "pfd-node",
    n.kind === "artifact" ? "pfd-artifact" : "pfd-process",
    n.human && "human",
    n.given && "given",
    n.goal && "goal",
    n.decision && "decision",
    n.available && "available",
    n.frozen && "frozen",
    selected && "selected",
    n.look && LOOK[n.look].cls,
  ]
    .filter(Boolean)
    .join(" ");

const nodeLabel = (n: PfdNode) =>
  [
    `${n.kind === "artifact" ? "成果物" : "プロセス"} ${n.label}`,
    n.look && LOOK[n.look].word,
    n.comments > 0 && `コメント ${n.comments} 件`,
  ]
    .filter(Boolean)
    .join("、");

/** 種類の印。文字は pfd.ts が幅に数えた印と同じ並びにする */
const kindMarks = (n: PfdNode) => [n.frozen && "🔒", n.goal && "◎", n.given && "既存", n.decision && "決定", n.human && "人"].filter(Boolean);

/** PFD を手書きの SVG で描く。外部の読み込みを持たず、要素の選択とコメント・状態の印は props で受ける */
export function PfdDiagram({ view, selected, onSelect }: { view: PfdView; selected: string | null; onSelect: (key: string) => void }) {
  const arrowId = useSvgId("pfd-arrow");
  const onKey = (key: string) => (e: KeyboardEvent<SVGGElement>) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    // Space は既定でスクロールする
    e.preventDefault();
    onSelect(key);
  };
  return (
    <div className="pfd-scroll">
      <svg className="pfd" width={view.width} height={view.height} viewBox={`0 0 ${view.width} ${view.height}`} role="group" aria-label="PFD の図">
        <defs>
          <marker id={arrowId} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M0,0 L10,5 L0,10 z" className="pfd-arrowhead" />
          </marker>
        </defs>
        {view.edges.map((e, i) => (
          <path key={i} d={e.d} fill="none" className="pfd-edge" markerEnd={`url(#${arrowId})`} />
        ))}
        {view.nodes.map((n) => {
          const mark = n.look ? LOOK[n.look].mark : "";
          const rx = n.kind === "process" ? n.h / 2 : 4;
          return (
            <g
              key={n.key}
              className={nodeClass(n, selected === n.key)}
              role="button"
              tabIndex={0}
              aria-pressed={selected === n.key}
              aria-label={nodeLabel(n)}
              onClick={() => onSelect(n.key)}
              onKeyDown={onKey(n.key)}
            >
              <title>{n.label}</title>
              <rect x={n.x} y={n.y} width={n.w} height={n.h} rx={rx} />
              {n.human && <rect className="pfd-inner" x={n.x + 3} y={n.y + 3} width={n.w - 6} height={n.h - 6} rx={rx - 3} />}
              <text x={n.x + n.w / 2} y={n.y + n.h / 2 + 3.5} textAnchor="middle" className="pfd-label">
                {mark && `${mark} `}
                {kindMarks(n).map((m) => (
                  <tspan key={m as string} className="pfd-mark">{m} </tspan>
                ))}
                {n.label}
              </text>
              {n.stage !== null && (
                <text x={n.x} y={n.y - 4} className="pfd-stage">{n.stage}</text>
              )}
              {n.comments > 0 && (
                <g className="pfd-comments">
                  <circle cx={n.x + n.w} cy={n.y} r={8} />
                  <text x={n.x + n.w} y={n.y + 3} textAnchor="middle">{n.comments}</text>
                </g>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
