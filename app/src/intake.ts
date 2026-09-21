import type { GhStatus } from "../../shared/intake/github.ts";
import type { Answer, Question } from "../../shared/intake/question.ts";
import type { IntakeState } from "../../shared/intake/state.ts";
import { answerChoiceIssue } from "../../shared/intake/validateQuestion.ts";
import type { IntakeSummary } from "../../shared/protocol.ts";
import type { Project } from "./types";

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

export type IntakeSection = "attention" | "working" | "active" | "closed";

export const INTAKE_SECTIONS: { key: IntakeSection; name: string }[] = [
  { key: "attention", name: "対応が要る" },
  { key: "working", name: "調査・分解中" },
  { key: "active", name: "進行中" },
  { key: "closed", name: "終了" },
];

export const INTAKE_STATE: Record<IntakeState, { word: string; cls: string }> = {
  investigating: { word: "調査中", cls: "p-run" },
  decomposing: { word: "分解中", cls: "p-run" },
  answering: { word: "回答待ち", cls: "p-attn" },
  reviewing: { word: "レビュー待ち", cls: "p-attn" },
  needs_attention: { word: "要確認", cls: "p-danger" },
  active: { word: "進行中", cls: "p-muted" },
  completed: { word: "完了", cls: "p-ok" },
  canceled: { word: "中止", cls: "p-muted" },
};

export function isClosedIntake(state: IntakeState): boolean {
  return state === "completed" || state === "canceled";
}

/** 人の対応が要る件数。needs_human はデーモンが決めるので、状態から数え直さない */
export function countIntakeAttention(intakes: IntakeSummary[]): number {
  return intakes.filter((i) => i.needs_human).length;
}

// 上から順に判定する。どの行もどこかの区分に入る
export function intakeSection(i: IntakeSummary): IntakeSection {
  if (isClosedIntake(i.state)) return "closed";
  if (i.needs_human) return "attention";
  if (i.state === "active") return "active";
  return "working";
}

/** project は表示名（Project.id）か "all" */
export function visibleIntakes(
  intakes: IntakeSummary[],
  projects: Project[],
  project: string,
): IntakeSummary[] {
  if (project === "all") return intakes;
  const daemonId = projects.find((p) => p.id === project)?.daemonId;
  return intakes.filter((i) => i.project_id === daemonId);
}

/** サイドバーの描画も j/k もこの順を使う */
export function intakeOrder(
  intakes: IntakeSummary[],
  projects: Project[],
  project: string,
  showClosed: boolean,
): IntakeSummary[] {
  const rows = visibleIntakes(intakes, projects, project);
  return INTAKE_SECTIONS.filter((s) => showClosed || s.key !== "closed").flatMap((s) => {
    const inSection = rows.filter((i) => intakeSection(i) === s.key);
    const sign = s.key === "attention" ? 1 : -1;
    return inSection.sort((a, b) => sign * (Date.parse(a.updated_at) - Date.parse(b.updated_at)));
  });
}

/** 表示のためだけに取る。参照には使わない */
export function issueNumber(url: string): string | null {
  return /\/issues\/(\d+)\/?$/.exec(url)?.[1] ?? null;
}

export function intakeProgress(i: IntakeSummary): string | null {
  return i.progress.total > 0 ? `${i.progress.done}/${i.progress.total}` : null;
}

export type IntakeFace = "running" | "questions" | "review" | "attention" | "progress";

export function intakeFace(state: IntakeState): IntakeFace {
  switch (state) {
    case "investigating":
    case "decomposing":
      return "running";
    case "answering":
      return "questions";
    case "reviewing":
      return "review";
    case "needs_attention":
      return "attention";
    case "active":
    case "completed":
    case "canceled":
      return "progress";
  }
}

/** `#123`・`123`・Issue の URL を、そのリポジトリの Issue の URL にする。読めなければ null */
export function parseIssueInput(input: string, repo: { nameWithOwner: string }): string | null {
  const text = input.trim();
  const short = /^#?(\d+)$/.exec(text);
  if (short) return `https://github.com/${repo.nameWithOwner}/issues/${short[1]}`;
  const url = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)(?:[/#?].*)?$/.exec(text);
  if (url && url[1].toLowerCase() === repo.nameWithOwner.toLowerCase()) {
    return `https://github.com/${repo.nameWithOwner}/issues/${url[2]}`;
  }
  return null;
}

export function ghGuidance(
  status: Extract<GhStatus, { ok: false }>,
): { title: string; fix: string; command: string | null } {
  switch (status.reason) {
    case "not_installed":
      return {
        title: "gh が見つかりません",
        fix: "gh を入れる（https://cli.github.com）。デーモンの PATH から見えることも確かめる",
        command: null,
      };
    case "not_logged_in":
      return {
        title: "gh にログインしていません",
        fix: "端末で次を実行する",
        command: "gh auth login",
      };
    case "no_github_remote":
      return {
        title: "このリポジトリに GitHub の remote がありません",
        fix: "GitHub の remote を持つリポジトリで使う",
        command: null,
      };
  }
}

export type IssueTarget = { kind: "open"; intakeId: string } | { kind: "start"; url: string };

/** 進行中の Intake がある Issue は、開始の代わりにそれを開く。直接入力の Issue は intake_id を持たないので、一覧とも照合する */
export function issueTarget(
  issue: { url: string; intake_id?: string | null },
  intakes: IntakeSummary[],
): IssueTarget {
  if (issue.intake_id) return { kind: "open", intakeId: issue.intake_id };
  const open = intakes.find((i) => i.issue_url === issue.url && !isClosedIntake(i.state));
  return open ? { kind: "open", intakeId: open.id } : { kind: "start", url: issue.url };
}
