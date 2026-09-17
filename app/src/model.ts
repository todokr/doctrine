// 画面の状態と、そこから導く値。副作用を持たない（テストは model.test.ts）
import type { DiffFile, Draft, LineComment, Project, StepDef, Task, TaskState } from "./types";

export const MIN = 60000;

// ---------------------------------------------------------------- 時刻の表示
const pad2 = (n: number) => String(n).padStart(2, "0");
export function clock(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
export function elapsed(ms: number, now: number): string {
  const m = Math.round((now - ms) / MIN);
  return m < 60 ? `${m}分` : `${Math.floor(m / 60)}時間${pad2(m % 60)}分`;
}
export function ago(ms: number, now: number): string {
  const m = Math.round((now - ms) / MIN);
  if (m < 1) return "たった今";
  if (m < 60) return `${m}分前`;
  if (m < 1440) return `${Math.floor(m / 60)}時間前`;
  return `${Math.floor(m / 1440)}日前`;
}

// ---------------------------------------------------------------- サイドバーの区分
export const isTerminal = (s: TaskState) => s === "completed" || s === "failed" || s === "canceled";

export type Group = "review" | "check" | "running" | "queued" | "paused" | "done";

export function groupOf(t: Task): Group {
  if (t.state === "suspended") return "review";
  if (t.state === "failed" || t.refused || (t.degraded && !isTerminal(t.state))) return "check";
  if (t.state === "running") return "running";
  if (t.state === "queued") return "queued";
  if (t.state === "paused") return "paused";
  return "done";
}

export const GROUPS: { key: Exclude<Group, "done">; name: string; sort: (a: Task, b: Task) => number }[] = [
  { key: "review", name: "レビュー待ち", sort: (a, b) => a.since - b.since },
  { key: "check", name: "要確認", sort: (a, b) => b.since - a.since },
  { key: "running", name: "実行中", sort: (a, b) => a.since - b.since },
  { key: "queued", name: "待ち", sort: (a, b) => a.prio - b.prio || a.since - b.since },
  { key: "paused", name: "一時停止", sort: (a, b) => b.since - a.since },
];

export type View = "tasks" | "done";

export const visibleTasks = (tasks: Task[], project: string) =>
  tasks.filter((t) => project === "all" || t.project === project);

/** サイドバーに並ぶ順。j / k の移動と、判断の後に次を選ぶときに使う */
export function sidebarOrder(tasks: Task[], view: View, project: string): Task[] {
  const ts = visibleTasks(tasks, project);
  if (view === "done") return ts.filter((t) => groupOf(t) === "done").sort((a, b) => b.since - a.since);
  return GROUPS.flatMap((g) => ts.filter((t) => groupOf(t) === g.key).sort(g.sort));
}

/** アイコン列の点。絞り込みに関係なく全プロジェクトを数える（見逃さないため） */
export const countReview = (tasks: Task[]) => tasks.filter((t) => groupOf(t) === "review").length;

export function timeLabel(t: Task, now: number): string {
  const g = groupOf(t);
  if (g === "review") return clock(t.since);
  if (g === "running") return elapsed(t.since, now);
  if (g === "queued") return `P${t.prio} · ${ago(t.since, now)}`;
  return ago(t.since, now);
}

// ---------------------------------------------------------------- diff
export function diffStats(f: DiffFile): { add: number; del: number } {
  let add = 0, del = 0;
  for (const h of f.hunks) {
    for (const l of h.body.split("\n")) {
      if (l[0] === "+") add++;
      else if (l[0] === "-") del++;
    }
  }
  return { add, del };
}

export type Scope = "all" | "since";

export function filesFor(t: Task, scope: Scope): DiffFile[] {
  return scope === "since" ? t.diff.filter((f) => f.since).map((f) => ({ ...f, hunks: f.since! })) : t.diff;
}

export type DiffLine = { kind: "a" | "d" | ""; text: string; old: number | null; new: number | null; line: number };

/** hunk の本文を行に分け、旧・新の行番号を振る。コメントは削除行なら旧、それ以外は新の行番号に付ける */
export function diffLines(h: { old: number; new: number; body: string }): DiffLine[] {
  let o = h.old, n = h.new;
  return h.body.split("\n").map((raw) => {
    const kind = raw[0] === "+" ? "a" : raw[0] === "-" ? "d" : "";
    const row: DiffLine = {
      kind,
      text: raw.slice(1),
      old: kind === "a" ? null : o,
      new: kind === "d" ? null : n,
      line: kind === "d" ? o : n,
    };
    if (kind !== "a") o++;
    if (kind !== "d") n++;
    return row;
  });
}

// ---------------------------------------------------------------- 差し戻し
export function composeRejection(draft: Draft): string {
  const parts = draft.comments.map((c) => `${c.path}:${c.line}\n  > ${c.quote}\n  ${c.text}`);
  const overall = draft.overall.trim();
  if (overall) parts.push(`全体: ${overall}`);
  return parts.join("\n\n");
}

export const canReject = (draft: Draft) => draft.comments.length > 0 || draft.overall.trim().length > 0;

// ---------------------------------------------------------------- Review Guide
export function unguidedFiles(t: Task): DiffFile[] {
  if (!t.guide) return [];
  const mentioned = new Set(t.guide.readingOrder.flatMap((r) => r.paths));
  return t.diff.filter((f) => !mentioned.has(f.path));
}

// ---------------------------------------------------------------- 状態
export type Editing = LineComment & { task: string };

export type State = {
  tasks: Task[];
  projects: Project[];
  workflows: Record<string, StepDef[]>;
  now: number;
  view: View;
  project: string;
  sel: string | null;
  scope: Record<string, Scope>;
  /** ガイドに沿って読むステップ。未設定ならガイドのあるタスクは最初のステップから、null は全体表示 */
  step: Record<string, number | null>;
  drafts: Record<string, Draft>;
  editing: Editing | null;
  modal: "reject-preview" | null;
  toast: string | null;
};

export const EMPTY_DRAFT: Draft = { comments: [], overall: "" };
export const draftOf = (s: State, id: string): Draft => s.drafts[id] ?? EMPTY_DRAFT;
export const selectedTask = (s: State) => s.tasks.find((t) => t.id === s.sel) ?? null;
export const stepDef = (s: State, t: Task) => s.workflows[t.wf].find((x) => x.id === t.step);

export function currentStep(s: State, t: Task): number | null {
  if (!t.guide) return null;
  const v = s.step[t.id];
  return v === undefined ? 0 : v;
}

export type Action =
  | { type: "view"; view: View }
  | { type: "project"; project: string }
  | { type: "select"; id: string }
  | { type: "move"; delta: 1 | -1 }
  | { type: "scope"; scope: Scope }
  | { type: "step"; idx: number | null }
  | { type: "comment.new"; path: string; line: number; quote: string }
  | { type: "comment.text"; text: string }
  | { type: "comment.save" }
  | { type: "comment.cancel" }
  | { type: "comment.delete"; index: number }
  | { type: "overall"; text: string }
  | { type: "approve" }
  | { type: "reject.preview" }
  | { type: "reject.confirm" }
  | { type: "modal.close" }
  | { type: "cancel" }
  | { type: "log.append"; id: string; line: string }
  | { type: "toast"; message: string | null };

const updateTask = (s: State, id: string, patch: Partial<Task>): Task[] =>
  s.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t));

const setDraft = (s: State, id: string, draft: Draft): Record<string, Draft> => ({ ...s.drafts, [id]: draft });

const withoutDraft = (s: State, id: string): Record<string, Draft> => {
  const { [id]: _, ...rest } = s.drafts;
  return rest;
};

/** 判断の後は、次のレビュー待ちを選んだ状態にする（spec 6章） */
function selectNextReview(s: State, except: string): string | null {
  const next = sidebarOrder(s.tasks, s.view, s.project).find((x) => groupOf(x) === "review" && x.id !== except);
  return next ? next.id : s.sel;
}

export function reduce(s: State, a: Action): State {
  const t = selectedTask(s);
  switch (a.type) {
    case "view": {
      const next = { ...s, view: a.view };
      const leaving = a.view === "done" || (t !== null && groupOf(t) === "done");
      const first = sidebarOrder(s.tasks, a.view, s.project)[0];
      return leaving && first ? { ...next, sel: first.id, editing: null } : next;
    }
    case "project":
      return { ...s, project: a.project };
    case "select":
      return { ...s, sel: a.id, editing: null };
    case "move": {
      const order = sidebarOrder(s.tasks, s.view, s.project);
      if (!order.length) return s;
      const i = order.findIndex((x) => x.id === s.sel);
      const n = order[Math.max(0, Math.min(order.length - 1, i + a.delta))];
      return { ...s, sel: n.id, editing: null };
    }
    case "scope":
      return t ? { ...s, scope: { ...s.scope, [t.id]: a.scope } } : s;
    case "step": {
      if (!t?.guide) return s;
      if (a.idx !== null && (a.idx < 0 || a.idx >= t.guide.readingOrder.length)) return s;
      return { ...s, step: { ...s.step, [t.id]: a.idx }, editing: null };
    }
    case "comment.new":
      return t ? { ...s, editing: { task: t.id, path: a.path, line: a.line, quote: a.quote, text: "" } } : s;
    case "comment.text":
      return s.editing ? { ...s, editing: { ...s.editing, text: a.text } } : s;
    case "comment.cancel":
      return { ...s, editing: null };
    case "comment.save": {
      const e = s.editing;
      if (!e) return s;
      const text = e.text.trim();
      if (!text) return { ...s, editing: null };
      const d = draftOf(s, e.task);
      const comment: LineComment = { path: e.path, line: e.line, quote: e.quote, text };
      return { ...s, editing: null, drafts: setDraft(s, e.task, { ...d, comments: [...d.comments, comment] }) };
    }
    case "comment.delete": {
      if (!t) return s;
      const d = draftOf(s, t.id);
      return { ...s, drafts: setDraft(s, t.id, { ...d, comments: d.comments.filter((_, i) => i !== a.index) }) };
    }
    case "overall":
      return t ? { ...s, drafts: setDraft(s, t.id, { ...draftOf(s, t.id), overall: a.text }) } : s;
    case "approve": {
      if (!t || t.state !== "suspended") return s;
      const steps = s.workflows[t.wf];
      const i = steps.findIndex((x) => x.id === t.step);
      const patch: Partial<Task> = i === steps.length - 1
        ? { state: "completed", worktree: null, since: s.now }
        : { state: "running", step: steps[i + 1].id, attempt: 1, log: `$ ${steps[i + 1].id}\n…`, since: s.now };
      const next = { ...s, tasks: updateTask(s, t.id, patch), drafts: withoutDraft(s, t.id), editing: null };
      return { ...next, sel: selectNextReview(next, t.id), toast: `承認しました: ${t.title}` };
    }
    case "reject.preview":
      return t && canReject(draftOf(s, t.id)) ? { ...s, modal: "reject-preview" } : s;
    case "reject.confirm": {
      if (!t || t.state !== "suspended") return s;
      const d = draftOf(s, t.id);
      if (!canReject(d)) return s;
      const def = stepDef(s, t);
      const next = {
        ...s,
        tasks: updateTask(s, t.id, {
          state: "running",
          step: def?.onReject ?? t.step,
          attempt: t.attempt + 1,
          since: s.now,
          reviews: [...t.reviews, { at: s.now, comment: composeRejection(d) }],
          log: "assistant: レビューの指摘を読みます\n…",
        }),
        drafts: withoutDraft(s, t.id),
        editing: null,
        modal: null,
      };
      return { ...next, sel: selectNextReview(next, t.id), toast: `差し戻しました: ${t.title}` };
    }
    case "modal.close":
      return { ...s, modal: null };
    case "cancel":
      if (!t || isTerminal(t.state)) return s;
      return { ...s, tasks: updateTask(s, t.id, { state: "canceled", since: s.now, dirty: true }), toast: "中止しました。worktree は残します" };
    case "log.append": {
      const target = s.tasks.find((x) => x.id === a.id);
      if (!target || target.state !== "running") return s;
      return { ...s, tasks: updateTask(s, a.id, { log: (target.log ?? "") + "\n" + a.line }) };
    }
    case "toast":
      return { ...s, toast: a.message };
  }
}
