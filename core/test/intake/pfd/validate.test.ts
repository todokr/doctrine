import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import type { Pfd } from "../../../../shared/intake/pfd.ts";
import { frozenPart, type ValidateContext, validatePfd } from "../../../src/intake/pfd/validate.ts";
import { example, noContext, withDecision } from "./fixture.ts";

function rules(pfd: Pfd, ctx: ValidateContext = noContext): string[] {
  return validatePfd(pfd, ctx).map((v) => `${v.rule}:${v.id}`);
}

test("validatePfd: 例には違反が無い", () => {
  assert.deepEqual(validatePfd(example(), noContext), []);
});

test("validatePfd: 入力の無いプロセス", () => {
  const pfd = example();
  pfd.processes[3].inputs = [];
  assert.ok(rules(pfd).includes("no_input:4"));
});

test("validatePfd: 出力の無いプロセス", () => {
  const pfd = example();
  pfd.processes[3].outputs = [];
  assert.ok(rules(pfd).includes("no_output:4"));
});

test("validatePfd: 定義されていない成果物を参照している", () => {
  const pfd = example();
  pfd.processes[0].inputs = ["ghost"];
  assert.ok(rules(pfd).includes("undefined_artifact:ghost"));
});

test("validatePfd: goal が定義されていない成果物を指している", () => {
  const pfd = example();
  pfd.goal = ["ghost"];
  assert.ok(rules(pfd).includes("undefined_artifact:ghost"));
});

test("validatePfd: 同じ成果物を 2 つのプロセスが出力している", () => {
  const pfd = example();
  pfd.processes[3].outputs = ["feature", "endpoint"];
  assert.ok(rules(pfd).includes("multiple_producers:endpoint"));
});

test("validatePfd: given の成果物を出力するプロセスがある", () => {
  const pfd = example();
  pfd.processes[0].outputs = ["new-table", "schema"];
  assert.ok(rules(pfd).includes("given_has_producer:schema"));
});

test("validatePfd: given でないのに出力するプロセスが無い", () => {
  const pfd = example();
  pfd.artifacts[0].given = false;
  pfd.artifacts[0].verify = "ある";
  assert.ok(rules(pfd).includes("no_producer:schema"));
});

test("validatePfd: 誰にも使われない成果物", () => {
  const pfd = example();
  pfd.artifacts.push({ id: "orphan", name: "使われないもの", given: true });
  assert.ok(rules(pfd).includes("unused_artifact:orphan"));
});

test("validatePfd: verify の無い成果物", () => {
  const pfd = example();
  delete pfd.artifacts[1].verify;
  assert.ok(rules(pfd).includes("no_verify:new-table"));
});

test("validatePfd: given の成果物に verify は要らない", () => {
  assert.ok(!rules(example()).includes("no_verify:schema"));
});

test("validatePfd: agent のプロセスに定義が欠けている", () => {
  const pfd = example();
  delete pfd.processes[0].steps;
  const v = validatePfd(pfd, noContext).find((x) => x.rule === "missing_definition");
  assert.equal(v?.id, "1");
  assert.match(v!.message, /steps/);
});

test("validatePfd: human のプロセスに steps は要らない", () => {
  assert.ok(!rules(example()).some((r) => r === "missing_definition:3"));
});

test("validatePfd: id の重複", () => {
  const pfd = example();
  pfd.processes[1].id = "1";
  pfd.artifacts[1].id = "schema";
  const r = rules(pfd);
  assert.ok(r.includes("duplicate_process:1"));
  assert.ok(r.includes("duplicate_artifact:schema"));
});

test("validatePfd: 循環", () => {
  const pfd = example();
  // 1 が、下流の 4 の出力を入力に取る
  pfd.processes[0].inputs = ["schema", "feature"];
  pfd.goal = ["endpoint"];
  assert.ok(validatePfd(pfd, noContext).some((v) => v.rule === "cycle"));
});

test("validatePfd: goal に given から辿り着けない", () => {
  const pfd = example();
  pfd.processes[0].inputs = ["schema", "feature"];
  assert.ok(rules(pfd).includes("goal_unreachable:feature"));
});

const answered: ValidateContext = { answeredQuestionIds: new Set(["q1"]), frozen: null };

test("validatePfd: 答えのある質問を指す decision は通る", () => {
  assert.deepEqual(validatePfd(withDecision(), answered), []);
});

test("validatePfd: decision を持つ成果物は given でなければならない", () => {
  const pfd = withDecision();
  const policy = pfd.artifacts.find((a) => a.id === "policy")!;
  policy.given = false;
  policy.verify = "ある";
  assert.ok(rules(pfd, answered).includes("decision_not_given:policy"));
});

test("validatePfd: 答えの無い質問を指す decision", () => {
  assert.ok(rules(withDecision()).includes("unknown_decision:policy"));
});

function revising(): ValidateContext {
  return { answeredQuestionIds: new Set(), frozen: frozenPart(example(), new Set(["1"])) };
}

test("validatePfd: 改訂でも固定された部分が同じなら通る", () => {
  const next = example();
  next.processes[3].steps = "別の手順";
  assert.deepEqual(validatePfd(next, revising()), []);
});

test("validatePfd: 固定されたプロセスの中身を変えると frozen_changed", () => {
  const next = example();
  next.processes[0].steps = "別の手順";
  assert.ok(rules(next, revising()).includes("frozen_changed:1"));
});

test("validatePfd: 固定されたプロセスの入出力の成果物を変えると frozen_changed", () => {
  const next = example();
  next.artifacts[1].description = "別の説明";
  assert.ok(rules(next, revising()).includes("frozen_changed:new-table"));
});

test("validatePfd: 固定されたプロセスを消すと frozen_changed", () => {
  const next = example();
  next.processes = next.processes.filter((p) => p.id !== "1");
  next.artifacts[1].given = true;
  assert.ok(rules(next, revising()).includes("frozen_changed:1"));
});

test("frozenPart: 固定されたプロセスとその入出力の成果物を集める", () => {
  const part = frozenPart(example(), new Set(["1", "3"]));
  assert.deepEqual(part.processes.map((p) => p.id), ["1", "3"]);
  assert.deepEqual(part.artifacts.map((a) => a.id), ["schema", "new-table", "metric-definition"]);
});
