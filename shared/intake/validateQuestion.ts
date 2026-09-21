import { z } from "zod/v4";
import { type Answer, answerSetSchema, type Question, questionSetSchema } from "./question.ts";

export type QuestionsValidation =
  | { ok: true; questions: Question[] }
  | { ok: false; issues: string[] };

export type AnswersValidation =
  | { ok: true; answers: Answer[] }
  | { ok: false; issues: string[] };

// 誤りの理由は zod 同梱の日本語ロケールに任せる。z.config() はアプリ側のメッセージまで変えるので使わない
const parseOptions = { error: z.locales.ja().localeError };

// パスは分解エージェントの出力（{ kind: "questions", questions }）の中の位置と合わせる
function formatShapeIssues(root: string, issues: z.core.$ZodIssue[]): string[] {
  return issues.map((issue) => [root, ...issue.path].join(".") + `: ${issue.message}`);
}

// 重複した id の位置を返す。同じ id の 2 つ目以降が重複になる
function duplicateIndexes(ids: string[]): number[] {
  const seen = new Set<string>();
  const duplicates: number[] = [];
  ids.forEach((id, i) => {
    if (seen.has(id)) duplicates.push(i);
    seen.add(id);
  });
  return duplicates;
}

function checkRecommendation(question: Question, path: string, issues: string[]): void {
  const { recommendation, options } = question;
  if (recommendation === null) return;
  const optionIds = new Set(options.map((option) => option.id));
  const ids = recommendation.optionIds;
  const at = `${path}.recommendation`;

  ids.forEach((id, i) => {
    if (!optionIds.has(id)) issues.push(`${at}.optionIds.${i}: 存在しない選択肢の id です: ${id}`);
  });
  for (const i of duplicateIndexes(ids)) {
    issues.push(`${at}.optionIds.${i}: id が重複しています: ${ids[i]}`);
  }

  if (question.kind === "single" && ids.length !== 1) {
    issues.push(`${at}.optionIds: single の推奨は選択肢 1 つです`);
  } else if (question.kind === "multiple" && ids.length === 0) {
    issues.push(`${at}.optionIds: multiple の推奨に選択肢がありません`);
  } else if (question.kind === "free" && (ids.length > 0 || recommendation.text === null)) {
    issues.push(`${at}.text: free の推奨は text で書きます`);
  }
}

// id の重複と参照先の実在、kind ごとの約束を確かめる。形は通っている前提
function checkQuestions(questions: Question[]): string[] {
  const issues: string[] = [];

  for (const i of duplicateIndexes(questions.map((q) => q.id))) {
    issues.push(`questions.${i}.id: id が重複しています: ${questions[i].id}`);
  }

  questions.forEach((question, i) => {
    const path = `questions.${i}`;

    for (const j of duplicateIndexes(question.options.map((o) => o.id))) {
      issues.push(`${path}.options.${j}.id: id が重複しています: ${question.options[j].id}`);
    }

    if (question.kind === "free" && question.options.length > 0) {
      issues.push(`${path}.options: free の質問は選択肢を持てません`);
    } else if (question.kind !== "free" && question.options.length === 0) {
      issues.push(`${path}.options: ${question.kind} の質問に選択肢がありません`);
    }

    checkRecommendation(question, path, issues);

    question.materials.forEach((material, j) => {
      if (material.kind !== "table") return;
      material.rows.forEach((row, k) => {
        if (row.length !== material.columns.length) {
          issues.push(
            `${path}.materials.${j}.rows.${k}: 列数が columns と違います: ${row.length} / ${material.columns.length}`,
          );
        }
      });
    });
  });

  return issues;
}

/** 質問のまとまりを、形と整合性の両面から確かめる。例外は投げない。 */
export function validateQuestions(input: unknown): QuestionsValidation {
  const parsed = questionSetSchema.safeParse(input, parseOptions);
  if (!parsed.success) {
    return { ok: false, issues: formatShapeIssues("questions", parsed.error.issues) };
  }
  const issues = checkQuestions(parsed.data);
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, questions: parsed.data };
}

/** 質問 1 件への答えが、種類ごとの約束（single は 1 つか other など）を満たすか。満たせば null */
export function answerChoiceIssue(question: Question, answer: Answer): string | null {
  const chosen = answer.optionIds.length;
  const hasOther = answer.other !== null;

  if (question.kind === "single") {
    if (!((chosen === 1 && !hasOther) || (chosen === 0 && hasOther))) {
      return "single の回答は選択肢 1 つか other のどちらか 1 つです";
    }
  } else if (question.kind === "multiple") {
    if (chosen === 0 && !hasOther) {
      return "multiple の回答に選択も other もありません";
    }
  } else if (chosen > 0 || !hasOther) {
    return "free の回答は other に書きます";
  }
  return null;
}

// 質問との照合。質問は検証済みとして信頼する
function checkAnswers(questions: Question[], answers: Answer[]): string[] {
  const issues: string[] = [];
  const byId = new Map(questions.map((question) => [question.id, question]));
  const answered = new Set<string>();

  answers.forEach((answer, i) => {
    const path = `answers.${i}`;
    const question = byId.get(answer.questionId);
    if (question === undefined) {
      issues.push(`${path}.questionId: 存在しない質問の id です: ${answer.questionId}`);
      return;
    }
    if (answered.has(answer.questionId)) {
      issues.push(`${path}.questionId: 同じ質問への回答が重複しています: ${answer.questionId}`);
    }
    answered.add(answer.questionId);

    const optionIds = new Set(question.options.map((option) => option.id));
    answer.optionIds.forEach((id, j) => {
      if (!optionIds.has(id)) {
        issues.push(`${path}.optionIds.${j}: 存在しない選択肢の id です: ${id}`);
      }
    });
    for (const j of duplicateIndexes(answer.optionIds)) {
      issues.push(`${path}.optionIds.${j}: id が重複しています: ${answer.optionIds[j]}`);
    }

    const choiceIssue = answerChoiceIssue(question, answer);
    if (choiceIssue !== null) issues.push(`${path}: ${choiceIssue}`);
  });

  for (const question of questions) {
    if (!answered.has(question.id)) issues.push(`answers: 回答がありません: ${question.id}`);
  }

  return issues;
}

/**
 * 人の回答を、すでに検証を通った質問のまとまりに照らして確かめる。例外は投げない。
 */
export function validateAnswers(questions: Question[], input: unknown): AnswersValidation {
  const parsed = answerSetSchema.safeParse(input, parseOptions);
  if (!parsed.success) {
    return { ok: false, issues: formatShapeIssues("answers", parsed.error.issues) };
  }
  const issues = checkAnswers(questions, parsed.data);
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, answers: parsed.data };
}
