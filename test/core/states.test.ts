import { test } from "vitest";
import assert from "node:assert/strict";
import {
  canTransition, assertTransition, holdsGlobalSlot, holdsProjectSlot,
  isTerminal, InvalidTransitionError,
} from "../../src/core/states.ts";

test("正常系の遷移を許す", () => {
  assert.ok(canTransition("queued", "running"));
  assert.ok(canTransition("running", "suspended"));
  assert.ok(canTransition("running", "paused"));
  assert.ok(canTransition("suspended", "queued"));
  assert.ok(canTransition("paused", "queued"));
  assert.ok(canTransition("running", "completed"));
  assert.ok(canTransition("running", "failed"));
  assert.ok(canTransition("queued", "canceled"));
  assert.ok(canTransition("suspended", "canceled"));
});

test("終端状態からは動かない", () => {
  for (const from of ["completed", "failed", "canceled"] as const) {
    for (const to of ["queued", "running", "suspended", "paused"] as const) {
      assert.equal(canTransition(from, to), false, `${from} -> ${to}`);
    }
  }
});

test("queued から直接 suspended にはならない", () => {
  assert.equal(canTransition("queued", "suspended"), false);
});

test("ワークフローが読めなければ、ステップを1つも実行せずに failed になれる", () => {
  assert.ok(canTransition("queued", "failed"),
    "queued のまま残すとスケジューラが毎tickリトライし続ける");
  assert.doesNotThrow(() => assertTransition("queued", "failed"));
});

test("不正な遷移は例外を投げる", () => {
  assert.throws(() => assertTransition("completed", "running"), InvalidTransitionError);
  assert.doesNotThrow(() => assertTransition("queued", "running"));
});

test("全体枠を握るのは running だけ", () => {
  assert.ok(holdsGlobalSlot("running"));
  for (const s of ["queued", "suspended", "paused", "completed", "failed", "canceled"] as const) {
    assert.equal(holdsGlobalSlot(s), false, s);
  }
});

test("プロジェクト枠は suspended / paused でも保持される", () => {
  for (const s of ["running", "suspended", "paused"] as const) {
    assert.ok(holdsProjectSlot(s), s);
  }
  for (const s of ["queued", "completed", "failed", "canceled"] as const) {
    assert.equal(holdsProjectSlot(s), false, s);
  }
});

test("終端判定", () => {
  assert.ok(isTerminal("completed") && isTerminal("failed") && isTerminal("canceled"));
  assert.equal(isTerminal("queued"), false);
});
