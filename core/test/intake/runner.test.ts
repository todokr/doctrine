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
  intakeAllowedTools,
  runIntakeRun,
} from "../../src/intake/runner.ts";
import { pfdHash } from "../../src/intake/pfd/hash.ts";
import { buildNoQuestionsMessage } from "../../src/intake/prompt.ts";
import { buildAnswerText } from "../../../shared/intake/answerText.ts";
import { decomposerJsonSchema } from "../../../shared/intake/decomposer.ts";
import { buildFeedback } from "../../../shared/intake/feedback.ts";
import type { Answer } from "../../../shared/intake/question.ts";
import {
  canonical,
  createDetachedWorktree,
  intakeWorktreePathFor,
  listIntakeWorktrees,
} from "../../src/domain/worktree.ts";
import { READ_ONLY_TOOLS } from "../../src/workflow/scaffold.ts";
import { makeRepo } from "../helpers/repo.ts";
import {
  addProject,
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
import { example, withDecision, withProject } from "./pfd/fixture.ts";

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
  assert.match(call.prompt, /## プロジェクト/);
  assert.match(call.prompt, /- repo（ディレクトリ: repo\/、baseBranch: main、GitHub: o\/r）/);
  assert.ok(call.opts.allowedTools!.includes("Read"));
  for (const banned of ["Write", "Edit"]) assert.ok(!call.opts.allowedTools!.includes(banned));
  assert.deepEqual(call.opts.jsonSchema, decomposerJsonSchema());
  assert.equal(call.opts.cwd, intake.worktree_path);
  assert.equal(call.sessionId, intake.claude_session_id);
  assert.equal(call.opts.permissionMode, undefined);
});

test("intakeAllowedTools は書き込みと gh・dctl を含まない", () => {
  for (const t of intakeAllowedTools(["api", "web"])) {
    assert.ok(!/^(Write|Edit|NotebookEdit)/.test(t), t);
    assert.ok(!/gh|dctl/.test(t), t);
  }
});

test("intakeAllowedTools は READ_ONLY_TOOLS の git 以外をそのまま並べる", () => {
  const tools = intakeAllowedTools(["repo"]);
  for (const t of READ_ONLY_TOOLS) {
    if (!t.startsWith("Bash(git ")) assert.ok(tools.includes(t), t);
  }
  assert.equal(tools.length, 3 + READ_ONLY_TOOLS.length);
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

test("(b) workspace に無い project の PFD は案にならず、unknown_project が同じ会話へ返る", async () => {
  const adapter = createMockAdapter({
    result: {},
    sequence: [questionsOut([]), pfdOut(withProject(example(), "ghost")), pfdOut(example())],
  });
  await enqueueIntakeRun(f.db, "i1", "investigate", opts());
  await drive(f.db, depsOf(f, adapter));

  const drafts = await listDrafts(f.db, "i1");
  assert.equal(drafts.length, 1);
  assert.equal(adapter.calls[2].kind, "resume");
  assert.match(adapter.calls[2].prompt, /unknown_project/);
  const failed = (await listIntakeRuns(f.db, "i1")).filter((r) => r.status === "failed");
  assert.equal(failed.length, 1);
  assert.match(failed[0].issues!, /unknown_project/);
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
      Deno.writeTextFileSync(join(o.cwd, "repo", "x.txt"), "x");
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
  assert.deepEqual(reason.paths, ["repo/x.txt"]);
  await assert.rejects(Deno.stat(join(intake.worktree_path!, "repo", "x.txt")));
  assert.equal((await listQuestionSets(f.db, "i1")).length, 0);
});

test("2 プロジェクトの workspace では、親ディレクトリの下にプロジェクトごとの worktree を並べて cwd にする", async () => {
  await addProject(f, "b");
  const adapter = createMockAdapter({ result: questionsOut([question("q1")]) });
  await enqueueIntakeRun(f.db, "i1", "investigate", opts());
  await drive(f.db, depsOf(f, adapter));

  const intake = (await getIntake(f.db, "i1"))!;
  const expectedParent = await canonical(join(f.root, "state", "worktrees", "intake-i1"));
  assert.equal(intake.worktree_path, expectedParent);
  assert.equal(adapter.calls[0].opts.cwd, intake.worktree_path);
  await Deno.stat(join(intake.worktree_path!, "repo", "README.md"));
  await Deno.stat(join(intake.worktree_path!, "b", "README.md"));
  const children = await listIntakeWorktrees(intake.worktree_path!);
  assert.deepEqual(children.map((c) => c.name), ["b", "repo"]);
  assert.equal(intake.state, "answering");
});

test("どれか 1 つの worktree の書き換えで wrote_repository になり、書き換えのあった worktree を巻き戻す", async () => {
  await addProject(f, "b");
  const inner = createMockAdapter({ result: questionsOut([question("q1")]) });
  const adapter: AgentAdapter = {
    start(prompt, o) {
      Deno.writeTextFileSync(join(o.cwd, "b", "x.txt"), "x");
      Deno.writeTextFileSync(join(o.cwd, "repo", "README.md"), "changed\n");
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
  assert.deepEqual(reason.paths, ["b/x.txt", "repo/README.md"]);
  await assert.rejects(Deno.stat(join(intake.worktree_path!, "b", "x.txt")));
  assert.equal(
    await Deno.readTextFile(join(intake.worktree_path!, "repo", "README.md")),
    "x\n",
  );
  assert.equal((await listQuestionSets(f.db, "i1")).length, 0);
});

test("外されたプロジェクトの worktree も書き換えを見て巻き戻し、残しておく", async () => {
  const bRepo = await makeRepo(join(f.root, "b"), { "README.md": "y\n" });
  const parent = intakeWorktreePathFor("i1");
  await Deno.mkdir(parent, { recursive: true });
  await createDetachedWorktree({
    repoPath: bRepo,
    worktreePath: join(parent, "b"),
    baseBranch: "main",
  });
  await updateIntake(f.db, "i1", { worktree_path: await canonical(parent) });

  const inner = createMockAdapter({ result: questionsOut([question("q1")]) });
  const adapter: AgentAdapter = {
    start(prompt, o) {
      Deno.writeTextFileSync(join(o.cwd, "b", "x.txt"), "x");
      return inner.start(prompt, o);
    },
    resume: inner.resume,
  };
  await enqueueIntakeRun(f.db, "i1", "investigate", opts());
  await drive(f.db, depsOf(f, adapter));

  const intake = (await getIntake(f.db, "i1"))!;
  const reason = await attentionOf();
  assert.equal(reason.kind, "wrote_repository");
  assert.deepEqual(reason.paths, ["b/x.txt"]);
  await assert.rejects(Deno.stat(join(intake.worktree_path!, "b", "x.txt")));
  await Deno.stat(join(intake.worktree_path!, "b"));
  await Deno.stat(join(intake.worktree_path!, "repo"));

  const tools = inner.calls[0].opts.allowedTools!;
  assert.ok(tools.includes("Bash(git -C repo log:*)"));
  assert.ok(!tools.includes("Bash(git -C b log:*)"));
});

test("allowedTools はプロジェクトごとに git -C <名前> を並べ、素の git を含まない", async () => {
  await addProject(f, "b");
  const adapter = createMockAdapter({ result: questionsOut([question("q1")]) });
  await enqueueIntakeRun(f.db, "i1", "investigate", opts());
  await drive(f.db, depsOf(f, adapter));

  const tools = adapter.calls[0].opts.allowedTools!;
  for (const t of ["Read", "Grep", "Glob", "Bash(grep:*)"]) assert.ok(tools.includes(t), t);
  for (const name of ["repo", "b"]) {
    assert.ok(tools.includes(`Bash(git -C ${name} status:*)`));
    assert.ok(tools.includes(`Bash(git -C ${name} diff:*)`));
    assert.ok(tools.includes(`Bash(git -C ${name} log:*)`));
    assert.ok(tools.includes(`Bash(git -C ${name} show:*)`));
    assert.ok(tools.includes(`Bash(git -C ${name} apply --stat:*)`));
  }
  assert.ok(!tools.some((t) => /^Bash\(git (status|diff|log|show|apply)/.test(t)));
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
