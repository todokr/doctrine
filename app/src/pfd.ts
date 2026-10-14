// PFD の図の配置と見た目の導出。副作用を持たない（テストは pfd.test.ts）
import { decisionTexts } from "../../shared/intake/answerText.ts";
import type { Artifact, Pfd, Process } from "../../shared/intake/pfd.ts";
import { DIRECT_PROCESS_ID, type ProcessStatus } from "../../shared/intake/processStatus.ts";
import type { IntakeProcessView, IntakeQuestionSet } from "../../shared/protocol.ts";
import type { RailNode, RailStatus } from "../../shared/rail.ts";
import { layoutGraph, type Change } from "./diagram";

export type PfdNodeKind = "artifact" | "process";
export type PfdLook = "waiting" | "ready" | "running" | "pr_open" | "merged" | "your_turn" | "done" | "needs_attention";

export type PfdNode = {
  /** 選択とコメントの件数のキー。`a:<id>` か `p:<id>`（成果物とプロセスの id は別の名前空間） */
  key: string;
  id: string;
  kind: PfdNodeKind;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** actor: human のプロセス */
  human: boolean;
  /** プロセスの project（投入先のプロジェクトの名前）。持たないプロセスと成果物は null */
  project: string | null;
  /** 最初から揃っている成果物 */
  given: boolean;
  /** 末端の成果物（Pfd.goal） */
  goal: boolean;
  /** 決定の記録から来た成果物 */
  decision: boolean;
  /** プロセスの段（1 始まり）。成果物は null */
  stage: number | null;
  /** 承認前は null（塗らない）。成果物は常に null */
  look: PfdLook | null;
  /** 成果物が揃っているか。statuses を渡さないときは false */
  available: boolean;
  /** この要素へのコメント数 */
  comments: number;
  /** 前の案からの変化。差分の純関数ができるまで常に null */
  change: Change | null;
  /** 改訂で変えられない */
  frozen: boolean;
  /** 箱の中に描くラベルの行。幅に収まるよう折り返し、3 行を超える分は … で切る */
  lines: string[];
  /** ラベルの最初の行のベースライン。行は LINE_H ずつ下げる */
  labelY: number;
  /** 種類の印（◎・既存・決定・人・🔒）。ラベルの上の小さな行に描く。Execution の図のプロセスは持たない */
  marks: string[];
  /** Execution の図のエージェントのプロセスだけが持つ、いまのタスクの帯。タスクが無ければ []。それ以外は null */
  rail: RailNode[] | null;
  /** Execution の図のプロセスの状態の文言と、そのベースライン。状態が無ければ null */
  status: (StatusLine & { y: number }) | null;
  /** 人の番（spec 6.3）。Execution の図だけが立てる */
  attention: boolean;
};
/** from / to は PfdNode.key */
export type PfdEdge = { from: string; to: string; d: string };
export type PfdView = {
  /** exec は Execution の図（spec 6.2）。plan は計画レビューと改訂の図 */
  mode: "plan" | "exec";
  width: number;
  height: number;
  nodes: PfdNode[];
  edges: PfdEdge[];
  /** 前の案から消えた要素。差分の純関数ができるまで常に空 */
  removed: { id: string; kind: PfdNodeKind; label: string }[];
};

export const pfdKey = (kind: PfdNodeKind, id: string) => `${kind === "artifact" ? "a" : "p"}:${id}`;

/** プロセスの id → 段（1 始まり）。入力の作り手の段の最大 + 1。作り手の無い入力（given・未定義）は段 0 として数える */
const stageOf = (pfd: Pfd): Map<string, number> => {
  const producer = new Map<string, string>();
  for (const p of pfd.processes) for (const o of p.outputs) producer.set(o, p.id);
  const byId = new Map(pfd.processes.map((p) => [p.id, p]));
  const stage = new Map<string, number>();
  const walking = new Set<string>();
  const visit = (id: string): number => {
    const known = stage.get(id);
    if (known !== undefined) return known;
    // 検証が閉路を弾くので探索中に戻ることはない。戻ったら 0 として、再帰を止める
    if (walking.has(id)) return 0;
    walking.add(id);
    const inputs = byId.get(id)?.inputs ?? [];
    const s = 1 + inputs.reduce((m, a) => {
      const by = producer.get(a);
      return Math.max(m, by === undefined ? 0 : visit(by));
    }, 0);
    walking.delete(id);
    stage.set(id, s);
    return s;
  };
  for (const p of pfd.processes) visit(p.id);
  return stage;
};

/** 段ごとのプロセス id（添字 0 が段 1）。同じ段のプロセスは並列に走れる */
export function processStages(pfd: Pfd): string[][] {
  const stage = stageOf(pfd);
  const stages: string[][] = [];
  for (const p of pfd.processes) {
    const s = stage.get(p.id)! - 1;
    while (stages.length <= s) stages.push([]);
    stages[s].push(p.id);
  }
  return stages;
}

/** 改訂で変えられない要素のキー（pfdKey）。task_ids が空でないか状態が done のプロセスと、その入出力の成果物 */
export function frozenIds(pfd: Pfd, processes: readonly IntakeProcessView[]): Set<string> {
  const started = new Set(processes.filter((p) => p.task_ids.length > 0 || p.state === "done").map((p) => p.id));
  const frozen = new Set<string>();
  for (const p of pfd.processes) {
    if (!started.has(p.id)) continue;
    frozen.add(pfdKey("process", p.id));
    for (const a of [...p.inputs, ...p.outputs]) frozen.add(pfdKey("artifact", a));
  }
  return frozen;
}

export const LOOK: Record<PfdLook, { word: string }> = {
  waiting: { word: "入力待ち" },
  ready: { word: "着手可能" },
  running: { word: "実行中" },
  pr_open: { word: "PR レビュー中" },
  merged: { word: "マージ済み" },
  your_turn: { word: "あなたの番" },
  done: { word: "完了（人）" },
  needs_attention: { word: "要確認" },
};

export const BLOCKED_BY = {
  revising: "改訂中",
  paused: "一時停止中",
  no_sub_issue: "sub-issue 待ち",
} as const;

export const ATTENTION_REASON = {
  task_stopped: "タスクが止まった",
  no_pr: "PR が無い",
  pr_closed: "PR が閉じられた",
} as const;

/** LOOK の語に添える語（spec 6.6）。ready の blockedBy と needs_attention の reason だけ。ほかは null */
export function statusNote(status: ProcessStatus): string | null {
  if (status.state === "ready") return status.blockedBy === null ? null : BLOCKED_BY[status.blockedBy];
  if (status.state === "needs_attention") return ATTENTION_REASON[status.reason];
  return null;
}

/** Execution の図のプロセスの状態の文言。「word · detail」と 1 行に描く */
export type StatusLine = { word: string; detail: string | null };

/**
 * 状態の言葉と、添える語（spec 6.2）。実行中はいまのステップの名前、要確認と着手可能は statusNote。
 * 1 行が max に収まらなければ添える語を … で切る
 */
export function statusLine(status: ProcessStatus, rail: readonly RailNode[] | null, max: number): StatusLine {
  const word = LOOK[status.state].word;
  const detail = status.state === "running" ? rail?.find((r) => r.current)?.id ?? null : statusNote(status);
  if (detail === null) return { word, detail };
  const fits = (d: string) => textWidth(`${word} · ${d}`) <= max;
  if (fits(detail)) return { word, detail };
  let cut = [...detail];
  while (cut.length > 0 && !fits(`${cut.join("")}…`)) cut = cut.slice(0, -1);
  return { word, detail: `${cut.join("")}…` };
}

// 箱の寸法。幅は種類ごとに固定し、長いラベルは行を増やして収める
const BOX_W = { artifact: 168, process: 188 } as const;
const BOX_PAD_X = 8;
const BOX_PAD_Y = 7;
const LINE_H = 13;
const MARK_H = 12;
const MAX_LINES = 3;
const COL_GAP = 44;
const ROW_GAP = 14;
const PAD = 12;
/** 段の数字（プロセスの上に出す）の分の上の余白。Execution の図は段を描かないので PAD */
const PAD_TOP = 22;
/** ラベルの最初の行の、行の上端からベースラインまで */
const LABEL_ASCENT = 12;
/** Execution の図のプロセスの縦の並び。上下の余白、ラベルの最後の行から状態の文言のベースライン、そこから帯の上端 */
const EXEC_PAD_Y = 9;
const STATUS_GAP = 16;
const RAIL_TOP = 7;
/** 状態の文言のベースラインから下の、文字の下がりの分 */
const STATUS_DESCENT = 3;
export const RAIL_BAR_H = 6;
const RAIL_GAP = 2;
/** 状態の文言を収める幅。両端の丸みの分を左右から引く */
const STATUS_INSET = 12;

/** ラベルの描画幅の見積もり（px）。10.5px の文字で、ASCII は 6、それ以外は 10.5 */
export function textWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += ch.charCodeAt(0) < 128 ? 6 : 10.5;
  return w;
}

/** 幅 max に収まるよう 1 文字ずつ折り返す。ASCII の語はなるべく途中で割らない */
function wrap(label: string, max: number): string[] {
  const tokens = label.match(/[\x21-\x7e]+|\s+|[^\x00-\x7f]/gu) ?? [];
  const lines: string[] = [];
  let cur = "";
  const push = () => {
    if (cur.trim() !== "") lines.push(cur.trim());
    cur = "";
  };
  for (const t of tokens) {
    if (/^\s+$/.test(t)) {
      if (cur !== "") cur += " ";
      continue;
    }
    if (textWidth(cur + t) <= max) {
      cur += t;
      continue;
    }
    if (cur.trim() !== "") push();
    // 1 行に収まらない語は文字で割る
    for (const ch of t) {
      if (textWidth(cur + ch) > max) push();
      cur += ch;
    }
  }
  push();
  if (lines.length <= MAX_LINES) return lines;
  const kept = lines.slice(0, MAX_LINES);
  let last = kept[MAX_LINES - 1];
  while (last.length > 0 && textWidth(last + "…") > max) last = [...last].slice(0, -1).join("");
  kept[MAX_LINES - 1] = last + "…";
  return kept;
}

export function buildPfdView(
  pfd: Pfd,
  o: {
    /** 承認後だけ渡す。キーはプロセスの id */
    statuses?: Record<string, ProcessStatus>;
    /** キーは PfdNode.key */
    comments?: Record<string, number>;
    /** キーは PfdNode.key */
    frozen?: ReadonlySet<string>;
    /** Execution の図だけ渡す */
    exec?: {
      /** キーはプロセスの id。null はタスクがあるが帯が読めない */
      rails: Record<string, RailNode[] | null>;
      /** 人の番のプロセスの id */
      attention?: ReadonlySet<string>;
    };
  } = {},
): PfdView {
  const goal = new Set(pfd.goal);
  const stage = stageOf(pfd);
  const { statuses, exec } = o;

  // 状態が揃えたことになるのは、マージ済みのプロセスと、人が完了したプロセスの出力
  const available = new Set<string>();
  if (statuses) {
    for (const a of pfd.artifacts) if (a.given) available.add(a.id);
    for (const p of pfd.processes) {
      const state = statuses[p.id]?.state;
      if (state === "merged" || state === "done") for (const out of p.outputs) available.add(out);
    }
  }

  const sources = [
    ...pfd.artifacts.map((a) => ({ kind: "artifact" as const, id: a.id, name: a.name, human: false, project: null, given: a.given, goal: goal.has(a.id), decision: a.decision !== undefined })),
    ...pfd.processes.map((p) => ({ kind: "process" as const, id: p.id, name: p.name, human: p.actor === "human", project: p.project ?? null, given: false, goal: false, decision: false })),
  ];
  const keys = sources.map((s) => pfdKey(s.kind, s.id));
  const edges = pfd.processes.flatMap((p) => [
    ...p.inputs.map((a) => ({ from: pfdKey("artifact", a), to: pfdKey("process", p.id) })),
    ...p.outputs.map((a) => ({ from: pfdKey("process", p.id), to: pfdKey("artifact", a) })),
  ]);

  // 層は layoutGraph に任せる（最長路）。座標は PFD の箱の大きさで自分で置く
  const graph = layoutGraph({
    shape: "graph",
    kind: "dependency",
    nodes: keys.map((id) => ({ id, label: id })),
    edges: edges.map((e) => ({ ...e, label: "" })),
  });
  const layer = new Map(graph.nodes.map((n) => [n.id, n.layer]));
  const succ = new Map<string, string[]>(keys.map((k) => [k, []]));
  const pred = new Map<string, string[]>(keys.map((k) => [k, []]));
  for (const e of edges) {
    if (!layer.has(e.from) || !layer.has(e.to)) continue;
    succ.get(e.from)!.push(e.to);
    pred.get(e.to)!.push(e.from);
  }
  // 作り手の無い成果物（given・決定）は、最初の使い手の直前の列へ寄せる。左端に積むと辺が途中の列を横切る
  for (const k of keys) {
    if (pred.get(k)!.length > 0) continue;
    const users = succ.get(k)!.map((u) => layer.get(u)!);
    if (users.length > 0) layer.set(k, Math.min(...users) - 1);
  }

  const layerCount = Math.max(0, ...keys.map((k) => layer.get(k)! + 1));
  const columns: string[][] = Array.from({ length: layerCount }, () => []);
  for (const k of keys) columns[layer.get(k)!].push(k);

  // 列の中の順は、隣の列の位置の平均（重心）で並べ直して辺の交差を減らす。同点は nodes の順を保つ
  const pos = new Map<string, number>();
  const index = () => columns.forEach((col) => col.forEach((k, i) => pos.set(k, col.length > 1 ? i / (col.length - 1) : 0.5)));
  index();
  const reorder = (l: number, neighbors: (k: string) => string[]) => {
    const keyOf = (k: string) => {
      const ns = neighbors(k).filter((n) => pos.has(n));
      return ns.length ? ns.reduce((m, n) => m + pos.get(n)!, 0) / ns.length : pos.get(k)!;
    };
    const order = columns[l].map((k, i) => ({ k, i, v: keyOf(k) }));
    order.sort((a, b) => a.v - b.v || a.i - b.i);
    columns[l] = order.map((x) => x.k);
    index();
  };
  for (let sweep = 0; sweep < 2; sweep++) {
    for (let l = 1; l < layerCount; l++) reorder(l, (k) => pred.get(k)!);
    for (let l = layerCount - 2; l >= 0; l--) reorder(l, (k) => succ.get(k)!);
  }

  const marksOf = (s: (typeof sources)[number]): string[] =>
    exec && s.kind === "process" ? [] : [
      o.frozen?.has(pfdKey(s.kind, s.id)) && "🔒",
      s.goal && "◎",
      s.given && !s.decision && "既存",
      s.decision && "決定",
      s.human && "人",
    ].filter((m): m is string => typeof m === "string");

  const byKey = new Map(sources.map((s, i) => [keys[i], s]));
  const sized = new Map(keys.map((k): [string, { w: number; h: number; lines: string[]; marks: string[]; labelDy: number; statusDy: number | null }] => {
    const s = byKey.get(k)!;
    const w = BOX_W[s.kind];
    const lines = wrap(s.name, w - BOX_PAD_X * 2);
    const marks = marksOf(s);
    if (exec && s.kind === "process") {
      const labelDy = EXEC_PAD_Y + LABEL_ASCENT;
      const statusDy = labelDy + (lines.length - 1) * LINE_H + STATUS_GAP;
      // 人のプロセスは帯を描かない
      const bottom = s.human ? statusDy + STATUS_DESCENT : statusDy + RAIL_TOP + RAIL_BAR_H;
      return [k, { w, h: bottom + EXEC_PAD_Y, lines, marks, labelDy, statusDy }];
    }
    // 印の行は、印が無くても取る。状態の印（承認）や 🔒（改訂）が付いたときに箱の高さが変わらないように
    const h = BOX_PAD_Y * 2 + MARK_H + lines.length * LINE_H;
    return [k, { w, h, lines, marks, labelDy: BOX_PAD_Y + MARK_H + LABEL_ASCENT, statusDy: null }];
  }));

  const colW = columns.map((col) => Math.max(0, ...col.map((k) => sized.get(k)!.w)));
  const colH = columns.map((col) => col.reduce((m, k) => m + sized.get(k)!.h, 0) + Math.max(0, col.length - 1) * ROW_GAP);
  const innerH = Math.max(0, ...colH);
  const top = exec ? PAD : PAD_TOP;
  const xy = new Map<string, { x: number; y: number }>();
  let cx = PAD;
  columns.forEach((col, l) => {
    let cy = top + (innerH - colH[l]) / 2;
    for (const k of col) {
      const { w, h } = sized.get(k)!;
      xy.set(k, { x: cx + (colW[l] - w) / 2, y: cy });
      cy += h + ROW_GAP;
    }
    cx += colW[l] + COL_GAP;
  });

  const nodes: PfdNode[] = sources.map((s, i) => {
    const key = keys[i];
    const { x, y } = xy.get(key)!;
    const { w, h, lines, marks, labelDy, statusDy } = sized.get(key)!;
    const status = statusDy !== null ? statuses?.[s.id] : undefined;
    const rail = exec && s.kind === "process" && !s.human ? exec.rails[s.id] ?? [] : null;
    return {
      key,
      id: s.id,
      kind: s.kind,
      label: s.name,
      x,
      y,
      w,
      h,
      human: s.human,
      project: s.project,
      given: s.given,
      goal: s.goal,
      decision: s.decision,
      stage: s.kind === "process" ? stage.get(s.id) ?? null : null,
      look: s.kind === "process" ? statuses?.[s.id]?.state ?? null : null,
      available: s.kind === "artifact" && available.has(s.id),
      comments: o.comments?.[key] ?? 0,
      change: null,
      frozen: o.frozen?.has(key) ?? false,
      lines,
      labelY: y + labelDy,
      marks,
      rail,
      status: status === undefined ? null : { ...statusLine(status, rail, w - STATUS_INSET * 2), y: y + statusDy! },
      attention: s.kind === "process" && (exec?.attention?.has(s.id) ?? false),
    };
  });

  const box = new Map(nodes.map((n) => [n.key, n]));
  return {
    mode: exec ? "exec" : "plan",
    width: Math.max(PAD * 2, cx - COL_GAP + PAD),
    height: top + innerH + PAD,
    nodes,
    edges: edges.filter((e) => box.has(e.from) && box.has(e.to)).map((e) => {
      const a = box.get(e.from)!;
      const b = box.get(e.to)!;
      const x1 = a.x + a.w;
      const y1 = a.y + a.h / 2;
      const x2 = b.x;
      const y2 = b.y + b.h / 2;
      const dx = Math.max(16, (x2 - x1) / 2);
      return { from: e.from, to: e.to, d: `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}` };
    }),
    removed: [],
  };
}

export type RailSegment = { x: number; y: number; w: number; status: RailStatus; current: boolean };

/**
 * ノードの帯の区画。プロセスの両端は丸い（rx = 高さの半分）ので、帯の下端の高さでの丸みの内側に、さらに RAIL_GAP * 2 を空けて収める。
 * 空の帯はタスクが無い（か帯が読めない）ので灰色の 1 本にする
 */
export function railSegments(n: PfdNode): RailSegment[] {
  if (n.rail === null) return [];
  const r = n.h / 2;
  const y = n.y + n.h - EXEC_PAD_Y - RAIL_BAR_H;
  const dy = y + RAIL_BAR_H - (n.y + r);
  const inset = r - Math.sqrt(r * r - dy * dy) + RAIL_GAP * 2;
  const x0 = n.x + inset;
  const width = n.w - inset * 2;
  if (n.rail.length === 0) return [{ x: x0, y, w: width, status: "pending", current: false }];
  const count = n.rail.length;
  // ステップが多いと隙間だけで幅を食い尽くすので、隙間も区画の半分までに詰める
  const gap = Math.min(RAIL_GAP, width / (count * 2));
  const w = (width - gap * (count - 1)) / count;
  return n.rail.map((r, i) => ({ x: x0 + i * (w + gap), y, w, status: r.status, current: r.current }));
}

/** direct の Intake の図。PFD は保存しないので、Issue の題から組み立てる（spec 6.2） */
export function directPfd(issueTitle: string): Pfd {
  return {
    title: issueTitle,
    goal: ["pr"],
    artifacts: [
      { id: "issue", name: "Issue", given: true },
      { id: "pr", name: "PR", given: false },
    ],
    processes: [{ id: DIRECT_PROCESS_ID, name: issueTitle, actor: "agent", inputs: ["issue"], outputs: ["pr"] }],
  };
}

/** pfdKey の逆。形が違えば null */
export function parsePfdKey(key: string): { kind: PfdNodeKind; id: string } | null {
  const head = key.slice(0, 2);
  if (head !== "a:" && head !== "p:") return null;
  return { kind: head === "a:" ? "artifact" : "process", id: key.slice(2) };
}

export type PfdElementInfo =
  | {
      kind: "artifact";
      key: string;
      artifact: Artifact;
      goal: boolean;
      /** この成果物を出すプロセス（前段） */
      producers: Process[];
      /** この成果物を入力に取るプロセス（後続） */
      consumers: Process[];
      /**
       * 決定の成果物なら、指す質問の文か仮定の結論（見つからなければ null）と、決定の文。
       * 回答が無ければ answer は null
       */
      decision: { id: string; prompt: string | null; answer: string | null } | null;
    }
  | { kind: "process"; key: string; process: Process; stage: number; inputs: Artifact[]; outputs: Artifact[] };

/** 選んだ要素の欄に出すもの。キーが案に無ければ null */
export function pfdElement(
  pfd: Pfd,
  key: string,
  questionSets: readonly IntakeQuestionSet[] = [],
): PfdElementInfo | null {
  const parsed = parsePfdKey(key);
  if (!parsed) return null;
  const artifactsById = (ids: string[]) => ids.flatMap((id) => pfd.artifacts.filter((a) => a.id === id));

  if (parsed.kind === "process") {
    const process = pfd.processes.find((p) => p.id === parsed.id);
    if (!process) return null;
    const stage = processStages(pfd).findIndex((ids) => ids.includes(process.id)) + 1;
    return { kind: "process", key, process, stage, inputs: artifactsById(process.inputs), outputs: artifactsById(process.outputs) };
  }

  const artifact = pfd.artifacts.find((a) => a.id === parsed.id);
  if (!artifact) return null;
  let decision: Extract<PfdElementInfo, { kind: "artifact" }>["decision"] = null;
  if (artifact.decision !== undefined) {
    const id = artifact.decision;
    const asked = questionSets.flatMap((s) => s.questions).find((q) => q.id === id)?.prompt ??
      questionSets.flatMap((s) => s.assumptions).find((a) => a.id === id)?.statement;
    decision = { id, prompt: asked ?? null, answer: decisionTexts(questionSets)[id] ?? null };
  }
  return {
    kind: "artifact",
    key,
    artifact,
    goal: pfd.goal.includes(artifact.id),
    producers: pfd.processes.filter((p) => p.outputs.includes(artifact.id)),
    consumers: pfd.processes.filter((p) => p.inputs.includes(artifact.id)),
    decision,
  };
}

export type StatusCount = { look: PfdLook; word: string; count: number };

/**
 * 進行中の面の状態ごとの件数（spec 3.5）。凡例を兼ねるので件数 0 も返す。
 * merged は counts に入れず、merged / total として返す
 */
export function statusCounts(view: PfdView): { counts: StatusCount[]; merged: number; total: number } {
  const processes = view.nodes.filter((n) => n.kind === "process");
  const count = (look: PfdLook) => processes.filter((n) => n.look === look).length;
  const counts = (Object.keys(LOOK) as PfdLook[])
    .filter((look) => look !== "merged")
    .map((look) => ({ look, word: LOOK[look].word, count: count(look) }));
  return { counts, merged: count("merged"), total: processes.length };
}
