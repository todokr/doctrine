import { afterEach, beforeEach, test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createMockAdapter } from "../../src/adapter/mock.ts";
import type { AgentAdapter } from "../../src/adapter/types.ts";
import {
  answerQuestionSet,
  getIntake,
  insertComments,
  latestDraft,
  listComments,
  listDrafts,
  listIntakeRuns,
  listQuestionSets,
  updateIntake,
} from "../../src/db/intakes.ts";
import {
  claimIntakeRun,
  enqueueIntakeRun,
  INTAKE_ALLOWED_TOOLS,
  runIntakeRun,
} from "../../src/intake/runner.ts";
import { pfdHash } from "../../src/intake/pfd/hash.ts";
import { buildNoQuestionsMessage } from "../../src/intake/prompt.ts";
import { buildAnswerText } from "../../../shared/intake/answerText.ts";
import { decomposerJsonSchema } from "../../../shared/intake/decomposer.ts";
import { buildFeedback } from "../../../shared/intake/feedback.ts";
import type { Answer } from "../../../shared/intake/question.ts";
import {
  createFixture,
  depsOf,
  destroyFixture,
  drive,
  type Fixture,
  pfdOut,
  question,
  questionsOut,
  reply,
} from "./runnerHelper.ts";
import { example, withDecision } from "./pfd/fixture.ts";

let f: Fixture;
beforeEach(async () => {
  f = await createFixture();
});
afterEach(async () => {
  await destroyFixture(f);
});

const opts = (resume = false) => ({ logRoot: f.logRoot, resume });

function brokenPfd() {
  const pfd = example();
  pfd.processes[0].outputs = [];
  return pfd;
}

async function attentionOf(): Promise<Record<string, unknown>> {
  const intake = (await getIntake(f.db, "i1"))!;
  return JSON.parse(intake.attention_reason!);
}

test("(a) 調査が質問を返したら回答待ちになる", async () => {
  const adapter = createMockAdapter({ result: questionsOut([question("q1")]) });
  await enqueueIntakeRun(f.db, "i1", "investigate", opts());
  await drive(f.db, depsOf(f, adapter));

  const intake = (await getIntake(f.db, "i1"))!;
  assert.equal(intake.state, "answering");
  assert.equal((await listQuestionSets(f.db, "i1")).length, 1);
  const runs = await listIntakeRuns(f.db, "i1");
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "success");
  assert.equal(intake.child_pid, null);

  const call = adapter.calls[0];
  assert.equal(call.kind, "start");
  assert.match(call.prompt, /Issue の本文/);
  assert.ok(call.opts.allowedTools!.includes("Read"));
  for (const banned of ["Write", "Edit"]) assert.ok(!call.opts.allowedTools!.includes(banned));
  assert.deepEqual(call.opts.jsonSchema, decomposerJsonSchema());
  assert.equal(call.opts.cwd, intake.worktree_path);
  assert.equal(call.sessionId, intake.claude_session_id);
  assert.equal(call.opts.permissionMode, undefined);
});

test("INTAKE_ALLOWED_TOOLS は書き込みと gh・dctl を含まない", () => {
  for (const t of INTAKE_ALLOWED_TOOLS) {
    assert.ok(!/^(Write|Edit|NotebookEdit)/.test(t), t);
    assert.ok(!/gh|dctl/.test(t), t);
  }
});

test("(a) 調査が空の質問を返したら分解へ進み、同じ会話で PFD を求める", async () => {
  const adapter = createMockAdapter({
    result: {},
    sequence: [questionsOut([]), pfdOut(example())],
  });
  await enqueueIntakeRun(f.db, "i1", "investigate", opts());
  await drive(f.db, depsOf(f, adapter));

  assert.equal((await getIntake(f.db, "i1"))!.state, "reviewing");
  const drafts = await listDrafts(f.db, "i1");
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].hash, await pfdHash(example()));
  assert.equal(adapter.calls[1].kind, "resume");
  assert.equal(adapter.calls[1].sessionId, adapter.calls[0].sessionId);
  assert.equal(adapter.calls[1].prompt, buildNoQuestionsMessage());
});

test("(a) 回答のあとは回答の文面が同じ会話に届く", async () => {
  const adapter = createMockAdapter({
    result: {},
    sequence: [questionsOut([question("q1")]), pfdOut(withDecision())],
  });
  const deps = depsOf(f, adapter);
  await enqueueIntakeRun(f.db, "i1", "investigate", opts());
  await drive(f.db, deps);

  const answers: Answer[] = [{ questionId: "q1", optionIds: ["a"], other: null, note: "補足" }];
  const [set] = await listQuestionSets(f.db, "i1");
  await answerQuestionSet(f.db, set.id, reply(answers));
  await updateIntake(f.db, "i1", { state: "decomposing" });
  await enqueueIntakeRun(f.db, "i1", "decompose", opts());
  await drive(f.db, deps);

  assert.equal((await getIntake(f.db, "i1"))!.state, "reviewing");
  assert.equal(adapter.calls[1].kind, "resume");
  assert.equal(adapter.calls[1].sessionId, adapter.calls[0].sessionId);
  assert.equal(
    adapter.calls[1].prompt,
    buildAnswerText(
      { questions: [question("q1")], assumptions: [] },
      { answers, assumptionResponses: [] },
    ),
  );
});

test("(a) 分解の途中の質問で回答待ちに戻る", async () => {
  const adapter = createMockAdapter({
    result: {},
    sequence: [questionsOut([question("q1")]), questionsOut([question("q2")])],
  });
  const deps = depsOf(f, adapter);
  await enqueueIntakeRun(f.db, "i1", "investigate", opts());
  await drive(f.db, deps);
  const [set] = await listQuestionSets(f.db, "i1");
  const answers: Answer[] = [{ questionId: "q1", optionIds: ["a"], other: null, note: null }];
  await answerQuestionSet(f.db, set.id, reply(answers));
  await updateIntake(f.db, "i1", { state: "decomposing" });
  await enqueueIntakeRun(f.db, "i1", "decompose", opts());
  await drive(f.db, deps);

  assert.equal((await getIntake(f.db, "i1"))!.state, "answering");
  assert.equal((await listQuestionSets(f.db, "i1")).length, 2);
});

test("(b) 検証に通らない PFD は案にならず、違反が同じ会話へ返る", async () => {
  const adapter = createMockAdapter({
    result: {},
    sequence: [questionsOut([]), pfdOut(brokenPfd()), pfdOut(example())],
  });
  await enqueueIntakeRun(f.db, "i1", "investigate", opts());
  await drive(f.db, depsOf(f, adapter));

  const drafts = await listDrafts(f.db, "i1");
  assert.equal(drafts.length, 1);
  assert.deepEqual(JSON.parse(drafts[0].pfd).processes, example().processes);
  assert.equal(adapter.calls[2].kind, "resume");
  assert.equal(adapter.calls[2].sessionId, adapter.calls[0].sessionId);
  assert.match(adapter.calls[2].prompt, /no_output/);
  const failed = (await listIntakeRuns(f.db, "i1")).filter((r) => r.status === "failed");
  assert.equal(failed.length, 1);
  assert.match(failed[0].issues!, /no_output/);
  assert.equal((await getIntake(f.db, "i1"))!.state, "reviewing");
});

test("(b) 検証落ちが 3 回続くと要確認になる", async () => {
  const adapter = createMockAdapter({ result: pfdOut(brokenPfd()) });
  await updateIntake(f.db, "i1", { state: "decomposing" });
  await enqueueIntakeRun(f.db, "i1", "decompose", opts());
  await drive(f.db, depsOf(f, adapter));

  const intake = (await getIntake(f.db, "i1"))!;
  assert.equal(intake.state, "needs_attention");
  const runs = await listIntakeRuns(f.db, "i1");
  assert.equal(runs.length, 3);
  const reason = await attentionOf();
  assert.equal(reason.kind, "invalid_output");
  assert.equal(reason.runId, runs[2].id);
  assert.equal((await listDrafts(f.db, "i1")).length, 0);
  assert.equal(adapter.calls.length, 3);
  assert.deepEqual(runs.map((r) => r.attempt), [1, 2, 3]);
});

test("(b) 調査の実行が PFD を返すと検証落ちになる", async () => {
  const adapter = createMockAdapter({ result: pfdOut(example()) });
  const id = await enqueueIntakeRun(f.db, "i1", "investigate", opts());
  assert.ok(await claimIntakeRun(f.db, id));
  await runIntakeRun(f.db, id, depsOf(f, adapter));

  const runs = await listIntakeRuns(f.db, "i1");
  assert.equal(runs[0].status, "failed");
  assert.equal(runs[1].status, "queued");
  assert.equal(runs[1].purpose, "investigate");
  assert.equal((await getIntake(f.db, "i1"))!.state, "investigating");
});

async function reachReviewing(adapter: AgentAdapter) {
  await enqueueIntakeRun(f.db, "i1", "investigate", opts());
  await drive(f.db, depsOf(f, adapter));
  assert.equal((await getIntake(f.db, "i1"))!.state, "reviewing");
}

const rejectComments = [
  { target_kind: "process" as const, target_id: "2", body: "コメント1" },
  { target_kind: "whole" as const, target_id: null, body: "コメント2" },
];

async function reject(): Promise<void> {
  const draft = (await latestDraft(f.db, "i1"))!;
  await insertComments(f.db, "i1", draft.id, rejectComments, null);
  await updateIntake(f.db, "i1", { state: "decomposing" });
  await enqueueIntakeRun(f.db, "i1", "decompose", opts());
}

test("(c) 差し戻しのコメントが同じ会話の続きとして渡る", async () => {
  const adapter = createMockAdapter({
    result: {},
    sequence: [
      questionsOut([]),
      pfdOut(example()),
      pfdOut(example(), [{ commentId: 1, reply: "直した" }]),
    ],
  });
  await reachReviewing(adapter);
  await reject();
  await drive(f.db, depsOf(f, adapter));

  const last = adapter.calls.at(-1)!;
  assert.equal(last.kind, "resume");
  assert.equal(last.sessionId, adapter.calls[0].sessionId);
  assert.equal(last.prompt, buildFeedback(example(), rejectComments));

  assert.equal((await getIntake(f.db, "i1"))!.state, "reviewing");
  const drafts = await listDrafts(f.db, "i1");
  assert.equal(drafts.length, 2);
  const comments = await listComments(f.db, "i1");
  assert.deepEqual(JSON.parse(drafts[1].replies), [{ commentId: comments[0].id, reply: "直した" }]);
});

test("(c) 差し戻しの後に検証落ちを挟んでも replies を受け付ける", async () => {
  const adapter = createMockAdapter({
    result: {},
    sequence: [
      questionsOut([]),
      pfdOut(example()),
      pfdOut(brokenPfd(), [{ commentId: 1, reply: "r" }]),
      pfdOut(example(), [{ commentId: 1, reply: "r" }]),
    ],
  });
  await reachReviewing(adapter);
  await reject();
  await drive(f.db, depsOf(f, adapter));

  assert.equal((await getIntake(f.db, "i1"))!.state, "reviewing");
  const drafts = await listDrafts(f.db, "i1");
  assert.equal(drafts.length, 2);
  assert.equal(JSON.parse(drafts[1].replies).length, 1);
});

test("エージェントが失敗したら要確認になる", async () => {
  const adapter = createMockAdapter({ result: { ok: false, text: "boom" } });
  await enqueueIntakeRun(f.db, "i1", "investigate", opts());
  await drive(f.db, depsOf(f, adapter));

  const intake = (await getIntake(f.db, "i1"))!;
  assert.equal(intake.state, "needs_attention");
  const reason = await attentionOf();
  assert.equal(reason.kind, "agent_failed");
  assert.match(String(reason.message), /boom/);
  // 最初の呼び出しが落ちたので、会話の記録は消える
  assert.equal(intake.claude_session_id, null);
  assert.equal((await listIntakeRuns(f.db, "i1"))[0].status, "failed");
});

test("リポジトリを書き換えたら出力を捨てて戻し、要確認にする", async () => {
  const inner = createMockAdapter({ result: questionsOut([question("q1")]) });
  const adapter: AgentAdapter = {
    start(prompt, o) {
      Deno.writeTextFileSync(join(o.cwd, "x.txt"), "x");
      return inner.start(prompt, o);
    },
    resume: inner.resume,
  };
  await enqueueIntakeRun(f.db, "i1", "investigate", opts());
  await drive(f.db, depsOf(f, adapter));

  const intake = (await getIntake(f.db, "i1"))!;
  assert.equal(intake.state, "needs_attention");
  const reason = await attentionOf();
  assert.equal(reason.kind, "wrote_repository");
  assert.deepEqual(reason.paths, ["x.txt"]);
  await assert.rejects(Deno.stat(join(intake.worktree_path!, "x.txt")));
  assert.equal((await listQuestionSets(f.db, "i1")).length, 0);
});

test("中止された Intake の実行は走らせない", async () => {
  const adapter = createMockAdapter({ result: questionsOut([question("q1")]) });
  const id = await enqueueIntakeRun(f.db, "i1", "investigate", opts());
  assert.ok(await claimIntakeRun(f.db, id));
  await updateIntake(f.db, "i1", { state: "canceled" });
  await runIntakeRun(f.db, id, depsOf(f, adapter));

  assert.equal((await listIntakeRuns(f.db, "i1"))[0].status, "interrupted");
  assert.equal(adapter.calls.length, 0);
});

test("実行中に中止されたら、結果を書かずに行だけ閉じる", async () => {
  const inner = createMockAdapter({ result: questionsOut([question("q1")]) });
  const adapter: AgentAdapter = {
    start(prompt, o) {
      // 実行の最中に人が中止した
      updateIntake(f.db, "i1", { state: "canceled" });
      return inner.start(prompt, o);
    },
    resume: inner.resume,
  };
  await enqueueIntakeRun(f.db, "i1", "investigate", opts());
  await drive(f.db, depsOf(f, adapter));

  assert.equal((await getIntake(f.db, "i1"))!.state, "canceled");
  assert.equal((await listQuestionSets(f.db, "i1")).length, 0);
  assert.equal((await listIntakeRuns(f.db, "i1"))[0].status, "interrupted");
});

test("attempt は新しく立てるたびに進み、上限待ちからの再開では進まない", async () => {
  const a = await enqueueIntakeRun(f.db, "i1", "investigate", opts());
  const b = await enqueueIntakeRun(f.db, "i1", "investigate", opts(true));
  const c = await enqueueIntakeRun(f.db, "i1", "investigate", opts());
  const runs = await listIntakeRuns(f.db, "i1");
  assert.deepEqual(runs.map((r) => r.id), [a, b, c]);
  assert.deepEqual(runs.map((r) => r.attempt), [1, 1, 2]);
  assert.equal(runs[0].log_path, join(f.logRoot, "intake-i1", "investigate.1.log"));
});
