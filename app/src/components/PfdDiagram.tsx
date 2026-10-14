import { useId, type KeyboardEvent } from "react";
import { LOOK, RAIL_BAR_H, railSegments, STATUS_DOT, type PfdNode, type PfdView } from "../pfd";
import { PROCESS_TONE, RUN_TONE, TASK_TONE, toneClass } from "../tone";

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
    n.attention && "attention",
    selected && "selected",
  ]
    .filter(Boolean)
    .join(" ");

const statusWords = (n: PfdNode) =>
  n.status ? (n.status.text === n.status.word ? n.status.word : `${n.status.word} · ${n.status.text}`) : n.look && LOOK[n.look].word;

const nodeLabel = (n: PfdNode, exec: boolean) =>
  [
    `${n.kind === "artifact" ? "成果物" : "プロセス"} ${n.label}`,
    !exec && n.project && `プロジェクト ${n.project}`,
    statusWords(n),
    n.attention && "人の番",
    n.comments > 0 && `コメント ${n.comments} 件`,
  ]
    .filter(Boolean)
    .join("、");

/**
 * PFD を手書きの SVG で描く。外部の読み込みを持たず、要素の選択とコメント・状態の印は props で受ける。
 * Execution の図（view.mode が exec）のプロセスは、ラベル・状態の文言・帯だけを描く（spec 6.2）
 */
export function PfdDiagram({ view, selected, onSelect }: { view: PfdView; selected: string | null; onSelect: (key: string) => void }) {
  const arrowId = useSvgId("pfd-arrow");
  const exec = view.mode === "exec";
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
          const rx = n.kind === "process" ? n.h / 2 : 4;
          return (
            <g
              key={n.key}
              className={nodeClass(n, selected === n.key)}
              role="button"
              tabIndex={0}
              aria-pressed={selected === n.key}
              aria-label={nodeLabel(n, exec)}
              onClick={() => onSelect(n.key)}
              onKeyDown={onKey(n.key)}
            >
              <title>{n.label}</title>
              <rect className="pfd-box" x={n.x} y={n.y} width={n.w} height={n.h} rx={rx} />
              {!exec && n.human && <rect className="pfd-inner" x={n.x + 3} y={n.y + 3} width={n.w - 6} height={n.h - 6} rx={rx - 3} />}
              {!exec && n.look && (
                <line
                  className={`pfd-bar ${toneClass(PROCESS_TONE[n.look].tone)}${PROCESS_TONE[n.look].dashed ? " dashed" : ""}`}
                  x1={n.x + rx}
                  x2={n.x + n.w - rx}
                  y1={n.y + 4}
                  y2={n.y + 4}
                />
              )}
              {n.badge === null && n.marks.length > 0 && (
                <text x={n.x + 8} y={n.y + 16} className="pfd-mark">
                  {n.marks.join(" ")}
                </text>
              )}
              {!exec && n.project !== null && (
                <text x={n.x + n.w - 8} y={n.y + 16} textAnchor="end" className="pfd-project">{n.project}</text>
              )}
              <text x={n.x + n.w / 2} y={n.labelY} textAnchor="middle" className="pfd-label">
                {n.lines.map((line, i) => (
                  <tspan key={i} x={n.x + n.w / 2} dy={i === 0 ? 0 : 13}>{line}</tspan>
                ))}
              </text>
              {n.status && n.look && (
                <text x={n.x + n.w / 2} y={n.status.y} textAnchor="middle" className="pfd-status">
                  <tspan className={`pfd-status-dot ${toneClass(n.status.awaiting ? TASK_TONE.suspended : PROCESS_TONE[n.look].tone)}`}>{STATUS_DOT}</tspan>
                  <tspan className="pfd-status-text">{` ${n.status.text}`}</tspan>
                </text>
              )}
              {railSegments(n).map((seg, i) => (
                <rect
                  key={i}
                  className={`pfd-step ${toneClass(RUN_TONE[seg.status])}${seg.current ? " now" : ""}`}
                  x={seg.x}
                  y={seg.y}
                  width={seg.w}
                  height={RAIL_BAR_H}
                  rx={1.5}
                />
              ))}
              {!exec && n.stage !== null && (
                <text x={n.x} y={n.y - 4} className="pfd-stage">{n.stage}</text>
              )}
              {n.badge !== null && (
                <g className="pfd-badge">
                  <rect x={n.badge.x} y={n.badge.y} width={n.badge.w} height={n.badge.h} rx={n.badge.h / 2} />
                  <text x={n.badge.x + n.badge.w / 2} y={n.badge.y + n.badge.h / 2} textAnchor="middle" dominantBaseline="central">
                    {n.marks.join(" ")}
                  </text>
                </g>
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
