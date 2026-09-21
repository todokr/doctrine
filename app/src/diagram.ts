// 図（graph）の配置と、現れる順の決め方。副作用を持たない（テストは diagram.test.ts）
import type { Diagram } from "./types";

type GraphBody = Extract<Diagram["body"], { shape: "graph" }>;
export type Change = "added" | "changed" | "removed";

export type PlacedNode = {
  id: string;
  label: string;
  change?: Change;
  x: number;
  y: number;
  w: number;
  h: number;
  layer: number;
};

export type PlacedEdge = {
  from: string;
  to: string;
  label: string;
  change?: Change;
  /** SVG の path の d */
  d: string;
  labelX: number;
  labelY: number;
  /** 層を戻る辺（状態遷移の閉路など）。弧で描く */
  back: boolean;
  /** 自分へ戻る辺 */
  self: boolean;
};

export type GraphLayout = {
  width: number;
  height: number;
  nodes: PlacedNode[];
  edges: PlacedEdge[];
  /** 図に無いノードを指していて、描けなかった辺の数 */
  dropped: number;
};

const NODE_H = 28;
const LAYER_GAP = 56;
const ROW_GAP = 18;
const PAD_X = 12;
// 自己ループはノードの上に出る。弧はノードの下を回る
const PAD_TOP = 24;
const ARC_DEPTH = 26;

/** ラベルの文字数から幅を見積もる。ASCII は 1、それ以外は 2 として数える */
const nodeWidth = (label: string) => {
  let n = 0;
  for (const ch of label) n += ch.charCodeAt(0) < 128 ? 1 : 2;
  return Math.min(180, Math.max(64, n * 6.5 + 20));
};

/**
 * ノードを層（左から右の列）に割り当てて並べる。依存を足さずに描ける大きさ（数十ノード）を前提にする。
 *
 * 入ってくる辺が無いノードから nodes の順に DFS し、探索中のノードへ戻る辺を「戻る辺」として
 * 層の計算から外す。残りの辺（閉路が無い）の最長路で層を決め、同じ層の中は nodes の順に上から下へ置く。
 */
export function layoutGraph(body: GraphBody): GraphLayout {
  const index = new Map(body.nodes.map((n, i) => [n.id, i]));
  const known = body.edges.filter((e) => index.has(e.from) && index.has(e.to));
  const dropped = body.edges.length - known.length;

  const out: number[][] = body.nodes.map(() => []);
  const hasIncoming = new Set<number>();
  known.forEach((e, k) => {
    const from = index.get(e.from)!;
    const to = index.get(e.to)!;
    if (from === to) return;
    out[from].push(k);
    hasIncoming.add(to);
  });

  // 探索中（1）のノードへ戻る辺が戻る辺。訪問済み（2）への辺は前向きか横断で、閉路を作らない
  const back = new Set<number>();
  const state = body.nodes.map(() => 0);
  const visit = (n: number) => {
    state[n] = 1;
    for (const k of out[n]) {
      const to = index.get(known[k].to)!;
      if (state[to] === 1) back.add(k);
      else if (state[to] === 0) visit(to);
    }
    state[n] = 2;
  };
  const roots = body.nodes.map((_, i) => i).filter((i) => !hasIncoming.has(i));
  for (const r of roots.length ? roots : body.nodes.length ? [0] : []) if (state[r] === 0) visit(r);
  for (let i = 0; i < body.nodes.length; i++) if (state[i] === 0) visit(i);

  // 層 = 前向きの辺の最長路
  const preds: number[][] = body.nodes.map(() => []);
  known.forEach((e, k) => {
    const from = index.get(e.from)!;
    const to = index.get(e.to)!;
    if (from !== to && !back.has(k)) preds[to].push(from);
  });
  const layers: number[] = body.nodes.map(() => -1);
  const layerOf = (n: number): number => {
    if (layers[n] >= 0) return layers[n];
    layers[n] = preds[n].reduce((m, p) => Math.max(m, layerOf(p) + 1), 0);
    return layers[n];
  };
  body.nodes.forEach((_, i) => layerOf(i));

  const layerCount = layers.reduce((m, l) => Math.max(m, l + 1), 0);
  const widths = body.nodes.map((n) => nodeWidth(n.label));
  const layerWidth = Array.from({ length: layerCount }, (_, l) =>
    body.nodes.reduce((m, _, i) => (layers[i] === l ? Math.max(m, widths[i]) : m), 0)
  );
  const layerX: number[] = [];
  let cursor = PAD_X;
  for (let l = 0; l < layerCount; l++) {
    layerX.push(cursor);
    cursor += layerWidth[l] + LAYER_GAP;
  }

  const rowOf: number[] = [];
  const rows: number[] = Array.from({ length: layerCount }, () => 0);
  body.nodes.forEach((_, i) => {
    rowOf[i] = rows[layers[i]]++;
  });

  const nodes: PlacedNode[] = body.nodes.map((n, i) => ({
    id: n.id,
    label: n.label,
    change: n.change,
    x: layerX[layers[i]],
    y: PAD_TOP + rowOf[i] * (NODE_H + ROW_GAP),
    w: widths[i],
    h: NODE_H,
    layer: layers[i],
  }));

  const at = (id: string) => nodes[index.get(id)!];
  const edges: PlacedEdge[] = known.map((e, k) => {
    const a = at(e.from);
    const b = at(e.to);
    const base = { from: e.from, to: e.to, label: e.label, change: e.change };
    if (a === b) {
      const x1 = a.x + a.w * 0.35;
      const x2 = a.x + a.w * 0.65;
      return {
        ...base,
        d: `M${x1},${a.y} C${x1 - 10},${a.y - 18} ${x2 + 10},${a.y - 18} ${x2},${a.y}`,
        labelX: a.x + a.w / 2,
        labelY: a.y - 16,
        back: false,
        self: true,
      };
    }
    if (back.has(k)) {
      const x1 = a.x + a.w / 2;
      const y1 = a.y + a.h;
      const x2 = b.x + b.w / 2;
      const y2 = b.y + b.h;
      return {
        ...base,
        d: `M${x1},${y1} C${x1},${y1 + ARC_DEPTH} ${x2},${y2 + ARC_DEPTH} ${x2},${y2}`,
        labelX: (x1 + x2) / 2,
        labelY: (y1 + y2) / 2 + ARC_DEPTH * 0.75 + 10,
        back: true,
        self: false,
      };
    }
    const x1 = a.x + a.w;
    const y1 = a.y + a.h / 2;
    const x2 = b.x;
    const y2 = b.y + b.h / 2;
    const dx = Math.max(24, (x2 - x1) / 2);
    return {
      ...base,
      d: `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`,
      labelX: (x1 + x2) / 2,
      labelY: (y1 + y2) / 2 - 5,
      back: false,
      self: false,
    };
  });

  const right = nodes.reduce((m, n) => Math.max(m, n.x + n.w), 0);
  const bottom = nodes.reduce((m, n) => Math.max(m, n.y + n.h), PAD_TOP);
  const hasBack = edges.some((e) => e.back);
  return {
    width: right + PAD_X,
    height: bottom + (hasBack ? ARC_DEPTH + 22 : 12),
    nodes,
    edges,
    dropped,
  };
}

/**
 * 図の要素がいつ現れるか（0 始まりの段）。ガイドのデータには持たせず、画面が形と変更の印から決める。
 * 変わっていないものが先に現れ、加わったものが後から現れる。removed は最初から出しておき、
 * 段 3 で「削除」の見た目に変わる（動きは CSS 側）。
 * シーケンス図は message の並び順（i 番目が段 i）で、これは使わない
 */
export function motionStep(part: "node" | "edge", change: Change | undefined): number {
  if (part === "node") return change === "added" ? 2 : 0;
  return change === "added" ? 3 : 1;
}
