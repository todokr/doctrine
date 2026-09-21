import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { buildAnswerText } from "../../../shared/intake/answerText.ts";
import type { Question } from "../../../shared/intake/question.ts";

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
