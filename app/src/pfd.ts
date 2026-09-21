// PFD の図の配置と見た目の導出。副作用を持たない（テストは pfd.test.ts）
import { decisionTexts } from "../../shared/intake/answerText.ts";
import type { Artifact, Pfd, Process } from "../../shared/intake/pfd.ts";
import type { ProcessStatus } from "../../shared/intake/processStatus.ts";
import type { Answer, Question } from "../../shared/intake/question.ts";
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
};
/** from / to は PfdNode.key */
export type PfdEdge = { from: string; to: string; d: string };
export type PfdView = {
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

export const LOOK: Record<PfdLook, { word: string; mark: string; cls: string }> = {
  waiting: { word: "入力待ち", mark: "", cls: "pfd-waiting" },
  ready: { word: "着手可能", mark: "▷", cls: "pfd-ready" },
  running: { word: "実行中", mark: "⟳", cls: "pfd-running" },
  pr_open: { word: "PR レビュー中", mark: "PR", cls: "pfd-pr_open" },
  merged: { word: "マージ済み", mark: "✓", cls: "pfd-merged" },
  your_turn: { word: "あなたの番", mark: "◆", cls: "pfd-your_turn" },
  done: { word: "完了（人）", mark: "✓", cls: "pfd-done" },
  needs_attention: { word: "要確認", mark: "!", cls: "pfd-needs_attention" },
};

// 状態の印（PR など）の分の空き。状態で幅が変わると承認の前後で図が動くので、印の文字ではなく固定の空白で取る
const LOOK_SPACE = "   ";

export function buildPfdView(
  pfd: Pfd,
  o: {
    /** 承認後だけ渡す。キーはプロセスの id */
    statuses?: Record<string, ProcessStatus>;
    /** キーは PfdNode.key */
    comments?: Record<string, number>;
    /** キーは PfdNode.key */
    frozen?: ReadonlySet<string>;
  } = {},
): PfdView {
  const goal = new Set(pfd.goal);
  const stage = stageOf(pfd);
  const { statuses } = o;

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
    ...pfd.artifacts.map((a) => ({ kind: "artifact" as const, id: a.id, name: a.name, human: false, given: a.given, goal: goal.has(a.id), decision: a.decision !== undefined })),
    ...pfd.processes.map((p) => ({ kind: "process" as const, id: p.id, name: p.name, human: p.actor === "human", given: false, goal: false, decision: false })),
  ];
  const marks = (s: (typeof sources)[number]) => `${s.goal ? "◎ " : ""}${s.given ? "既存 " : ""}${s.decision ? "決定 " : ""}${s.human ? "人 " : ""}`;

  const layout = layoutGraph({
    shape: "graph",
    kind: "dependency",
    nodes: sources.map((s) => ({ id: pfdKey(s.kind, s.id), label: `${LOOK_SPACE}${marks(s)}${s.name}` })),
    edges: pfd.processes.flatMap((p) => [
      ...p.inputs.map((a) => ({ from: pfdKey("artifact", a), to: pfdKey("process", p.id), label: "" })),
      ...p.outputs.map((a) => ({ from: pfdKey("process", p.id), to: pfdKey("artifact", a), label: "" })),
    ]),
  });

  const nodes: PfdNode[] = layout.nodes.map((placed, i) => {
    const s = sources[i];
    const key = placed.id;
    return {
      key,
      id: s.id,
      kind: s.kind,
      label: s.name,
      x: placed.x,
      y: placed.y,
      w: placed.w,
      h: placed.h,
      human: s.human,
      given: s.given,
      goal: s.goal,
      decision: s.decision,
      stage: s.kind === "process" ? stage.get(s.id) ?? null : null,
      look: s.kind === "process" ? statuses?.[s.id]?.state ?? null : null,
      available: s.kind === "artifact" && available.has(s.id),
      comments: o.comments?.[key] ?? 0,
      change: null,
      frozen: o.frozen?.has(key) ?? false,
    };
  });

  return {
    width: layout.width,
    height: layout.height,
    nodes,
    edges: layout.edges.map((e) => ({ from: e.from, to: e.to, d: e.d })),
    removed: [],
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
      /** 決定の成果物なら、その質問の文と回答の文。回答が無ければ answer は null */
      decision: { questionId: string; prompt: string | null; answer: string | null } | null;
    }
  | { kind: "process"; key: string; process: Process; stage: number; inputs: Artifact[]; outputs: Artifact[] };

/** 選んだ要素の欄に出すもの。キーが案に無ければ null */
export function pfdElement(
  pfd: Pfd,
  key: string,
  questionSets: readonly { questions: Question[]; answers: Answer[] | null }[] = [],
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
    const questionId = artifact.decision;
    const asked = questionSets.flatMap((s) => s.questions).find((q) => q.id === questionId);
    decision = { questionId, prompt: asked?.prompt ?? null, answer: decisionTexts(questionSets)[questionId] ?? null };
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
