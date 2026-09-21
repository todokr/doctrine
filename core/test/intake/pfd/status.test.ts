import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import type { PrFact } from "../../../../shared/intake/processStatus.ts";
import type { TaskState } from "../../../src/db/tasks.ts";
import {
  computeProcessStatuses,
  goalReached,
  type ProcessProgress,
  type StatusInput,
} from "../../../src/intake/pfd/status.ts";
import { example } from "./fixture.ts";

const base: StatusInput = {
  pfd: example(),
  baseBranch: "main",
  revising: false,
  dispatchPaused: false,
  progress: new Map(),
};

const subIssue = "https://github.com/o/r/issues/201";
const doneNote = { note: "ログイン 1 回を 1 利用と数える", at: "2026-09-20T00:00:00.000Z" };

function stateOf(input: StatusInput): Record<string, string> {
  return Object.fromEntries(computeProcessStatuses(input).map((e) => [e.id, e.state]));
}

function entry(input: StatusInput, id: string) {
  return computeProcessStatuses(input).find((e) => e.id === id)!;
}

function pr(state: PrFact["state"], baseRef = "main"): PrFact {
  return {
    number: 1,
    url: "https://github.com/o/r/pull/1",
    state,
    baseRef,
    mergedAt: state === "MERGED" ? "2026-09-20T01:00:00.000Z" : null,
    mergeCommit: state === "MERGED" ? "abc123" : null,
  };
}

function agent(
  taskState: TaskState,
  prFact: PrFact | null,
  subIssueUrl: string | null = subIssue,
): ProcessProgress {
  return { task: { id: "t1", state: taskState }, pr: prFact, subIssueUrl, humanDone: null };
}

function human(): ProcessProgress {
  return { task: null, pr: null, subIssueUrl: null, humanDone: doneNote };
}

function withProgress(entries: Record<string, ProcessProgress>): StatusInput {
  return { ...base, progress: new Map(Object.entries(entries)) };
}

const ready1: ProcessProgress = {
  task: null,
  pr: null,
  subIssueUrl: subIssue,
  humanDone: null,
};

test("computeProcessStatuses: 最初は 1 が着手可能、3 があなたの番、2 と 4 は入力待ち", () => {
  const input = withProgress({ "1": ready1 });
  assert.deepEqual(stateOf(input), {
    "1": "ready",
    "2": "waiting",
    "3": "your_turn",
    "4": "waiting",
  });
  assert.deepEqual(entry(input, "1"), { id: "1", state: "ready", blockedBy: null });
});

test("computeProcessStatuses: 入力待ちは揃っていない成果物の id を持つ", () => {
  assert.deepEqual(entry(base, "2"), {
    id: "2",
    state: "waiting",
    missing: ["new-table", "metric-definition"],
  });
});

test("computeProcessStatuses: sub-issue が無ければ ready の blockedBy は no_sub_issue", () => {
  assert.deepEqual(entry(base, "1"), { id: "1", state: "ready", blockedBy: "no_sub_issue" });
});

test("computeProcessStatuses: 改訂中なら blockedBy は revising、止めていれば paused", () => {
  const input = withProgress({ "1": ready1 });
  assert.deepEqual(entry({ ...input, revising: true, dispatchPaused: true }, "1"), {
    id: "1",
    state: "ready",
    blockedBy: "revising",
  });
  assert.deepEqual(entry({ ...input, dispatchPaused: true }, "1"), {
    id: "1",
    state: "ready",
    blockedBy: "paused",
  });
});

test("computeProcessStatuses: タスクが走っていて PR が無ければ running", () => {
  assert.deepEqual(entry(withProgress({ "1": agent("running", null) }), "1"), {
    id: "1",
    state: "running",
    taskId: "t1",
  });
});

test("computeProcessStatuses: PR が開いていれば pr_open", () => {
  const open = pr("OPEN");
  assert.deepEqual(entry(withProgress({ "1": agent("completed", open) }), "1"), {
    id: "1",
    state: "pr_open",
    taskId: "t1",
    pr: open,
  });
});

test("computeProcessStatuses: completed で PR が無ければ要確認（no_pr）", () => {
  assert.deepEqual(entry(withProgress({ "1": agent("completed", null) }), "1"), {
    id: "1",
    state: "needs_attention",
    taskId: "t1",
    reason: "no_pr",
  });
});

test("computeProcessStatuses: failed / canceled は要確認（task_stopped）", () => {
  for (const s of ["failed", "canceled"] as const) {
    assert.deepEqual(entry(withProgress({ "1": agent(s, null) }), "1"), {
      id: "1",
      state: "needs_attention",
      taskId: "t1",
      reason: "task_stopped",
    });
  }
});

test("computeProcessStatuses: マージされずに閉じた PR は要確認（pr_closed）", () => {
  assert.deepEqual(entry(withProgress({ "1": agent("completed", pr("CLOSED")) }), "1"), {
    id: "1",
    state: "needs_attention",
    taskId: "t1",
    reason: "pr_closed",
  });
});

test("computeProcessStatuses: baseBranch 以外へのマージは pr_closed で、下流は入力待ちのまま", () => {
  const input = withProgress({
    "1": agent("completed", pr("MERGED", "release")),
    "3": human(),
  });
  assert.deepEqual(entry(input, "1"), {
    id: "1",
    state: "needs_attention",
    taskId: "t1",
    reason: "pr_closed",
  });
  assert.deepEqual(entry(input, "2"), { id: "2", state: "waiting", missing: ["new-table"] });
});

test("computeProcessStatuses: 1 がマージされただけでは 2 は始まらない（人の成果物を待つ）", () => {
  const input = withProgress({ "1": agent("completed", pr("MERGED")) });
  assert.equal(entry(input, "1").state, "merged");
  assert.deepEqual(entry(input, "2"), {
    id: "2",
    state: "waiting",
    missing: ["metric-definition"],
  });
});

test("computeProcessStatuses: 1 がマージされ 3 が完了すれば 2 が着手可能になる", () => {
  const input = withProgress({
    "1": agent("completed", pr("MERGED")),
    "2": ready1,
    "3": human(),
  });
  assert.deepEqual(stateOf(input), {
    "1": "merged",
    "2": "ready",
    "3": "done",
    "4": "waiting",
  });
  assert.deepEqual(entry(input, "3"), { id: "3", state: "done", ...doneNote });
});

test("computeProcessStatuses: PR が開いているだけでは下流は始まらない", () => {
  const input = withProgress({ "1": agent("completed", pr("OPEN")), "3": human() });
  assert.equal(entry(input, "2").state, "waiting");
});

test("computeProcessStatuses: W-9 の 8 状態をすべて返せる", () => {
  const seen = new Set<string>();
  const inputs = [
    base,
    withProgress({ "1": ready1 }),
    withProgress({ "1": agent("running", null) }),
    withProgress({ "1": agent("completed", pr("OPEN")) }),
    withProgress({ "1": agent("completed", pr("MERGED")), "3": human() }),
    withProgress({ "1": agent("failed", null) }),
  ];
  for (const input of inputs) {
    for (const e of computeProcessStatuses(input)) seen.add(e.state);
  }
  assert.deepEqual(
    [...seen].sort(),
    ["done", "merged", "needs_attention", "pr_open", "ready", "running", "waiting", "your_turn"],
  );
});

function goalReachedOf(input: StatusInput): boolean {
  return goalReached(input.pfd, computeProcessStatuses(input));
}

test("goalReached: goal を出すプロセスがマージされるまでは false", () => {
  const input = withProgress({
    "1": agent("completed", pr("MERGED")),
    "2": agent("completed", pr("MERGED")),
    "3": human(),
    "4": agent("running", null),
  });
  assert.equal(goalReachedOf(input), false);
});

test("goalReached: goal を出すプロセスがマージされれば true", () => {
  const input = withProgress({
    "1": agent("completed", pr("MERGED")),
    "2": agent("completed", pr("MERGED")),
    "3": human(),
    "4": agent("completed", pr("MERGED")),
  });
  assert.equal(goalReachedOf(input), true);
});

test("goalReached: 人のプロセスの完了でも揃う", () => {
  const pfd = example();
  pfd.goal = ["metric-definition"];
  assert.equal(goalReachedOf({ ...base, pfd, progress: new Map([["3", human()]]) }), true);
});
