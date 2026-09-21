import { describe, expect, test, vi } from "vitest";
import {
  NOW,
  PROJECTS,
  RATELIMIT_NEAR_SATURATION,
  RATELIMIT_NORMAL,
  SAMPLE_DIFF,
  seedTasks,
} from "./fixtures";
import {
  bounceNotice,
  canReject,
  composeRejection,
  countReview,
  currentStep,
  denialLines,
  diffLines,
  diffOf,
  fellBackToAll,
  groupOf,
  guideOf,
  hasSince,
  isTerminal,
  LIMIT_DANGER_UTILIZATION,
  LIMIT_WARN_UTILIZATION,
  LOG_LINES_KEPT,
  MIN,
  omittedDenials,
  queuePosition,
  rateLimitViews,
  reduce,
  rejections,
  remaining,
  reviewRound,
  sidebarOrder,
  stepRunHistory,
  stopReasons,
  timeLabel,
  toProject,
  toRateLimitWindow,
  toTask,
  unguidedFiles,
  type DiffView,
  type Loaded,
  type State,
} from "./model";
import type { GuideView } from "./guide";
import { buildDiff } from "./patch";
import type { Guide, RateLimitWindow, ReviewEntry, Task, TaskContext } from "./types";
import type {
  ProjectSummary,
  ServerEvent,
  StepRun,
  TaskDetail,
  TaskSummary,
} from "../../shared/protocol.ts";

const base = (overrides: Partial<State> = {}): State => ({
  tasks: seedTasks(),
  projects: PROJECTS,
  detail: {},
  logs: {},
  limits: {},
  now: NOW,
  view: "tasks",
  project: "all",
  sel: "t-2b91",
  scope: {},
  step: {},
  diffs: {},
  contexts: {},
  guides: {},
  gen: {},
  drafts: {},
  draftsLoaded: true,
  editing: null,
  modal: null,
  conn: { status: "connected" },
  toast: null,
  ...overrides,
});

const task = (s: State, id: string) => s.tasks.find((t) => t.id === id)!;

describe("groupOf", () => {
  const t = (patch: Partial<Task>) => ({ ...seedTasks()[0], ...patch });

  test("suspended はレビュー待ち", () => {
    expect(groupOf(t({ state: "suspended" }))).toBe("review");
  });
  test("worktree の残っている failed と、削除拒否の completed は要確認", () => {
    expect(groupOf(t({ state: "failed", worktree: "/w" }))).toBe("check");
    expect(groupOf(t({ state: "completed", refused: true, worktree: "/w" }))).toBe("check");
  });
  test("gc 済み（worktree が無い）の failed は要確認から外れる", () => {
    expect(groupOf(t({ state: "failed", worktree: null }))).toBe("done");
  });
  test("gc 済みの削除拒否だった completed も要確認から外れる", () => {
    // failed と同じ規則で動いていることを固定する
    expect(groupOf(t({ state: "completed", refused: false, worktree: null }))).toBe("done");
  });
  test("上限待ちは要確認ではなく専用の区分に入る", () => {
    // 人が何かする必要は無く、枠が明ければ自分で再開する
    expect(groupOf(t({ state: "rate_limited" }))).toBe("limited");
  });
  test("それ以外は状態のとおり", () => {
    expect(groupOf(t({ state: "running" }))).toBe("running");
    expect(groupOf(t({ state: "queued" }))).toBe("queued");
    expect(groupOf(t({ state: "paused" }))).toBe("paused");
    expect(groupOf(t({ state: "completed" }))).toBe("done");
  });
  test("unknown（版のずれで知らない state になったタスク）は要確認に入る", () => {
    expect(groupOf(t({ state: "unknown" }))).toBe("check");
  });
});

describe("isTerminal", () => {
  test("unknown は終端ではない", () => {
    expect(isTerminal("unknown")).toBe(false);
  });
});

describe("sidebarOrder", () => {
  test("区分の順に並び、レビュー待ちは古い順", () => {
    const order = sidebarOrder(seedTasks(), "tasks", "all");
    const groups = order.map(groupOf);
    expect(groups.indexOf("check")).toBeGreaterThan(groups.lastIndexOf("review"));
    expect(groups).not.toContain("done");
    const reviews = order.filter((t) => groupOf(t) === "review");
    expect(reviews.map((t) => t.since)).toEqual([...reviews.map((t) => t.since)].sort((a, b) => a - b));
  });
  test("プロジェクトで絞り込める", () => {
    expect(sidebarOrder(seedTasks(), "tasks", "blog").every((t) => t.project === "blog")).toBe(true);
  });
  test("終了ビューは終了したタスクだけを新しい順に並べる", () => {
    const order = sidebarOrder(seedTasks(), "done", "all");
    expect(order.every((t) => groupOf(t) === "done")).toBe(true);
    expect(order.map((t) => t.since)).toEqual([...order.map((t) => t.since)].sort((a, b) => b - a));
  });
  test("gc 済みの failed はタスク一覧から消え、終了ビューに移る", () => {
    const gced = seedTasks().find((t) => t.state === "failed" && t.worktree === null)!;
    expect(sidebarOrder(seedTasks(), "tasks", "all").map((t) => t.id)).not.toContain(gced.id);
    expect(sidebarOrder(seedTasks(), "done", "all").map((t) => t.id)).toContain(gced.id);
  });
});

describe("上限待ち", () => {
  const t = (patch: Partial<Task>): Task => ({ ...seedTasks()[0], state: "rate_limited", ...patch });

  test("サイドバーでは実行中と待ちの間に、再開の早い順で並ぶ", () => {
    const tasks = [
      t({ id: "late", resumeAt: 2000 }),
      { ...seedTasks()[0], id: "run", state: "running" as const },
      { ...seedTasks()[0], id: "q", state: "queued" as const },
      t({ id: "early", resumeAt: 1000 }),
    ];
    expect(sidebarOrder(tasks, "tasks", "all").map((x) => x.id)).toEqual(["run", "early", "late", "q"]);
  });

  test("timeLabel は再開予定時刻を出す", () => {
    const at = new Date(2026, 8, 19, 12, 20).getTime();
    expect(timeLabel(t({ resumeAt: at }), at - MIN)).toBe("12:20 再開");
  });

  test("再開予定時刻が無くても Invalid Date にならない", () => {
    // task.stateChanged は期限を運ばない。取り直しが来るまでは分からない
    expect(timeLabel(t({ resumeAt: null }), 0)).toBe("再開時刻は取得中");
  });

  test("toTask は rate_limited_until を resumeAt に写し、読めない値は落とす", () => {
    expect(t1({ rate_limited_until: "2026-09-19T03:20:00.000Z" }).resumeAt)
      .toBe(Date.parse("2026-09-19T03:20:00.000Z"));
    expect(t1({ rate_limited_until: null }).resumeAt).toBeNull();
    expect(t1({ rate_limited_until: "いつか" }).resumeAt).toBeNull();
  });

  test("task.stateChanged で rate_limited を受け取っても unknown に落ちない", () => {
    const s = base({ sel: null });
    const id = s.tasks[0].id;
    const next = reduce(s, {
      type: "daemon",
      ev: { event: "task.stateChanged", task_id: id, from: "running", to: "rate_limited" },
      now: 1,
    });
    expect(task(next, id).state).toBe("rate_limited");
  });
});

test("countReview は絞り込みに関係なく全プロジェクトを数える", () => {
  expect(countReview(seedTasks())).toBe(5);
});

describe("diff", () => {
  test("diffLines は削除行に旧、それ以外に新の行番号を振る", () => {
    const lines = diffLines({ old: 10, new: 20, body: " a\n-b\n+c\n d" });
    expect(lines.map((l) => [l.kind, l.old, l.new, l.line])).toEqual([
      ["", 10, 20, 20],
      ["d", 11, null, 11],
      ["a", null, 21, 21],
      ["", 12, 22, 22],
    ]);
  });
  test("ガイドが触れていないファイルを拾う（readingOrder と risks の箇所を見る）", () => {
    const guide = {
      readingOrder: [{ locations: [{ path: "src/keep.ts" }] }],
      risks: [{ locations: [{ path: "src/added.ts", hunk: "h1" }] }],
    } as unknown as Guide;
    expect(unguidedFiles(buildDiff(SAMPLE_DIFF), guide).map((f) => f.path))
      .toEqual(["logo.png", "src/gone.ts", "src/renamed.ts"]);
  });
  test("前回レビューの記録が無いまま since を頼んだ応答は「前回以降」と名乗らない", () => {
    const view: DiffView = { meta: SAMPLE_DIFF, files: [] };
    expect(fellBackToAll(view, "since")).toBe(true);
    expect(fellBackToAll(view, "all")).toBe(false);
    expect(fellBackToAll({ ...view, meta: { ...SAMPLE_DIFF, since_step_run_id: 7 } }, "since")).toBe(false);
  });
});

describe("経緯", () => {
  const entry = (o: Partial<ReviewEntry> & Pick<ReviewEntry, "status">): ReviewEntry =>
    ({ stepRunId: 1, stepId: "review", attempt: 1, startedAt: "2026-09-18T00:00:00.000Z", reviewTree: "abc",
       endedAt: "2026-09-18T00:05:00.000Z", comment: "直してください", ...o }) as ReviewEntry;
  const ctx = (reviews: ReviewEntry[]): TaskContext =>
    ({ prompt: "p", reviews, lastCommand: null, lastAgentMessage: null, reviewFiles: [] });

  test("今が何回目かは、決着した回に1を足した数（今待っている回は数えない）", () => {
    expect(reviewRound(ctx([entry({ status: "awaiting" })]))).toBe(1);
    expect(reviewRound(ctx([entry({ status: "rejected" }), entry({ status: "awaiting" })]))).toBe(2);
  });

  test("差し戻された回だけを取り出す", () => {
    const c = ctx([entry({ status: "approved" }), entry({ status: "rejected" }), entry({ status: "interrupted" })]);
    expect(rejections(c).map((r) => r.comment)).toEqual(["直してください"]);
  });

  test("記録の無い差し戻ししか無ければ「前回レビュー以降」は出さない", () => {
    expect(hasSince(ctx([entry({ status: "rejected", reviewTree: null })]))).toBe(false);
    expect(hasSince(ctx([entry({ status: "rejected" })]))).toBe(true);
    expect(hasSince(ctx([entry({ status: "awaiting" })]))).toBe(false);
  });
});

describe("差し戻しコメント", () => {
  test("行コメントと全体コメントを1つの文字列にまとめる", () => {
    const text = composeRejection({
      comments: [{ path: "src/a.ts", line: 3, quote: "return x;", text: "null を返しうる" }],
      overall: "  テストも足してください ",
    });
    expect(text).toBe("src/a.ts:3\n  > return x;\n  null を返しうる\n\n全体: テストも足してください");
  });
  test("コメントが無ければ差し戻せない", () => {
    expect(canReject({ comments: [], overall: "  " })).toBe(false);
    expect(canReject({ comments: [], overall: "理由" })).toBe(true);
  });
});

describe("reduce", () => {
  test("行コメントを下書きに足し、空なら足さない", () => {
    let s = reduce(base(), { type: "comment.new", path: "src/core/worktree.ts", line: 92, quote: "export function" });
    s = reduce(s, { type: "comment.text", text: "  " });
    s = reduce(s, { type: "comment.save" });
    expect(s.drafts["t-2b91"]).toBeUndefined();
    s = reduce(s, { type: "comment.new", path: "src/core/worktree.ts", line: 92, quote: "export function" });
    s = reduce(s, { type: "comment.text", text: "名前が曖昧" });
    s = reduce(s, { type: "comment.save" });
    expect(s.editing).toBeNull();
    expect(s.drafts["t-2b91"].comments).toEqual([{ path: "src/core/worktree.ts", line: 92, quote: "export function", text: "名前が曖昧" }]);
  });

  test("承認は状態を捏造せず、下書きを捨てて次のレビュー待ちを選び toast を出す", () => {
    // 実際の遷移はデーモンが決め、task.stateChanged で返ってくる（Task 13 で rpc に繋ぐ）
    let s = reduce(base(), { type: "overall", text: "メモ" });
    s = reduce(s, { type: "approve" });
    expect(task(s, "t-2b91")).toMatchObject({ state: "suspended", step: "review" });
    expect(s.drafts["t-2b91"]).toBeUndefined();
    expect(s.sel).toBe("b-204");
    expect(s.toast).toBe("承認しました: worktree.list をディスク上の全件にする");
  });

  test("最後のステップで承認しても完了を捏造しない", () => {
    const s = reduce(base({ sel: "s-1103", tasks: seedTasks().map((t) => (t.id === "s-1103" ? { ...t, wf: "shop-api/hotfix", step: "confirm" } : t)) }), { type: "approve" });
    // 完了させるのはデーモン。ここでは worktree も state もそのまま
    expect(task(s, "s-1103")).toMatchObject({ state: "suspended", step: "confirm" });
    expect(task(s, "s-1103").worktree).not.toBeNull();
    expect(s.drafts["s-1103"]).toBeUndefined();
    expect(s.toast).toBe("承認しました: 在庫引当のリトライを冪等にする");
  });

  test("差し戻しの確認画面は、コメントが無ければ開かない", () => {
    // 「送ってよいか」はここ（ボタンを押す前）で決める。reject.confirm 自身は
    // もう決めない（下の「イベントが先に届いても」テストの通り、無条件で後片付けする）
    expect(reduce(base(), { type: "reject.preview" }).modal).toBeNull();
  });

  test("差し戻しも状態を捏造せず、下書きを捨てて次のレビュー待ちを選び toast を出す", () => {
    let s = reduce(base(), { type: "overall", text: "全件返す理由を書いてください" });
    s = reduce(s, { type: "reject.preview" });
    expect(s.modal).toBe("reject-preview");
    s = reduce(s, { type: "reject.confirm" });
    const t = task(s, "t-2b91");
    expect(t).toMatchObject({ state: "suspended", step: "review" });
    expect(s.modal).toBeNull();
    expect(s.drafts["t-2b91"]).toBeUndefined();
    expect(s.sel).toBe("b-204");
    expect(s.toast).toBe("差し戻しました: worktree.list をディスク上の全件にする");
  });

  test("承認の後片付けは、イベントが先に届いて状態が変わっていても走る", () => {
    // デーモンは task.stateChanged を rpc の応答より先に流すことがあるので、
    // await sendDecision(...) が返る頃には、ローカルの state はもう suspended
    // ではないかもしれない。それでも「送信は成功した」という事実は変わらないので、
    // 後片付け（下書きを消す・toast を出す）は必ず走らなければならない
    const changed = seedTasks().map((x) => (x.id === "t-2b91" ? { ...x, state: "running" as const } : x));
    const s = base({ tasks: changed, drafts: { "t-2b91": { comments: [], overall: "メモ" } } });
    const after = reduce(s, { type: "approve" });
    expect(after.drafts["t-2b91"]).toBeUndefined();
    expect(after.toast).toBe("承認しました: worktree.list をディスク上の全件にする");
  });

  test("差し戻しの後片付けも同じ", () => {
    const changed = seedTasks().map((x) => (x.id === "t-2b91" ? { ...x, state: "running" as const } : x));
    const s = base({
      tasks: changed,
      modal: "reject-preview",
      drafts: { "t-2b91": { comments: [], overall: "全件返す理由" } },
    });
    const after = reduce(s, { type: "reject.confirm" });
    expect(after.drafts["t-2b91"]).toBeUndefined();
    expect(after.modal).toBeNull();
    expect(after.toast).toBe("差し戻しました: worktree.list をディスク上の全件にする");
  });

  test("中止は状態を捏造せず toast を出す。下書きは消さない", () => {
    // approve / reject.confirm と違い、中止は下書きの後片付けをしない
    // （中止は下書きの送信ではないので、下書きは残っていてよい）
    const s = base({ drafts: { "t-2b91": { comments: [], overall: "メモ" } } });
    const after = reduce(s, { type: "cancel" });
    expect(task(after, "t-2b91")).toMatchObject({ state: "suspended" });
    expect(after.drafts["t-2b91"]).toEqual({ comments: [], overall: "メモ" });
    expect(after.toast).toBe("中止しました。worktree は残します");
  });

  test("中止の後片付けは、イベントが先に届いて canceled になっていても走る", () => {
    // 送信自体はもう成功しているので、ローカルの状態が先にイベントで
    // canceled になっていても toast は出す（isTerminal も見ない）
    const changed = seedTasks().map((x) => (x.id === "t-2b91" ? { ...x, state: "canceled" as const } : x));
    const s = base({ tasks: changed });
    const after = reduce(s, { type: "cancel" });
    expect(after.toast).toBe("中止しました。worktree は残します");
  });

  test("j / k の移動はサイドバーの端で止まる", () => {
    const order = sidebarOrder(seedTasks(), "tasks", "all");
    let s = base({ sel: order[0].id });
    s = reduce(s, { type: "move", delta: -1 });
    expect(s.sel).toBe(order[0].id);
    s = reduce(s, { type: "move", delta: 1 });
    expect(s.sel).toBe(order[1].id);
  });

  test("終了ビューに切り替えると終了したタスクを選ぶ", () => {
    const s = reduce(base(), { type: "view", view: "done" });
    expect(groupOf(task(s, s.sel!))).toBe("done");
  });

  test("ガイドのステップは範囲外へ動かない", () => {
    const guide = { readingOrder: [{}, {}, {}, {}], risks: [] } as unknown as Guide;
    const view: GuideView = { kind: "ok", guide, createdAt: "2026-09-21T00:00:00Z", stale: false };
    const s = base({ sel: "t-9f21", guides: { "t-9f21": { kind: "ok", value: view } } });
    expect(reduce(s, { type: "step", idx: 4 })).toBe(s);
    expect(reduce(s, { type: "step", idx: 3 }).step["t-9f21"]).toBe(3);
    expect(reduce(s, { type: "step", idx: null }).step["t-9f21"]).toBeNull();
  });

  test("ログの取得結果はタスクごとに持つ", () => {
    const s = reduce(base(), {
      type: "logs",
      id: "t-7f3a",
      logs: { stepRunId: 7, lines: ["a", "b"] },
    });
    expect(s.logs["t-7f3a"]).toEqual({ stepRunId: 7, lines: ["a", "b"] });
  });
});

const row = (o: Partial<TaskSummary> = {}): TaskSummary => ({
  id: "t-1",
  project_id: 1,
  title: "タイトル",
  prompt: "指示",
  workflow_name: "feature",
  state: "queued",
  current_step_id: null,
  branch: "doctrine/t-1",
  worktree_path: null,
  rate_limited_until: null,
  priority: 2,
  created_at: "2026-09-18T00:00:00.000Z",
  updated_at: "2026-09-18T00:10:00.000Z",
  ...o,
});

const summary = (o: Partial<ProjectSummary> = {}): ProjectSummary => ({
  id: 1,
  path: "/home/u/git/doctrine",
  default_workflow: "feature",
  max_concurrent: 2,
  base_branch: "main",
  setup: null,
  ...o,
});

const PJ = [summary()];
const t1 = (o: Partial<TaskSummary> = {}) => toTask(row(o), PJ);

describe("toProject / toTask", () => {
  test("プロジェクトの表示名はパスの末尾", () => {
    expect(toProject(summary()).id).toBe("doctrine");
    expect(toProject(summary({ path: "/home/u/work/shop-api/" })).id).toBe("shop-api");
  });

  test("同じパスからは同じ色が出る", () => {
    expect(toProject(summary()).color).toBe(toProject(summary()).color);
    expect(toProject(summary()).color).not.toBe(toProject(summary({ path: "/x/y" })).color);
  });

  test("project_id を突き合わせて表示名にする", () => {
    expect(t1().project).toBe("doctrine");
    // 取得の前後でずれてプロジェクトが見つからないことはありうる
    expect(toTask(row({ project_id: 99 }), PJ).project).toBe("99");
  });

  test("since は updated_at から作る（待ち始めた時刻の記録は #43）", () => {
    expect(t1().since).toBe(Date.parse("2026-09-18T00:10:00.000Z"));
  });

  test("削除拒否は completed かつ worktree が残っていることで分かる", () => {
    expect(t1({ state: "completed", worktree_path: "/w" }).refused).toBe(true);
    expect(t1({ state: "completed", worktree_path: null }).refused).toBe(false);
    expect(t1({ state: "failed", worktree_path: "/w" }).refused).toBe(false);
  });

  test("failed が要確認に入るかは worktree_path の有無で決まる", () => {
    expect(groupOf(t1({ state: "failed", worktree_path: "/w" }))).toBe("check");
    expect(groupOf(t1({ state: "failed", worktree_path: null }))).toBe("done");
  });

  test("差し戻しの通知は 15 秒ごとの取り直しで消えない", () => {
    const bounce = { step: "test", goto: "implement", attempt: 1 };
    const before = { ...t1({ state: "running" }), bounce };
    expect(toTask(row({ state: "running" }), PJ, before).bounce).toEqual(bounce);
  });

  test("終わったタスクには差し戻しの通知を引き継がない", () => {
    // イベントを取りこぼして取り直しだけで終端状態になることがある。引き継ぐと
    // 完了・失敗したタスクに差し戻し中の通知が残る
    const before = { ...t1({ state: "running" }), bounce: { step: "test", goto: "implement", attempt: 1 } };
    expect(toTask(row({ state: "completed" }), PJ, before).bounce).toBeUndefined();
  });

  test("知らない state 文字列はタスクを消さず unknown にする（版のずれ対策）", () => {
    // TaskSummary#state は protocol.ts 上は TaskState だが、それはコンパイル時の
    // 注釈にすぎない。JSON で来る実行時の値は保証されないので、あえて型をはみ出させる
    const weird = row({ state: "half-migrated" as unknown as TaskSummary["state"] });
    const task = toTask(weird, PJ);
    expect(task.state).toBe("unknown");
    expect(task.id).toBe(weird.id);
  });

  test("知っている状態はそのまま通す", () => {
    // 「全部 unknown にする」という壊し方を、既存のテストは捕まえられない
    for (const state of ["queued", "running", "suspended", "paused", "rate_limited", "completed", "failed", "canceled"] as const) {
      expect(t1({ state }).state).toBe(state);
    }
  });

  test("知らない state の警告は同じ値では1回だけ出す（15秒ごとの取り直しでコンソールを埋めない）", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const weird = { state: "never-seen-before" as unknown as TaskSummary["state"] };
      toTask(row(weird), PJ);
      toTask(row(weird), PJ);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("sync", () => {
  test("知らないタスクが増え、消えたタスクは落ちる", () => {
    const s = base({ tasks: [], projects: [], sel: null });
    const a = t1({ id: "a", state: "suspended" });
    const b = t1({ id: "b", state: "suspended" });
    const one = reduce(s, { type: "sync", tasks: [a, b], projects: [], now: 1 });
    expect(one.tasks.map((t) => t.id)).toEqual(["a", "b"]);
    const two = reduce(one, { type: "sync", tasks: [a], projects: [], now: 2 });
    expect(two.tasks.map((t) => t.id)).toEqual(["a"]);
  });

  test("選択中のタスクが消えたら先頭を選び直す", () => {
    const a = t1({ id: "a", state: "suspended" });
    const b = t1({ id: "b", state: "suspended" });
    const s = reduce(base({ tasks: [], projects: [], sel: null }), {
      type: "sync", tasks: [a, b], projects: [], now: 1,
    });
    const picked = reduce(s, { type: "select", id: "b" });
    const after = reduce(picked, { type: "sync", tasks: [a], projects: [], now: 2 });
    expect(after.sel).toBe("a");
  });

  test("選択中のタスクが残っていれば選択は動かない", () => {
    const a = t1({ id: "a", state: "suspended" });
    const b = t1({ id: "b", state: "suspended" });
    const s = reduce(base({ tasks: [], projects: [], sel: null }), {
      type: "sync", tasks: [a, b], projects: [], now: 1,
    });
    const picked = reduce(s, { type: "select", id: "b" });
    expect(reduce(picked, { type: "sync", tasks: [a, b], projects: [], now: 2 }).sel).toBe("b");
  });

  test("消えたタスクの下書きは捨てる", () => {
    const a = t1({ id: "a", state: "suspended" });
    const s = base({
      tasks: [a],
      projects: [],
      sel: "a",
      drafts: { a: { comments: [], overall: "残す" }, gone: { comments: [], overall: "捨てる" } },
    });
    const after = reduce(s, { type: "sync", tasks: [a], projects: [], now: 2 });
    expect(Object.keys(after.drafts)).toEqual(["a"]);
  });
});

describe("daemon イベント", () => {
  const withTask = () => {
    const t = t1({ id: "a", state: "running", current_step_id: "implement" });
    return base({ tasks: [t], projects: [], sel: "a" });
  };

  test("task.stateChanged で状態と経過の起点が動く", () => {
    const after = reduce(withTask(), {
      type: "daemon",
      ev: { event: "task.stateChanged", task_id: "a", from: "running", to: "suspended" },
      now: 999,
    });
    expect(after.tasks[0].state).toBe("suspended");
    expect(after.tasks[0].since).toBe(999);
  });

  test("stepRun.started で今のステップが動く", () => {
    const after = reduce(withTask(), {
      type: "daemon",
      ev: { event: "stepRun.started", task_id: "a", step_run_id: 1, step_id: "test" },
      now: 999,
    });
    expect(after.tasks[0].step).toBe("test");
  });

  const bounceEvent = (o: Partial<{ step_id: string; status: string; goto_step_id: string | null; attempt: number }> = {}) => ({
    event: "stepRun.finished" as const, task_id: "a", step_run_id: 1,
    step_id: "test", status: "bounced", goto_step_id: "implement", attempt: 1,
    ...o,
  });

  test("stepRun.finished の bounced は差し戻しとして持ち、失敗扱いにしない", () => {
    const after = reduce(withTask(), { type: "daemon", ev: bounceEvent(), now: 999 });
    expect(after.tasks[0].bounce).toEqual({ step: "test", goto: "implement", attempt: 1 });
    // 差し戻しは「要確認」でも「終了」でもない。ワークフローは続いている
    expect(groupOf(after.tasks[0])).toBe("running");
  });

  test("差し戻してもサイドバーの並びは変わらない", () => {
    const a = t1({ id: "a", state: "running", current_step_id: "test" });
    const b = t1({ id: "b", state: "running", current_step_id: "x" });
    const s = base({ tasks: [a, b], projects: [], sel: "a" });
    const before = sidebarOrder(s.tasks, "tasks", "all").map((t) => t.id);
    const after = reduce(s, { type: "daemon", ev: bounceEvent(), now: 999 });
    expect(sidebarOrder(after.tasks, "tasks", "all").map((t) => t.id)).toEqual(before);
  });

  test("同じステップが今度は通ったら差し戻しの通知は消える", () => {
    const bounced = reduce(withTask(), { type: "daemon", ev: bounceEvent(), now: 999 });
    const after = reduce(bounced, {
      type: "daemon",
      ev: bounceEvent({ status: "success", goto_step_id: null, attempt: 2 }),
      now: 1000,
    });
    expect(after.tasks[0].bounce).toBeUndefined();
  });

  test("別のステップが終わっても差し戻しの通知は残る", () => {
    const bounced = reduce(withTask(), { type: "daemon", ev: bounceEvent(), now: 999 });
    const after = reduce(bounced, {
      type: "daemon",
      ev: bounceEvent({ step_id: "implement", status: "success", goto_step_id: null, attempt: 2 }),
      now: 1000,
    });
    expect(after.tasks[0].bounce).toEqual({ step: "test", goto: "implement", attempt: 1 });
  });

  test("タスクが終わったら差し戻しの通知は消える", () => {
    const bounced = reduce(withTask(), { type: "daemon", ev: bounceEvent(), now: 999 });
    const after = reduce(bounced, {
      type: "daemon",
      ev: { event: "task.stateChanged", task_id: "a", from: "running", to: "completed" },
      now: 1000,
    });
    expect(after.tasks[0].bounce).toBeUndefined();
  });

  test("知らないタスクのイベントは何も壊さない", () => {
    const s = withTask();
    const after = reduce(s, {
      type: "daemon",
      ev: { event: "task.stateChanged", task_id: "知らない", from: "queued", to: "running" },
      now: 999,
    });
    expect(after.tasks).toEqual(s.tasks);
  });

  test("知らない to は無視せず unknown にする（イベントを捨てるとサイドバーが古いまま固まる）", () => {
    const after = reduce(withTask(), {
      type: "daemon",
      ev: { event: "task.stateChanged", task_id: "a", from: "running", to: "half-migrated" },
      now: 999,
    });
    expect(after.tasks[0].state).toBe("unknown");
    expect(after.tasks[0].since).toBe(999);
  });

  test("知らない event は無視する", () => {
    const s = withTask();
    const after = reduce(s, {
      type: "daemon",
      ev: { event: "なにか.新しい" } as unknown as ServerEvent,
      now: 999,
    });
    expect(after).toEqual(s);
  });

  const line = (s: State, step_run_id: number, l: string): State =>
    reduce(s, {
      type: "daemon",
      ev: { event: "log.line", task_id: "a", step_run_id, line: l },
      now: 999,
    });

  test("log.line は同じステップ実行の間だけ積み上がる", () => {
    const after = line(line(withTask(), 3, "一行目"), 3, "二行目");
    expect(after.logs["a"]).toEqual({ stepRunId: 3, lines: ["一行目", "二行目"] });
  });

  test("log.line の step_run_id が変わったら入れ替える（前のステップのログを混ぜない）", () => {
    const after = line(line(withTask(), 3, "前のステップ"), 4, "次のステップ");
    expect(after.logs["a"]).toEqual({ stepRunId: 4, lines: ["次のステップ"] });
  });

  test("ログは上限を超えたら古い行から落とす", () => {
    let s = withTask();
    for (let i = 0; i < LOG_LINES_KEPT + 5; i++) s = line(s, 3, `l${i}`);
    expect(s.logs["a"].lines.length).toBe(LOG_LINES_KEPT);
    expect(s.logs["a"].lines[0]).toBe("l5");
  });

  test("task.cleanedUp の removed は worktree が消えたことを伝える", () => {
    const s = base({
      tasks: [{ ...t1({ id: "a", state: "completed" }), worktree: "/w", refused: true }],
      sel: "a",
    });
    const after = reduce(s, {
      type: "daemon",
      ev: {
        event: "task.cleanedUp", task_id: "a", outcome: "removed", worktree_path: null,
      },
      now: 999,
    });
    expect(after.tasks[0].worktree).toBeNull();
    expect(after.tasks[0].refused).toBe(false);
    expect(groupOf(after.tasks[0])).toBe("done");
  });

  test("task.cleanedUp の refused は要確認に入れる", () => {
    const s = base({
      tasks: [{ ...t1({ id: "a", state: "completed" }), worktree: "/w", refused: false }],
      sel: "a",
    });
    const after = reduce(s, {
      type: "daemon",
      ev: {
        event: "task.cleanedUp", task_id: "a", outcome: "refused",
        worktree_path: "/w", warning: "未コミットの変更が残っています",
      },
      now: 999,
    });
    expect(after.tasks[0].refused).toBe(true);
    expect(groupOf(after.tasks[0])).toBe("check");
  });

  test("daemon.warning はトーストで知らせる", () => {
    const after = reduce(withTask(), {
      type: "daemon",
      ev: { event: "daemon.warning", at: "2026-09-19T00:00:00.000Z", message: "消せませんでした" },
      now: 999,
    });
    expect(after.toast).toBe("消せませんでした");
  });
});

describe("取ってきた diff と経緯", () => {
  const view: DiffView = { meta: SAMPLE_DIFF, files: buildDiff(SAMPLE_DIFF) };
  const loadedAll = (s: State) =>
    reduce(s, { type: "diff", id: "t-2b91", scope: "all", gen: 0, loaded: { kind: "ok", value: view } });

  test("範囲ごとに別々に持つ", () => {
    let s = loadedAll(base());
    s = reduce(s, { type: "diff", id: "t-2b91", scope: "since", gen: 0, loaded: { kind: "loading" } });
    expect(diffOf(s, "t-2b91", "all")).toEqual({ kind: "ok", value: view });
    expect(diffOf(s, "t-2b91", "since")).toEqual({ kind: "loading" });
  });

  test("状態が動いたら捨てる（取り直しの合図になる）", () => {
    const s = reduce(loadedAll(base()), {
      type: "daemon",
      ev: { event: "task.stateChanged", task_id: "t-2b91", from: "suspended", to: "running" },
      now: 1,
    });
    expect(diffOf(s, "t-2b91", "all")).toBeUndefined();
  });

  test("承認・差し戻しでも捨てる", () => {
    expect(diffOf(reduce(loadedAll(base()), { type: "approve" }), "t-2b91", "all")).toBeUndefined();
    const s = reduce(loadedAll(base({ modal: "reject-preview" })), { type: "reject.confirm" });
    expect(diffOf(s, "t-2b91", "all")).toBeUndefined();
  });

  test("捨てた後に届いた古い応答は書き込まない", () => {
    // 承認を送った直後に、その前に始めた task.diff が返ってくる順序がありうる。
    // そのまま書くと、もう捨てたはずの diff が画面に戻ってしまう
    const s = reduce(loadedAll(base()), { type: "approve" });
    const late = reduce(s, { type: "diff", id: "t-2b91", scope: "all", gen: 0, loaded: { kind: "ok", value: view } });
    expect(diffOf(late, "t-2b91", "all")).toBeUndefined();
  });

  test("消えたタスクのぶんは取り直しで落ちる", () => {
    const s = loadedAll(base());
    const a = t1({ id: "a", state: "suspended" });
    const after = reduce(s, { type: "sync", tasks: [a], projects: [], now: 2 });
    expect(after.diffs).toEqual({});
    expect(after.gen).toEqual({});
  });
});

describe("取ってきたガイド", () => {
  const guide = {
    readingOrder: [{ locations: [{ path: "a.ts" }] }, { locations: [{ path: "b.ts" }] }],
    risks: [],
  } as unknown as Guide;
  const okView: GuideView = { kind: "ok", guide, createdAt: "2026-09-21T00:00:00Z", stale: false };
  const loaded = (view: GuideView): Loaded<GuideView> => ({ kind: "ok", value: view });
  const withGuide = (view: GuideView) => base({ guides: { "t-2b91": loaded(view) } });

  test("状態が動いたら捨てる", () => {
    const s = reduce(withGuide(okView), {
      type: "daemon",
      ev: { event: "task.stateChanged", task_id: "t-2b91", from: "suspended", to: "running" },
      now: 1,
    });
    expect(guideOf(s, "t-2b91")).toBeUndefined();
  });

  test("世代の合わない guide は書き込まない", () => {
    const s = base({ gen: { "t-2b91": 1 } });
    const after = reduce(s, { type: "guide", id: "t-2b91", gen: 0, loaded: loaded(okView) });
    expect(after.guides).toEqual({});
    const fresh = reduce(s, { type: "guide", id: "t-2b91", gen: 1, loaded: loaded(okView) });
    expect(guideOf(fresh, "t-2b91")).toEqual(loaded(okView));
  });

  test("消えたタスクのガイドは sync で落ちる", () => {
    const a = t1({ id: "a", state: "suspended" });
    const after = reduce(withGuide(okView), { type: "sync", tasks: [a], projects: [], now: 2 });
    expect(after.guides).toEqual({});
  });

  test("繋ぎ直したら失敗したガイドだけ捨てる", () => {
    const s = base({
      guides: { "t-2b91": { kind: "error", message: "切断" }, "s-1103": loaded(okView) },
    });
    const after = reduce(s, { type: "connection", conn: { status: "connected" } });
    expect(guideOf(after, "t-2b91")).toBeUndefined();
    expect(guideOf(after, "s-1103")).toEqual(loaded(okView));
  });

  test("ガイドが無ければステップモードに入らない", () => {
    const s = withGuide({ kind: "none" });
    expect(currentStep(s, task(s, "t-2b91"))).toBeNull();
    expect(reduce(s, { type: "step", idx: 0 })).toBe(s);
  });

  test("壊れている・まだ無い・取得前のガイドはステップモードにしない", () => {
    for (const view of [{ kind: "broken", issues: ["x"] }, { kind: "missing" }] as GuideView[]) {
      const s = withGuide(view);
      expect(currentStep(s, task(s, "t-2b91"))).toBeNull();
    }
    expect(currentStep(base(), task(base(), "t-2b91"))).toBeNull();
  });

  test("ガイドがあればステップを進められる", () => {
    const s = withGuide(okView);
    expect(currentStep(s, task(s, "t-2b91"))).toBe(0);
    const next = reduce(s, { type: "step", idx: 1 });
    expect(currentStep(next, task(next, "t-2b91"))).toBe(1);
    expect(reduce(s, { type: "step", idx: 2 })).toBe(s);
  });
});

describe("下書きの読み込み", () => {
  test("読み込み中に書いた下書きは、後から届いたファイルの中身で上書きしない", () => {
    const s = base({ draftsLoaded: false, drafts: { "t-2b91": { comments: [], overall: "いま書いた" } } });
    const after = reduce(s, {
      type: "drafts.loaded",
      drafts: { "t-2b91": { comments: [], overall: "ファイルの古い方" }, "b-204": { comments: [], overall: "別のタスク" } },
    });
    expect(after.drafts["t-2b91"].overall).toBe("いま書いた");
    expect(after.drafts["b-204"].overall).toBe("別のタスク");
    expect(after.draftsLoaded).toBe(true);
  });
});

describe("bounceNotice", () => {
  test("どこが通らず・どこへ戻り・差し戻しが何回目かを書く", () => {
    const text = bounceNotice({ step: "plan-gate", goto: "plan", attempt: 1 });
    expect(text).toContain("plan-gate");
    expect(text).toContain("plan に差し戻し");
    expect(text).toContain("1 回目");
  });

  test("回数は差し戻した回数（戻り先が何周目かではない）", () => {
    expect(bounceNotice({ step: "plan-gate", goto: "plan", attempt: 2 })).toContain("2 回目");
  });
});

describe("connection", () => {
  test("接続状態を持つ", () => {
    const after = reduce(base(), { type: "connection", conn: { status: "disconnected" } });
    expect(after.conn.status).toBe("disconnected");
  });

  test("繋ぎ直したら、失敗したままの取得を捨てて取り直せるようにする", () => {
    // 失敗を残すと「取りに行くべきか」の判定が false のままで、
    // dctld を再起動しても画面はエラーのまま固まる
    const s = base({
      diffs: { "t-2b91": { all: { kind: "error", message: "切断" } } },
      contexts: { "t-2b91": { kind: "error", message: "切断" } },
    });
    const after = reduce(s, { type: "connection", conn: { status: "connected" } });
    expect(after.diffs).toEqual({});
    expect(after.contexts).toEqual({});
  });

  test("取れている diff は繋ぎ直しても捨てない", () => {
    const value: DiffView = { meta: SAMPLE_DIFF, files: [] };
    const s = base({ diffs: { "t-2b91": { all: { kind: "ok", value } } } });
    const after = reduce(s, { type: "connection", conn: { status: "connected" } });
    expect(diffOf(after, "t-2b91", "all")).toEqual({ kind: "ok", value });
  });
});

describe("止まった理由と実行履歴", () => {
  const stepRun = (o: Partial<StepRun> = {}): StepRun => ({
    id: 1,
    step_id: "implement",
    attempt: 1,
    status: "success",
    exit_code: 0,
    started_at: "2026-09-18T00:00:00.000Z",
    ended_at: "2026-09-18T00:01:00.000Z",
    permission_denials: null,
    ...o,
  });
  const detail = (stepRuns: StepRun[]): TaskDetail =>
    ({ task: {} as TaskDetail["task"], stepRuns, steps: null });
  const t = (patch: Partial<Task>): Task => ({ ...seedTasks()[0], ...patch });

  test("失敗したステップは task.get の stepRuns から取る", () => {
    const task = t({ state: "failed", step: "open-pr", worktree: "/w" });
    const d = detail([
      stepRun({ id: 1, step_id: "implement" }),
      stepRun({ id: 2, step_id: "test", status: "failed", exit_code: 1 }),
    ]);
    expect(stopReasons([task], task, d)).toEqual([{ kind: "failed", step: "test" }]);
  });

  test("履歴がまだ無いときは task.list の今のステップで代える", () => {
    const task = t({ state: "failed", step: "test", worktree: "/w" });
    expect(stopReasons([task], task)).toEqual([{ kind: "failed", step: "test" }]);
  });

  test("止まった理由は failed → 削除拒否 → queued の順に並ぶ", () => {
    const task = t({ state: "failed", worktree: "/w", refused: true });
    expect(stopReasons([task], task).map((r) => r.kind)).toEqual(["failed", "refused"]);
  });

  test("queued は行列の何番目かを持つ", () => {
    const first = t({ id: "a", state: "queued", prio: 1, since: 1 });
    const second = t({ id: "b", state: "queued", prio: 2, since: 1 });
    expect(stopReasons([first, second], second)).toEqual([{ kind: "queued", position: 2 }]);
    expect(queuePosition([first, second], t({ id: "c", state: "running" }))).toBe(0);
  });

  test("動いているタスクには止まった理由が無い", () => {
    const task = t({ state: "running", refused: false });
    expect(stopReasons([task], task, detail([stepRun()]))).toEqual([]);
  });

  test("実行履歴は新しい順", () => {
    const d = detail([stepRun({ id: 1 }), stepRun({ id: 2 })]);
    expect(stepRunHistory(d).map((r) => r.id)).toEqual([2, 1]);
    expect(stepRunHistory(undefined)).toEqual([]);
  });

  test("拒否はツール名と引数の並びになる", () => {
    expect(denialLines({
      total: 1,
      denials: [{ tool_name: "Bash", tool_use_id: null, input: { command: "git push origin main" } }],
    })).toEqual([{ tool: "Bash", detail: "git push origin main" }]);
  });

  test("引数は切り詰めない", () => {
    const command = `echo ${"x".repeat(500)}`;
    const [line] = denialLines({
      total: 1,
      denials: [{ tool_name: "Bash", tool_use_id: null, input: { command } }],
    });
    expect(line.detail).toBe(command);
  });

  test("未知のツールは入力全体を出す", () => {
    const [line] = denialLines({
      total: 1,
      denials: [{ tool_name: "MyTool", tool_use_id: null, input: { a: 1 } }],
    });
    expect(line.detail).toContain("a");
    expect(line.detail).toContain("1");
  });

  test("保存しなかった件数を数える", () => {
    const one = { tool_name: "Bash", tool_use_id: null, input: {} };
    expect(omittedDenials({ total: 25, denials: Array(20).fill(one) })).toBe(5);
    expect(omittedDenials({ total: 3, denials: Array(3).fill(one) })).toBe(0);
  });
});

describe("利用上限の表示", () => {
  const sample = (window: string, utilization: number, resets_at: string | null = null): ServerEvent => ({
    event: "ratelimit.sample", window, utilization, resets_at,
  });
  const feed = (s: State, evs: ServerEvent[], now = NOW): State =>
    evs.reduce((acc, ev) => reduce(acc, { type: "daemon", ev, now }), s);
  const win = (patch: Partial<RateLimitWindow>): RateLimitWindow => ({
    window: "five_hour", utilization: 0.5, resetsAt: NOW + 60 * MIN, observedAt: NOW, ...patch,
  });
  const viewOf = (w: RateLimitWindow, now = NOW) =>
    rateLimitViews(base({ limits: { [w.window]: w }, now }))[0];

  test("ratelimit.sample を受けると、その window の最新の値が入る", () => {
    const after = feed(base(), [sample("five_hour", 0.4, "2026-09-15T09:05:00.000Z")], 999);
    expect(after.limits).toEqual({
      five_hour: {
        window: "five_hour",
        utilization: 0.4,
        resetsAt: Date.parse("2026-09-15T09:05:00.000Z"),
        observedAt: 999,
      },
    });
  });

  test("同じ window は置き換わり、別の window は残る", () => {
    const after = feed(base(), [sample("five_hour", 0.4), sample("seven_day", 0.6), sample("five_hour", 0.5)]);
    expect(after.limits.five_hour.utilization).toBe(0.5);
    expect(after.limits.seven_day.utilization).toBe(0.6);
  });

  test("未知の window も捨てずに持ち、既知の枠の後ろに生のキーで出す", () => {
    const after = feed(base(), [sample("seven_day_opus", 0.3), sample("seven_day", 0.6), sample("five_hour", 0.4)]);
    expect(rateLimitViews(after).map((v) => [v.window, v.label])).toEqual([
      ["five_hour", "5時間枠"],
      ["seven_day", "7日枠"],
      ["seven_day_opus", "seven_day_opus"],
    ]);
  });

  test("読めない resets_at は null にする（Invalid Date を出さない）", () => {
    const after = feed(base(), [sample("five_hour", 0.4, "1789828800.0")]);
    expect(after.limits.five_hour.resetsAt).toBeNull();
  });

  test("sync は limits を消さない", () => {
    const s = feed(base(), [sample("five_hour", 0.4)]);
    const after = reduce(s, { type: "sync", tasks: [], projects: [], now: NOW + MIN });
    expect(after.limits).toEqual(s.limits);
  });

  test("limits.recent は、イベントで届いた新しい値を DB の古い行で上書きしない", () => {
    const s = feed(base(), [sample("five_hour", 0.8)], NOW);
    const after = reduce(s, {
      type: "limits.recent",
      samples: [
        win({ window: "five_hour", utilization: 0.2, observedAt: NOW - 30 * MIN }),
        win({ window: "seven_day", utilization: 0.6, observedAt: NOW - 30 * MIN }),
      ],
    });
    expect(after.limits.five_hour.utilization).toBe(0.8);
    expect(after.limits.seven_day.utilization).toBe(0.6);
  });

  test("limits.recent に同じ window が複数あっても、並び順によらず最新1件に畳む", () => {
    const rows = [
      win({ utilization: 0.3, observedAt: NOW - 2 * MIN }),
      win({ utilization: 0.5, observedAt: NOW - MIN }),
      win({ utilization: 0.1, observedAt: NOW - 3 * MIN }),
    ];
    for (const samples of [rows, [...rows].reverse()]) {
      expect(reduce(base(), { type: "limits.recent", samples }).limits.five_hour.utilization).toBe(0.5);
    }
  });

  test("toRateLimitWindow は ISO を数値にし、観測時刻の読めない行を捨てる", () => {
    const row = {
      observed_at: "2026-09-15T05:00:00.000Z",
      window: "seven_day",
      utilization: 0.66,
      resets_at: "2026-09-19T00:00:00.000Z",
    };
    expect(toRateLimitWindow(row)).toEqual({
      window: "seven_day",
      utilization: 0.66,
      resetsAt: Date.parse(row.resets_at),
      observedAt: Date.parse(row.observed_at),
    });
    expect(toRateLimitWindow({ ...row, resets_at: null })?.resetsAt).toBeNull();
    expect(toRateLimitWindow({ ...row, observed_at: "いつか" })).toBeNull();
  });

  test("色はどの枠も同じ閾値で決まる（0.7 から warn、0.8 から danger）", () => {
    for (const window of ["five_hour", "seven_day", "seven_day_opus"]) {
      const at = (utilization: number) => viewOf(win({ window, utilization })).severity;
      expect(at(LIMIT_WARN_UTILIZATION - 0.01)).toBe("calm");
      expect(at(LIMIT_WARN_UTILIZATION)).toBe("warn");
      expect(at(LIMIT_DANGER_UTILIZATION - 0.01)).toBe("warn");
      expect(at(LIMIT_DANGER_UTILIZATION)).toBe("danger");
      expect(at(1)).toBe("danger");
    }
  });

  test("5時間枠の説明文は飽和したときだけで、新しいタスクが始まらないことを伝える", () => {
    expect(viewOf(win({ utilization: 0.99 })).note).toBeNull();
    expect(viewOf(win({ utilization: 1 })).note).toBe("新しいタスクはリセットまで始まりません");
  });

  test("7日枠の説明文は danger から出て、失敗に直結することを説明する", () => {
    const seven = (utilization: number) =>
      viewOf(win({ window: "seven_day", utilization, resetsAt: NOW + 4 * 1440 * MIN }));
    expect(seven(LIMIT_DANGER_UTILIZATION - 0.01).note).toBeNull();
    expect(seven(LIMIT_DANGER_UTILIZATION).note).toContain("飽和すると");
    expect(seven(LIMIT_DANGER_UTILIZATION).note).toContain("待たずに失敗します");
    expect(seven(1).note).toContain("飽和しています");
    expect(seven(1).note).toContain("待たずに失敗します");
  });

  test("フィクスチャ: 通常の状態はどの行も calm", () => {
    const views = rateLimitViews(feed(base(), RATELIMIT_NORMAL));
    expect(views.map((v) => [v.window, v.severity])).toEqual([
      ["five_hour", "calm"],
      ["seven_day", "calm"],
    ]);
    expect(views.every((v) => v.note === null)).toBe(true);
  });

  test("フィクスチャ: 飽和が近い状態はどちらも danger で、説明文は7日枠だけ", () => {
    const views = rateLimitViews(feed(base(), RATELIMIT_NEAR_SATURATION));
    expect(views.map((v) => [v.window, v.severity, v.note !== null])).toEqual([
      ["five_hour", "danger", false],
      ["seven_day", "danger", true],
    ]);
  });

  test("remaining は切り捨てで、分・時間と分・日と時間の3段階。端数が0なら省く", () => {
    expect(remaining(59 * 1000)).toBe("1分未満");
    expect(remaining(47 * MIN + 59 * 1000)).toBe("47分");
    expect(remaining(59 * MIN)).toBe("59分");
    expect(remaining(60 * MIN)).toBe("1時間");
    expect(remaining(3 * 60 * MIN + 54 * MIN)).toBe("3時間54分");
    expect(remaining(24 * 60 * MIN - 1)).toBe("23時間59分");
    expect(remaining(24 * 60 * MIN)).toBe("1日");
    expect(remaining((6 * 24 + 7) * 60 * MIN + 30 * MIN)).toBe("6日7時間");
  });

  test("リセットまでの残り時間を、どの枠も同じ書式で出す", () => {
    expect(viewOf(win({ resetsAt: NOW + 3 * 60 * MIN + 54 * MIN })).reset).toBe("あと3時間54分でリセット");
    const far = NOW + 4 * 1440 * MIN + 5 * 60 * MIN;
    expect(viewOf(win({ window: "seven_day", resetsAt: far })).reset).toBe("あと4日5時間でリセット");
  });

  test("もうリセットされた枠は利用率を古い値として扱い、色も説明文も付けない", () => {
    const v = viewOf(win({ window: "seven_day", utilization: 1, resetsAt: NOW - MIN }));
    expect(v).toMatchObject({ reset: null, stale: true, severity: "calm", note: null });
    expect(viewOf(win({ resetsAt: NOW })).stale).toBe(true);
    expect(viewOf(win({})).stale).toBe(false);
  });

  test("リセット時刻が分からなければそう出す", () => {
    expect(viewOf(win({ resetsAt: null })).reset).toBe("リセット時刻は不明");
  });

  test("パーセント表記と、いつ観測した値か", () => {
    const v = viewOf(win({ utilization: 0.664, observedAt: NOW - 3 * MIN }));
    expect(v.percent).toBe("66% 使用");
    expect(v.observed).toBe("3分前");
    expect(viewOf(win({ utilization: 0.9996 })).percent).toBe("99% 使用");
    expect(viewOf(win({ utilization: 1 })).percent).toBe("100% 使用");
    // 0.29 * 100 は 28.999… になる
    expect(viewOf(win({ utilization: 0.29 })).percent).toBe("29% 使用");
    expect(viewOf(win({ utilization: 1.2 })).fill).toBe(1);
  });

  test("標本が無ければ行も無い", () => {
    expect(rateLimitViews(base())).toEqual([]);
  });
});
