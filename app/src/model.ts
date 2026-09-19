// 画面の状態と、そこから導く値。副作用を持たない（テストは model.test.ts）
import type {
  DiffFile,
  Draft,
  Guide,
  LineComment,
  Project,
  ReviewEntry,
  Task,
  TaskContext,
  TaskDiff,
  TaskState,
} from "./types";
import type {
  ProjectSummary,
  ServerEvent,
  TaskListEntry,
} from "../../shared/protocol.ts";
import type { ConnectionStatus } from "./daemon/client";

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
  // failed を要確認に置くのは worktree が残っている間だけ（レビューアプリ設計spec 5章）。
  // 削除拒否の completed は refused の定義そのものが同じ規則になっている
  const failedWithEvidence = t.state === "failed" && t.worktree !== null;
  if (failedWithEvidence || t.state === "unknown" || t.refused || (t.degraded && !isTerminal(t.state))) return "check";
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
/** 「全体」か「前回レビュー以降」か。task.diff の since に対応する */
export type Scope = "all" | "since";

/** 組み立て済みの diff。meta は打ち切りや基準（base / since_step_run_id）を読むために残す */
export type DiffView = { meta: TaskDiff; files: DiffFile[] };

/**
 * since を頼んだのに前回が無くて全体が返ってきた状態。デーモンは記録が無ければ
 * merge-base に倒すので、このとき「前回レビュー以降」と名乗ると嘘になる。
 */
export const fellBackToAll = (d: DiffView, scope: Scope) =>
  scope === "since" && d.meta.since_step_run_id === null;

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
export function unguidedFiles(files: DiffFile[], guide: Guide): DiffFile[] {
  const mentioned = new Set(guide.readingOrder.flatMap((r) => r.paths));
  return files.filter((f) => !mentioned.has(f.path));
}

// ---------------------------------------------------------------- 経緯
/**
 * 今が何回目のレビューか。決着した回（承認・却下・中断）＋今の1回。
 * reviews には今まさに人を待っている awaiting の回も入るので、
 * 件数そのものに1を足すと1つ多く数える。
 */
export const reviewRound = (c: TaskContext) =>
  c.reviews.filter((r) => r.status !== "awaiting").length + 1;

/** 差し戻された回だけ。画面はここにコメントを並べる */
export const rejections = (c: TaskContext) =>
  c.reviews.filter((r): r is ReviewEntry & { status: "rejected" } => r.status === "rejected");

/**
 * 「前回レビュー以降」を出してよいか。記録（review_tree）の無い回は
 * デーモンが基準にできないので、あっても切り替えを出さない。
 */
export const hasSince = (c: TaskContext) =>
  rejections(c).some((r) => r.reviewTree !== null);

// ---------------------------------------------------------------- デーモンの state 文字列の検証
const TASK_STATES: ReadonlySet<Exclude<TaskState, "unknown">> = new Set([
  "queued", "running", "suspended", "paused", "completed", "failed", "canceled",
]);
/**
 * protocol.ts の TaskState / ServerEvent#to は、デーモンから来る JSON に対する
 * コンパイル時の注釈にすぎず、実行時の保証ではない。新しい dctld と古い画面の
 * 組み合わせなど版のずれで、知らない文字列が来ることがありうる。
 */
function isKnownState(x: string): x is Exclude<TaskState, "unknown"> {
  return (TASK_STATES as ReadonlySet<string>).has(x);
}

/**
 * 同じ値で何度も警告しない。15 秒ごとの取り直しが同じ行を読み直すので、
 * 絞らないとコンソールが埋まり、次の本物の警告が見えなくなる。
 */
const warnedStates = new Set<string>();

/**
 * 知らない state 文字列を "unknown" に落とす。捨てるとタスクが画面から消えたり
 * 「終了」に紛れたりして、ユーザーが気づけなくなるので、見える状態として残す。
 */
function toKnownState(x: string, where: string): TaskState {
  if (isKnownState(x)) return x;
  if (!warnedStates.has(x)) {
    warnedStates.add(x);
    console.warn(`知らない state を受け取った（${where}）: ${x}`);
  }
  return "unknown";
}

// ---------------------------------------------------------------- デーモンの形 → 画面の形

/**
 * task.list の has_degraded はどのステップかを教えてくれない。
 * stepRun.finished を受け取れば具体的なステップ名に置き換わる。
 */
export const DEGRADED_UNKNOWN = "(ステップ不明)";

/** プロジェクトの表示名。デーモンはパスしか持たないので末尾を使う */
export function projectKey(path: string): string {
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || path;
}

/** 同じパスからは常に同じ色。色をデーモンに持たせる話は本specでは扱わない */
export function toProject(p: ProjectSummary): Project {
  let h = 0;
  for (const ch of p.path) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return {
    id: projectKey(p.path),
    path: p.path,
    def: p.default_workflow,
    color: `hsl(${h} 45% 38%)`,
  };
}

/**
 * diff と経緯は task.list に乗らない。別の口（task.diff / task.context）で
 * 取って State の diffs / contexts に置くので、ここでは作らない。
 * previous を渡すと、イベントで足した欄（degraded など）を引き継ぐ。
 */
export function toTask(
  row: TaskListEntry,
  projects: ProjectSummary[],
  previous?: Task,
): Task {
  // デーモンは project_id しか返さない。表示名はパスの末尾から作る
  const project = projects.find((p) => p.id === row.project_id);
  return {
    id: row.id,
    wf: row.workflow_name,
    project: project ? projectKey(project.path) : String(row.project_id),
    title: row.title,
    prompt: row.prompt,
    branch: row.branch,
    worktree: row.worktree_path,
    state: toKnownState(row.state, `task.list(${row.id})`),
    step: row.current_step_id,
    // 本当の試行回数は task.list の attempt_counts から作る必要があるが、それは別issue。
    // ここでは常に1を入れる代わりに、UI 側は t.attempt を表示に使わない（使うと常に「1回目」になる）
    attempt: 1,
    prio: row.priority,
    // 「待ち始めた時刻」の記録は #43。それまでは最後に動いた時刻で代える
    since: Date.parse(row.updated_at),
    // 完了したのに worktree が残っているのは、後始末が削除を拒否したということ
    refused: row.state === "completed" && row.worktree_path !== null,
    // groupOf は `t.degraded &&` で見るので、空文字にすると要確認から落ちる。
    // has_degraded だけではどのステップか分からないので、分からないと書く
    degraded: row.has_degraded ? (previous?.degraded ?? DEGRADED_UNKNOWN) : undefined,
  };
}

// ---------------------------------------------------------------- 状態
export type Editing = LineComment & { task: string };

/**
 * 取りに行って返ってくるもの。読み込み中・失敗を「まだ無い」と同じ扱いにすると、
 * 取れていないことを「変更なし」と見せてしまう。
 */
export type Loaded<T> =
  | { kind: "loading" }
  | { kind: "ok"; value: T }
  | { kind: "error"; message: string };

export type State = {
  tasks: Task[];
  projects: Project[];
  now: number;
  view: View;
  project: string;
  sel: string | null;
  scope: Record<string, Scope>;
  /** タスクごと・範囲ごとの diff。範囲を切り替えるたびに取り直す */
  diffs: Record<string, Partial<Record<Scope, Loaded<DiffView>>>>;
  contexts: Record<string, Loaded<TaskContext>>;
  /**
   * タスクごとの取得の世代。捨てるたびに1つ上げる。取りに行った側は
   * 始めた時点の世代を持ち帰り、その間に捨てられていたら書き込まない
   * （そうしないと、承認で捨てた直後に1つ前の diff が復活する）。
   */
  gen: Record<string, number>;
  /** データディレクトリから下書きを読み終えたか。読む前に書くと空で上書きしてしまう */
  draftsLoaded: boolean;
  /** ガイドに沿って読むステップ。未設定ならガイドのあるタスクは最初のステップから、null は全体表示 */
  step: Record<string, number | null>;
  drafts: Record<string, Draft>;
  editing: Editing | null;
  modal: "reject-preview" | null;
  toast: string | null;
  conn: ConnectionStatus;
};

export const EMPTY_DRAFT: Draft = { comments: [], overall: "" };
export const draftOf = (s: State, id: string): Draft => s.drafts[id] ?? EMPTY_DRAFT;
export const diffOf = (s: State, id: string, scope: Scope): Loaded<DiffView> | undefined =>
  s.diffs[id]?.[scope];
export const contextOf = (s: State, id: string): Loaded<TaskContext> | undefined => s.contexts[id];
export const scopeOf = (s: State, id: string): Scope => s.scope[id] ?? "all";
export const genOf = (s: State, id: string): number => s.gen[id] ?? 0;
export const selectedTask = (s: State) => s.tasks.find((t) => t.id === s.sel) ?? null;

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
  | { type: "drafts.loaded"; drafts: Record<string, Draft> }
  | { type: "diff"; id: string; scope: Scope; gen: number; loaded: Loaded<DiffView> }
  | { type: "context"; id: string; gen: number; loaded: Loaded<TaskContext> }
  // approve / reject.confirm / cancel は判断そのものではない。ボタン側が rpc を
  // 送って成功したときにだけ dispatch される。ここでの役目は後片付け
  // （下書きを消す・次のレビュー待ちを選ぶ・トーストを出す）だけで、
  // 「送ってよいか」「受理されたか」はもうこの時点で確定している
  | { type: "approve" }
  | { type: "reject.preview" }
  | { type: "reject.confirm" }
  | { type: "modal.close" }
  | { type: "cancel" }
  | { type: "log.append"; id: string; line: string }
  | { type: "toast"; message: string | null }
  | { type: "sync"; tasks: Task[]; projects: Project[]; now: number }
  | { type: "daemon"; ev: ServerEvent; now: number }
  | { type: "connection"; conn: ConnectionStatus };

const updateTask = (s: State, id: string, patch: Partial<Task>): Task[] =>
  s.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t));

const setDraft = (s: State, id: string, draft: Draft): Record<string, Draft> => ({ ...s.drafts, [id]: draft });

const withoutDraft = (s: State, id: string): Record<string, Draft> => {
  const { [id]: _, ...rest } = s.drafts;
  return rest;
};

/**
 * そのタスクの取得済み diff / 経緯を捨てる。worktree は suspended の間は
 * 凍っているので 15 秒ごとに取り直さないぶん、中身が変わり得る出来事
 * （ステップが進んだ・判断を送った）では明示的に捨てる必要がある。
 */
function invalidate(s: State, id: string): Pick<State, "diffs" | "contexts" | "gen"> {
  const { [id]: _d, ...diffs } = s.diffs;
  const { [id]: _c, ...contexts } = s.contexts;
  return { diffs, contexts, gen: { ...s.gen, [id]: genOf(s, id) + 1 } };
}

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
    case "drafts.loaded": {
      // 読み込みの間に書かれた下書きを消さない。同じタスクなら画面のものが新しい
      const drafts = { ...a.drafts, ...s.drafts };
      return { ...s, drafts, draftsLoaded: true };
    }
    case "diff":
      if (a.gen !== genOf(s, a.id)) return s;
      return { ...s, diffs: { ...s.diffs, [a.id]: { ...s.diffs[a.id], [a.scope]: a.loaded } } };
    case "context":
      if (a.gen !== genOf(s, a.id)) return s;
      return { ...s, contexts: { ...s.contexts, [a.id]: a.loaded } };
    case "approve": {
      // rpc("task.approve") はもう成功している（呼び出し側が判定済み）。ここでの
      // 仕事は後片付けだけ。task.stateChanged は RPC の応答より先に届くことがあるので、
      // ローカルの t.state で「本当に受理されたか」を判定してはいけない
      // （判定するとイベントが先着した場合に後片付けが素通りし、下書きが古いまま残る）
      if (!t) return s;
      const next = { ...s, drafts: withoutDraft(s, t.id), editing: null, ...invalidate(s, t.id) };
      return { ...next, sel: selectNextReview(next, t.id), toast: `承認しました: ${t.title}` };
    }
    case "reject.preview":
      return t && canReject(draftOf(s, t.id)) ? { ...s, modal: "reject-preview" } : s;
    case "reject.confirm": {
      // 同じ理由で t.state も canReject も見ない。送ってよいかはボタン側が
      // 送信前に判定済みで、ここに来る時点でコメントはもうエージェントに向かっている
      if (!t) return s;
      const next = {
        ...s,
        drafts: withoutDraft(s, t.id),
        editing: null,
        modal: null,
        ...invalidate(s, t.id),
      };
      return { ...next, sel: selectNextReview(next, t.id), toast: `差し戻しました: ${t.title}` };
    }
    case "modal.close":
      return { ...s, modal: null };
    case "cancel":
      // 同じ理由で isTerminal も見ない。task.stateChanged が先着して canceled に
      // なっていても、送信自体は成功しているので「中止しました」は出す
      if (!t) return s;
      return { ...s, toast: "中止しました。worktree は残します" };
    case "log.append": {
      // どの画面も t.log をもう読まない。task.logs の follow（#47）までの残骸
      const target = s.tasks.find((x) => x.id === a.id);
      if (!target || target.state !== "running") return s;
      return { ...s, tasks: updateTask(s, a.id, { log: (target.log ?? "") + "\n" + a.line }) };
    }
    case "toast":
      return { ...s, toast: a.message };
    case "sync": {
      // 取り直しがイベントの取りこぼしを吸収する（レビューアプリ設計spec 4章）。
      // 連番も再送も持たないので、ここが唯一の合わせ込みの場所である。
      const ids = new Set(a.tasks.map((x) => x.id));
      const keep = <T,>(r: Record<string, T>) =>
        Object.fromEntries(Object.entries(r).filter(([id]) => ids.has(id)));
      const next: State = {
        ...s,
        tasks: a.tasks,
        projects: a.projects,
        now: a.now,
        drafts: keep(s.drafts),
        diffs: keep(s.diffs),
        contexts: keep(s.contexts),
        gen: keep(s.gen),
      };
      if (s.sel !== null && ids.has(s.sel)) return next;
      const first = sidebarOrder(a.tasks, s.view, s.project)[0];
      return { ...next, sel: first ? first.id : null, editing: null };
    }
    case "daemon": {
      const ev = a.ev;
      // 知らない event は無視する。Rust は素通しするだけなので、
      // デーモンが先に増えてもここで落ちない
      if (ev.event === "task.stateChanged") {
        if (!s.tasks.some((x) => x.id === ev.task_id)) return s;
        // 知らない state 文字列は無視せず "unknown" にする。無視するとサイドバーが
        // 古いまま固まり、まさに避けたい「気づけない」を起こす
        const state = toKnownState(ev.to, `task.stateChanged(${ev.task_id})`);
        return {
          ...s,
          now: a.now,
          tasks: updateTask(s, ev.task_id, { state, since: a.now }),
          // 状態が動いた ＝ worktree が動いた。取ってある diff と経緯はもう古い
          ...invalidate(s, ev.task_id),
        };
      }
      if (ev.event === "stepRun.started") {
        if (!s.tasks.some((x) => x.id === ev.task_id)) return s;
        return { ...s, now: a.now, tasks: updateTask(s, ev.task_id, { step: ev.step_id }) };
      }
      if (ev.event === "stepRun.finished" && ev.status === "degraded") {
        if (!s.tasks.some((x) => x.id === ev.task_id)) return s;
        return { ...s, now: a.now, tasks: updateTask(s, ev.task_id, { degraded: ev.step_id }) };
      }
      // log.line は #47、ratelimit.sample は第2段階
      return s;
    }
    case "connection":
      return { ...s, conn: a.conn };
  }
}
