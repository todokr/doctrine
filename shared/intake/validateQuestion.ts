import { z } from "zod/v4";
import {
  type Answer,
  answerSetSchema,
  type Assumption,
  type AssumptionResponse,
  assumptionResponseSetSchema,
  assumptionSetSchema,
  type Question,
  questionSetSchema,
} from "./question.ts";

/** 一度に届く質問と仮定のまとまり。 */
export type QuestionSetContent = { questions: Question[]; assumptions: Assumption[] };

/** 質問のまとまりへの人の応答。 */
export type QuestionSetReply = { answers: Answer[]; assumptionResponses: AssumptionResponse[] };

export type QuestionsValidation =
  | ({ ok: true } & QuestionSetContent)
  | { ok: false; issues: string[] };

export type AnswersValidation =
  | ({ ok: true } & QuestionSetReply)
  | { ok: false; issues: string[] };

// 誤りの理由は zod 同梱の日本語ロケールに任せる。z.config() はアプリ側のメッセージまで変えるので使わない
const parseOptions = { error: z.locales.ja().localeError };

// パスは分解エージェントの出力（{ kind: "questions", questions, assumptions }）の中の位置と合わせる
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

// id の重複と kind ごとの約束を確かめる。形は通っている前提。
// 質問と仮定の id は成果物の decision が区別せずに指すので、互いにも重ねない
function checkQuestions({ questions, assumptions }: QuestionSetContent): string[] {
  const issues: string[] = [];

  const ids = [
    ...questions.map((q, i) => ({ id: q.id, at: `questions.${i}.id` })),
    ...assumptions.map((a, i) => ({ id: a.id, at: `assumptions.${i}.id` })),
  ];
  for (const i of duplicateIndexes(ids.map((x) => x.id))) {
    issues.push(`${ids[i].at}: id が重複しています: ${ids[i].id}`);
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

/** 質問と仮定のまとまりを、形と整合性の両面から確かめる。例外は投げない。 */
export function validateQuestions(
  input: { questions: unknown; assumptions: unknown },
): QuestionsValidation {
  const questions = questionSetSchema.safeParse(input.questions, parseOptions);
  const assumptions = assumptionSetSchema.safeParse(input.assumptions, parseOptions);
  const shapeIssues = [
    ...(questions.success ? [] : formatShapeIssues("questions", questions.error.issues)),
    ...(assumptions.success ? [] : formatShapeIssues("assumptions", assumptions.error.issues)),
  ];
  if (!questions.success || !assumptions.success) return { ok: false, issues: shapeIssues };
  const content = { questions: questions.data, assumptions: assumptions.data };
  const issues = checkQuestions(content);
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, ...content };
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

/** 仮定への応答 1 件が約束（書き直すなら内容がある）を満たすか。満たせば null */
export function assumptionResponseIssue(response: AssumptionResponse): string | null {
  if (response.verdict === "corrected" && response.correction.trim() === "") {
    return "書き直した内容がありません";
  }
  return null;
}

// 仮定との照合。仮定は検証済みとして信頼する
function checkAssumptionResponses(
  assumptions: Assumption[],
  responses: AssumptionResponse[],
): string[] {
  const issues: string[] = [];
  const ids = new Set(assumptions.map((a) => a.id));
  const responded = new Set<string>();

  responses.forEach((response, i) => {
    const path = `assumptionResponses.${i}`;
    if (!ids.has(response.assumptionId)) {
      issues.push(`${path}.assumptionId: 存在しない仮定の id です: ${response.assumptionId}`);
      return;
    }
    if (responded.has(response.assumptionId)) {
      issues.push(
        `${path}.assumptionId: 同じ仮定への応答が重複しています: ${response.assumptionId}`,
      );
    }
    responded.add(response.assumptionId);
    const issue = assumptionResponseIssue(response);
    if (issue !== null) issues.push(`${path}: ${issue}`);
  });

  for (const assumption of assumptions) {
    if (!responded.has(assumption.id)) {
      issues.push(`assumptionResponses: 応答がありません: ${assumption.id}`);
    }
  }

  return issues;
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
 * 人の回答と仮定への応答を、すでに検証を通った質問のまとまりに照らして確かめる。例外は投げない。
 */
export function validateAnswers(
  set: QuestionSetContent,
  input: { answers: unknown; assumptionResponses: unknown },
): AnswersValidation {
  const answers = answerSetSchema.safeParse(input.answers, parseOptions);
  const responses = assumptionResponseSetSchema.safeParse(input.assumptionResponses, parseOptions);
  const shapeIssues = [
    ...(answers.success ? [] : formatShapeIssues("answers", answers.error.issues)),
    ...(responses.success ? [] : formatShapeIssues("assumptionResponses", responses.error.issues)),
  ];
  if (!answers.success || !responses.success) return { ok: false, issues: shapeIssues };
  const issues = [
    ...checkAnswers(set.questions, answers.data),
    ...checkAssumptionResponses(set.assumptions, responses.data),
  ];
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, answers: answers.data, assumptionResponses: responses.data };
}
