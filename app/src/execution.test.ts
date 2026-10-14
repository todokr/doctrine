import { describe, expect, test, vi } from "vitest";
import type { IntakeSummary } from "../../shared/protocol.ts";
import {
  attentionProcessIds,
  clampPanelHeight,
  countExecutionAttention,
  executionOrder,
  executionSection,
  firstAttentionKey,
  inExecution,
  isExecutionAttention,
  PANEL_DEFAULT,
  PANEL_MIN,
  panelContentOf,
  processKeyOfTask,
  railsOf,
  suspendedProcessIds,
  readPanelHeight,
  writePanelHeight,
} from "./execution";
import { INTAKE_ACTIVE, INTAKES, PFD_SAMPLE, seedTasks } from "./fixtures";
import { buildPfdView } from "./pfd";
import type { Task, TaskState } from "./types";

const row = (id: string): IntakeSummary => INTAKES.find((i) => i.id === id)!;
const ids = (rows: IntakeSummary[]) => rows.map((i) => i.id);
const task = (id: string, state: TaskState, intakeId: string | null): Task => ({
  ...seedTasks()[0],
  id,
  state,
  intake: intakeId === null ? null : { id: intakeId, processId: "p1", issueUrl: null, parentIssueUrl: null },
});

describe("inExecution / executionSection", () => {
  test("承認後・改訂中・終端だけが並ぶ。承認前は並ばない", () => {
    expect(INTAKES.filter(inExecution).map((i) => i.id).sort()).toEqual(["i2", "i5", "i6", "i7"]);
  });

  test("改訂中は承認前の状態でも進行中に並ぶ", () => {
    const revising = { ...row("i4"), revising: true };
    expect(inExecution(revising)).toBe(true);
    expect(executionSection(revising)).toBe("active");
  });

  test("完了と中止は終了", () => {
    expect(executionSection(row("i6"))).toBe("closed");
    expect(executionSection(row("i7"))).toBe("closed");
    expect(executionSection(row("i2"))).toBe("active");
  });
});

describe("isExecutionAttention", () => {
  test("active で needs_human なら人の番", () => {
    expect(isExecutionAttention(row("i2"), [])).toBe(true);
  });

  test("承認前の needs_human（レビュー待ち）は Execution の人の番に入れない", () => {
    expect(isExecutionAttention(row("i1"), [])).toBe(false);
  });

  test("その Intake のタスクが承認待ちなら、needs_human が偽でも人の番", () => {
    const quiet = { ...row("i2"), needs_human: false };
    expect(isExecutionAttention(quiet, [])).toBe(false);
    expect(isExecutionAttention(quiet, [task("t1", "suspended", "i2")])).toBe(true);
  });

  test("別の Intake や Intake の無いタスクの承認待ちは数えない", () => {
    const quiet = { ...row("i2"), needs_human: false };
    expect(isExecutionAttention(quiet, [task("t1", "suspended", "i5"), task("t2", "suspended", null)])).toBe(false);
  });

  test("改訂中でも走っているタスクの承認待ちは人の番", () => {
    expect(isExecutionAttention(row("i5"), [task("t1", "suspended", "i5")])).toBe(true);
  });

  test("終了した Intake は人の番にしない", () => {
    expect(isExecutionAttention({ ...row("i7"), needs_human: true }, [task("t1", "suspended", "i7")])).toBe(false);
  });

  test("countExecutionAttention は人の番のある Intake の数", () => {
    expect(countExecutionAttention(INTAKES, [])).toBe(1);
    expect(countExecutionAttention(INTAKES, [task("t1", "suspended", "i5")])).toBe(2);
  });
});

describe("executionOrder", () => {
  test("進行中は人の番を上に、その中は更新の新しい順", () => {
    expect(ids(executionOrder(INTAKES, [], "all", false))).toEqual(["i2", "i5"]);
    const quiet = INTAKES.map((i) => (i.id === "i2" ? { ...i, needs_human: false } : i));
    expect(ids(executionOrder(quiet, [task("t1", "suspended", "i5")], "all", false))).toEqual(["i5", "i2"]);
  });

  test("終了は完了と中止を更新の新しい順に並べる", () => {
    expect(ids(executionOrder(INTAKES, [], "all", true))).toEqual(["i6", "i7"]);
  });

  test("workspace で絞り込む", () => {
    expect(ids(executionOrder(INTAKES, [], 2, false))).toEqual(["i2"]);
    expect(ids(executionOrder(INTAKES, [], 99, true))).toEqual([]);
  });

  test("渡した配列を並べ替えない", () => {
    const before = ids(INTAKES);
    executionOrder(INTAKES, [], "all", false);
    expect(ids(INTAKES)).toEqual(before);
  });
});

describe("suspendedProcessIds", () => {
  test("いまのタスクが承認待ちのプロセスだけ。古いタスクの承認待ちと状態だけの人の番は入れない", () => {
    const processes = [
      ...INTAKE_ACTIVE.processes,
      { ...INTAKE_ACTIVE.processes[1], id: "build-api", state: "running" as const, taskId: "t9", task_ids: ["t9"] },
      { ...INTAKE_ACTIVE.processes[1], id: "build-ui", state: "running" as const, taskId: "t8", task_ids: ["t7", "t8"] },
    ];
    const tasks = [task("t9", "suspended", "i2"), task("t7", "suspended", "i2"), task("t8", "running", "i2")];
    expect(suspendedProcessIds(processes, tasks)).toEqual(new Set(["build-api"]));
  });
});

describe("attentionProcessIds", () => {
  test("your_turn と needs_attention のプロセス", () => {
    // INTAKE_ACTIVE は approve が your_turn、design が needs_attention
    expect(attentionProcessIds(INTAKE_ACTIVE.processes, [])).toEqual(new Set(["approve", "design"]));
  });

  test("いまのタスクが承認待ちのプロセス。古いタスクの承認待ちは数えない", () => {
    const processes = [
      { ...INTAKE_ACTIVE.processes[1], id: "build-api", state: "running" as const, taskId: "t9", task_ids: ["t9"] },
      { ...INTAKE_ACTIVE.processes[1], id: "build-ui", state: "running" as const, taskId: "t8", task_ids: ["t7", "t8"] },
    ];
    const tasks = [task("t9", "suspended", "i2"), task("t7", "suspended", "i2"), task("t8", "running", "i2")];
    expect(attentionProcessIds(processes, tasks)).toEqual(new Set(["build-api"]));
  });

  test("pr_open は人の番に入れない", () => {
    const pr = { number: 1, url: "u", state: "OPEN" as const, baseRef: "develop", mergedAt: null, mergeCommit: null };
    const processes = [{ ...INTAKE_ACTIVE.processes[0], state: "pr_open" as const, taskId: "t1", pr }];
    expect(attentionProcessIds(processes, [task("t1", "waiting", "i2")]).size).toBe(0);
  });
});

describe("firstAttentionKey", () => {
  test("図のノードの順で最初の人の番", () => {
    const view = buildPfdView(PFD_SAMPLE, { exec: { rails: {}, attention: new Set(["approve", "design"]) } });
    expect(firstAttentionKey(view)).toBe("p:design");
    expect(firstAttentionKey(buildPfdView(PFD_SAMPLE))).toBeNull();
  });
});

describe("railsOf", () => {
  test("プロセスの id から帯", () => {
    expect(railsOf([{ ...INTAKE_ACTIVE.processes[0], id: "x", rail: null }])).toEqual({ x: null });
  });
});

describe("panelContentOf", () => {
  const keys = new Set(buildPfdView(PFD_SAMPLE).nodes.map((n) => n.key));
  const running = (id: string, task_ids: string[]) =>
    ({ ...INTAKE_ACTIVE.processes[0], id, state: "running" as const, taskId: task_ids.at(-1)!, task_ids });
  const base = { keys, processes: INTAKE_ACTIVE.processes, tasks: [] as Task[], chosenTaskId: null };

  test("何も選んでいない、または図に無いキーなら null（パネルを閉じる）", () => {
    expect(panelContentOf({ ...base, key: null })).toBeNull();
    expect(panelContentOf({ ...base, key: "p:retired" })).toBeNull();
  });

  test("成果物は要素の欄", () => {
    expect(panelContentOf({ ...base, key: "a:api" })).toEqual({ kind: "element", key: "a:api" });
  });

  test("your_turn は人の操作", () => {
    expect(panelContentOf({ ...base, key: "p:approve" })).toEqual({ kind: "human", key: "p:approve", processId: "approve" });
  });

  test("タスクの無いプロセスは要素の欄", () => {
    expect(panelContentOf({ ...base, key: "p:build-api" })).toEqual({ kind: "element", key: "p:build-api" });
  });

  test("いまのタスクが承認待ちならレビュー画面", () => {
    const processes = [running("build-api", ["t9"])];
    const r = panelContentOf({ ...base, processes, tasks: [task("t9", "suspended", "i2")], key: "p:build-api" });
    expect(r).toEqual({ kind: "review", key: "p:build-api", processId: "build-api", taskId: "t9" });
  });

  test("承認待ち以外ならタスク画面", () => {
    const processes = [running("build-api", ["t9"])];
    const r = panelContentOf({ ...base, processes, tasks: [task("t9", "running", "i2")], key: "p:build-api" });
    expect(r).toEqual({ kind: "task", key: "p:build-api", processId: "build-api", taskId: "t9", attention: false });
  });

  test("needs_attention はいまのタスクに理由と再投入を添える", () => {
    // INTAKE_ACTIVE の design は needs_attention で、task_ids は t-old, t1
    const tasks = [task("t1", "failed", "i2"), task("t-old", "canceled", "i2")];
    const r = panelContentOf({ ...base, tasks, key: "p:design" });
    expect(r).toEqual({ kind: "task", key: "p:design", processId: "design", taskId: "t1", attention: true });
  });

  test("s.sel がそのプロセスの過去のタスクならそれを開き、再投入は添えない", () => {
    const tasks = [task("t1", "failed", "i2"), task("t-old", "canceled", "i2")];
    const r = panelContentOf({ ...base, tasks, key: "p:design", chosenTaskId: "t-old" });
    expect(r).toEqual({ kind: "task", key: "p:design", processId: "design", taskId: "t-old", attention: false });
  });

  test("s.sel が別のプロセスのタスクなら、このプロセスのいまのタスクを開く", () => {
    const tasks = [task("t1", "failed", "i2")];
    const r = panelContentOf({ ...base, tasks, key: "p:design", chosenTaskId: "other" });
    expect(r).toMatchObject({ kind: "task", taskId: "t1" });
  });

  test("タスクが一覧に無ければ要素の欄に倒す", () => {
    const processes = [running("build-api", ["t-new"])];
    expect(panelContentOf({ ...base, processes, key: "p:build-api" })).toEqual({ kind: "element", key: "p:build-api" });
  });
});

describe("パネルの高さ", () => {
  test("下限と、図の分を残した上限に収める", () => {
    expect(clampPanelHeight(10, 800)).toBe(PANEL_MIN);
    expect(clampPanelHeight(5000, 800)).toBe(680);
    expect(clampPanelHeight(400.4, 800)).toBe(400);
    // 領域が狭くても下限は守る
    expect(clampPanelHeight(400, 200)).toBe(PANEL_MIN);
  });

  test("覚えた値を読む。無い・壊れている・投げるなら既定", () => {
    const of = (v: string | null) => ({ getItem: () => v });
    expect(readPanelHeight(of("420"))).toBe(420);
    expect(readPanelHeight(of(null))).toBe(PANEL_DEFAULT);
    expect(readPanelHeight(of("abc"))).toBe(PANEL_DEFAULT);
    expect(readPanelHeight(of("-3"))).toBe(PANEL_DEFAULT);
    expect(readPanelHeight(null)).toBe(PANEL_DEFAULT);
    expect(readPanelHeight({ getItem: () => { throw new Error("denied"); } })).toBe(PANEL_DEFAULT);
  });

  test("書き込みが投げても止まらない", () => {
    const set = vi.fn();
    writePanelHeight({ setItem: set }, 333.7);
    expect(set).toHaveBeenCalledWith(expect.any(String), "334");
    expect(() => writePanelHeight({ setItem: () => { throw new Error("quota"); } }, 300)).not.toThrow();
    expect(() => writePanelHeight(null, 300)).not.toThrow();
  });
});

describe("processKeyOfTask", () => {
  test("選んでいるタスクがこの Intake のものなら、そのプロセスのキー", () => {
    const tasks = [task("t1", "running", "i2"), task("t2", "running", "i5"), task("t3", "running", null)];
    // task() の intake.processId は p1
    expect(processKeyOfTask(tasks, "t1", "i2")).toBe("p:p1");
    expect(processKeyOfTask(tasks, "t2", "i2")).toBeNull();
    expect(processKeyOfTask(tasks, "t3", "i2")).toBeNull();
    expect(processKeyOfTask(tasks, "gone", "i2")).toBeNull();
    expect(processKeyOfTask(tasks, null, "i2")).toBeNull();
  });
});
