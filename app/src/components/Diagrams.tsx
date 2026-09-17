import type { CSSProperties } from "react";
import type { SequenceDiagram } from "../types";

export function SequenceSvg({ seq }: { seq: SequenceDiagram }) {
  const W = 320, top = 24, rowH = 40;
  const { actors, messages } = seq;
  const xs = actors.map((_, i) => 26 + i * ((W - 52) / (actors.length - 1)));
  const H = top + rowH * messages.length + 14;
  return (
    <svg className="seqd" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`シーケンス図: ${actors.join(" → ")}`}>
      <defs>
        <marker id="sd-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" className="sd-arrowhead" />
        </marker>
      </defs>
      {actors.map((a, i) => (
        <g key={a}>
          <text x={xs[i]} y={14} textAnchor="middle" className="sd-actor">{a}</text>
          <line x1={xs[i]} y1={20} x2={xs[i]} y2={H - 6} className="sd-life" />
        </g>
      ))}
      {messages.map((m, i) => {
        const y = top + rowH * (i + 1) - 12;
        const x1 = xs[actors.indexOf(m.from)], x2 = xs[actors.indexOf(m.to)];
        const mid = (x1 + x2) / 2;
        return (
          <g key={i}>
            <text x={mid} y={y - 14} textAnchor="middle" className="sd-lbl">{i + 1}.</text>
            <foreignObject x={Math.max(2, mid - 92)} y={y - 12} width={184} height={14}>
              <div style={{ font: "9.5px var(--mono)", color: "var(--ink-3)", textAlign: "center", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {m.label}
              </div>
            </foreignObject>
            <line x1={x1} y1={y} x2={x2} y2={y} className="sd-arrow" markerEnd="url(#sd-arrow)" style={{ "--d": `${(i * 0.14).toFixed(2)}s` } as CSSProperties} />
          </g>
        );
      })}
    </svg>
  );
}

// モックのガイドに合わせた固定の図。ガイドの形式が決まったら生成に置き換える
export function RelationSvg() {
  return (
    <svg className="reld" viewBox="0 0 320 128" role="img" aria-label="tasks と task_sessions の関係">
      <rect x="8" y="26" width="120" height="80" rx="8" className="rel-box" />
      <text x="68" y="42" textAnchor="middle" className="rel-name">tasks</text>
      <text x="16" y="60" className="rel-field">id (PK)</text>
      <text x="16" y="74" className="rel-field">claude_session_id</text>
      <text x="16" y="88" className="rel-field">（廃止予定）</text>
      <rect x="176" y="10" width="136" height="108" rx="8" className="rel-box" />
      <text x="244" y="26" textAnchor="middle" className="rel-name">task_sessions</text>
      <text x="184" y="44" className="rel-field">task_id (PK, FK)</text>
      <text x="184" y="58" className="rel-field">role (PK)</text>
      <text x="184" y="72" className="rel-field">claude_session_id</text>
      <line x1="128" y1="66" x2="176" y2="64" className="rel-line" />
      <text x="134" y="62" className="rel-card">1</text>
      <text x="160" y="60" className="rel-card">N</text>
    </svg>
  );
}
