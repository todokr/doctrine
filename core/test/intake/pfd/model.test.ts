import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { canonicalJson, parsePfd } from "../../../../shared/intake/pfd.ts";
import { example, withDecision } from "./fixture.ts";

test("parsePfd: 例を読める", () => {
  const r = parsePfd(example());
  assert.ok(r.ok);
  assert.deepEqual(r.pfd.goal, ["feature"]);
  assert.equal(r.pfd.artifacts.length, 5);
  assert.equal(r.pfd.processes.length, 4);
});

test("parsePfd: decision を持つ成果物を読める", () => {
  const r = parsePfd(withDecision());
  assert.ok(r.ok);
  assert.equal(r.pfd.artifacts.find((a) => a.id === "policy")?.decision, "q1");
});

test("parsePfd: 知らないキーを、場所を示して拒む", () => {
  const input = example() as unknown as { processes: Record<string, unknown>[] };
  input.processes[2].owner = "me";
  const r = parsePfd(input);
  assert.ok(!r.ok);
  assert.ok(r.issues.some((i) => i.startsWith("processes.2")));
});

test("parsePfd: issue キーは持たない", () => {
  const r = parsePfd({ ...example(), issue: 123 });
  assert.ok(!r.ok);
});

test("parsePfd: goal が空なら拒む", () => {
  const r = parsePfd({ ...example(), goal: [] });
  assert.ok(!r.ok);
  assert.ok(r.issues.some((i) => i.startsWith("goal")));
});

test("parsePfd: 必須項目が無ければ場所を示す", () => {
  const input = example() as unknown as { processes: Record<string, unknown>[] };
  delete input.processes[3].name;
  const r = parsePfd(input);
  assert.ok(!r.ok);
  assert.ok(r.issues.some((i) => i.startsWith("processes.3.name")));
});

test("parsePfd: given と actor は省けない", () => {
  const input = example() as unknown as { artifacts: Record<string, unknown>[] };
  delete input.artifacts[0].given;
  const r = parsePfd(input);
  assert.ok(!r.ok);
  assert.ok(r.issues.some((i) => i.includes("artifacts.0.given")));
});

test("parsePfd: enum 外の値を拒む", () => {
  const input = example() as unknown as { processes: Record<string, unknown>[] };
  input.processes[2].actor = "robot";
  const r = parsePfd(input);
  assert.ok(!r.ok);
  assert.ok(r.issues.some((i) => i.includes("processes.2.actor")));
});

test("parsePfd: 失敗の文言に zod の英語がそのまま出ない", () => {
  const input = example() as unknown as { processes: Record<string, unknown>[] };
  input.processes[2].owner = "me";
  const r = parsePfd(input);
  assert.ok(!r.ok);
  for (const i of r.issues) assert.doesNotMatch(i, /Unrecognized|Required|Expected|Invalid/);
});

test("parsePfd: 例外を投げない", () => {
  assert.equal(parsePfd("text").ok, false);
  assert.equal(parsePfd(null).ok, false);
});

test("canonicalJson: キーの順に依らず同じ文字列になる", () => {
  const a = canonicalJson({ b: 1, a: { d: 2, c: 3 } });
  const b = canonicalJson({ a: { c: 3, d: 2 }, b: 1 });
  assert.equal(a, b);
  assert.equal(a, '{"a":{"c":3,"d":2},"b":1}');
});

test("canonicalJson: undefined のキーを落とし、配列の順は保つ", () => {
  assert.equal(canonicalJson({ x: undefined, y: [2, 1] }), '{"y":[2,1]}');
});
