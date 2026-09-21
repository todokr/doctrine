import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import {
  assertIntakeTransition,
  canIntakeTransition,
  InvalidIntakeTransitionError,
  isIntakeTerminal,
  retryStateFor,
} from "../../src/domain/intakeStates.ts";
import type { IntakeState } from "../../src/db/intakes.ts";

const STATES: IntakeState[] = [
  "investigating",
  "answering",
  "decomposing",
  "reviewing",
  "active",
  "needs_attention",
  "completed",
  "canceled",
];

/** spec 5 章の遷移表を、コードの表を写さずに文字で書き下したもの。revising に関係ない辺。 */
const ALWAYS: [IntakeState, IntakeState][] = [
  ["investigating", "answering"],
  ["investigating", "decomposing"],
  ["investigating", "needs_attention"],
  ["investigating", "canceled"],
  ["answering", "decomposing"],
  ["answering", "canceled"],
  ["decomposing", "answering"],
  ["decomposing", "reviewing"],
  ["decomposing", "needs_attention"],
  ["decomposing", "canceled"],
  ["reviewing", "decomposing"],
  ["reviewing", "active"],
  ["reviewing", "canceled"],
  ["active", "decomposing"],
  ["active", "completed"],
  ["active", "canceled"],
  ["needs_attention", "investigating"],
  ["needs_attention", "decomposing"],
  ["needs_attention", "canceled"],
];

/** revising = 1 のときだけ許す辺（intake.abandonRevision）。 */
const ONLY_REVISING: [IntakeState, IntakeState][] = [
  ["answering", "active"],
  ["decomposing", "active"],
  ["needs_attention", "active"],
];

const key = (from: IntakeState, to: IntakeState, revising: boolean) =>
  `${from} -> ${to} (${revising})`;

test("許す遷移は spec 5 章の表と一致し、それ以外はすべて拒む", () => {
  const allowed = new Set<string>();
  for (const [from, to] of ALWAYS) {
    allowed.add(key(from, to, false));
    allowed.add(key(from, to, true));
  }
  for (const [from, to] of ONLY_REVISING) allowed.add(key(from, to, true));

  let checked = 0;
  for (const from of STATES) {
    for (const to of STATES) {
      for (const revising of [false, true]) {
        assert.equal(
          canIntakeTransition(from, to, revising),
          allowed.has(key(from, to, revising)),
          key(from, to, revising),
        );
        checked++;
      }
    }
  }
  assert.equal(checked, 128);
});

test("PRD 8 章の図の辺を許す", () => {
  const edges: [string, IntakeState, IntakeState, boolean][] = [
    ["調査中 → 回答待ち", "investigating", "answering", false],
    ["調査中 → 分解中（質問なし）", "investigating", "decomposing", false],
    ["調査中 → 要確認", "investigating", "needs_attention", false],
    ["回答待ち → 分解中", "answering", "decomposing", false],
    ["分解中 → 回答待ち", "decomposing", "answering", false],
    ["分解中 → レビュー待ち", "decomposing", "reviewing", false],
    ["分解中 → 要確認", "decomposing", "needs_attention", false],
    ["要確認 → 分解中（やり直す）", "needs_attention", "decomposing", false],
    ["レビュー待ち → 分解中（差し戻し）", "reviewing", "decomposing", false],
    ["レビュー待ち → 進行中（承認）", "reviewing", "active", false],
    ["進行中 → 完了", "active", "completed", false],
    ["進行中 → 改訂の開始（分解中）", "active", "decomposing", false],
    ["改訂中のレビュー待ち → 進行中（再承認）", "reviewing", "active", true],
    ["改訂中の分解中 → 進行中（改訂をやめる）", "decomposing", "active", true],
  ];
  for (const [name, from, to, revising] of edges) {
    assert.equal(canIntakeTransition(from, to, revising), true, name);
  }
});

test("進行中から要確認へは移らない", () => {
  assert.equal(canIntakeTransition("active", "needs_attention", false), false);
  assert.equal(canIntakeTransition("active", "needs_attention", true), false);
});

test("要確認から調査中へ戻れる（調査で落ちたものを質問なしで分解に入れない）", () => {
  assert.equal(canIntakeTransition("needs_attention", "investigating", false), true);
  assert.equal(canIntakeTransition("needs_attention", "investigating", true), true);
});

test("改訂中でなければ、回答待ち・分解中・要確認から進行中へは移れない", () => {
  for (const from of ["answering", "decomposing", "needs_attention"] as const) {
    assert.equal(canIntakeTransition(from, "active", false), false, from);
    assert.equal(canIntakeTransition(from, "active", true), true, from);
  }
});

test("承認はいつでもレビュー待ちから進行中へ移す", () => {
  assert.equal(canIntakeTransition("reviewing", "active", false), true);
  assert.equal(canIntakeTransition("reviewing", "active", true), true);
});

test("終わった Intake は動かない", () => {
  for (const from of ["completed", "canceled"] as const) {
    for (const to of STATES) {
      for (const revising of [false, true]) {
        assert.equal(canIntakeTransition(from, to, revising), false, key(from, to, revising));
      }
    }
  }
});

test("終わっていないどの状態からも中止できる", () => {
  const open = STATES.filter((s) => s !== "completed" && s !== "canceled");
  assert.equal(open.length, 6);
  for (const from of open) {
    assert.equal(canIntakeTransition(from, "canceled", false), true, from);
    assert.equal(canIntakeTransition(from, "canceled", true), true, from);
  }
});

test("不正な遷移は InvalidIntakeTransitionError を投げる", () => {
  assert.throws(
    () => assertIntakeTransition("completed", "active", false),
    (e: unknown) => {
      assert.ok(e instanceof InvalidIntakeTransitionError);
      assert.equal(e.name, "InvalidIntakeTransitionError");
      assert.match(e.message, /completed -> active/);
      return true;
    },
  );
  assert.doesNotThrow(() => assertIntakeTransition("reviewing", "active", false));
  assert.throws(() => assertIntakeTransition("answering", "active", false), (e: unknown) => {
    assert.ok(e instanceof InvalidIntakeTransitionError);
    assert.doesNotMatch(e.message, /改訂中/);
    return true;
  });
  assert.throws(() => assertIntakeTransition("completed", "active", true), (e: unknown) => {
    assert.ok(e instanceof InvalidIntakeTransitionError);
    assert.match(e.message, /改訂中/);
    return true;
  });
  assert.doesNotThrow(() => assertIntakeTransition("answering", "active", true));
});

test("終端判定", () => {
  for (const s of STATES) {
    assert.equal(isIntakeTerminal(s), s === "completed" || s === "canceled", s);
  }
});

test("やり直し先は失敗した実行の purpose で決まる", () => {
  assert.equal(retryStateFor("investigate"), "investigating");
  assert.equal(retryStateFor("decompose"), "decomposing");
  assert.equal(retryStateFor("revise"), "decomposing");
});
