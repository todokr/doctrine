import { describe, expect, test } from "vitest";
import type { WorkflowListEntry } from "../../shared/protocol.ts";
import {
  canRetry,
  retryInit,
  canSubmitComposer,
  composerWorkflowOptions,
  createdToast,
  createParams,
  initialComposerForm,
  pickWorkflow,
  selectedSteps,
  type ComposerForm,
} from "./composer";
import { PROJECTS, seedTasks, WORKFLOW_LIST } from "./fixtures";

const task = (id: string) => seedTasks().find((t) => t.id === id)!;
const intake = { id: "i1", processId: "2", issueUrl: null, parentIssueUrl: null };

describe("canRetry", () => {
  test("failed と canceled で出す", () => {
    for (const id of ["t-e812", "t-6ba3", "s-1105"]) expect(canRetry(task(id))).toBe(true);
  });
  test("終わっていない・完了したタスクでは出さない", () => {
    for (const id of ["t-7f3a", "t-91e0", "t-0a77"]) expect(canRetry(task(id))).toBe(false);
  });
  test("Intake 由来のタスクでは出さない", () => {
    expect(canRetry({ ...task("t-e812"), intake })).toBe(false);
    expect(canRetry({ ...task("s-1105"), intake })).toBe(false);
  });
});

describe("retryInit", () => {
  test("元のタスクのタイトル・指示・ワークフローとプロジェクトのパスを入れる", () => {
    expect(retryInit(task("t-e812"), PROJECTS)).toEqual({
      project: "~/git/doctrine",
      workflow: "doctrine/feature",
      title: "daemon.warning イベントを追加する",
      prompt: "daemon.warning イベントを追加する。詳細は issue を参照してください。",
    });
  });
  test("中止したタスクでも同じ", () => {
    expect(retryInit(task("s-1105"), PROJECTS).project).toBe("~/work/shop-api");
  });
  test("プロジェクトが見つからなければ project を入れない", () => {
    const init = retryInit(task("t-e812"), []);
    expect(init.project).toBeUndefined();
    expect(init.title).toBe("daemon.warning イベントを追加する");
  });
  test("コンポーザの欄に元のタスクの中身が入る", () => {
    expect(initialComposerForm(PROJECTS, retryInit(task("s-1105"), PROJECTS), "doctrine")).toEqual({
      project: "~/work/shop-api",
      workflow: "shop-api/feature",
      title: "決済 Webhook の署名検証",
      prompt: "決済 Webhook の署名検証。詳細は issue を参照してください。",
    });
  });
});

describe("initialComposerForm", () => {
  test("init のプロジェクトを使う", () => {
    expect(initialComposerForm(PROJECTS, { project: "~/work/shop-api" }, "all").project).toBe("~/work/shop-api");
  });
  test("init が無ければ絞り込み中のプロジェクト", () => {
    expect(initialComposerForm(PROJECTS, {}, "blog").project).toBe("~/git/blog");
  });
  test("どちらも無ければ先頭", () => {
    expect(initialComposerForm(PROJECTS, {}, "all").project).toBe("~/git/doctrine");
  });
  test("知らないパスは使わない", () => {
    expect(initialComposerForm(PROJECTS, { project: "/nowhere" }, "all").project).toBe("~/git/doctrine");
  });
  test("タイトル・指示・ワークフローの初期値が入る", () => {
    expect(initialComposerForm(PROJECTS, { workflow: "light", title: "T", prompt: "P" }, "all")).toMatchObject({
      workflow: "light",
      title: "T",
      prompt: "P",
    });
  });
});

describe("pickWorkflow", () => {
  test("preferred が ok ならそれ", () => {
    expect(pickWorkflow(WORKFLOW_LIST, "light")).toBe("light");
  });
  test("空なら既定", () => {
    expect(pickWorkflow(WORKFLOW_LIST, "")).toBe("default");
  });
  test("ok: false や一覧に無い名前は既定に倒す", () => {
    expect(pickWorkflow(WORKFLOW_LIST, "broken")).toBe("default");
    expect(pickWorkflow(WORKFLOW_LIST, "gone")).toBe("default");
  });
  test("既定が ok でなければ最初の ok", () => {
    const list: WorkflowListEntry[] = WORKFLOW_LIST.map((w) =>
      w.name === "default" ? { name: w.name, default: true, ok: false, issues: ["x"] } : w
    );
    expect(pickWorkflow(list, "")).toBe("light");
  });
  test("ok が無ければ空", () => {
    expect(pickWorkflow([WORKFLOW_LIST[0]], "")).toBe("");
  });
});

test("composerWorkflowOptions", () => {
  expect(composerWorkflowOptions(WORKFLOW_LIST)).toEqual([
    { name: "broken", label: "broken（不正）", disabled: true },
    { name: "default", label: "default（既定）", disabled: false },
    { name: "light", label: "light", disabled: false },
  ]);
});

test("selectedSteps", () => {
  expect(selectedSteps(WORKFLOW_LIST, "light")).toEqual([{ id: "review", type: "approval", title: "見て" }]);
  expect(selectedSteps(WORKFLOW_LIST, "broken")).toBeNull();
});

describe("canSubmitComposer", () => {
  const full: ComposerForm = { project: "~/git/doctrine", workflow: "default", title: "T", prompt: "P" };
  test("全部入りなら true", () => {
    expect(canSubmitComposer(full, WORKFLOW_LIST)).toBe(true);
  });
  test.each([
    ["title が空白だけ", { title: "  " }],
    ["prompt が空", { prompt: "" }],
    ["workflow が不正", { workflow: "broken" }],
    ["workflow が空", { workflow: "" }],
    ["project が空", { project: "" }],
  ])("%s なら false", (_, patch) => {
    expect(canSubmitComposer({ ...full, ...patch }, WORKFLOW_LIST)).toBe(false);
  });
});

test("createParams は trim したタイトルで、priority を持たない", () => {
  const p = createParams({ project: "~/git/doctrine", workflow: "light", title: " T ", prompt: "P" });
  expect(p).toEqual({ project: "~/git/doctrine", workflow: "light", title: "T", prompt: "P" });
  expect("priority" in p).toBe(false);
});

test("createdToast", () => {
  expect(createdToast("T", [])).toBe("タスクを作りました: T");
  expect(createdToast("T", ["a", "b"])).toBe("タスクを作りました: T（警告: a / b）");
});
