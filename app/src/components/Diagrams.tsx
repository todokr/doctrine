import type { CSSProperties } from "react";
import type { Diagram } from "../types";

type Body<S extends Diagram["body"]["shape"]> = Extract<Diagram["body"], { shape: S }>;
type Change = "added" | "changed" | "removed";

const CHANGE_WORD: Record<Change, string> = { added: "追加", changed: "変更", removed: "削除" };
const GRAPH_KIND: Record<Body<"graph">["kind"], string> = { relation: "関係", dependency: "依存", state: "状態遷移" };

/** shape で振り分ける。図の題名はここで付ける */
export function DiagramView({ diagram }: { diagram: Diagram }) {
  const { body } = diagram;
  return (
    <figure className="diagram">
      <figcaption className="hint">{diagram.title}</figcaption>
      {body.shape === "sequence" ? <SequenceSvg body={body} /> : <GraphList body={body} />}
    </figure>
  );
}

export function SequenceSvg({ body }: { body: Body<"sequence"> }) {
  const W = 320, top = 24, rowH = 40;
  const { actors, messages } = body;
  // 1人だけの図では間隔が 0 で割れない。真ん中に置く
  const gap = actors.length > 1 ? (W - 52) / (actors.length - 1) : 0;
  const xs = actors.map((_, i) => (actors.length > 1 ? 26 + i * gap : W / 2));
  const H = top + rowH * messages.length + 14;
  return (
    <svg className="seqd" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`シーケンス図: ${actors.join(" → ")}`}>
      <defs>
        <marker id="sd-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" className="sd-arrowhead" />
        </marker>
      </defs>
      {actors.map((a, i) => (
        <g key={i}>
          <text x={xs[i]} y={14} textAnchor="middle" className="sd-actor">{a}</text>
          <line x1={xs[i]} y1={20} x2={xs[i]} y2={H - 6} className="sd-life" />
        </g>
      ))}
      {messages.map((m, i) => {
        const y = top + rowH * (i + 1) - 12;
        const from = actors.indexOf(m.from), to = actors.indexOf(m.to);
        // actors に無い名前を指す message は、矢印を引かずラベルだけ出す（座標が決まらない）
        const known = from >= 0 && to >= 0;
        const x1 = known ? xs[from] : W / 2, x2 = known ? xs[to] : W / 2;
        const mid = (x1 + x2) / 2;
        return (
          <g key={i}>
            <text x={mid} y={y - 14} textAnchor="middle" className="sd-lbl">{i + 1}.</text>
            <foreignObject x={Math.max(2, mid - 92)} y={y - 12} width={184} height={14}>
              <div style={{ font: "9.5px var(--mono)", color: "var(--ink-3)", textAlign: "center", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {known ? m.label : `${m.from} → ${m.to}: ${m.label}`}
              </div>
            </foreignObject>
            {known && (
              <line x1={x1} y1={y} x2={x2} y2={y} className={`sd-arrow ${m.change ?? ""}`} markerEnd="url(#sd-arrow)" style={{ "--d": `${(i * 0.14).toFixed(2)}s` } as CSSProperties} />
            )}
          </g>
        );
      })}
    </svg>
  );
}

/** 作図はせず、ノードと辺を箇条書きで出す。change は色に頼らず語で添える */
export function GraphList({ body }: { body: Body<"graph"> }) {
  const label = (id: string) => body.nodes.find((n) => n.id === id)?.label ?? id;
  const word = (c: Change | undefined) => (c ? <span className={`g-change ${c}`}>［{CHANGE_WORD[c]}］</span> : null);
  return (
    <div className="graphl">
      <span className="hint">{GRAPH_KIND[body.kind]}</span>
      <ul className="g-list">
        {body.nodes.map((n) => <li key={n.id}>{word(n.change)}<span className="mono">{n.label}</span></li>)}
      </ul>
      {body.edges.length > 0 && (
        <ul className="g-list">
          {body.edges.map((e, i) => (
            <li key={i}>
              {word(e.change)}
              <span className="mono">{label(e.from)} → {label(e.to)}</span>
              {e.label && <span>（{e.label}）</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
