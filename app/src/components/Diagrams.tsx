import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { layoutGraph, motionStep, type Change } from "../diagram";
import type { Diagram } from "../types";

type Body<S extends Diagram["body"]["shape"]> = Extract<Diagram["body"], { shape: S }>;

const CHANGE_WORD: Record<Change, string> = { added: "追加", changed: "変更", removed: "削除" };
const GRAPH_KIND: Record<Body<"graph">["kind"], string> = { relation: "関係", dependency: "依存", state: "状態遷移" };

/** `useId()` の記号（«r0» など）は url(#…) の中で WebKit が解決しないことがあるので、英数字だけにする */
const useSvgId = (name: string) => `${name}-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;

/** その図に出てくる変更の印。凡例はこれだけを出す */
function changesIn(body: Diagram["body"]): Change[] {
  const found = new Set<Change>();
  if (body.shape === "sequence") {
    for (const m of body.messages) if (m.change) found.add(m.change);
  } else {
    for (const x of [...body.nodes, ...body.edges]) if (x.change) found.add(x.change);
  }
  return (["added", "changed", "removed"] as const).filter((c) => found.has(c));
}

/**
 * shape で振り分ける。図の題名・凡例・文章版はここで付ける。
 * 動きは図の種類と変更の印から CSS が決める。最初に画面へ入ったときに一度だけ再生し、押せば再生し直せる
 */
export function DiagramView({ diagram }: { diagram: Diagram }) {
  const { body } = diagram;
  const ref = useRef<HTMLElement>(null);
  const [play, setPlay] = useState(false);
  // 押すたびに図を作り直して、CSS のアニメーションを最初から始める
  const [run, setRun] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setPlay(true);
      return;
    }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setPlay(true);
        io.disconnect();
      }
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const changes = changesIn(body);
  return (
    <figure className={`diagram ${play ? "play" : ""}`} ref={ref}>
      <figcaption className="hint">
        {diagram.title}
        {body.shape === "graph" && <span className="dg-kind">{GRAPH_KIND[body.kind]}</span>}
      </figcaption>
      <div key={run}>{body.shape === "sequence" ? <SequenceSvg body={body} /> : <GraphSvg body={body} />}</div>
      <div className="dg-foot">
        {changes.length > 0 && (
          <span className="dg-legend">
            この図の変更:{" "}
            {changes.map((c) => <span key={c} className={`g-change ${c}`}>{c === "added" ? "＋" : ""}{CHANGE_WORD[c]}</span>)}
          </span>
        )}
        <button
          type="button"
          className="btn sm dg-replay"
          onClick={() => {
            setPlay(true);
            setRun((r) => r + 1);
          }}
        >
          もう一度再生
        </button>
      </div>
      <details className="dg-text">
        <summary>図の中身を文章で読む</summary>
        {body.shape === "sequence" ? <SequenceList body={body} /> : <GraphList body={body} />}
      </details>
    </figure>
  );
}

export function SequenceSvg({ body }: { body: Body<"sequence"> }) {
  const arrowId = useSvgId("sd-arrow");
  const W = 320, top = 24, rowH = 40;
  const { actors, messages } = body;
  // 1人だけの図では間隔が 0 で割れない。真ん中に置く
  const gap = actors.length > 1 ? (W - 52) / (actors.length - 1) : 0;
  const xs = actors.map((_, i) => (actors.length > 1 ? 26 + i * gap : W / 2));
  const H = top + rowH * messages.length + 14;
  return (
    <svg className="seqd" viewBox={`0 0 ${W} ${H}`} style={{ maxWidth: W * 1.4 }} role="img" aria-label={`シーケンス図: ${actors.join(" → ")}`}>
      <defs>
        <marker id={arrowId} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
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
        const selfCall = known && from === to;
        const x1 = known ? xs[from] : W / 2, x2 = known ? xs[to] : W / 2;
        // 自分への message はライフラインの右に小さい輪を描く
        const mid = selfCall ? x1 + 34 : (x1 + x2) / 2;
        const cls = `sd-arrow ${m.change ?? ""}`;
        const delay = { "--d": `${(i * 0.14).toFixed(2)}s` } as CSSProperties;
        return (
          <g key={i}>
            <text x={mid} y={y - 14} textAnchor="middle" className="sd-lbl">{i + 1}.</text>
            <foreignObject x={Math.max(2, mid - 92)} y={y - 12} width={184} height={14}>
              <div style={{ font: "9.5px var(--mono)", color: "var(--ink-3)", textAlign: "center", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {known ? m.label : `${m.from} → ${m.to}: ${m.label}`}
              </div>
            </foreignObject>
            {known && !selfCall && (
              <line x1={x1} y1={y} x2={x2} y2={y} pathLength={1} className={cls} markerEnd={`url(#${arrowId})`} style={delay} />
            )}
            {selfCall && (
              <path d={`M${x1},${y - 8} C${x1 + 30},${y - 12} ${x1 + 30},${y + 6} ${x1},${y + 4}`} fill="none" pathLength={1} className={cls} markerEnd={`url(#${arrowId})`} style={delay} />
            )}
          </g>
        );
      })}
    </svg>
  );
}

/** 関係・依存・状態遷移を、ノードと辺としてデータから描く */
export function GraphSvg({ body }: { body: Body<"graph"> }) {
  const arrowId = useSvgId("gd-arrow");
  const { width, height, nodes, edges, dropped } = layoutGraph(body);
  // 関係は向きを主張しないので矢じりを付けない
  const arrows = body.kind !== "relation";
  const rx = body.kind === "state" ? 14 : 4;
  const step = (part: "node" | "edge", c: Change | undefined) => ({ "--step": motionStep(part, c) }) as CSSProperties;
  return (
    <>
      <svg className="graphd" viewBox={`0 0 ${width} ${height}`} style={{ maxWidth: width * 1.4 }} role="img" aria-label={`${GRAPH_KIND[body.kind]}の図`}>
        <defs>
          <marker id={arrowId} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M0,0 L10,5 L0,10 z" className="gd-arrowhead" />
          </marker>
        </defs>
        {edges.map((e, i) => (
          <g key={i} className={`ge ${e.change ?? ""}`} style={step("edge", e.change)}>
            <path d={e.d} fill="none" pathLength={1} className="ge-line" markerEnd={arrows ? `url(#${arrowId})` : undefined} />
            {e.label && <text x={e.labelX} y={e.labelY} textAnchor="middle" className="gd-lbl">{e.label}</text>}
          </g>
        ))}
        {nodes.map((n) => (
          <g key={n.id} className={`gn ${n.change ?? ""}`} style={step("node", n.change)}>
            <title>{n.label}</title>
            <rect x={n.x} y={n.y} width={n.w} height={n.h} rx={rx} />
            <text x={n.x + n.w / 2} y={n.y + n.h / 2 + 3.5} textAnchor="middle" className="gd-node">
              {n.change === "added" ? "＋ " : ""}{n.label}
            </text>
          </g>
        ))}
      </svg>
      {dropped > 0 && <p className="g-warn">描けなかった辺が{dropped}本あります（ノードの id が図にありません）</p>}
    </>
  );
}

const changeWord = (c: Change | undefined) => (c ? <span className={`g-change ${c}`}>［{CHANGE_WORD[c]}］</span> : null);

/** シーケンス図を、番号付きの文章で読む版 */
function SequenceList({ body }: { body: Body<"sequence"> }) {
  return (
    <ol className="g-list">
      {body.messages.map((m, i) => (
        <li key={i}>{changeWord(m.change)}<span className="mono">{m.from} → {m.to}</span>：{m.label}</li>
      ))}
    </ol>
  );
}

/** 作図はせず、ノードと辺を箇条書きで出す。change は色に頼らず語で添える */
export function GraphList({ body }: { body: Body<"graph"> }) {
  const label = (id: string) => body.nodes.find((n) => n.id === id)?.label ?? id;
  return (
    <div className="graphl">
      <span className="hint">{GRAPH_KIND[body.kind]}</span>
      <ul className="g-list">
        {body.nodes.map((n) => <li key={n.id}>{changeWord(n.change)}<span className="mono">{n.label}</span></li>)}
      </ul>
      {body.edges.length > 0 && (
        <ul className="g-list">
          {body.edges.map((e, i) => (
            <li key={i}>
              {changeWord(e.change)}
              <span className="mono">{label(e.from)} → {label(e.to)}</span>
              {e.label && <span>（{e.label}）</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
