import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import {
  assertTransition,
  canTransition,
  holdsGlobalSlot,
  holdsProjectSlot,
  InvalidTransitionError,
  isTerminal,
} from "../../src/domain/states.ts";

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
  assert.ok(
    canTransition("queued", "failed"),
    "queued のまま残すとスケジューラが毎tickリトライし続ける",
  );
  assert.doesNotThrow(() => assertTransition("queued", "failed"));
});

test("suspended から completed になれる（最後が approval で承認されたとき）", () => {
  assert.ok(
    canTransition("suspended", "completed"),
    "承認されて次のステップが無ければ、そこでタスクは完了している",
  );
  assert.doesNotThrow(() => assertTransition("suspended", "completed"));
});

test("suspended から running / paused へは直接行けない", () => {
  assert.equal(canTransition("suspended", "running"), false);
  assert.equal(canTransition("suspended", "paused"), false);
});

test("running から rate_limited へ入り、解放で queued に戻れる", () => {
  assert.ok(canTransition("running", "rate_limited"));
  assert.ok(canTransition("rate_limited", "queued"));
  assert.doesNotThrow(() => assertTransition("running", "rate_limited"));
});

test("上限待ちのタスクも人の操作と tick の失敗経路で外へ出られる", () => {
  for (const to of ["paused", "canceled", "failed"] as const) {
    assert.ok(canTransition("rate_limited", to), `rate_limited -> ${to}`);
  }
});

test("rate_limited から直接 running / suspended / completed へは行けない", () => {
  for (const to of ["running", "suspended", "completed"] as const) {
    assert.equal(canTransition("rate_limited", to), false, `rate_limited -> ${to}`);
  }
});

test("終端状態から rate_limited へは戻れない", () => {
  for (const from of ["completed", "failed", "canceled"] as const) {
    assert.equal(canTransition(from, "rate_limited"), false, from);
  }
});

test("不正な遷移は例外を投げる", () => {
  assert.throws(() => assertTransition("completed", "running"), InvalidTransitionError);
  assert.doesNotThrow(() => assertTransition("queued", "running"));
});

test("全体枠を握るのは running だけ", () => {
  assert.ok(holdsGlobalSlot("running"));
  for (
    const s of [
      "queued",
      "suspended",
      "paused",
      "rate_limited",
      "completed",
      "failed",
      "canceled",
    ] as const
  ) {
    assert.equal(holdsGlobalSlot(s), false, s);
  }
});

test("プロジェクト枠は suspended / paused / rate_limited / waiting でも保持される", () => {
  for (const s of ["running", "suspended", "paused", "rate_limited", "waiting"] as const) {
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

test("running から waiting へ入り、解放で queued に戻れる", () => {
  assert.ok(canTransition("running", "waiting"));
  assert.ok(canTransition("waiting", "queued"));
});

test("マージ待ちのタスクも人の操作と tick の失敗経路で外へ出られる", () => {
  for (const to of ["paused", "canceled", "failed"] as const) {
    assert.ok(canTransition("waiting", to), `waiting -> ${to}`);
  }
});

test("waiting から直接 running / suspended / completed へは行けない", () => {
  for (const to of ["running", "suspended", "completed"] as const) {
    assert.equal(canTransition("waiting", to), false, `waiting -> ${to}`);
  }
});
