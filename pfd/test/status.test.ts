import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { parsePfd } from "../src/model.ts";
import { emptyRecord } from "../src/store.ts";
import { findTask, keyOf, taskTitle } from "../src/key.ts";
import { computeStatus, type Facts } from "../src/status.ts";
import { EXAMPLE_YAML } from "./fixture.ts";

const pfd = parsePfd(EXAMPLE_YAML);
const noFacts: Facts = { tasks: [], prs: {} };

function stateOf(facts: Facts, record = emptyRecord()): Record<string, string> {
  return Object.fromEntries(computeStatus(pfd, record, facts).map((s) => [s.id, s.state]));
}

function task(processId: string, state: string) {
  return {
    id: `t${processId}`,
    title: taskTitle(123, pfd.processes.find((p) => p.id === processId)!),
    state,
    branch: `doctrine/t${processId}`,
  };
}

test("keyOf / taskTitle: キーの形", () => {
  assert.equal(keyOf(123, "2"), "[pfd:123/2]");
  assert.equal(taskTitle(123, pfd.processes[1]), "[pfd:123/2] API を実装する");
});

test("findTask: 前方一致で別のプロセスを拾わない", () => {
  const tasks = [{ id: "a", title: "[pfd:123/12] x", state: "running", branch: "b" }];
  assert.equal(findTask(tasks, 123, "1"), undefined);
  assert.equal(findTask(tasks, 123, "12")?.id, "a");
});

test("computeStatus: 最初は 1 が着手可能、3 が人の番、2 と 4 は入力待ち", () => {
  assert.deepEqual(stateOf(noFacts), {
    "1": "ready",
    "2": "waiting",
    "3": "your_turn",
    "4": "waiting",
  });
});

test("computeStatus: 入力待ちのプロセスは、何を待っているかを成果物の名前で持つ", () => {
  const p2 = computeStatus(pfd, emptyRecord(), noFacts).find((s) => s.id === "2")!;
  assert.deepEqual(p2.waiting_for, ["集計テーブル", "集計の定義"]);
});

test("computeStatus: タスクがあれば running、task_id と branch を持つ", () => {
  const s = computeStatus(pfd, emptyRecord(), { tasks: [task("1", "running")], prs: {} })[0];
  assert.equal(s.state, "running");
  assert.equal(s.task_id, "t1");
  assert.equal(s.branch, "doctrine/t1");
});

test("computeStatus: PR が開いていれば pr_open", () => {
  const facts: Facts = { tasks: [task("1", "completed")], prs: { "doctrine/t1": "open" } };
  assert.equal(stateOf(facts)["1"], "pr_open");
});

test("computeStatus: completed なのに PR が無ければ no_pr", () => {
  const facts: Facts = { tasks: [task("1", "completed")], prs: { "doctrine/t1": "none" } };
  assert.equal(stateOf(facts)["1"], "no_pr");
});

test("computeStatus: failed / canceled は task_stopped", () => {
  assert.equal(stateOf({ tasks: [task("1", "failed")], prs: {} })["1"], "task_stopped");
  assert.equal(stateOf({ tasks: [task("1", "canceled")], prs: {} })["1"], "task_stopped");
});

test("computeStatus: 記録にタスクがあるのに dctl ls に無ければ lost、下流は入力待ちのまま", () => {
  const record = emptyRecord();
  record.tasks["1"] = { task_id: "t1", branch: "doctrine/t1", at: "2026-09-20T00:00:00.000Z" };
  const all = computeStatus(pfd, record, noFacts);
  assert.equal(all[0].state, "lost");
  assert.equal(all[0].task_id, "t1");
  assert.equal(all[0].branch, "doctrine/t1");
  assert.equal(all[1].state, "waiting");
  assert.deepEqual(all[1].waiting_for, ["集計テーブル", "集計の定義"]);
});

test("computeStatus: 1 がマージされただけでは 2 は始まらない（人の成果物を待つ）", () => {
  const facts: Facts = { tasks: [task("1", "completed")], prs: { "doctrine/t1": "merged" } };
  const all = computeStatus(pfd, emptyRecord(), facts);
  assert.equal(all[0].state, "merged");
  assert.equal(all[1].state, "waiting");
  assert.deepEqual(all[1].waiting_for, ["集計の定義"]);
});

test("computeStatus: 1 がマージされ 3 が完了すれば 2 が着手可能になる", () => {
  const facts: Facts = { tasks: [task("1", "completed")], prs: { "doctrine/t1": "merged" } };
  const record = emptyRecord();
  record.done["3"] = { note: "ログイン 1 回を 1 利用と数える", at: "2026-09-20T00:00:00.000Z" };
  assert.deepEqual(stateOf(facts, record), {
    "1": "merged",
    "2": "ready",
    "3": "done",
    "4": "waiting",
  });
});

test("computeStatus: PR が開いているだけでは下流は始まらない", () => {
  const facts: Facts = { tasks: [task("1", "completed")], prs: { "doctrine/t1": "open" } };
  const record = emptyRecord();
  record.done["3"] = { note: "x", at: "2026-09-20T00:00:00.000Z" };
  assert.equal(stateOf(facts, record)["2"], "waiting");
});
