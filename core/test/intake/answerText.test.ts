import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { buildAnswerText, decisionTexts } from "../../../shared/intake/answerText.ts";
import type { Question } from "../../../shared/intake/question.ts";
import { question } from "./runnerHelper.ts";

function single(id: string): Question {
  return {
    id,
    prompt: `${id} をどうするか`,
    kind: "single",
    options: [
      { id: "a", label: "同期で書く", description: "d" },
      { id: "b", label: "キューに積む", description: "d" },
    ],
    recommendation: null,
    materials: [],
  };
}

test("選んだ選択肢の label と other と note が出る", () => {
  const text = buildAnswerText([single("q1")], [
    { questionId: "q1", optionIds: ["a"], other: "その他の答え", note: "補足" },
  ]);
  assert.match(text, /q1/);
  assert.match(text, /同期で書く/);
  assert.doesNotMatch(text, /キューに積む/);
  assert.match(text, /その他の答え/);
  assert.match(text, /補足/);
});

test("答えの無い質問は回答なしと書く", () => {
  const text = buildAnswerText([single("q1"), single("q2")], [
    { questionId: "q1", optionIds: ["b"], other: null, note: null },
  ]);
  assert.match(text, /q2[\s\S]*回答なし/);
});

test("decisionTexts: 回答済みの質問だけを、質問 id ごとの文章にする", () => {
  const texts = decisionTexts([
    {
      questions: [question("q1")],
      answers: [{ questionId: "q1", optionIds: ["a"], other: null, note: "x" }],
    },
    { questions: [question("q2")], answers: null },
  ]);
  assert.deepEqual(texts, { q1: "選んだ選択肢: 案A（a）、補足: x" });
});
