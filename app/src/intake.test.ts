import { describe, expect, test } from "vitest";
import { validateAnswers, validateQuestions } from "../../shared/intake/validateQuestion.ts";
import { ANSWERS, QUESTIONS } from "./fixtures";
import { answerIssues, normalizeAnswers, toggleOption, updateAnswer } from "./intake";

const [Q1, Q2] = QUESTIONS;

function withAnswer(questionId: string, patch: object) {
  return ANSWERS.map((a) => (a.questionId === questionId ? { ...a, ...patch } : a));
}

describe("normalizeAnswers", () => {
  test("空白だけのその他と補足は null にする", () => {
    const out = normalizeAnswers(QUESTIONS, withAnswer("q1", { other: "  ", note: "" }));
    expect(out[0]).toMatchObject({ questionId: "q1", other: null, note: null });
  });

  test("回答の無い質問は空の回答で埋め、質問の順に並べる", () => {
    const out = normalizeAnswers(QUESTIONS, [ANSWERS[2]]);
    expect(out).toHaveLength(3);
    expect(out.map((a) => a.questionId)).toEqual(["q1", "q2", "q3"]);
    expect(out[0]).toEqual({ questionId: "q1", optionIds: [], other: null, note: null });
  });

  test("質問に無い回答は落とす", () => {
    const out = normalizeAnswers(QUESTIONS, [
      ...ANSWERS,
      { questionId: "zz", optionIds: [], other: "x", note: null },
    ]);
    expect(out.map((a) => a.questionId)).toEqual(["q1", "q2", "q3"]);
  });

  test("値のある other と note は前後の空白ごと残す", () => {
    const out = normalizeAnswers(QUESTIONS, withAnswer("q3", { other: " ログ ", note: " 急ぐ " }));
    expect(out[2]).toMatchObject({ other: " ログ ", note: " 急ぐ " });
  });
});

describe("answerIssues", () => {
  test("そろった回答なら指摘なし", () => {
    expect(answerIssues(QUESTIONS, ANSWERS)).toEqual([]);
  });

  test("必須の質問に答えていなければ、その質問の指摘", () => {
    const answers = ANSWERS.filter((a) => a.questionId !== "q2");
    expect(answerIssues(QUESTIONS, answers)).toEqual([
      { questionId: "q2", message: "選択肢を 1 つ以上選ぶか、その他に書きます" },
    ]);
  });

  test("回答が空なら全ての質問が指摘される", () => {
    expect(answerIssues(QUESTIONS, []).map((i) => i.questionId)).toEqual(["q1", "q2", "q3"]);
  });

  test("single で選択肢とその他の両方は指摘", () => {
    const issues = answerIssues(QUESTIONS, withAnswer("q1", { optionIds: ["a"], other: "別案" }));
    expect(issues).toEqual([
      { questionId: "q1", message: "選択肢を 1 つ選ぶか、その他に書きます" },
    ]);
  });

  test("single でその他だけなら指摘なし", () => {
    expect(answerIssues(QUESTIONS, withAnswer("q1", { optionIds: [], other: "別案" }))).toEqual([]);
  });

  test("free のその他が空白だけなら未回答", () => {
    expect(answerIssues(QUESTIONS, withAnswer("q3", { other: "   " }))).toEqual([
      { questionId: "q3", message: "答えを書きます" },
    ]);
  });

  test("無い選択肢の id は指摘", () => {
    expect(answerIssues(QUESTIONS, withAnswer("q1", { optionIds: ["zz"] }))).toEqual([
      { questionId: "q1", message: "選択肢が見つかりません" },
    ]);
  });
});

describe("updateAnswer", () => {
  test("その他と補足が回答に入る", () => {
    const a = updateAnswer([], "q1", { other: "別案" });
    const b = updateAnswer(a, "q1", { note: "補足" });
    expect(b).toEqual([{ questionId: "q1", optionIds: [], other: "別案", note: "補足" }]);
  });

  test("入力の配列を書き換えない", () => {
    const input = ANSWERS.map((a) => ({ ...a, optionIds: [...a.optionIds] }));
    updateAnswer(input, "q1", { optionIds: ["b"], other: "x" });
    updateAnswer(input, "zz", { note: "y" });
    expect(input).toEqual(ANSWERS);
  });

  test("打鍵中の空白は消さない", () => {
    expect(updateAnswer([], "q1", { other: "a " })[0].other).toBe("a ");
  });
});

describe("toggleOption", () => {
  test("single は選んだ 1 つだけになる", () => {
    expect(toggleOption(Q1, ["a"], "b")).toEqual(["b"]);
  });

  test("multiple は足し引きし、選択肢の順にそろえる", () => {
    expect(toggleOption(Q2, ["c"], "a")).toEqual(["a", "c"]);
    expect(toggleOption(Q2, ["a", "c"], "a")).toEqual(["c"]);
  });
});

test("標本が質問と回答の検証を通る", () => {
  expect(validateQuestions(QUESTIONS).ok).toBe(true);
  expect(validateAnswers(QUESTIONS, ANSWERS).ok).toBe(true);
});
