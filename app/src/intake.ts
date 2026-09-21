import type { Answer, Question } from "../../shared/intake/question.ts";
import { answerChoiceIssue } from "../../shared/intake/validateQuestion.ts";

export type AnswerIssue = { questionId: string; message: string };

const CHOICE_MESSAGE: Record<Question["kind"], string> = {
  single: "選択肢を 1 つ選ぶか、その他に書きます",
  multiple: "選択肢を 1 つ以上選ぶか、その他に書きます",
  free: "答えを書きます",
};

function emptyAnswer(questionId: string): Answer {
  return { questionId, optionIds: [], other: null, note: null };
}

// 空白だけの入力は「書いていない」。値があるときは入力のまま返す
function blankToNull(text: string | null): string | null {
  return text === null || text.trim() === "" ? null : text;
}

/** 質問の順に 1 問 1 件の回答へそろえる。質問に無い回答は落とし、空白だけの入力は null にする */
export function normalizeAnswers(questions: Question[], answers: Answer[]): Answer[] {
  return questions.map((question) => {
    const answer = answers.find((a) => a.questionId === question.id) ??
      emptyAnswer(question.id);
    return { ...answer, other: blankToNull(answer.other), note: blankToNull(answer.note) };
  });
}

/** 送れない質問ごとに 1 件。空なら送れる */
export function answerIssues(questions: Question[], answers: Answer[]): AnswerIssue[] {
  const issues: AnswerIssue[] = [];
  normalizeAnswers(questions, answers).forEach((answer, i) => {
    const question = questions[i];
    if (answer.optionIds.some((id) => !question.options.some((o) => o.id === id))) {
      issues.push({ questionId: question.id, message: "選択肢が見つかりません" });
    } else if (answerChoiceIssue(question, answer) !== null) {
      issues.push({ questionId: question.id, message: CHOICE_MESSAGE[question.kind] });
    }
  });
  return issues;
}

/** questionId の回答に patch を重ねた新しい配列。other と note は生の文字列のまま持つ */
export function updateAnswer(
  answers: Answer[],
  questionId: string,
  patch: Partial<Omit<Answer, "questionId">>,
): Answer[] {
  if (!answers.some((a) => a.questionId === questionId)) {
    answers = [...answers, emptyAnswer(questionId)];
  }
  return answers.map((a) => (a.questionId === questionId ? { ...a, ...patch } : a));
}

/** 選択肢を押したあとの optionIds。single は押した 1 つ、multiple は足し引きして選択肢の順にそろえる */
export function toggleOption(question: Question, optionIds: string[], optionId: string): string[] {
  if (question.kind === "single") return [optionId];
  const next = optionIds.includes(optionId)
    ? optionIds.filter((id) => id !== optionId)
    : [...optionIds, optionId];
  return question.options.map((o) => o.id).filter((id) => next.includes(id));
}
