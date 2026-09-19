import { describe, expect, test, vi } from "vitest";
import { NOW, PROJECTS, SAMPLE_DIFF, seedTasks } from "./fixtures";
import {
  canReject,
  composeRejection,
  countReview,
  DEGRADED_UNKNOWN,
  diffLines,
  diffOf,
  fellBackToAll,
  groupOf,
  hasSince,
  isTerminal,
  MIN,
  reduce,
  rejections,
  reviewRound,
  sidebarOrder,
  timeLabel,
  toProject,
  toTask,
  unguidedFiles,
  type DiffView,
  type State,
} from "./model";
import { buildDiff } from "./patch";
import type { Guide, ReviewEntry, Task, TaskContext } from "./types";
import type { ProjectSummary, TaskListEntry } from "../../shared/protocol.ts";

const base = (overrides: Partial<State> = {}): State => ({
  tasks: seedTasks(),
  projects: PROJECTS,
  now: NOW,
  view: "tasks",
  project: "all",
  sel: "t-2b91",
  scope: {},
  step: {},
  diffs: {},
  contexts: {},
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
  test("worktree の残っている failed、削除拒否の completed、degraded な非終端タスクは要確認", () => {
    expect(groupOf(t({ state: "failed", worktree: "/w" }))).toBe("check");
    expect(groupOf(t({ state: "completed", refused: true, worktree: "/w" }))).toBe("check");
    expect(groupOf(t({ state: "running", degraded: "fix" }))).toBe("check");
  });
  test("gc 済み（worktree が無い）の failed は要確認から外れる", () => {
    expect(groupOf(t({ state: "failed", worktree: null }))).toBe("done");
  });
  test("gc 済みの削除拒否だった completed も要確認から外れる", () => {
    // failed と同じ規則で動いていることを固定する
    expect(groupOf(t({ state: "completed", refused: false, worktree: null }))).toBe("done");
  });
  test("degraded でも終端状態になれば要確認から外れる", () => {
    expect(groupOf(t({ state: "canceled", degraded: "fix" }))).toBe("done");
  });
  test("上限待ちは要確認ではなく専用の区分に入る", () => {
    // 人が何かする必要は無い。degraded が付いていても要確認へは寄せない
    expect(groupOf(t({ state: "rate_limited" }))).toBe("limited");
    expect(groupOf(t({ state: "rate_limited", degraded: "implement" }))).toBe("limited");
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
  test("ガイドが触れていないファイルを拾う", () => {
    const guide = { readingOrder: [{ paths: ["src/keep.ts", "src/added.ts"] }] } as Guide;
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
    const s = base({ sel: "t-9f21" });
    expect(reduce(s, { type: "step", idx: 4 })).toBe(s);
    expect(reduce(s, { type: "step", idx: 3 }).step["t-9f21"]).toBe(3);
    expect(reduce(s, { type: "step", idx: null }).step["t-9f21"]).toBeNull();
  });

  test("ログの追記は実行中のタスクにだけ効く", () => {
    const s = reduce(base(), { type: "log.append", id: "t-7f3a", line: "next" });
    expect(task(s, "t-7f3a").log?.endsWith("\nnext")).toBe(true);
    expect(reduce(base(), { type: "log.append", id: "t-0a77", line: "next" }).tasks).toEqual(base().tasks);
  });
});

const row = (o: Partial<TaskListEntry> = {}): TaskListEntry => ({
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
  has_degraded: false,
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
const t1 = (o: Partial<TaskListEntry> = {}) => toTask(row(o), PJ);

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

  test("has_degraded は degraded に写し、要確認に入る", () => {
    // 空文字にすると groupOf の `t.degraded &&` をすり抜けて要確認から落ちる
    expect(t1({ has_degraded: true }).degraded).toBe(DEGRADED_UNKNOWN);
    expect(groupOf(t1({ has_degraded: true, state: "running" }))).toBe("check");
    expect(t1({ has_degraded: false }).degraded).toBeUndefined();
  });

  test("イベントで分かったステップ名は取り直しで消えない", () => {
    const before = { ...t1({ has_degraded: true }), degraded: "implement" };
    expect(toTask(row({ has_degraded: true }), PJ, before).degraded).toBe("implement");
  });

  test("知らない state 文字列はタスクを消さず unknown にする（版のずれ対策）", () => {
    // TaskListEntry#state は protocol.ts 上は TaskState だが、それはコンパイル時の
    // 注釈にすぎない。JSON で来る実行時の値は保証されないので、あえて型をはみ出させる
    const weird = row({ state: "half-migrated" as unknown as TaskListEntry["state"] });
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
      const weird = { state: "never-seen-before" as unknown as TaskListEntry["state"] };
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

  test("stepRun.finished の degraded は要確認に入れる", () => {
    const after = reduce(withTask(), {
      type: "daemon",
      ev: {
        event: "stepRun.finished", task_id: "a", step_run_id: 1,
        step_id: "implement", status: "degraded",
      },
      now: 999,
    });
    expect(after.tasks[0].degraded).toBe("implement");
    expect(groupOf(after.tasks[0])).toBe("check");
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

  test("まだ扱わないイベントは無視する", () => {
    const s = withTask();
    const after = reduce(s, {
      type: "daemon",
      ev: { event: "log.line", task_id: "a", step_run_id: 1, line: "x" },
      now: 999,
    });
    expect(after).toEqual(s);
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
