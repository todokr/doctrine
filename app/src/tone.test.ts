import { describe, expect, test } from "vitest";
import { seedTasks } from "./fixtures";
import { groupOf } from "./model";
import { INTAKE_TONE, PROCESS_TONE, RUN_TONE, TASK_TONE, groupTone, sectionTone, toneClass } from "./tone";
import type { IntakeSummary } from "../../shared/protocol.ts";
import type { Task } from "./types";

const task = (o: Partial<Task>): Task => ({ ...seedTasks()[0], ...o });

describe("トーンの対応表", () => {
  test("中断は失敗と別のトーンになる", () => {
    expect(RUN_TONE.interrupted).toBe("idle");
    expect(RUN_TONE.failed).toBe("danger");
  });

  test("差し戻しは danger、人を待つ実行は human、まだの実行は idle", () => {
    expect(RUN_TONE.bounced).toBe("danger");
    expect(RUN_TONE.awaiting).toBe("human");
    expect(RUN_TONE.pending).toBe("idle");
    expect(RUN_TONE.success).toBe("ok");
  });

  test("タスクの状態", () => {
    expect(TASK_TONE.suspended).toBe("human");
    expect(TASK_TONE.running).toBe("run");
    expect(TASK_TONE.failed).toBe("danger");
    expect(TASK_TONE.unknown).toBe("danger");
    expect(TASK_TONE.completed).toBe("ok");
    for (const s of ["queued", "paused", "rate_limited", "canceled"] as const) expect(TASK_TONE[s]).toBe("idle");
  });

  test("Intake の状態。進行中は run", () => {
    expect(INTAKE_TONE.active).toBe("run");
    expect(INTAKE_TONE.answering).toBe("human");
    expect(INTAKE_TONE.reviewing).toBe("human");
    expect(INTAKE_TONE.needs_attention).toBe("danger");
    expect(INTAKE_TONE.canceled).toBe("idle");
  });

  test("プロセスの状態。PR レビュー中は human、入力待ちと着手可能は破線", () => {
    expect(PROCESS_TONE.pr_open).toEqual({ tone: "human", dashed: false });
    expect(PROCESS_TONE.your_turn).toEqual({ tone: "human", dashed: false });
    expect(PROCESS_TONE.waiting).toEqual({ tone: "idle", dashed: true });
    expect(PROCESS_TONE.ready).toEqual({ tone: "run", dashed: true });
    expect(PROCESS_TONE.merged.tone).toBe("ok");
    expect(PROCESS_TONE.done.tone).toBe("ok");
    expect(PROCESS_TONE.needs_attention.tone).toBe("danger");
  });

  test("サイドバーは状態ではなく区分から引く。削除を拒否した completed は要確認で danger", () => {
    const refused = task({ state: "completed", refused: true, worktree: "/w" });
    expect(groupOf(refused)).toBe("check");
    expect(groupTone(groupOf(refused), refused)).toBe("danger");
    const done = task({ state: "completed", refused: false, worktree: null });
    expect(groupTone(groupOf(done), done)).toBe("ok");
    const canceled = task({ state: "canceled", refused: false, worktree: null });
    expect(groupTone(groupOf(canceled), canceled)).toBe("idle");
  });

  test("Intake の区分", () => {
    const i = (o: Partial<IntakeSummary>) => ({ state: "active", ...o }) as IntakeSummary;
    expect(sectionTone("attention", i({ state: "needs_attention" }))).toBe("danger");
    expect(sectionTone("attention", i({ state: "reviewing" }))).toBe("human");
    expect(sectionTone("working", i({ state: "investigating" }))).toBe("run");
    expect(sectionTone("active", i({ state: "active" }))).toBe("idle");
    expect(sectionTone("closed", i({ state: "completed" }))).toBe("ok");
    expect(sectionTone("closed", i({ state: "canceled" }))).toBe("idle");
  });

  test("クラス名", () => {
    expect(toneClass("human")).toBe("tone-human");
  });
});
