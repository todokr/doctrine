import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import type {
  IntakeCommentRow,
  IntakeDraftRow,
  IntakeQuestionSetRow,
  IntakeRunPurpose,
  IntakeRunRow,
  IntakeRunStatus,
} from "../../src/db/schema.ts";
import { consecutiveInvalid, continuationMessage } from "../../src/intake/conversation.ts";
import { buildNoQuestionsMessage } from "../../src/intake/prompt.ts";
import { buildAnswerText } from "../../../shared/intake/answerText.ts";
import { buildFeedback } from "../../../shared/intake/feedback.ts";
import type { Answer, Question } from "../../../shared/intake/question.ts";
import { canonicalJson } from "../../../shared/intake/pfd.ts";
import { example } from "./pfd/fixture.ts";

const q1: Question = {
  id: "q1",
  prompt: "どうするか",
  kind: "single",
  options: [
    { id: "a", label: "案A", description: "d" },
    { id: "b", label: "案B", description: "d" },
  ],
  recommendation: null,
  materials: [],
};
const answers: Answer[] = [{ questionId: "q1", optionIds: ["a"], other: null, note: "補足" }];

function run(
  id: number,
  purpose: IntakeRunPurpose,
  status: IntakeRunStatus,
  o: { output?: unknown; issues?: string[] } = {},
): IntakeRunRow {
  return {
    id,
    intake_id: "i1",
    purpose,
    attempt: 1,
    status,
    started_at: null,
    ended_at: null,
    log_path: "",
    cost_usd: null,
    num_turns: null,
    duration_ms: null,
    output: o.output === undefined ? null : JSON.stringify(o.output),
    issues: o.issues === undefined ? null : JSON.stringify(o.issues),
    permission_denials: null,
  };
}

const failedInvalid = (id: number, purpose: IntakeRunPurpose = "decompose") =>
  run(id, purpose, "failed", { issues: ["x"] });

test("consecutiveInvalid: 上限待ちを挟んでも連続を数える", () => {
  const runs = [failedInvalid(1), run(2, "decompose", "rate_limited"), failedInvalid(3)];
  assert.equal(consecutiveInvalid(runs, "decompose"), 2);
});

test("consecutiveInvalid: 成功で止まる", () => {
  const runs = [failedInvalid(1), run(2, "decompose", "success"), failedInvalid(3)];
  assert.equal(consecutiveInvalid(runs, "decompose"), 1);
});

test("consecutiveInvalid: 別の purpose は数えない", () => {
  const runs = [
    failedInvalid(1, "investigate"),
    failedInvalid(2, "investigate"),
    failedInvalid(3, "decompose"),
  ];
  assert.equal(consecutiveInvalid(runs, "decompose"), 1);
});

test("consecutiveInvalid: エージェント自体の失敗（issues なし）は連続を切る", () => {
  const runs = [failedInvalid(1), run(2, "decompose", "failed"), failedInvalid(3)];
  assert.equal(consecutiveInvalid(runs, "decompose"), 1);
});

const questionsOutput = { kind: "questions", questions: [q1], pfd: null, replies: null };
const emptyQuestionsOutput = { kind: "questions", questions: [], pfd: null, replies: null };

function questionSet(runId: number, withAnswers: boolean): IntakeQuestionSetRow {
  return {
    id: 1,
    intake_id: "i1",
    run_id: runId,
    questions: JSON.stringify([q1]),
    answers: withAnswers ? JSON.stringify(answers) : null,
    created_at: "",
    answered_at: withAnswers ? "" : null,
  };
}

function draft(runId: number): IntakeDraftRow {
  return {
    id: 10,
    intake_id: "i1",
    seq: 1,
    run_id: runId,
    pfd: canonicalJson(example()),
    hash: "h",
    replies: "[]",
    created_at: "",
  };
}

function comment(id: number, body: string): IntakeCommentRow {
  return {
    id,
    intake_id: "i1",
    draft_id: 10,
    target_kind: "process",
    target_id: "2",
    body,
    run_id: null,
    created_at: "",
  };
}

const none = { questionSets: [], drafts: [], comments: [] };

test("continuationMessage: 実行が無ければ null", () => {
  assert.equal(continuationMessage({ closedRuns: [], ...none }), null);
});

test("continuationMessage: 回答のあとは buildAnswerText", () => {
  const text = continuationMessage({
    closedRuns: [run(1, "investigate", "success", { output: questionsOutput })],
    questionSets: [questionSet(1, true)],
    drafts: [],
    comments: [],
  });
  assert.equal(text, buildAnswerText([q1], answers));
});

test("continuationMessage: 回答が無いまま続きを求めたら投げる", () => {
  assert.throws(() =>
    continuationMessage({
      closedRuns: [run(1, "investigate", "success", { output: questionsOutput })],
      questionSets: [questionSet(1, false)],
      drafts: [],
      comments: [],
    })
  );
});

test("continuationMessage: 空の質問のあとは分解へ進ませる", () => {
  const text = continuationMessage({
    closedRuns: [run(1, "investigate", "success", { output: emptyQuestionsOutput })],
    ...none,
  });
  assert.equal(text, buildNoQuestionsMessage());
});

function feedbackSituation() {
  return {
    closedRuns: [
      run(1, "investigate", "success", { output: emptyQuestionsOutput }),
      run(2, "decompose", "success", {
        output: { kind: "pfd", pfd: example(), replies: [] },
      }),
    ],
    questionSets: [],
    drafts: [draft(2)],
    comments: [comment(5, "コメント1"), comment(6, "コメント2")],
  };
}

test("continuationMessage: 差し戻しのあとは buildFeedback", () => {
  const text = continuationMessage(feedbackSituation());
  assert.equal(
    text,
    buildFeedback(example(), [
      { target_kind: "process", target_id: "2", body: "コメント1" },
      { target_kind: "process", target_id: "2", body: "コメント2" },
    ]),
  );
});

test("continuationMessage: 検証落ちのあとは違反を返す", () => {
  const text = continuationMessage({
    closedRuns: [run(1, "investigate", "failed", { issues: ["ここが違反"] })],
    ...none,
  });
  assert.match(text!, /ここが違反/);
});

test("continuationMessage: 上限待ちの行は飛ばして同じ文面を送り直す", () => {
  const base = feedbackSituation();
  const withLimit = {
    ...base,
    closedRuns: [...base.closedRuns, run(3, "decompose", "rate_limited")],
  };
  assert.equal(continuationMessage(withLimit), continuationMessage(base));
});

test("continuationMessage: エージェント自体の失敗の行も飛ばす", () => {
  const base = feedbackSituation();
  const withFailure = {
    ...base,
    closedRuns: [...base.closedRuns, run(3, "decompose", "failed")],
  };
  assert.equal(continuationMessage(withFailure), continuationMessage(base));
});
