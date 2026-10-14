import { describe, expect, test } from "vitest";
import type { IntakeSummary } from "../../shared/protocol.ts";
import {
  attentionProcessIds,
  countExecutionAttention,
  executionOrder,
  executionSection,
  firstAttentionKey,
  inExecution,
  isExecutionAttention,
  railsOf,
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
    const view = buildPfdView(PFD_SAMPLE, { attention: new Set(["approve", "design"]) });
    expect(firstAttentionKey(view)).toBe("p:design");
    expect(firstAttentionKey(buildPfdView(PFD_SAMPLE))).toBeNull();
  });
});

describe("railsOf", () => {
  test("プロセスの id から帯", () => {
    expect(railsOf([{ ...INTAKE_ACTIVE.processes[0], id: "x", rail: null }])).toEqual({ x: null });
  });
});
