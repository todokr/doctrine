import type { CommentReply } from "../../shared/intake/decomposer.ts";
import { buildFeedback } from "../../shared/intake/feedback.ts";
import type { TrackerStatus } from "../../shared/intake/tracker.ts";
import type { Pfd, Process } from "../../shared/intake/pfd.ts";
import type { PrFact, ProcessStatus } from "../../shared/intake/processStatus.ts";
import type { Answer, AssumptionResponse, Question } from "../../shared/intake/question.ts";
import type { IntakeRunPurpose, IntakeState } from "../../shared/intake/state.ts";
import {
  answerChoiceIssue,
  assumptionResponseIssue,
  type QuestionSetContent,
  type QuestionSetReply,
} from "../../shared/intake/validateQuestion.ts";
import type {
  IntakeComment,
  IntakeDetail,
  IntakeProcessView,
  IntakeQuestionSet,
  IntakeSummary,
  NewComment,
  WatchHealth,
} from "../../shared/protocol.ts";
import { LOOK, parsePfdKey, pfdKey } from "./pfd";
import type { Project, Task } from "./types";

/** targetId は質問か仮定の id */
export type AnswerIssue = { targetId: string; message: string };

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

/** 仮定の順にそろえる。仮定に無い応答と、まだ選んでいない仮定の分は落とす */
export function normalizeResponses(
  set: QuestionSetContent,
  responses: AssumptionResponse[],
): AssumptionResponse[] {
  return set.assumptions.flatMap((a) => responses.filter((r) => r.assumptionId === a.id).slice(0, 1));
}

/** 送る形にそろえた回答と応答 */
export function normalizeReply(set: QuestionSetContent, reply: QuestionSetReply): QuestionSetReply {
  return {
    answers: normalizeAnswers(set.questions, reply.answers),
    assumptionResponses: normalizeResponses(set, reply.assumptionResponses),
  };
}

/** 送れない質問・仮定ごとに 1 件。空なら送れる */
export function answerIssues(set: QuestionSetContent, reply: QuestionSetReply): AnswerIssue[] {
  const issues: AnswerIssue[] = [];
  normalizeAnswers(set.questions, reply.answers).forEach((answer, i) => {
    const question = set.questions[i];
    if (answer.optionIds.some((id) => !question.options.some((o) => o.id === id))) {
      issues.push({ targetId: question.id, message: "選択肢が見つかりません" });
    } else if (answerChoiceIssue(question, answer) !== null) {
      issues.push({ targetId: question.id, message: CHOICE_MESSAGE[question.kind] });
    }
  });
  for (const assumption of set.assumptions) {
    const response = reply.assumptionResponses.find((r) => r.assumptionId === assumption.id);
    if (response === undefined) {
      issues.push({ targetId: assumption.id, message: "認めるか書き直すかを選びます" });
    } else if (assumptionResponseIssue(response) !== null) {
      issues.push({ targetId: assumption.id, message: "正しい内容を書きます" });
    }
  }
  return issues;
}

/** assumptionId の応答を next で置き換えた新しい配列 */
export function updateResponse(
  responses: AssumptionResponse[],
  next: AssumptionResponse,
): AssumptionResponse[] {
  return [...responses.filter((r) => r.assumptionId !== next.assumptionId), next];
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

/** intake_runs.purpose の語 */
export const RUN_PURPOSE_WORD: Record<IntakeRunPurpose, string> = {
  investigate: "調査",
  decompose: "分解",
  revise: "改訂",
};

export const INTAKE_WORD: Record<IntakeState, string> = {
  investigating: "調査中",
  decomposing: "分解中",
  answering: "回答待ち",
  reviewing: "レビュー待ち",
  needs_attention: "要確認",
  active: "進行中",
  completed: "完了",
  canceled: "中止",
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

/** GitHub の Issue の URL のときだけ "#<番号>" を返す。ほかのトラッカーの URL は null */
export function issueIdentifier(url: string): string | null {
  const m = /^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/(\d+)(?:[/#?].*)?$/.exec(url);
  return m ? `#${m[1]}` : null;
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

/** UI spec 11 章。comments には whole も入る */
export type IntakeDraft = {
  comments: NewComment[];
  /** 回答中の答えと仮定への応答。questionSetId が今の未回答のまとまりと違えば使わない */
  answers: { questionSetId: number; answers: Answer[]; assumptionResponses: AssumptionResponse[] } | null;
  /** 人のプロセスの「決めた内容」。キーは process_id */
  notes: Record<string, string>;
};

export const EMPTY_INTAKE_DRAFT: IntakeDraft = { comments: [], answers: null, notes: {} };

/** 回答待ちの面が出す、未回答のまとまり。無ければ null */
export function openQuestionSet(detail: IntakeDetail): IntakeQuestionSet | null {
  const open = detail.question_sets.filter((q) => q.reply === null);
  return open[open.length - 1] ?? null;
}

/** 下書きの答えと応答。まとまりが違えば空 */
export function draftReply(draft: IntakeDraft, questionSetId: number): QuestionSetReply {
  if (draft.answers?.questionSetId !== questionSetId) return { answers: [], assumptionResponses: [] };
  return { answers: draft.answers.answers, assumptionResponses: draft.answers.assumptionResponses };
}

/** 図で選んだ要素のキー（a:<id> / p:<id>）を、コメントの対象にする */
export function commentTarget(key: string): Pick<NewComment, "target_kind" | "target_id"> | null {
  const parsed = parsePfdKey(key);
  return parsed ? { target_kind: parsed.kind, target_id: parsed.id } : null;
}

/** 要素ごとのコメント数。キーは PfdNode.key。whole は数えない */
export function commentCounts(comments: NewComment[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const c of comments) {
    if (c.target_kind === "whole" || c.target_id === null) continue;
    const key = pfdKey(c.target_kind, c.target_id);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/** その要素へのコメントと、comments の中の位置（消すときに使う） */
export function commentsOn(comments: NewComment[], key: string): { index: number; comment: NewComment }[] {
  const target = commentTarget(key);
  if (!target) return [];
  return comments.flatMap((comment, index) =>
    comment.target_kind === target.target_kind && comment.target_id === target.target_id ? [{ index, comment }] : [],
  );
}

const isWhole = (c: NewComment) => c.target_kind === "whole";

/** whole のコメントの本文。無ければ空文字 */
export function wholeComment(comments: NewComment[]): string {
  return comments.find(isWhole)?.body ?? "";
}

/** whole の本文を書き換える。空白だけなら消し、無ければ末尾に足す。本文は入力のまま持つ（打てなくなるので trim しない） */
export function setWholeComment(comments: NewComment[], body: string): NewComment[] {
  if (body.trim() === "") return comments.filter((c) => !isWhole(c));
  if (!comments.some(isWhole)) return [...comments, { target_kind: "whole", target_id: null, body }];
  return comments.map((c) => (isWhole(c) ? { ...c, body } : c));
}

/** 差し戻せるか。コメントが 1 つ以上あるとき（whole を含む） */
export function canRejectIntake(draft: IntakeDraft): boolean {
  return draft.comments.length > 0;
}

/** 差し戻しで送る文面。画面で見せる文面とデーモンに届く文面を、同じ関数で作る */
export function rejectionText(pfd: Pfd, draft: IntakeDraft): string {
  return buildFeedback(pfd, draft.comments);
}

/** 「計画全体」「成果物 <id>「名前」」「プロセス <id>「名前」」。pfd に無ければ id だけ */
export function commentTargetLabel(c: NewComment, pfd: Pfd | null): string {
  if (c.target_kind === "whole") return "計画全体";
  const kind = c.target_kind === "artifact" ? "成果物" : "プロセス";
  const id = c.target_id ?? "";
  const list: { id: string; name: string }[] = (c.target_kind === "artifact" ? pfd?.artifacts : pfd?.processes) ?? [];
  const found = list.find((e) => e.id === id);
  return found ? `${kind} ${id}「${found.name}」` : `${kind} ${id}`;
}

/** 前の案へのコメントと、この案の返答の組。返答はコメントの DB の id で引く */
export function commentReplies(
  comments: IntakeComment[],
  replies: CommentReply[],
): { comment: IntakeComment; reply: string | null }[] {
  return comments.map((comment) => ({
    comment,
    reply: replies.find((r) => r.commentId === comment.id)?.reply ?? null,
  }));
}

export type IntakeHistoryEntry =
  | { kind: "questions"; at: string; set: IntakeQuestionSet }
  | {
      kind: "draft";
      at: string;
      draftId: number;
      seq: number;
      /** 1 つ前の案へのコメント。返答はこの案の replies にある */
      previousComments: IntakeComment[];
      /** この案へのコメントで、まだ次の案が届いていないもの */
      pendingComments: IntakeComment[];
    }
  | { kind: "approval"; at: string; draftId: number; seq: number };

/** 回答済みの質問のまとまり・各回の案・承認を、起きた順（created_at / approved_at の昇順）に並べる。未回答のまとまりは回答待ちの面そのものなので入れない */
export function intakeHistory(detail: IntakeDetail): IntakeHistoryEntry[] {
  const seqOf = (draftId: number) => detail.drafts.find((d) => d.id === draftId)?.seq ?? 0;
  const drafts = [...detail.drafts].sort((a, b) => a.seq - b.seq);
  const last = drafts[drafts.length - 1];

  const entries: IntakeHistoryEntry[] = [
    ...detail.question_sets
      .filter((set) => set.reply !== null)
      .map((set): IntakeHistoryEntry => ({ kind: "questions", at: set.created_at, set })),
    ...drafts.map((d, i): IntakeHistoryEntry => ({
      kind: "draft",
      at: d.created_at,
      draftId: d.id,
      seq: d.seq,
      previousComments: i === 0 ? [] : detail.comments.filter((c) => c.draft_id === drafts[i - 1].id),
      pendingComments: d === last ? detail.comments.filter((c) => c.draft_id === d.id) : [],
    })),
  ];
  if (detail.approval) {
    entries.push({
      kind: "approval",
      at: detail.approval.approved_at,
      draftId: detail.approval.draft_id,
      seq: seqOf(detail.approval.draft_id),
    });
  }
  return entries.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** `#123`・`123`・Issue の URL を、そのリポジトリの Issue の URL にする。読めなければ null */
export function parseIssueInput(input: string, target: { name: string }): string | null {
  const text = input.trim();
  const short = /^#?(\d+)$/.exec(text);
  if (short) return `https://github.com/${target.name}/issues/${short[1]}`;
  const url = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)(?:[/#?].*)?$/.exec(text);
  if (url && url[1].toLowerCase() === target.name.toLowerCase()) {
    return `https://github.com/${target.name}/issues/${url[2]}`;
  }
  return null;
}

export function trackerGuidance(
  status: Extract<TrackerStatus, { ok: false }>,
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
    case "no_api_key":
      return {
        title: "Linear の API key がありません",
        fix:
          "状態ディレクトリ（既定は ~/.local/state/doctrine。DOCTRINE_STATE_DIR で変わる）の config.json に、Linear の Personal API key を linearApiKey として書き、dctld を起動し直す",
        command: '{ "linearApiKey": "lin_api_..." }',
      };
    case "invalid_api_key":
      return {
        title: "Linear の API key が使えません",
        fix:
          "Linear で Personal API key を作り直し、状態ディレクトリの config.json の linearApiKey を書き換えて dctld を起動し直す",
        command: null,
      };
    case "team_not_found":
      return {
        title: "Linear のチームが見つかりません",
        fix:
          ".doctrine/project.yaml の tracker.team が Linear のチームのキー（ENG など）と合っているか確かめる",
        command: null,
      };
    default:
      return {
        title: "Issue トラッカーを使えません",
        fix: "下の出力を見て直す",
        command: null,
      };
  }
}

export type IssueTarget = { kind: "open"; intakeId: string } | { kind: "start"; url: string };

/** 進行中の Intake がある Issue は、開始の代わりにそれを開く。キャッシュした一覧の intake_id は古いことがあるので、s.intakes だけで決める */
export function issueTarget(url: string, intakes: IntakeSummary[]): IssueTarget {
  const open = intakes.find((i) => i.issue_url === url && !isClosedIntake(i.state));
  return open ? { kind: "open", intakeId: open.id } : { kind: "start", url };
}

/** buildPfdView の statuses に渡す形。キーはプロセスの id */
export function processStatuses(processes: readonly IntakeProcessView[]): Record<string, ProcessStatus> {
  return Object.fromEntries(processes.map((p) => [p.id, p]));
}

export const BLOCKED_BY = {
  revising: "改訂中",
  paused: "一時停止中",
  no_sub_issue: "sub-issue 待ち",
} as const;

export const ATTENTION_REASON = {
  task_stopped: "タスクが止まった",
  no_pr: "PR が無い",
  pr_closed: "PR が閉じられた",
} as const;

/** LOOK の語に添える語（spec 6.6）。ready の blockedBy と needs_attention の reason だけ。ほかは null */
export function statusNote(status: ProcessStatus): string | null {
  if (status.state === "ready") return status.blockedBy === null ? null : BLOCKED_BY[status.blockedBy];
  if (status.state === "needs_attention") return ATTENTION_REASON[status.reason];
  return null;
}

/** 状態の語と添える語をまとめた 1 行（「着手可能（一時停止中）」） */
export function statusText(status: ProcessStatus): string {
  const note = statusNote(status);
  return note === null ? LOOK[status.state].word : `${LOOK[status.state].word}（${note}）`;
}

/** 「操作が必要」に並べるプロセス。pfd.processes の順 */
export function actionNeeded(detail: IntakeDetail, pfd: Pfd): {
  yourTurn: { process: Process; view: IntakeProcessView }[];
  needsAttention: { process: Process; view: IntakeProcessView & { state: "needs_attention" } }[];
} {
  const yourTurn: { process: Process; view: IntakeProcessView }[] = [];
  const needsAttention: { process: Process; view: IntakeProcessView & { state: "needs_attention" } }[] = [];
  for (const process of pfd.processes) {
    const view = detail.processes.find((p) => p.id === process.id);
    if (!view) continue;
    if (view.state === "your_turn") yourTurn.push({ process, view });
    else if (view.state === "needs_attention") needsAttention.push({ process, view });
  }
  return { yourTurn, needsAttention };
}

/** プロセスの欄の sub-issue・タスク・PR */
export function processTrail(view: IntakeProcessView): {
  subIssueUrl: string | null;
  /** 今のタスクが先頭、古いものが続く */
  taskIds: string[];
  pr: PrFact | null;
} {
  return {
    subIssueUrl: view.sub_issue_url,
    taskIds: [...view.task_ids].reverse(),
    pr: view.state === "pr_open" || view.state === "merged" ? view.pr : null,
  };
}

export const PR_STATE: Record<PrFact["state"], string> = {
  OPEN: "レビュー中",
  MERGED: "マージ済み",
  CLOSED: "閉じられた",
};

/** 完了を記録できるか。空白だけは不可（コアと同じ規則） */
export function canCompleteHuman(note: string): boolean {
  return note.trim() !== "";
}

/** 進行中の面で出す操作。中止は見出しが持つのでここに入れない */
export type ProgressOps = { refresh: boolean; pause: boolean; revise: boolean; closeIssue: boolean };

export function progressOps(detail: Pick<IntakeSummary, "state" | "revising">): ProgressOps {
  const none = { refresh: false, pause: false, revise: false, closeIssue: false };
  if (detail.state === "completed") return { ...none, closeIssue: true };
  if (detail.state === "active" && !detail.revising) return { ...none, refresh: true, pause: true, revise: true };
  return none;
}

/** 見張りの失敗の箱の文言。失敗が続いていなければ null */
export function watchAlert(watch: WatchHealth): string | null {
  return watch.consecutiveFailures > 0 ? `GitHub の確認に ${watch.consecutiveFailures} 回続けて失敗しています` : null;
}

/** 詳細から一覧の行を作る。取り直した詳細で一覧の needs_human と進み具合を先に直すため */
export function summaryOf(d: IntakeDetail): IntakeSummary {
  return {
    id: d.id,
    project_id: d.project_id,
    issue_url: d.issue_url,
    issue_title: d.issue_title,
    state: d.state,
    revising: d.revising,
    attention_reason: d.attention_reason,
    dispatch_paused: d.dispatch_paused,
    rate_limited_until: d.rate_limited_until,
    progress: d.progress,
    needs_human: d.needs_human,
    watch: d.watch,
    created_at: d.created_at,
    updated_at: d.updated_at,
  };
}

type TaskIntake = NonNullable<Task["intake"]>;

/** タスクの行の印「Intake #N」。親 Issue の URL から番号が取れなければ「Intake」 */
export function taskIntakeMark(intake: TaskIntake): string {
  const n = intake.parentIssueUrl === null ? null : issueNumber(intake.parentIssueUrl);
  return n === null ? "Intake" : `Intake #${n}`;
}

/** 見出しのリンクの文言「Intake: <Issue のタイトル> / <プロセス id>」。一覧に無ければ「Intake: #N / <プロセス id>」 */
export function taskIntakeLabel(intake: TaskIntake, intakes: readonly IntakeSummary[]): string {
  const title = intakes.find((i) => i.id === intake.id)?.issue_title;
  const n = intake.parentIssueUrl === null ? null : issueNumber(intake.parentIssueUrl);
  return `Intake: ${title ?? (n === null ? intake.id : `#${n}`)} / ${intake.processId}`;
}
