import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { validateGuide } from "../../../shared/guide/validate.ts";

function minimalGuide(): Record<string, unknown> {
  return {
    version: 1,
    why: "利用者が待たされる原因を取り除く",
    what: [],
    how: [],
    readingOrder: [],
    decisions: [],
    risks: [],
    tests: [],
    diagrams: [],
  };
}

function validGuide(): Record<string, unknown> {
  return {
    ...minimalGuide(),
    decisions: [{ id: "d1", decision: "キャッシュを捨てる", reason: "古い値が残るため" }],
    risks: [{ id: "r1", kind: "breaks", body: "初回表示が遅くなる", locations: [] }],
    tests: [{
      id: "t1",
      behavior: "古い値が返らない",
      path: "core/test/x.test.ts",
      name: "古い値が返らない",
    }],
    diagrams: [{
      id: "g1",
      title: "流れ",
      body: { shape: "sequence", actors: ["UI"], messages: [] },
    }],
    how: [{ body: "呼び出しの流れを変える", diagram: "g1" }],
    readingOrder: [{
      title: "入口",
      body: "ここから読む",
      locations: [{ path: "a.ts" }],
      refs: { decisions: ["d1"], risks: ["r1"], tests: ["t1"], diagrams: ["g1"] },
    }],
  };
}

function issuesOf(input: unknown): string[] {
  const result = validateGuide(input);
  assert.equal(result.ok, false);
  return result.ok ? [] : result.issues;
}

test("正しいガイドが ok になる", () => {
  const input = validGuide();
  const result = validateGuide(input);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.guide, input);
});

test("形が壊れた入力でも例外を投げずに落ちる", () => {
  for (const input of [null, undefined, "ガイド", []]) {
    assert.ok(issuesOf(input).length >= 1);
  }

  const missingTests = minimalGuide();
  delete missingTests.tests;
  assert.ok(issuesOf(missingTests).some((s) => s.startsWith("tests")));

  const unknownKey = { ...minimalGuide(), summary: "要約" };
  assert.ok(issuesOf(unknownKey).some((s) => s.includes("summary")));
});
