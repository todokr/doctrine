import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { guideSchema } from "../../../shared/guide/schema.ts";

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

test("最小のガイドが parse を通る", () => {
  const guide = minimalGuide();
  assert.deepEqual(guideSchema.parse(guide), guide);
});

test("節が欠けていたら落ちる", () => {
  const guide = minimalGuide();
  delete guide.tests;
  assert.equal(guideSchema.safeParse(guide).success, false);
});

test("知らないキーがあったら落ちる", () => {
  const guide = { ...minimalGuide(), summary: "要約" };
  assert.equal(guideSchema.safeParse(guide).success, false);
});

test("version が 1 以外なら落ちる", () => {
  assert.equal(guideSchema.safeParse({ ...minimalGuide(), version: 2 }).success, false);
  assert.equal(guideSchema.safeParse({ ...minimalGuide(), version: "1" }).success, false);
});

test("読む箇所は hunk を省ける", () => {
  const guide = {
    ...minimalGuide(),
    readingOrder: [{
      title: "入口",
      body: "ここから読む",
      locations: [{ path: "a.ts" }, { path: "b.ts", hunk: "h1" }],
      refs: { decisions: [], risks: [], tests: [], diagrams: [] },
    }],
  };
  const parsed = guideSchema.parse(guide);
  assert.equal(parsed.readingOrder[0].locations[0].hunk, undefined);
  assert.equal(parsed.readingOrder[0].locations[1].hunk, "h1");
});

test("risk の kind は 4 つだけ", () => {
  const withKind = (kind: string) => ({
    ...minimalGuide(),
    risks: [{ id: "r1", kind, impact: "high", body: "壊れうる", locations: [] }],
  });
  assert.equal(guideSchema.safeParse(withKind("breaks")).success, true);
  assert.equal(guideSchema.safeParse(withKind("critical")).success, false);
});

test("risk の impact は high / medium / low だけで、省けない", () => {
  const withImpact = (impact?: string) => ({
    ...minimalGuide(),
    risks: [{
      id: "r1",
      kind: "breaks",
      ...(impact === undefined ? {} : { impact }),
      body: "壊れうる",
      locations: [],
    }],
  });
  for (const impact of ["high", "medium", "low"]) {
    assert.equal(guideSchema.safeParse(withImpact(impact)).success, true, impact);
  }
  assert.equal(guideSchema.safeParse(withImpact("critical")).success, false);
  assert.equal(guideSchema.safeParse(withImpact()).success, false);
});

test("図はシーケンスとグラフの 2 形だけ", () => {
  const withBody = (body: Record<string, unknown>) => ({
    ...minimalGuide(),
    diagrams: [{ id: "d1", title: "流れ", body }],
  });
  const sequence = {
    shape: "sequence",
    actors: ["UI", "Core"],
    messages: [{ from: "UI", to: "Core", label: "要求" }],
  };
  const graph = {
    shape: "graph",
    kind: "dependency",
    nodes: [{ id: "n1", label: "A", change: "added" }],
    edges: [{ from: "n1", to: "n1", label: "自己参照" }],
  };
  assert.equal(guideSchema.safeParse(withBody(sequence)).success, true);
  assert.equal(guideSchema.safeParse(withBody(graph)).success, true);
  assert.equal(guideSchema.safeParse(withBody({ shape: "flow" })).success, false);
});
