import type {
  IntakeCommentRow,
  IntakeDraftRow,
  IntakeQuestionSetRow,
  IntakeRunPurpose,
  IntakeRunRow,
} from "../db/schema.ts";
import { buildAnswerText } from "../../../shared/intake/answerText.ts";
import { buildFeedback } from "../../../shared/intake/feedback.ts";
import type { Pfd } from "../../../shared/intake/pfd.ts";
import type { Answer, Question } from "../../../shared/intake/question.ts";
import { buildInvalidOutputMessage, buildNoQuestionsMessage } from "./prompt.ts";

/** 同じ purpose で検証落ちが何行続いたらあきらめるか（spec 7 章）。 */
export const MAX_INVALID_OUTPUTS = 3;

/**
 * 同じ purpose の行を新しい順に見て、検証落ち（failed で issues あり）が何行続いているか。
 * 上限待ちと中断の行は数えず、連続も切らない。カウンタを持たず、行から数える。
 */
export function consecutiveInvalid(
  runs: readonly Pick<IntakeRunRow, "purpose" | "status" | "issues">[],
  purpose: IntakeRunPurpose,
): number {
  let n = 0;
  for (let i = runs.length - 1; i >= 0; i--) {
    const r = runs[i];
    if (r.purpose !== purpose) continue;
    if (r.status === "rate_limited" || r.status === "interrupted") continue;
    if (r.status === "failed" && r.issues !== null) {
      n++;
      continue;
    }
    break;
  }
  return n;
}

/** 次の実行が受け取るはずの文面が無い行（やり直しても同じ文面を送る）。 */
function isSkipped(r: IntakeRunRow): boolean {
  if (r.status === "rate_limited" || r.status === "interrupted") return true;
  // エージェント自体の失敗。会話に何も返していない。
  return r.status === "failed" && r.issues === null;
}

/**
 * 次の実行でエージェントへ送る続きの文面。無ければ null（会話の最初の実行）。
 * 直前の実行の出力に紐づく行（回答・案とコメント）から毎回導くので、再起動・上限待ち・
 * 要確認からのやり直しをまたいでも同じ文面になる。
 */
export function continuationMessage(input: {
  /** この Intake の閉じた実行（queued / running を除く）。id 昇順。 */
  closedRuns: readonly IntakeRunRow[];
  questionSets: readonly IntakeQuestionSetRow[];
  drafts: readonly IntakeDraftRow[];
  comments: readonly IntakeCommentRow[];
}): string | null {
  const effective = input.closedRuns.filter((r) => !isSkipped(r));
  const last = effective.at(-1);
  if (last === undefined) return null;

  if (last.status === "failed") {
    return buildInvalidOutputMessage(last.purpose, JSON.parse(last.issues!) as string[]);
  }

  const output = JSON.parse(last.output ?? "null") as
    | { kind: "questions"; questions: Question[] }
    | { kind: "pfd"; pfd: Pfd }
    | null;
  if (output === null) throw new Error(`実行 ${last.id} に出力がありません`);

  if (output.kind === "questions") {
    if (output.questions.length === 0) return buildNoQuestionsMessage();
    const set = input.questionSets.find((s) => s.run_id === last.id);
    if (set === undefined || set.answers === null) {
      throw new Error(`実行 ${last.id} の質問に回答がありません`);
    }
    return buildAnswerText(
      JSON.parse(set.questions) as Question[],
      JSON.parse(set.answers) as Answer[],
    );
  }

  const draft = input.drafts.find((d) => d.run_id === last.id);
  if (draft === undefined) throw new Error(`実行 ${last.id} の案がありません`);
  const comments = input.comments.filter((c) => c.draft_id === draft.id);
  if (comments.length === 0) throw new Error(`案 ${draft.id} に差し戻しのコメントがありません`);
  return buildFeedback(
    JSON.parse(draft.pfd) as Pfd,
    [...comments].sort((a, b) => a.id - b.id),
  );
}
