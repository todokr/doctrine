import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { createWarningLog, WARNING_CAPACITY } from "../../src/daemon/warnings.ts";
import type { ServerEvent } from "../../../shared/protocol.ts";

function log() {
  const events: ServerEvent[] = [];
  const written: string[] = [];
  return {
    events,
    written,
    warnings: createWarningLog({
      broadcast: (ev) => events.push(ev),
      write: (line) => written.push(line),
    }),
  };
}

test("push した警告は新しい順に返る", () => {
  const { warnings } = log();
  warnings.push("古い");
  warnings.push("新しい");
  assert.deepEqual(warnings.recent().map((w) => w.message), ["新しい", "古い"]);
});

test("直近 WARNING_CAPACITY 件だけを保つ", () => {
  const { warnings } = log();
  for (let i = 0; i <= WARNING_CAPACITY; i++) warnings.push(`w${i}`);
  const recent = warnings.recent();
  assert.equal(recent.length, WARNING_CAPACITY);
  assert.equal(recent[0].message, `w${WARNING_CAPACITY}`);
  assert.equal(recent.at(-1)!.message, "w1", "いちばん古い w0 が落ちる");
});

test("push はその場で daemon.warning を broadcast する", () => {
  const { warnings, events } = log();
  warnings.push("後始末に失敗しました", "task-1");
  assert.equal(events.length, 1);
  const ev = events[0];
  assert.equal(ev.event, "daemon.warning");
  if (ev.event !== "daemon.warning") throw new Error("型の絞り込み");
  assert.equal(ev.message, "後始末に失敗しました");
  assert.equal(ev.task_id, "task-1");
  assert.ok(!Number.isNaN(Date.parse(ev.at)));
});

test("task_id の無い警告は task_id を持たない", () => {
  const { warnings, events } = log();
  warnings.push("対応するタスクのない worktree: /tmp/x");
  assert.equal((events[0] as { task_id?: string }).task_id, undefined);
  assert.equal(warnings.recent()[0].task_id, undefined);
});

test("push は stderr 相当にもその場で書く", () => {
  const { warnings, written } = log();
  warnings.push("消せませんでした", "task-1");
  assert.deepEqual(written, ["[warn] task-1: 消せませんでした"]);
});
