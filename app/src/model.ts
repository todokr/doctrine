// 画面の状態と、そこから導く値。副作用を持たない（テストは model.test.ts）
import type {
  DiffFile,
  Draft,
  LineComment,
  Project,
  RateLimitWindow,
  ReviewEntry,
  Task,
  TaskContext,
  TaskDiff,
  TaskState,
} from "./types";
import type {
  IntakeDetail,
  IntakeSummary,
  ProjectSummary,
  RateLimitSample,
  ServerEvent,
  StepRun,
  StepRunDenials,
  TaskDetail,
  TaskSummary,
} from "../../shared/protocol.ts";
import { toolInputParts } from "../../shared/toolInput.ts";
import type { GuideView } from "./guide";
import type { ConnectionStatus } from "./daemon/client";
import type { Answer } from "../../shared/intake/question.ts";
import {
  canRejectIntake,
  commentTarget,
  EMPTY_INTAKE_DRAFT,
  type IntakeDraft,
  intakeOrder,
  setWholeComment,
} from "./intake";

export const MIN = 60000;

// ---------------------------------------------------------------- 時刻の表示
const pad2 = (n: number) => String(n).padStart(2, "0");
export function clock(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
/** 再開予定時刻。今日か明日かまでは出さない（数時間先までしか待たない） */
export function hm(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
export function elapsed(ms: number, now: number): string {
  const m = Math.round((now - ms) / MIN);
  return m < 60 ? `${m}分` : `${Math.floor(m / 60)}時間${pad2(m % 60)}分`;
}
/** 残り時間（「47分」「3時間54分」「6日7時間」）。切り捨てる */
export function remaining(ms: number): string {
  const mins = Math.floor(ms / MIN);
  if (mins < 1) return "1分未満";
  if (mins < 60) return `${mins}分`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return mins % 60 > 0 ? `${hours}時間${mins % 60}分` : `${hours}時間`;
  const days = Math.floor(hours / 24);
  return hours % 24 > 0 ? `${days}日${hours % 24}時間` : `${days}日`;
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

export type Group = "review" | "check" | "running" | "limited" | "queued" | "paused" | "done";

export function groupOf(t: Task): Group {
  if (t.state === "suspended") return "review";
  // 要確認には入れない。人が何かする必要は無く、枠が明ければ自分で再開する
  if (t.state === "rate_limited") return "limited";
  // failed を要確認に置くのは worktree が残っている間だけ（レビューアプリ設計spec 5章）。
  // 削除拒否の completed は refused の定義そのものが同じ規則になっている
  const failedWithEvidence = t.state === "failed" && t.worktree !== null;
  if (failedWithEvidence || t.state === "unknown" || t.refused) return "check";
  if (t.state === "running") return "running";
  if (t.state === "queued") return "queued";
  if (t.state === "paused") return "paused";
  return "done";
}

export const GROUPS: { key: Exclude<Group, "done">; name: string; sort: (a: Task, b: Task) => number }[] = [
  { key: "review", name: "レビュー待ち", sort: (a, b) => a.since - b.since },
  { key: "check", name: "要確認", sort: (a, b) => b.since - a.since },
  { key: "running", name: "実行中", sort: (a, b) => a.since - b.since },
  { key: "limited", name: "上限待ち", sort: (a, b) => (a.resumeAt ?? Infinity) - (b.resumeAt ?? Infinity) },
  { key: "queued", name: "待ち", sort: (a, b) => a.prio - b.prio || a.since - b.since },
  { key: "paused", name: "一時停止", sort: (a, b) => b.since - a.since },
];

export type View = "tasks" | "done" | "intake";

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
  // task.stateChanged は期限を運ばないので、取り直しが来るまでは分からない
  if (g === "limited") return t.resumeAt ? `${hm(t.resumeAt)} 再開` : "再開時刻は取得中";
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

/**
 * 前回レビュー以降だけを見ている状態。ガイドの箇所は merge-base から tree までの diff に対して
 * 検証されているので、このとき指す箇所が画面に無いことが正常に起こる。
 * 前回が無くて全体に倒れているとき（fellBackToAll）は全体を見ているので含めない。
 */
export const isPartial = (d: DiffView, scope: Scope) => scope === "since" && !fellBackToAll(d, scope);

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

// ---------------------------------------------------------------- タスク画面

/** 行列の何番目か。1始まり。queued でないタスクは 0 */
export function queuePosition(tasks: Task[], t: Task): number {
  if (t.state !== "queued") return 0;
  return tasks
    .filter((x) => x.state === "queued")
    .sort((a, b) => a.prio - b.prio || a.since - b.since)
    .findIndex((x) => x.id === t.id) + 1;
}

/**
 * 止まった理由（レビューアプリ設計spec 7章）。並び順がそのまま優先順位で、
 * 当てはまるものを当てはまる順に返す。
 */
export type StopReason =
  | { kind: "failed"; step: string | null }
  | { kind: "refused" }
  | { kind: "queued"; position: number };

/**
 * ステップ名は task.get の stepRuns から取る。task.list の current_step_id は
 * 失敗した後も動き得る。
 */
export function stopReasons(tasks: Task[], t: Task, detail?: TaskDetail): StopReason[] {
  const runs = detail?.stepRuns ?? [];
  const out: StopReason[] = [];
  if (t.state === "failed") {
    const failed = [...runs].reverse().find((r) => r.status === "failed");
    out.push({ kind: "failed", step: failed?.step_id ?? t.step });
  }
  if (t.refused) out.push({ kind: "refused" });
  if (t.state === "queued") out.push({ kind: "queued", position: queuePosition(tasks, t) });
  return out;
}

/** 実行履歴は新しい順に見る（spec 7章は畳んで置く） */
export function stepRunHistory(detail?: TaskDetail): StepRun[] {
  return detail ? [...detail.stepRuns].reverse() : [];
}

/** 拒否1件を「ツール名 + 主要引数」の並びにする。引数は切り詰めない（コマンドを読むため）。 */
export function denialLines(d: StepRunDenials): { tool: string; detail: string }[] {
  return d.denials.map((x) => ({
    tool: x.tool_name,
    detail: toolInputParts(x.tool_name, x.input).join("  "),
  }));
}

/** 保存されなかった件数。0 なら出さない。 */
export const omittedDenials = (d: StepRunDenials) => Math.max(0, d.total - d.denials.length);

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
  "queued", "running", "suspended", "paused", "rate_limited", "completed", "failed", "canceled",
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

/** 読めない時刻は捨てる。NaN を持ち回ると「Invalid Date」が画面に出る */
function parseTime(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/**
 * 差し戻しの通知文。どのステップの指摘で戻ったかは記録から決められない
 * （差し戻したのは step であり、その手前のステップはワークフロー定義にしか無い）ので
 * 推測せず、持っている事実だけで書く。「◯回目」が何の回数かを取り違えられないよう、
 * 戻り先が何周目かではなく差し戻しの回数だと本文で言う。
 */
export function bounceNotice(b: NonNullable<Task["bounce"]>): string {
  return `${b.step} が通らず ${b.goto} に差し戻しました（差し戻しは ${b.attempt} 回目）`;
}

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
    daemonId: p.id,
    path: p.path,
    def: p.default_workflow,
    color: `hsl(${h} 45% 38%)`,
  };
}

/**
 * diff と経緯は task.list に乗らない。別の口（task.diff / task.context）で
 * 取って State の diffs / contexts に置くので、ここでは作らない。
 * previous を渡すと、イベントで足した欄（bounce）を引き継ぐ。
 */
export function toTask(
  row: TaskSummary,
  projects: ProjectSummary[],
  previous?: Task,
): Task {
  // デーモンは project_id しか返さない。表示名はパスの末尾から作る
  const project = projects.find((p) => p.id === row.project_id);
  const state = toKnownState(row.state, `task.list(${row.id})`);
  return {
    id: row.id,
    wf: row.workflow_name,
    project: project ? projectKey(project.path) : String(row.project_id),
    title: row.title,
    prompt: row.prompt,
    branch: row.branch,
    worktree: row.worktree_path,
    state,
    step: row.current_step_id,
    // 本当の試行回数は task.list の attempt_counts から作る必要があるが、それは別issue。
    // ここでは常に1を入れる代わりに、UI 側は t.attempt を表示に使わない（使うと常に「1回目」になる）
    attempt: 1,
    prio: row.priority,
    // 「待ち始めた時刻」の記録は #43。それまでは最後に動いた時刻で代える
    since: Date.parse(row.updated_at),
    resumeAt: parseTime(row.rate_limited_until),
    // 完了したのに worktree が残っているのは、後始末が削除を拒否したということ
    refused: row.state === "completed" && row.worktree_path !== null,
    // 差し戻しは task.list に載らない（進行中の一時的な出来事なので印を足さない）ので、
    // イベントで立てた値を引き継がないと 15 秒で消える。ただし終端状態のタスクには
    // 引き継がない。イベントを取りこぼすと取り直しだけで終端になることがあり、
    // 引き継ぐと完了・失敗したタスクに差し戻し中の通知が残る
    bounce: isTerminal(state) ? undefined : previous?.bounce,
  };
}

/** ratelimit.recent の行を画面の形にする。observed_at が読めない行は null（捨てる）。 */
export function toRateLimitWindow(row: RateLimitSample): RateLimitWindow | null {
  const observedAt = parseTime(row.observed_at);
  if (observedAt === null) return null;
  return {
    window: row.window,
    utilization: row.utilization,
    resetsAt: parseTime(row.resets_at),
    observedAt,
  };
}

// ---------------------------------------------------------------- 利用上限
const WINDOW_ORDER = ["five_hour", "seven_day"];
const WINDOW_LABEL: Record<string, string> = { five_hour: "5時間枠", seven_day: "7日枠" };

/**
 * バーの色が変わる利用率。どの枠も同じ値で、デーモンが反応する飽和（利用率 1）とは別の値
 * （docs/superpowers/specs/2026-09-19-rate-limit-visibility-design.md）。
 */
export const LIMIT_WARN_UTILIZATION = 0.7;
export const LIMIT_DANGER_UTILIZATION = 0.8;

export type RateLimitSeverity = "calm" | "warn" | "danger";

export type RateLimitView = {
  window: string;
  label: string;
  /** バーの長さ（0〜1） */
  fill: number;
  /** 「66% 使用」 */
  percent: string;
  severity: RateLimitSeverity;
  /** 「あと3時間54分でリセット」「リセット時刻は不明」。もうリセットされた枠では null */
  reset: string | null;
  /** 枠はもうリセットされていて、利用率はリセット前の値である */
  stale: boolean;
  /** いつ観測した値か（「3分前」） */
  observed: string;
  note: string | null;
};

function rateLimitView(w: RateLimitWindow, now: number): RateLimitView {
  const stale = w.resetsAt !== null && w.resetsAt <= now;
  const weekly = w.window === "seven_day";
  const saturated = w.utilization >= 1;
  const severity: RateLimitSeverity = stale
    ? "calm"
    : w.utilization >= LIMIT_DANGER_UTILIZATION
    ? "danger"
    : w.utilization >= LIMIT_WARN_UTILIZATION
    ? "warn"
    : "calm";
  const note = stale
    ? null
    : weekly && saturated
    ? "7日枠が飽和しています。リセットが6時間より先なら、タスクは待たずに失敗します"
    : weekly && severity === "danger"
    ? "7日枠が飽和すると、リセットが6時間より先になるのでタスクは待たずに失敗します"
    : w.window === "five_hour" && saturated
    ? "新しいタスクはリセットまで始まりません"
    : null;
  return {
    window: w.window,
    label: WINDOW_LABEL[w.window] ?? w.window,
    fill: Math.min(1, Math.max(0, w.utilization)),
    // 切り捨てる。四捨五入すると飽和の手前（0.9996）が 100% に見える。
    // 1e-9 は 0.29 * 100 が 28.999… になる誤差のぶん
    percent: `${Math.floor(w.utilization * 100 + 1e-9)}% 使用`,
    severity,
    reset: w.resetsAt === null
      ? "リセット時刻は不明"
      : stale
      ? null
      : `あと${remaining(w.resetsAt - now)}でリセット`,
    stale,
    observed: ago(w.observedAt, now),
    note,
  };
}

/** サイドバーに出す行。既知の枠を決まった順に、未知の枠はその後ろに生のキーで。 */
export function rateLimitViews(s: State): RateLimitView[] {
  const rank = (w: string) => {
    const i = WINDOW_ORDER.indexOf(w);
    return i < 0 ? WINDOW_ORDER.length : i;
  };
  return Object.values(s.limits)
    .sort((a, b) => rank(a.window) - rank(b.window) || a.window.localeCompare(b.window))
    .map((w) => rateLimitView(w, s.now));
}

// ---------------------------------------------------------------- 状態
export type Editing = LineComment & { task: string };

/** 画面が持つログ。step_run_id が変われば別のステップの実行なので入れ替える */
export type LogView = { stepRunId: number | null; lines: string[] };

/** ログの保持行数。追従したまま放置しても増え続けないように上限を持つ */
export const LOG_LINES_KEPT = 2000;

/**
 * 取りに行って返ってくるもの。読み込み中・失敗を「まだ無い」と同じ扱いにすると、
 * 取れていないことを「変更なし」と見せてしまう。
 */
export type Loaded<T> =
  | { kind: "loading" }
  | { kind: "ok"; value: T }
  | { kind: "error"; message: string };

/** レビュー画面の diff の並べ方。flow はガイドの読む順、files はファイル順 */
export type Layout = "flow" | "files";

export type State = {
  tasks: Task[];
  projects: Project[];
  /** task.get の結果。選んだタスクぶんだけ持つ */
  detail: Record<string, TaskDetail>;
  logs: Record<string, LogView>;
  /** 利用上限の枠ごとの最新の標本。キーは window 名 */
  limits: Record<string, RateLimitWindow>;
  now: number;
  view: View;
  project: string;
  sel: string | null;
  scope: Record<string, Scope>;
  /** タスクごと・範囲ごとの diff。範囲を切り替えるたびに取り直す */
  diffs: Record<string, Partial<Record<Scope, Loaded<DiffView>>>>;
  contexts: Record<string, Loaded<TaskContext>>;
  /** タスクごとのガイド。取れなかったこと（error）と、ガイドが無いこと（GuideView の none）は別 */
  guides: Record<string, Loaded<GuideView>>;
  /**
   * タスクごとの取得の世代。捨てるたびに1つ上げる。取りに行った側は
   * 始めた時点の世代を持ち帰り、その間に捨てられていたら書き込まない
   * （そうしないと、承認で捨てた直後に1つ前の diff が復活する）。
   */
  gen: Record<string, number>;
  intakes: IntakeSummary[];
  /** "new" は Issue の選択の面 */
  intakeSel: string | "new" | null;
  showClosedIntakes: boolean;
  /** intake.get の結果。選んだ Intake ぶんだけ持つ */
  intakeDetails: Record<string, Loaded<IntakeDetail>>;
  intakeGen: Record<string, number>;
  /** データディレクトリから下書きを読み終えたか。読む前に書くと空で上書きしてしまう */
  draftsLoaded: boolean;
  /** タスクごとに選んだ並べ方。未設定なら layoutOf が既定を決める */
  layout: Record<string, Layout>;
  drafts: Record<string, Draft>;
  /** Intake ごとの下書き（回答中の答え・差し戻しのコメント） */
  intakeDrafts: Record<string, IntakeDraft>;
  editing: Editing | null;
  modal: "reject-preview" | "intake-answer" | "intake-reject" | null;
  toast: string | null;
  conn: ConnectionStatus;
};

export const EMPTY_DRAFT: Draft = { comments: [], overall: "" };
export const draftOf = (s: State, id: string): Draft => s.drafts[id] ?? EMPTY_DRAFT;
export const intakeDraftOf = (s: State, id: string): IntakeDraft => s.intakeDrafts[id] ?? EMPTY_INTAKE_DRAFT;
export const diffOf = (s: State, id: string, scope: Scope): Loaded<DiffView> | undefined =>
  s.diffs[id]?.[scope];
export const contextOf = (s: State, id: string): Loaded<TaskContext> | undefined => s.contexts[id];
export const guideOf = (s: State, id: string): Loaded<GuideView> | undefined => s.guides[id];
export const scopeOf = (s: State, id: string): Scope => s.scope[id] ?? "all";
export const genOf = (s: State, id: string): number => s.gen[id] ?? 0;
export const selectedTask = (s: State) => s.tasks.find((t) => t.id === s.sel) ?? null;
export const intakeGenOf = (s: State, id: string): number => s.intakeGen[id] ?? 0;
export const intakeDetailOf = (s: State, id: string): Loaded<IntakeDetail> | undefined =>
  s.intakeDetails[id];

/** 一覧の行。一覧から消えていれば、取ってある詳細を代わりに返す */
export function selectedIntake(s: State): IntakeSummary | null {
  if (s.intakeSel === null || s.intakeSel === "new") return null;
  const row = s.intakes.find((i) => i.id === s.intakeSel);
  if (row) return row;
  const d = intakeDetailOf(s, s.intakeSel);
  return d?.kind === "ok" ? d.value : null;
}

/**
 * ガイドの読む順で diff を並べられるか。ガイドが ok で、前回レビュー以降を見ていない
 * （diff が取れるまでを含む）とき。since の diff では hunk が変わり、ガイドの id が
 * ほとんど合わないので並べない。並べ方を動かす経路（切り替えと reduce）はここを通る。
 */
export function canFlow(s: State, id: string): boolean {
  const g = guideOf(s, id);
  if (g?.kind !== "ok" || g.value.kind !== "ok") return false;
  const scope = scopeOf(s, id);
  const d = diffOf(s, id, scope);
  return !(scope === "since" && (d?.kind !== "ok" || isPartial(d.value, scope)));
}

/** 今の並べ方。canFlow でなければ files。選んでいなければ、stale でないガイドは flow、stale は files */
export function layoutOf(s: State, id: string): Layout {
  if (!canFlow(s, id)) return "files";
  const chosen = s.layout[id];
  if (chosen) return chosen;
  const g = guideOf(s, id);
  return g?.kind === "ok" && g.value.kind === "ok" && !g.value.stale ? "flow" : "files";
}

export type Action =
  | { type: "view"; view: View }
  | { type: "project"; project: string }
  | { type: "select"; id: string }
  | { type: "move"; delta: 1 | -1 }
  | { type: "scope"; scope: Scope }
  | { type: "layout"; layout: Layout }
  | { type: "comment.new"; path: string; line: number; quote: string }
  | { type: "comment.text"; text: string }
  | { type: "comment.save" }
  | { type: "comment.cancel" }
  | { type: "comment.delete"; index: number }
  | { type: "overall"; text: string }
  | { type: "drafts.loaded"; drafts: { tasks: Record<string, Draft>; intakes: Record<string, IntakeDraft> } }
  | { type: "intake.answers"; id: string; questionSetId: number; answers: Answer[] }
  | { type: "intake.comment.add"; id: string; key: string; body: string }
  | { type: "intake.comment.delete"; id: string; index: number }
  | { type: "intake.whole"; id: string; body: string }
  | { type: "intake.preview"; modal: "intake-answer" | "intake-reject" }
  // 送信が成功した後の後片付けだけ。approve / reject.confirm と同じく状態を見ない
  | { type: "intake.sent"; id: string; what: "answer" | "reject" | "approve" }
  /** 承認などが失敗したとき、詳細を取り直させる */
  | { type: "intake.reload"; id: string }
  | { type: "diff"; id: string; scope: Scope; gen: number; loaded: Loaded<DiffView> }
  | { type: "context"; id: string; gen: number; loaded: Loaded<TaskContext> }
  | { type: "guide"; id: string; gen: number; loaded: Loaded<GuideView> }
  | { type: "intake.select"; id: string | "new" }
  | { type: "intake.showClosed"; show: boolean }
  | { type: "intakes.sync"; intakes: IntakeSummary[] }
  | { type: "intake.started"; intake: IntakeSummary }
  | { type: "intake.detail"; id: string; gen: number; loaded: Loaded<IntakeDetail> }
  // approve / reject.confirm / cancel は判断そのものではない。ボタン側が rpc を
  // 送って成功したときにだけ dispatch される。ここでの役目は後片付け
  // （下書きを消す・次のレビュー待ちを選ぶ・トーストを出す）だけで、
  // 「送ってよいか」「受理されたか」はもうこの時点で確定している
  | { type: "approve" }
  | { type: "reject.preview" }
  | { type: "reject.confirm" }
  | { type: "modal.close" }
  | { type: "cancel" }
  | { type: "detail"; id: string; detail: TaskDetail }
  | { type: "logs"; id: string; logs: LogView }
  | { type: "toast"; message: string | null }
  | { type: "sync"; tasks: Task[]; projects: Project[]; now: number }
  | { type: "limits.recent"; samples: RateLimitWindow[] }
  | { type: "daemon"; ev: ServerEvent; now: number }
  | { type: "connection"; conn: ConnectionStatus };

/**
 * 流れてきた1行を足す。step_run_id が持っているものと違えば、別のステップの
 * 実行が始まったということなので入れ替える（stepRun.started を待たない）。
 */
function appendLog(
  current: LogView | undefined,
  ev: { step_run_id: number; line: string },
): LogView {
  const lines = current && current.stepRunId === ev.step_run_id ? [...current.lines, ev.line] : [
    ev.line,
  ];
  return { stepRunId: ev.step_run_id, lines: lines.slice(-LOG_LINES_KEPT) };
}

const updateTask = (s: State, id: string, patch: Partial<Task>): Task[] =>
  s.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t));

const setDraft = (s: State, id: string, draft: Draft): Record<string, Draft> => ({ ...s.drafts, [id]: draft });

const withoutDraft = (s: State, id: string): Record<string, Draft> => {
  const { [id]: _, ...rest } = s.drafts;
  return rest;
};

/**
 * そのタスクの取得済み diff / 経緯 / ガイドを捨てる。worktree は suspended の間は
 * 凍っているので 15 秒ごとに取り直さないぶん、中身が変わり得る出来事
 * （ステップが進んだ・判断を送った）では明示的に捨てる必要がある。
 * ガイドは stale の判定が worktree の今のツリーとの比較なので、捨てて取り直す。
 */
function invalidate(s: State, id: string): Pick<State, "diffs" | "contexts" | "guides" | "gen"> {
  const { [id]: _d, ...diffs } = s.diffs;
  const { [id]: _c, ...contexts } = s.contexts;
  const { [id]: _g, ...guides } = s.guides;
  return { diffs, contexts, guides, gen: { ...s.gen, [id]: genOf(s, id) + 1 } };
}

/** invalidate の Intake 版。取ってある詳細を捨て、世代を上げる */
function invalidateIntake(s: State, id: string): Pick<State, "intakeDetails" | "intakeGen"> {
  const { [id]: _, ...intakeDetails } = s.intakeDetails;
  return { intakeDetails, intakeGen: { ...s.intakeGen, [id]: intakeGenOf(s, id) + 1 } };
}

const setIntakeDraft = (s: State, id: string, patch: Partial<IntakeDraft>): Record<string, IntakeDraft> => ({
  ...s.intakeDrafts,
  [id]: { ...intakeDraftOf(s, id), ...patch },
});

const SENT_TOAST = { answer: "回答を送りました", reject: "差し戻しました", approve: "承認しました" } as const;

/** 判断の後は、次のレビュー待ちを選んだ状態にする（spec 6章） */
function selectNextReview(s: State, except: string): string | null {
  const next = sidebarOrder(s.tasks, s.view, s.project).find((x) => groupOf(x) === "review" && x.id !== except);
  return next ? next.id : s.sel;
}

export function reduce(s: State, a: Action): State {
  const t = selectedTask(s);
  switch (a.type) {
    case "view": {
      if (a.view === "intake") return { ...s, view: "intake", editing: null };
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
      if (s.view === "intake") {
        const rows = intakeOrder(s.intakes, s.projects, s.project, s.showClosedIntakes);
        if (!rows.length) return s;
        const i = rows.findIndex((x) => x.id === s.intakeSel);
        const n = i < 0 ? rows[0] : rows[Math.max(0, Math.min(rows.length - 1, i + a.delta))];
        return { ...s, intakeSel: n.id };
      }
      const order = sidebarOrder(s.tasks, s.view, s.project);
      if (!order.length) return s;
      const i = order.findIndex((x) => x.id === s.sel);
      const n = order[Math.max(0, Math.min(order.length - 1, i + a.delta))];
      return { ...s, sel: n.id, editing: null };
    }
    case "scope":
      return t ? { ...s, scope: { ...s.scope, [t.id]: a.scope } } : s;
    case "layout":
      // editing は消さない。書きかけのコメントは、どちらの並びでも同じ行に出る
      return t && canFlow(s, t.id) ? { ...s, layout: { ...s.layout, [t.id]: a.layout } } : s;
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
      const drafts = { ...a.drafts.tasks, ...s.drafts };
      const intakeDrafts = { ...a.drafts.intakes, ...s.intakeDrafts };
      return { ...s, drafts, intakeDrafts, draftsLoaded: true };
    }
    case "intake.answers":
      return {
        ...s,
        intakeDrafts: setIntakeDraft(s, a.id, { answers: { questionSetId: a.questionSetId, answers: a.answers } }),
      };
    case "intake.comment.add": {
      const target = commentTarget(a.key);
      const body = a.body.trim();
      if (!target || !body) return s;
      const d = intakeDraftOf(s, a.id);
      return { ...s, intakeDrafts: setIntakeDraft(s, a.id, { comments: [...d.comments, { ...target, body }] }) };
    }
    case "intake.comment.delete": {
      const d = intakeDraftOf(s, a.id);
      return { ...s, intakeDrafts: setIntakeDraft(s, a.id, { comments: d.comments.filter((_, i) => i !== a.index) }) };
    }
    case "intake.whole":
      return {
        ...s,
        intakeDrafts: setIntakeDraft(s, a.id, { comments: setWholeComment(intakeDraftOf(s, a.id).comments, a.body) }),
      };
    case "intake.preview": {
      if (a.modal === "intake-answer") return { ...s, modal: "intake-answer" };
      return s.intakeSel !== null && canRejectIntake(intakeDraftOf(s, s.intakeSel)) ? { ...s, modal: "intake-reject" } : s;
    }
    case "intake.sent": {
      // 同じ理由で状態を見ない。送信はもう成功していて、下書きは送った中身だから捨てる
      const patch: Partial<IntakeDraft> = a.what === "answer" ? { answers: null } : { comments: [] };
      return {
        ...s,
        intakeDrafts: setIntakeDraft(s, a.id, patch),
        modal: null,
        ...invalidateIntake(s, a.id),
        toast: SENT_TOAST[a.what],
      };
    }
    case "intake.reload":
      return { ...s, ...invalidateIntake(s, a.id) };
    case "diff":
      if (a.gen !== genOf(s, a.id)) return s;
      return { ...s, diffs: { ...s.diffs, [a.id]: { ...s.diffs[a.id], [a.scope]: a.loaded } } };
    case "context":
      if (a.gen !== genOf(s, a.id)) return s;
      return { ...s, contexts: { ...s.contexts, [a.id]: a.loaded } };
    case "guide":
      if (a.gen !== genOf(s, a.id)) return s;
      return { ...s, guides: { ...s.guides, [a.id]: a.loaded } };
    case "intake.select":
      return { ...s, intakeSel: a.id };
    case "intake.showClosed":
      return { ...s, showClosedIntakes: a.show };
    case "intakes.sync": {
      // 選んでいる Intake は、完了・中止で一覧から消えても外さない。面は取ってある詳細で描く
      const ids = new Set(a.intakes.map((i) => i.id));
      const keep = <T,>(r: Record<string, T>) =>
        Object.fromEntries(
          Object.entries(r).filter(([id]) => ids.has(id) || id === s.intakeSel),
        );
      return {
        ...s,
        intakes: a.intakes,
        intakeDetails: keep(s.intakeDetails),
        intakeGen: keep(s.intakeGen),
        intakeDrafts: keep(s.intakeDrafts),
      };
    }
    case "intake.started": {
      const has = s.intakes.some((i) => i.id === a.intake.id);
      const intakes = has
        ? s.intakes.map((i) => (i.id === a.intake.id ? a.intake : i))
        : [a.intake, ...s.intakes];
      return { ...s, intakes, intakeSel: a.intake.id };
    }
    case "intake.detail":
      if (a.gen !== intakeGenOf(s, a.id)) return s;
      return { ...s, intakeDetails: { ...s.intakeDetails, [a.id]: a.loaded } };
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
    case "detail":
      return { ...s, detail: { ...s.detail, [a.id]: a.detail } };
    case "logs":
      return { ...s, logs: { ...s.logs, [a.id]: a.logs } };
    case "toast":
      return { ...s, toast: a.message };
    case "sync": {
      // 取り直しがイベントの取りこぼしを吸収する（レビューアプリ設計spec 4章）。
      // 連番も再送も持たないので、ここが唯一の合わせ込みの場所である。
      const ids = new Set(a.tasks.map((x) => x.id));
      // 消えたタスクのぶんは捨てる。持ち続けても見る画面が無い
      const keep = <T,>(r: Record<string, T>) =>
        Object.fromEntries(Object.entries(r).filter(([id]) => ids.has(id)));
      const next: State = {
        ...s,
        tasks: a.tasks,
        projects: a.projects,
        now: a.now,
        drafts: keep(s.drafts),
        detail: keep(s.detail),
        logs: keep(s.logs),
        diffs: keep(s.diffs),
        contexts: keep(s.contexts),
        guides: keep(s.guides),
        layout: keep(s.layout),
        gen: keep(s.gen),
      };
      if (s.sel !== null && ids.has(s.sel)) return next;
      const first = sidebarOrder(a.tasks, s.view, s.project)[0];
      return { ...next, sel: first ? first.id : null, editing: null };
    }
    case "limits.recent": {
      // DB の行はイベントで届いた値より古いことがあるので、代入せず新しいほうを残す
      const limits = { ...s.limits };
      for (const w of a.samples) {
        const have = limits[w.window];
        if (!have || w.observedAt > have.observedAt) limits[w.window] = w;
      }
      return { ...s, limits };
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
          // 終わったタスクに差し戻し中の通知は無い（取り直し経路の toTask と同じ不変条件）
          tasks: updateTask(s, ev.task_id, {
            state,
            since: a.now,
            ...(isTerminal(state) ? { bounce: undefined } : {}),
          }),
          // 状態が動いた ＝ worktree が動いた。取ってある diff と経緯はもう古い
          ...invalidate(s, ev.task_id),
        };
      }
      if (ev.event === "intake.stateChanged") {
        return {
          ...s,
          intakes: s.intakes.map((i) =>
            i.id === ev.intake_id ? { ...i, state: ev.to, revising: ev.revising } : i
          ),
          ...invalidateIntake(s, ev.intake_id),
        };
      }
      if (ev.event === "intake.updated") {
        return { ...s, ...invalidateIntake(s, ev.intake_id) };
      }
      if (ev.event === "stepRun.started") {
        if (!s.tasks.some((x) => x.id === ev.task_id)) return s;
        return { ...s, now: a.now, tasks: updateTask(s, ev.task_id, { step: ev.step_id }) };
      }
      if (ev.event === "stepRun.finished") {
        const target = s.tasks.find((x) => x.id === ev.task_id);
        if (!target) return s;
        const patch: Partial<Task> = {};
        if (ev.status === "bounced" && ev.goto_step_id !== null) {
          // 持つのは最新の1件だけ。経緯の一覧は dctl get の領分
          patch.bounce = { step: ev.step_id, goto: ev.goto_step_id, attempt: ev.attempt };
        } else if (target.bounce?.step === ev.step_id) {
          // 差し戻したステップが今度は先へ進んだ（通った、あるいは本当に失敗した）。
          // 落とさないと、この通知がワークフローの残り全部の間ずっと出たままになる
          patch.bounce = undefined;
        }
        if (Object.keys(patch).length === 0) return s;
        return { ...s, now: a.now, tasks: updateTask(s, ev.task_id, patch) };
      }
      if (ev.event === "log.line") {
        if (!s.tasks.some((x) => x.id === ev.task_id)) return s;
        return { ...s, logs: { ...s.logs, [ev.task_id]: appendLog(s.logs[ev.task_id], ev) } };
      }
      if (ev.event === "task.cleanedUp") {
        if (!s.tasks.some((x) => x.id === ev.task_id)) return s;
        // 後始末が終わるまで worktree は残っている。消えた時点で要確認から外れ、
        // 拒否されたなら「要確認」に入る（groupOf が refused を見る）
        return {
          ...s,
          now: a.now,
          tasks: updateTask(s, ev.task_id, {
            worktree: ev.worktree_path,
            refused: ev.outcome === "refused",
          }),
        };
      }
      if (ev.event === "daemon.warning") {
        return { ...s, toast: ev.message };
      }
      if (ev.event === "ratelimit.sample") {
        const w: RateLimitWindow = {
          window: ev.window,
          utilization: ev.utilization,
          resetsAt: parseTime(ev.resets_at),
          observedAt: a.now,
        };
        return { ...s, now: a.now, limits: { ...s.limits, [ev.window]: w } };
      }
      return s;
    }
    case "connection": {
      if (a.conn.status !== "connected") return { ...s, conn: a.conn };
      // 繋ぎ直せたので、前の接続で失敗した取得をやり直せるようにする。
      // 失敗のまま置くと、needDiff が false のままで誰も取り直さない
      const drop = <T,>(r: Record<string, T>, failed: (v: T) => boolean) =>
        Object.fromEntries(Object.entries(r).filter(([, v]) => !failed(v)));
      return {
        ...s,
        conn: a.conn,
        diffs: drop(s.diffs, (byScope) => Object.values(byScope).every((v) => v?.kind === "error")),
        contexts: drop(s.contexts, (v) => v.kind === "error"),
        guides: drop(s.guides, (v) => v.kind === "error"),
        intakeDetails: drop(s.intakeDetails, (v) => v.kind === "error"),
      };
    }
  }
}
