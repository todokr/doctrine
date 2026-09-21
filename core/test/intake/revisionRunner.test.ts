import { afterEach, beforeEach, test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { createMockAdapter } from "../../src/adapter/mock.ts";
import {
  getIntake,
  insertApproval,
  insertDraft,
  insertIntakeRun,
  insertProcesses,
  latestDraft,
  listComments,
  listDrafts,
  listIntakeRuns,
  listQuestionSets,
  updateIntake,
  updateProcess,
} from "../../src/db/intakes.ts";
import { createDetachedWorktree, intakeWorktreePathFor } from "../../src/domain/worktree.ts";
import {
  abandonRevision,
  answerIntake,
  rejectIntake,
  reviseIntake,
} from "../../src/intake/commands.ts";
import { dispatchIntake } from "../../src/intake/dispatch.ts";
import { pfdHash } from "../../src/intake/pfd/hash.ts";
import { claimIntakeRun, runIntakeRun } from "../../src/intake/runner.ts";
import { canonicalJson } from "../../../shared/intake/pfd.ts";
import {
  createFixture,
  depsOf,
  destroyFixture,
  drive,
  type Fixture,
  pfdOut,
  question,
  questionsOut,
} from "./runnerHelper.ts";
import { example, revised } from "./pfd/fixture.ts";

const run = promisify(execFile);

let f: Fixture;
beforeEach(async () => {
  f = await createFixture();
});
afterEach(async () => {
  await destroyFixture(f);
});

const NEVER_ALIVE = { startTimeOf: () => Promise.resolve(null), kill: () => {} };

/** 承認済みで active、プロセス 1 が投入済みの Intake にする。worktree と会話（old）も持つ。 */
async function seedApproved(): Promise<string> {
  const worktree = await createDetachedWorktree({
    repoPath: f.repo,
    worktreePath: intakeWorktreePathFor(f.repo, "i1"),
    baseBranch: "main",
  });
  const runId = await insertIntakeRun(f.db, {
    intake_id: "i1",
    purpose: "decompose",
    attempt: 1,
    status: "success",
    started_at: null,
    log_path: "/dev/null",
  });
  const pfd = example();
  const draft = await insertDraft(f.db, {
    intake_id: "i1",
    run_id: runId,
    pfd: canonicalJson(pfd),
    hash: await pfdHash(pfd),
    replies: "[]",
  });
  await insertApproval(f.db, { intake_id: "i1", draft_id: draft.id, hash: draft.hash });
  await insertProcesses(f.db, "i1", pfd.processes.map((p) => p.id));
  for (const p of pfd.processes) {
    await updateProcess(f.db, "i1", p.id, {
      sub_issue_url: `https://github.com/o/r/issues/${p.id}0`,
    });
  }
  await updateIntake(f.db, "i1", {
    state: "active",
    worktree_path: worktree,
    claude_session_id: "old",
  });
  const report = await dispatchIntake(f.db, "i1");
  assert.deepEqual(report.created.map((c) => c.processId), ["1"]);
  return worktree;
}

const startComments = [{ target_kind: "process" as const, target_id: "4", body: "画面を分けて" }];

const revise = (comments: unknown = startComments) =>
  reviseIntake(f.db, { intakeId: "i1", comments, logRoot: f.logRoot });

/** queued の行を先頭から n 個だけ走らせる（drive は queued が尽きるまで走る）。 */
async function driveN(deps: ReturnType<typeof depsOf>, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const next = await f.db.selectFrom("intake_runs").selectAll()
      .where("status", "=", "queued").orderBy("id").executeTakeFirstOrThrow();
    assert.ok(await claimIntakeRun(f.db, next.id));
    await runIntakeRun(f.db, next.id, deps);
  }
}

function frozenViolation() {
  const pfd = example();
  pfd.processes[0].steps = "別の手順にする";
  return pfd;
}

test("改訂の最初の実行は新しい会話で、承認済みの計画と改訂のコメントを載せる", async () => {
  await seedApproved();
  const adapter = createMockAdapter({
    result: {},
    sequence: [pfdOut(revised(), [{ commentId: 1, reply: "分けました" }])],
  });
  await revise();
  await drive(f.db, depsOf(f, adapter));

  const call = adapter.calls[0];
  assert.equal(call.kind, "start");
  assert.notEqual(call.sessionId, "old");
  assert.match(call.prompt, /## 承認済みの計画/);
  assert.match(call.prompt, /画面を分けて/);
  const intake = (await getIntake(f.db, "i1"))!;
  assert.equal(intake.state, "reviewing");
  assert.equal(intake.revising, 1);
  const draft = (await latestDraft(f.db, "i1"))!;
  assert.equal(draft.pfd, canonicalJson(revised()));
  const [comment] = await listComments(f.db, "i1");
  assert.deepEqual(JSON.parse(draft.replies), [{ commentId: comment.id, reply: "分けました" }]);
});

test("投入済みのプロセスを変えた案は検証で弾かれ、同じ会話で直させる", async () => {
  await seedApproved();
  const adapter = createMockAdapter({
    result: {},
    sequence: [pfdOut(frozenViolation()), pfdOut(revised(), [])],
  });
  await revise();
  await drive(f.db, depsOf(f, adapter));

  const runs = (await listIntakeRuns(f.db, "i1")).filter((r) => r.purpose === "revise");
  assert.equal(runs.length, 2);
  assert.equal(runs[0].status, "failed");
  assert.match(runs[0].issues!, /frozen_changed 1/);
  assert.equal(adapter.calls[1].kind, "resume");
  assert.match(adapter.calls[1].prompt, /frozen_changed 1/);
  assert.equal((await getIntake(f.db, "i1"))!.state, "reviewing");
});

test("投入済みのプロセスの出力を変える案が 3 回続くと要確認になり、改訂中のまま", async () => {
  await seedApproved();
  const changed = example();
  changed.artifacts.find((a) => a.id === "new-table")!.verify = "別の確かめ方";
  const adapter = createMockAdapter({ result: pfdOut(changed) });
  await revise();
  await drive(f.db, depsOf(f, adapter));

  const intake = (await getIntake(f.db, "i1"))!;
  assert.equal(intake.state, "needs_attention");
  assert.equal(JSON.parse(intake.attention_reason!).kind, "invalid_output");
  assert.equal(intake.revising, 1);
  assert.equal(adapter.calls.length, 3);
});

test("改訂中の差し戻しは revise の実行を立てる", async () => {
  await seedApproved();
  const adapter = createMockAdapter({
    result: {},
    sequence: [
      pfdOut(revised(), [{ commentId: 1, reply: "分けました" }]),
      pfdOut(revised(), [{ commentId: 1, reply: "x" }]),
    ],
  });
  const deps = depsOf(f, adapter);
  await revise();
  await drive(f.db, deps);

  const first = (await latestDraft(f.db, "i1"))!;
  await rejectIntake(f.db, {
    intakeId: "i1",
    draftId: first.id,
    comments: [{ target_kind: "process", target_id: "4b", body: "もう一度" }],
    logRoot: f.logRoot,
  });
  const queued = (await listIntakeRuns(f.db, "i1")).filter((r) => r.status === "queued");
  assert.deepEqual(queued.map((r) => r.purpose), ["revise"]);

  await drive(f.db, deps);
  const draft = (await latestDraft(f.db, "i1"))!;
  const rejectComment = (await listComments(f.db, "i1")).find((c) => c.draft_id === first.id)!;
  assert.deepEqual(JSON.parse(draft.replies), [{ commentId: rejectComment.id, reply: "x" }]);
  assert.equal((await listDrafts(f.db, "i1")).length, 3);
});

test("改訂中の回答は revise の実行を立てる", async () => {
  await seedApproved();
  const adapter = createMockAdapter({
    result: {},
    sequence: [
      questionsOut([question("q2")]),
      pfdOut(revised(), [{ commentId: 1, reply: "x" }]),
    ],
  });
  const deps = depsOf(f, adapter);
  await revise();
  await drive(f.db, deps);
  assert.equal((await getIntake(f.db, "i1"))!.state, "answering");

  const [set] = await listQuestionSets(f.db, "i1");
  await answerIntake(f.db, {
    intakeId: "i1",
    questionSetId: set.id,
    answers: [{ questionId: "q2", optionIds: ["a"], other: null, note: null }],
    logRoot: f.logRoot,
  });
  const queued = (await listIntakeRuns(f.db, "i1")).filter((r) => r.status === "queued");
  assert.deepEqual(queued.map((r) => r.purpose), ["revise"]);

  await drive(f.db, deps);
  assert.equal((await getIntake(f.db, "i1"))!.state, "reviewing");
});

test("2 回目の改訂は、放棄した改訂の実行とコメントを持ち込まない", async () => {
  await seedApproved();
  const adapter = createMockAdapter({
    result: {},
    sequence: [
      pfdOut(frozenViolation()),
      pfdOut(frozenViolation()),
      pfdOut(frozenViolation()),
      pfdOut(revised(), [{ commentId: 1, reply: "x" }]),
    ],
  });
  const deps = depsOf(f, adapter);
  await revise([{ target_kind: "process", target_id: "4", body: "最初のコメント" }]);
  await driveN(deps, 2);
  const abandoned = await abandonRevision(f.db, { probe: NEVER_ALIVE }, { intakeId: "i1" });
  assert.equal(abandoned.revising, false);

  await revise([{ target_kind: "process", target_id: "4", body: "API を先に" }]);
  await driveN(deps, 1);
  assert.equal(
    (await getIntake(f.db, "i1"))!.state,
    "decomposing",
    "放棄前の検証落ちを数えず、連続は 1",
  );
  await drive(f.db, deps);

  assert.equal(adapter.calls[2].kind, "start");
  assert.match(adapter.calls[2].prompt, /API を先に/);
  assert.doesNotMatch(adapter.calls[2].prompt, /最初のコメント/);
  assert.equal((await getIntake(f.db, "i1"))!.state, "reviewing");
  const second = (await listComments(f.db, "i1")).find((c) => c.body === "API を先に")!;
  assert.deepEqual(JSON.parse((await latestDraft(f.db, "i1"))!.replies), [
    { commentId: second.id, reply: "x" },
  ]);
});

test("改訂に入るとき worktree を最新の baseBranch へ進める", async () => {
  const worktree = await seedApproved();
  await writeFile(join(f.repo, "next.txt"), "n\n");
  await run("git", ["-C", f.repo, "add", "."]);
  await run("git", ["-C", f.repo, "commit", "-m", "next"]);
  const adapter = createMockAdapter({
    result: {},
    sequence: [pfdOut(revised(), [{ commentId: 1, reply: "x" }])],
  });
  await revise();
  await drive(f.db, depsOf(f, adapter));

  const head = async (dir: string, ref: string) =>
    (await run("git", ["-C", dir, "rev-parse", ref])).stdout.trim();
  assert.equal(await head(worktree, "HEAD"), await head(f.repo, "main"));
});
