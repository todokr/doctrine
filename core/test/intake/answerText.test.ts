import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { buildAnswerText, decisionTexts } from "../../../shared/intake/answerText.ts";
import type { Question } from "../../../shared/intake/question.ts";
import { assumption, question } from "./runnerHelper.ts";

function single(id: string): Question {
  return {
    id,
    prompt: `${id} をどうするか`,
    kind: "single",
    options: [
      { id: "a", label: "同期で書く", description: "d" },
      { id: "b", label: "キューに積む", description: "d" },
    ],
    materials: [],
  };
}

test("選んだ選択肢の label と other と note が出る", () => {
  const text = buildAnswerText({ questions: [single("q1")], assumptions: [] }, {
    answers: [{ questionId: "q1", optionIds: ["a"], other: "その他の答え", note: "補足" }],
    assumptionResponses: [],
  });
  assert.match(text, /q1/);
  assert.match(text, /同期で書く/);
  assert.doesNotMatch(text, /キューに積む/);
  assert.match(text, /その他の答え/);
  assert.match(text, /補足/);
});

test("答えの無い質問は回答なしと書く", () => {
  const text = buildAnswerText({ questions: [single("q1"), single("q2")], assumptions: [] }, {
    answers: [{ questionId: "q1", optionIds: ["b"], other: null, note: null }],
    assumptionResponses: [],
  });
  assert.match(text, /q2[\s\S]*回答なし/);
});

test("書き直した仮定と認めた仮定を分けて載せる", () => {
  const text = buildAnswerText(
    { questions: [], assumptions: [assumption("s1"), assumption("s2")] },
    {
      answers: [],
      assumptionResponses: [
        { assumptionId: "s1", verdict: "corrected", correction: "集計は時間単位で要る" },
        { assumptionId: "s2", verdict: "accepted" },
      ],
    },
  );
  assert.doesNotMatch(text, /質問への回答/);
  assert.match(
    text,
    /人が書き直した仮定[\s\S]*s1[\s\S]*集計は時間単位で要る[\s\S]*人が認めた仮定[\s\S]*s2/,
  );
});

test("decisionTexts: 回答済みのまとまりの質問と仮定を、id ごとの文章にする", () => {
  const texts = decisionTexts([
    {
      questions: [question("q1")],
      assumptions: [assumption("s1"), assumption("s2")],
      reply: {
        answers: [{ questionId: "q1", optionIds: ["a"], other: null, note: "x" }],
        assumptionResponses: [
          { assumptionId: "s1", verdict: "accepted" },
          { assumptionId: "s2", verdict: "corrected", correction: "週次" },
        ],
      },
    },
    { questions: [question("q2")], assumptions: [assumption("s3")], reply: null },
  ]);
  assert.deepEqual(texts, {
    q1: "選んだ選択肢: 案A（a）、補足: x",
    s1: "エージェントの仮定を人が認めた: 集計は日次で足りる",
    s2: "人が書き直した: 週次（エージェントの仮定: 集計は日次で足りる）",
  });
});
