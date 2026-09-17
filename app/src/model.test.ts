import { describe, expect, test } from "vitest";
import { NOW, PROJECTS, WORKFLOWS, seedTasks } from "./mock";
import {
  canReject,
  composeRejection,
  countReview,
  diffLines,
  diffStats,
  filesFor,
  groupOf,
  reduce,
  sidebarOrder,
  unguidedFiles,
  type State,
} from "./model";
import type { Task } from "./types";

const base = (overrides: Partial<State> = {}): State => ({
  tasks: seedTasks(),
  projects: PROJECTS,
  workflows: WORKFLOWS,
  now: NOW,
  view: "tasks",
  project: "all",
  sel: "t-2b91",
  scope: {},
  step: {},
  drafts: {},
  editing: null,
  modal: null,
  toast: null,
  ...overrides,
});

const task = (s: State, id: string) => s.tasks.find((t) => t.id === id)!;

describe("groupOf", () => {
  const t = (patch: Partial<Task>) => ({ ...seedTasks()[0], ...patch });

  test("suspended はレビュー待ち", () => {
    expect(groupOf(t({ state: "suspended" }))).toBe("review");
  });
  test("failed、削除拒否の completed、degraded な非終端タスクは要確認", () => {
    expect(groupOf(t({ state: "failed" }))).toBe("check");
    expect(groupOf(t({ state: "completed", refused: true }))).toBe("check");
    expect(groupOf(t({ state: "running", degraded: "fix" }))).toBe("check");
  });
  test("degraded でも終端状態になれば要確認から外れる", () => {
    expect(groupOf(t({ state: "canceled", degraded: "fix" }))).toBe("done");
  });
  test("それ以外は状態のとおり", () => {
    expect(groupOf(t({ state: "running" }))).toBe("running");
    expect(groupOf(t({ state: "queued" }))).toBe("queued");
    expect(groupOf(t({ state: "paused" }))).toBe("paused");
    expect(groupOf(t({ state: "completed" }))).toBe("done");
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
  test("diffStats は追加と削除の行を数える", () => {
    expect(diffStats({ path: "x", hunks: [{ old: 1, new: 1, body: " a\n-b\n+c\n+d" }] })).toEqual({ add: 2, del: 1 });
  });
  test("前回レビュー以降は since を持つファイルだけにする", () => {
    const t = seedTasks().find((x) => x.id === "s-1103")!;
    const files = filesFor(t, "since");
    expect(files.map((f) => f.path)).toEqual(["src/stock/reserve.ts", "test/stock/reserve.test.ts"]);
    expect(files[0].hunks).toBe(t.diff[0].since);
  });
  test("ガイドが触れていないファイルを拾う", () => {
    const t = seedTasks().find((x) => x.id === "t-9f21")!;
    expect(unguidedFiles(t).map((f) => f.path)).toEqual(["test/db/migrations.test.ts"]);
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

  test("承認すると次のステップへ進み、下書きを捨てて次のレビュー待ちを選ぶ", () => {
    let s = reduce(base(), { type: "overall", text: "メモ" });
    s = reduce(s, { type: "approve" });
    expect(task(s, "t-2b91")).toMatchObject({ state: "running", step: "open-pr", attempt: 1 });
    expect(s.drafts["t-2b91"]).toBeUndefined();
    expect(s.sel).toBe("b-204");
  });

  test("最後のステップで承認すると完了し worktree を持たない", () => {
    const s = reduce(base({ sel: "s-1103", tasks: seedTasks().map((t) => (t.id === "s-1103" ? { ...t, wf: "shop-api/hotfix", step: "confirm" } : t)) }), { type: "approve" });
    expect(task(s, "s-1103")).toMatchObject({ state: "completed", worktree: null });
  });

  test("差し戻しはコメントが無ければ確認画面を開かない", () => {
    expect(reduce(base(), { type: "reject.preview" }).modal).toBeNull();
    expect(reduce(base(), { type: "reject.confirm" })).toEqual(base());
  });

  test("差し戻すと onReject のステップに戻り、送った内容をレビュー履歴に残す", () => {
    let s = reduce(base(), { type: "overall", text: "全件返す理由を書いてください" });
    s = reduce(s, { type: "reject.preview" });
    expect(s.modal).toBe("reject-preview");
    s = reduce(s, { type: "reject.confirm" });
    const t = task(s, "t-2b91");
    expect(t).toMatchObject({ state: "running", step: "implement", attempt: 2 });
    expect(t.reviews.at(-1)).toEqual({ at: NOW, comment: "全体: 全件返す理由を書いてください" });
    expect(s.modal).toBeNull();
    expect(s.drafts["t-2b91"]).toBeUndefined();
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
