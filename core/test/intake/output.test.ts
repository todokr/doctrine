import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { checkDecomposerOutput } from "../../src/intake/output.ts";
import type { Question } from "../../../shared/intake/question.ts";
import { example, withDecision } from "./pfd/fixture.ts";

const q = (id: string): Question => ({
  id,
  prompt: "どうするか",
  kind: "single",
  options: [
    { id: "a", label: "案A", description: "d" },
    { id: "b", label: "案B", description: "d" },
  ],
  recommendation: null,
  materials: [],
});

type Ctx = Parameters<typeof checkDecomposerOutput>[1];
const ctx = (o: Partial<Ctx> = {}): Ctx => ({
  purpose: "decompose",
  askedQuestionIds: new Set(),
  answeredQuestionIds: new Set(),
  feedbackCount: 0,
  ...o,
});

const questionsOut = (questions: Question[]) => ({
  kind: "questions",
  questions,
  pfd: null,
  replies: null,
});
const pfdOut = (pfd: unknown, replies: unknown[] = []) => ({
  kind: "pfd",
  questions: null,
  pfd,
  replies,
});

function issuesOf(r: ReturnType<typeof checkDecomposerOutput>): string[] {
  assert.equal(r.ok, false);
  return r.ok ? [] : r.issues;
}

test("出力が無ければ違反", () => {
  assert.match(issuesOf(checkDecomposerOutput(null, ctx())).join("\n"), /構造化出力/);
});

test("形が違えば違反（パスが付く）", () => {
  const issues = issuesOf(checkDecomposerOutput({ kind: "nothing" }, ctx()));
  assert.ok(issues.some((i) => i.startsWith("kind")));
});

test("kind と中身が食い違えば違反", () => {
  const raw = { kind: "questions", questions: null, pfd: example(), replies: null };
  assert.ok(issuesOf(checkDecomposerOutput(raw, ctx())).length > 0);
});

test("質問の出力を通す", () => {
  const r = checkDecomposerOutput(questionsOut([q("q1")]), ctx());
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.output.kind, "questions");
});

test("調査の実行が PFD を返したら違反", () => {
  const issues = issuesOf(
    checkDecomposerOutput(pfdOut(example()), ctx({ purpose: "investigate" })),
  );
  assert.match(issues.join("\n"), /調査の実行は質問だけを返します/);
});

test("調査の実行の空の質問は通る", () => {
  const r = checkDecomposerOutput(questionsOut([]), ctx({ purpose: "investigate" }));
  assert.equal(r.ok, true);
});

test("分解の実行の空の質問は違反", () => {
  const issues = issuesOf(checkDecomposerOutput(questionsOut([]), ctx()));
  assert.match(issues.join("\n"), /質問が無ければ PFD を返します/);
});

test("前に出した質問と同じ id は違反", () => {
  const issues = issuesOf(
    checkDecomposerOutput(questionsOut([q("q1")]), ctx({ askedQuestionIds: new Set(["q1"]) })),
  );
  assert.match(issues.join("\n"), /questions\.0\.id: 前に出した質問と id が重複しています: q1/);
});

test("質問の整合性の違反を返す", () => {
  const dup = [q("q1"), q("q1")];
  assert.ok(issuesOf(checkDecomposerOutput(questionsOut(dup), ctx())).length > 0);
});

test("PFD の規則違反を返す", () => {
  const pfd = example();
  pfd.processes[0].outputs = [];
  const issues = issuesOf(checkDecomposerOutput(pfdOut(pfd), ctx()));
  assert.ok(issues.some((i) => i.includes("no_output")));
});

test("決定の成果物は答えのある質問を指せば通る", () => {
  const r = checkDecomposerOutput(
    pfdOut(withDecision()),
    ctx({ answeredQuestionIds: new Set(["q1"]) }),
  );
  assert.equal(r.ok, true);
});

test("決定の成果物が答えの無い質問を指せば違反", () => {
  const issues = issuesOf(checkDecomposerOutput(pfdOut(withDecision()), ctx()));
  assert.ok(issues.some((i) => i.includes("unknown_decision")));
});

test("replies の番号が範囲外なら違反", () => {
  const issues = issuesOf(
    checkDecomposerOutput(
      pfdOut(example(), [{ commentId: 2, reply: "r" }]),
      ctx({ feedbackCount: 1 }),
    ),
  );
  assert.match(issues.join("\n"), /commentId/);
});

test("replies の番号が重複したら違反", () => {
  const issues = issuesOf(
    checkDecomposerOutput(
      pfdOut(example(), [{ commentId: 1, reply: "r" }, { commentId: 1, reply: "s" }]),
      ctx({ feedbackCount: 1 }),
    ),
  );
  assert.match(issues.join("\n"), /重複/);
});

test("replies の番号が範囲内なら通る", () => {
  const r = checkDecomposerOutput(
    pfdOut(example(), [{ commentId: 1, reply: "r" }]),
    ctx({ feedbackCount: 1 }),
  );
  assert.equal(r.ok, true);
});
