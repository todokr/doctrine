import { fakeBaseSync } from "../helpers/watcher.ts";
import { afterEach, beforeEach, test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/db/migrate.ts";
import { getIntake, listIntakeRuns, listProcesses, updateIntake } from "../../src/db/intakes.ts";
import { createHandler, type DaemonContext, tick } from "../../src/daemon/handlers.ts";
import { commitStepBoundary } from "../../src/db/boundary.ts";
import { getTask } from "../../src/db/tasks.ts";
import { createWorktree, worktreePathFor } from "../../src/domain/worktree.ts";
import { createMockAdapter } from "../../src/adapter/mock.ts";
import type { AgentAdapter } from "../../src/adapter/types.ts";
import { createWarningLog } from "../../src/daemon/warnings.ts";
import type { IntakeDetail, IntakeSummary, ServerEvent } from "../../../shared/protocol.ts";
import type { PrFact } from "../../../shared/intake/github.ts";
import type { IntakeState } from "../../../shared/intake/state.ts";
import type { PrWatcher, Tracker } from "../../src/github/tracker.ts";
import { createIntakeWatcher } from "../../src/intake/watch.ts";
import { loadWorkflowFromDisk, taskWorkflow } from "../../src/workflow/load.ts";
import { fakeTracker as statefulTracker } from "../helpers/fakeTracker.ts";
import { fakePrWatcher } from "../helpers/prWatcher.ts";
import { makeRepo, until } from "../helpers/repo.ts";
import { fakeTracker } from "../helpers/tracker.ts";
import { pfdOut, question, questionsOut } from "../intake/runnerHelper.ts";
import { example, revised } from "../intake/pfd/fixture.ts";

const ISSUE = "https://github.com/o/r/issues/1";
const NOOP_CONN = { follow() {}, unfollow() {}, isFollowing: () => false };

let root: string;
let repo: string;
const contexts: DaemonContext[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "doctrine-intake-rpc-"));
  repo = await makeRepo(root, {
    "README.md": "x\n",
    ".doctrine/project.yaml": "defaultWorkflow: feature\nmaxConcurrent: 1\nbaseBranch: main\n",
    ".doctrine/workflows/feature.yaml":
      "name: feature\nsteps:\n  - id: review\n    type: approval\n    title: 見て\n",
  });
  process.env.DOCTRINE_STATE_DIR = join(root, "state");
});
afterEach(async () => {
  await until(() =>
    contexts.every((c) =>
      c.running.size === 0 && c.runningIntakeRuns.size === 0 && c.intakeWatcher.idle()
    )
  );
  contexts.length = 0;
  await rm(root, { recursive: true, force: true });
  delete process.env.DOCTRINE_STATE_DIR;
});

function standardAdapter(): AgentAdapter {
  return createMockAdapter({
    result: {},
    sequence: [
      questionsOut([question("q1")]),
      pfdOut(example()),
      pfdOut(example(), [{ commentId: 1, reply: "直しました" }]),
    ],
  });
}

type Options = { adapter?: AgentAdapter; tracker?: Tracker; prWatcher?: PrWatcher };

async function context(events: ServerEvent[] = [], o: Options = {}): Promise<DaemonContext> {
  const db = await openDb(":memory:");
  const tracker = o.tracker ?? fakeTracker();
  const ctx: DaemonContext = {
    db,
    adapter: o.adapter ?? standardAdapter(),
    logRoot: join(root, "logs"),
    globalLimit: 4,
    configPath: join(root, "config.json"),
    broadcast: (ev) => events.push(ev),
    warnings: createWarningLog({ broadcast: (ev) => events.push(ev), write: () => {} }),
    loadWorkflow: loadWorkflowFromDisk,
    workflowOf: (t, p) => taskWorkflow(t, p, loadWorkflowFromDisk),
    running: new Set(),
    tracker,
    runningIntakeRuns: new Set(),
    intakeWatcher: createIntakeWatcher({
      db,
      tracker,
      prWatcher: o.prWatcher ?? fakePrWatcher().prWatcher,
      baseSync: fakeBaseSync().baseSync,
      loadWorkflow: loadWorkflowFromDisk,
      onStateChanged: (t) =>
        events.push({
          event: "intake.stateChanged",
          intake_id: t.intakeId,
          from: t.from,
          to: t.to,
          revising: t.revising,
        }),
      onUpdated: (intake_id) => events.push({ event: "intake.updated", intake_id }),
    }),
  };
  contexts.push(ctx);
  return ctx;
}

type Call = <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>;

async function setup(o: Options = {}) {
  const events: ServerEvent[] = [];
  const ctx = await context(events, o);
  const h = createHandler(ctx);
  const call: Call = <T>(method: string, params: Record<string, unknown> = {}) =>
    h(method, params, NOOP_CONN) as Promise<T>;
  await call("project.add", { path: repo });
  return { ctx, events, call };
}

/** tick して、状態 X になり、走っている実行が全部終わるのを待つ。 */
async function tickUntil(ctx: DaemonContext, id: string, state: IntakeState): Promise<void> {
  await until(() => ctx.runningIntakeRuns.size === 0);
  await tick(ctx);
  await until(async () => (await getIntake(ctx.db, id))!.state === state);
  await until(() => ctx.runningIntakeRuns.size === 0);
}

const answerQ1 = [{ questionId: "q1", optionIds: ["a"], other: null, note: null }];

async function toAnswering(ctx: DaemonContext, call: Call): Promise<IntakeSummary> {
  const started = await call<IntakeSummary>("intake.start", { project: repo, issue_url: ISSUE });
  await tickUntil(ctx, started.id, "answering");
  return started;
}

async function toReviewing(ctx: DaemonContext, call: Call): Promise<IntakeDetail> {
  const started = await toAnswering(ctx, call);
  const detail = await call<IntakeDetail>("intake.get", { intake_id: started.id });
  await call("intake.answer", {
    intake_id: started.id,
    question_set_id: detail.question_sets[0].id,
    answers: answerQ1,
  });
  await tickUntil(ctx, started.id, "reviewing");
  return await call<IntakeDetail>("intake.get", { intake_id: started.id });
}

async function count(
  ctx: DaemonContext,
  table: "intake_comments" | "intake_approvals" | "intake_processes",
) {
  const row = await ctx.db.selectFrom(table).select((eb) => eb.fn.countAll<number>().as("n"))
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

async function queuedRuns(ctx: DaemonContext, id: string) {
  return (await listIntakeRuns(ctx.db, id)).filter((r) => r.status === "queued");
}

test("開始から承認までの一連の呼び出しが通る", async () => {
  const tracker = fakeTracker();
  const { ctx, events, call } = await setup({ tracker });

  const started = await call<IntakeSummary & { alreadyActive: boolean }>("intake.start", {
    project: repo,
    issue_url: ISSUE,
  });
  assert.equal(started.state, "investigating");
  assert.equal(started.alreadyActive, false);
  assert.equal(started.needs_human, false);
  assert.deepEqual(tracker.reads, [ISSUE]);
  const id = started.id;

  await tickUntil(ctx, id, "answering");
  const answering = await call<IntakeDetail>("intake.get", { intake_id: id });
  assert.equal(answering.question_sets.length, 1);
  assert.equal(answering.question_sets[0].answers, null);
  assert.equal(answering.needs_human, true);

  const answered = await call<IntakeSummary>("intake.answer", {
    intake_id: id,
    question_set_id: answering.question_sets[0].id,
    answers: answerQ1,
  });
  assert.equal(answered.state, "decomposing");

  await tickUntil(ctx, id, "reviewing");
  const first = await call<IntakeDetail>("intake.get", { intake_id: id });
  assert.equal(first.latest_draft!.seq, 1);
  assert.deepEqual(first.latest_draft!.pfd, example());

  const rejected = await call<IntakeSummary>("intake.reject", {
    intake_id: id,
    draft_id: first.latest_draft!.id,
    comments: [{ target_kind: "process", target_id: "2", body: "分けすぎ" }],
  });
  assert.equal(rejected.state, "decomposing");

  await tickUntil(ctx, id, "reviewing");
  const second = await call<IntakeDetail>("intake.get", { intake_id: id });
  assert.equal(second.drafts.length, 2);
  assert.equal(second.comments.length, 1);
  assert.equal(second.comments[0].draft_id, first.latest_draft!.id);
  assert.equal(second.latest_draft!.replies[0].commentId, second.comments[0].id);

  const approved = await call<IntakeSummary>("intake.approve", {
    intake_id: id,
    draft_id: second.latest_draft!.id,
    hash: second.latest_draft!.hash,
  });
  assert.equal(approved.state, "active");
  assert.deepEqual(approved.progress, { done: 0, total: 4 });
  assert.equal(approved.needs_human, true);
  const active = await call<IntakeDetail>("intake.get", { intake_id: id });
  assert.equal(active.approval!.draft_id, second.latest_draft!.id);
  assert.deepEqual(active.processes.map((p) => p.id), ["1", "2", "3", "4"]);
  assert.deepEqual(await call("task.list"), []);

  const transitions = events
    .filter((e) => e.event === "intake.stateChanged")
    .map((e) => e.event === "intake.stateChanged" ? [e.from, e.to] : []);
  assert.deepEqual(transitions, [
    ["investigating", "answering"],
    ["answering", "decomposing"],
    ["decomposing", "reviewing"],
    ["reviewing", "decomposing"],
    ["decomposing", "reviewing"],
    ["reviewing", "active"],
  ]);
});

test("コメントの無い差し戻しは拒まれる", async () => {
  const { ctx, call } = await setup();
  const detail = await toReviewing(ctx, call);
  const draft_id = detail.latest_draft!.id;

  await assert.rejects(
    () => call("intake.reject", { intake_id: detail.id, draft_id, comments: [] }),
    /コメントが 1 つ以上/,
  );
  await assert.rejects(
    () =>
      call("intake.reject", {
        intake_id: detail.id,
        draft_id,
        comments: [{ target_kind: "whole", target_id: null, body: "  " }],
      }),
    /コメント 1/,
  );
  assert.equal((await getIntake(ctx.db, detail.id))!.state, "reviewing");
  assert.equal(await count(ctx, "intake_comments"), 0);
  assert.equal((await queuedRuns(ctx, detail.id)).length, 0);
});

test("差し戻しのコメントの対象が案に無ければ拒まれる", async () => {
  const { ctx, call } = await setup();
  const detail = await toReviewing(ctx, call);
  const draft_id = detail.latest_draft!.id;

  await assert.rejects(() =>
    call("intake.reject", {
      intake_id: detail.id,
      draft_id,
      comments: [{ target_kind: "process", target_id: "99", body: "x" }],
    })
  );
  await assert.rejects(() =>
    call("intake.reject", {
      intake_id: detail.id,
      draft_id,
      comments: [{ target_kind: "whole", target_id: "1", body: "x" }],
    })
  );
  assert.equal(await count(ctx, "intake_comments"), 0);
});

test("表示と異なる PFD への承認は拒まれる", async () => {
  const { ctx, call } = await setup();
  const first = await toReviewing(ctx, call);
  await call("intake.reject", {
    intake_id: first.id,
    draft_id: first.latest_draft!.id,
    comments: [{ target_kind: "whole", target_id: null, body: "直して" }],
  });
  await tickUntil(ctx, first.id, "reviewing");
  const second = await call<IntakeDetail>("intake.get", { intake_id: first.id });

  await assert.rejects(
    () =>
      call("intake.approve", {
        intake_id: first.id,
        draft_id: second.latest_draft!.id,
        hash: "0".repeat(64),
      }),
    /異なります/,
  );
  await assert.rejects(
    () =>
      call("intake.approve", {
        intake_id: first.id,
        draft_id: first.latest_draft!.id,
        hash: first.latest_draft!.hash,
      }),
    /最新ではありません/,
  );
  assert.equal((await getIntake(ctx.db, first.id))!.state, "reviewing");
  assert.equal(await count(ctx, "intake_approvals"), 0);
  assert.equal(await count(ctx, "intake_processes"), 0);
});

test("承認するとデーモンの見張りが走り、プロセス 1 だけがタスクになる", async () => {
  const { ctx, events, call } = await setup({ tracker: statefulTracker().tracker });
  const reviewing = await toReviewing(ctx, call);
  await call("intake.approve", {
    intake_id: reviewing.id,
    draft_id: reviewing.latest_draft!.id,
    hash: reviewing.latest_draft!.hash,
  });
  await until(() => ctx.intakeWatcher.idle());

  const tasks = await call<{ intake_process_id: string | null }[]>("task.list");
  assert.deepEqual(tasks.map((t) => t.intake_process_id), ["1"]);
  assert.ok(events.some((e) => e.event === "intake.updated" && e.intake_id === reviewing.id));
  const detail = await call<IntakeDetail>("intake.get", { intake_id: reviewing.id });
  assert.equal(detail.processes.find((p) => p.id === "1")!.state, "running");
});

test("sub-issue が作れないとき、承認は成功し、失敗が intake.get の watch に出る", async () => {
  const { ctx, call } = await setup();
  const reviewing = await toReviewing(ctx, call);
  const approved = await call<IntakeSummary>("intake.approve", {
    intake_id: reviewing.id,
    draft_id: reviewing.latest_draft!.id,
    hash: reviewing.latest_draft!.hash,
  });
  assert.equal(approved.state, "active");
  await until(() => ctx.intakeWatcher.idle());

  const detail = await call<IntakeDetail>("intake.get", { intake_id: reviewing.id });
  assert.equal(detail.watch.consecutiveFailures, 1);
  assert.notEqual(detail.watch.lastError, null);
  assert.deepEqual(await call("task.list"), []);
});

test("reviewing でない Intake は承認できない", async () => {
  const { ctx, call } = await setup();
  const started = await toAnswering(ctx, call);
  await assert.rejects(() =>
    call("intake.approve", { intake_id: started.id, draft_id: 1, hash: "0".repeat(64) })
  );
  assert.equal((await getIntake(ctx.db, started.id))!.state, "answering");
});

test("同じ Issue に進行中の Intake があるとき、開始は新しい Intake を作らない", async () => {
  const tracker = fakeTracker();
  const { ctx, call } = await setup({ tracker });
  const first = await call<IntakeSummary>("intake.start", { project: repo, issue_url: ISSUE });
  const second = await call<IntakeSummary & { alreadyActive: boolean }>("intake.start", {
    project: repo,
    issue_url: ISSUE,
  });
  assert.equal(second.id, first.id);
  assert.equal(second.alreadyActive, true);
  assert.equal((await call<IntakeSummary[]>("intake.list")).length, 1);
  assert.equal((await queuedRuns(ctx, first.id)).length, 1);
  assert.deepEqual(tracker.reads, [ISSUE]);
});

test("中止した Issue はもう一度開始できる", async () => {
  const { ctx, events, call } = await setup();
  const first = await call<IntakeSummary>("intake.start", { project: repo, issue_url: ISSUE });
  const canceled = await call<IntakeSummary>("intake.cancel", {
    intake_id: first.id,
    mode: "leave",
  });
  assert.equal(canceled.state, "canceled");
  const runs = await listIntakeRuns(ctx.db, first.id);
  assert.deepEqual(runs.map((r) => r.status), ["interrupted"]);
  assert.ok(runs[0].ended_at);
  assert.ok(
    events.some((e) =>
      e.event === "intake.stateChanged" && e.intake_id === first.id &&
      e.from === "investigating" && e.to === "canceled"
    ),
  );

  const again = await call<IntakeSummary & { alreadyActive: boolean }>("intake.start", {
    project: repo,
    issue_url: ISSUE,
  });
  assert.equal(again.alreadyActive, false);
  assert.notEqual(again.id, first.id);
  assert.equal((await call<IntakeSummary[]>("intake.list")).length, 1);
  assert.equal(
    (await call<IntakeSummary[]>("intake.list", { include_closed: true })).length,
    2,
  );
});

test("中止は終端から拒まれ、mode が無ければ拒まれる", async () => {
  const { call } = await setup();
  const first = await call<IntakeSummary>("intake.start", { project: repo, issue_url: ISSUE });
  await assert.rejects(() => call("intake.cancel", { intake_id: first.id }));
  await call("intake.cancel", { intake_id: first.id, mode: "stop" });
  await assert.rejects(() => call("intake.cancel", { intake_id: first.id, mode: "leave" }));
});

test("回答の検証に落ちると状態は変わらない", async () => {
  const { ctx, call } = await setup();
  const started = await toAnswering(ctx, call);
  const detail = await call<IntakeDetail>("intake.get", { intake_id: started.id });
  const question_set_id = detail.question_sets[0].id;

  await assert.rejects(
    () => call("intake.answer", { intake_id: started.id, question_set_id, answers: [] }),
    /回答がありません: q1/,
  );
  await assert.rejects(() =>
    call("intake.answer", {
      intake_id: started.id,
      question_set_id,
      answers: [{ questionId: "q1", optionIds: ["zzz"], other: null, note: null }],
    })
  );
  assert.equal((await getIntake(ctx.db, started.id))!.state, "answering");

  await call("intake.answer", { intake_id: started.id, question_set_id, answers: answerQ1 });
  await assert.rejects(() =>
    call("intake.answer", { intake_id: started.id, question_set_id, answers: answerQ1 })
  );
  assert.equal((await getIntake(ctx.db, started.id))!.state, "decomposing");
});

test("github.issues は進行中の Intake に印を付ける", async () => {
  const tracker = fakeTracker({}, {
    issues: [
      { url: ISSUE, number: 1, title: "one", assignees: [], updatedAt: "2026-09-21T00:00:00Z" },
      {
        url: "https://github.com/o/r/issues/2",
        number: 2,
        title: "two",
        assignees: [],
        updatedAt: "2026-09-21T00:00:00Z",
      },
    ],
  });
  const { call } = await setup({ tracker });
  const started = await call<IntakeSummary>("intake.start", { project: repo, issue_url: ISSUE });

  const issues = await call<{ url: string; intake_id: string | null }[]>("github.issues", {
    project: repo,
  });
  assert.deepEqual(issues.map((i) => i.intake_id), [started.id, null]);
  await call("github.issues", { project: repo, assignee: "any", search: "x" });
  assert.deepEqual(tracker.listCalls, [{ assignee: "me" }, { assignee: "any", search: "x" }]);
});

test("gh が使えないとき github.issues は理由を返して失敗する", async () => {
  const tracker = fakeTracker({}, {
    failList: true,
    status: { ok: false, reason: "not_logged_in", message: "gh auth login を" },
  });
  const { call } = await setup({ tracker });
  await assert.rejects(
    () => call("github.issues", { project: repo }),
    /not_logged_in.*gh auth login を/,
  );
});

const MERGED: PrFact = {
  number: 7,
  url: "https://github.com/o/r/pull/7",
  state: "MERGED",
  baseRef: "main",
  mergedAt: "2026-09-21T00:00:00.000Z",
  mergeCommit: "abc",
};

type TaskListItem = {
  id: string;
  branch: string;
  prompt: string;
  state: string;
  intake_process_id: string | null;
  issue_url: string | null;
};

const processOf = (d: IntakeDetail, id: string) => d.processes.find((p) => p.id === id)!;

/** 承認して、見張りの 1 周（sub-issue の作成とプロセス 1 の投入）が終わるまで進める。 */
async function toActive(o: { adapter?: AgentAdapter } = {}) {
  const ft = statefulTracker();
  const pw = fakePrWatcher();
  const s = await setup({ tracker: ft.tracker, prWatcher: pw.prWatcher, adapter: o.adapter });
  const reviewing = await toReviewing(s.ctx, s.call);
  await s.call("intake.approve", {
    intake_id: reviewing.id,
    draft_id: reviewing.latest_draft!.id,
    hash: reviewing.latest_draft!.hash,
  });
  await until(() => s.ctx.intakeWatcher.idle());
  return { ...s, ft, pw, id: reviewing.id };
}

async function tasksOf(call: Call): Promise<TaskListItem[]> {
  return await call<TaskListItem[]>("task.list");
}

test("人のプロセスの完了の記録は、下流のタスクの prompt に載り、sub-issue を completed で閉じる", async () => {
  const { ctx, events, call, ft, pw, id } = await toActive();
  const [first] = await tasksOf(call);
  pw.prs.set(first.branch, [MERGED]);

  const note = "ログイン 1 回を 1 利用と数える";
  const detail = await call<IntakeDetail>("intake.completeHumanProcess", {
    intake_id: id,
    process_id: "3",
    note,
  });

  const three = processOf(detail, "3");
  assert.equal(three.state, "done");
  assert.equal((three as { note: string }).note, note);
  const second = (await tasksOf(call)).find((t) => t.intake_process_id === "2")!;
  assert.ok(second.prompt.includes(`- 集計の定義: ${note}`));
  assert.equal(processOf(detail, "2").state, "running");
  const issue = ft.issues.find((i) => i.ref.url === three.sub_issue_url)!;
  assert.equal(issue.state, "CLOSED");
  assert.equal(issue.closeReason, "completed");
  assert.ok(events.some((e) => e.event === "intake.updated" && e.intake_id === id));
  assert.equal(
    (await listProcesses(ctx.db, id)).find((r) => r.process_id === "3")!.sub_issue_closed,
    1,
  );
});

test("内容の無い完了の記録は拒まれる", async () => {
  const { ctx, call, ft, id } = await toActive();
  for (const note of ["", "  \n", undefined, 123]) {
    await assert.rejects(
      () => call("intake.completeHumanProcess", { intake_id: id, process_id: "3", note }),
      /完了の内容は必須です/,
    );
  }
  const row = (await listProcesses(ctx.db, id)).find((r) => r.process_id === "3")!;
  assert.equal(row.human_done_at, null);
  assert.equal(ft.calls.some((c) => c.op === "closeIssue"), false);
});

test("完了の記録は人のプロセスで、あなたの番のときだけ", async () => {
  const { call, id } = await toActive();
  for (const process_id of ["1", "2"]) {
    await assert.rejects(
      () => call("intake.completeHumanProcess", { intake_id: id, process_id, note: "x" }),
      /人のプロセスではありません/,
    );
  }
  await call("intake.completeHumanProcess", { intake_id: id, process_id: "3", note: "x" });
  await assert.rejects(
    () => call("intake.completeHumanProcess", { intake_id: id, process_id: "3", note: "y" }),
    /すでに完了が記録されています/,
  );
});

test("完了の記録は active でない Intake では拒まれる", async () => {
  const { ctx, call } = await setup();
  const reviewing = await toReviewing(ctx, call);
  await assert.rejects(
    () =>
      call("intake.completeHumanProcess", {
        intake_id: reviewing.id,
        process_id: "3",
        note: "x",
      }),
    /完了を記録できる状態ではありません/,
  );
});

test("要確認のプロセスを再投入すると、新しいタスクが同じプロセスと sub-issue に紐づく", async () => {
  const { call, id } = await toActive();
  const [old] = await tasksOf(call);
  await call("task.cancel", { task_id: old.id });

  const detail = await call<IntakeDetail>("intake.redispatch", {
    intake_id: id,
    process_id: "1",
  });

  const one = processOf(detail, "1");
  assert.equal(one.state, "running");
  const tasks = await tasksOf(call);
  const fresh = tasks.find((t) => t.id !== old.id)!;
  assert.deepEqual(one.task_ids, [old.id, fresh.id]);
  assert.equal(fresh.intake_process_id, "1");
  assert.equal(fresh.issue_url, old.issue_url);
  assert.equal(fresh.issue_url, one.sub_issue_url);
  assert.equal(tasks.find((t) => t.id === old.id)!.state, "canceled");
});

/** 古いタスクに worktree を持たせる（走らせずに、tick が作るのと同じ置き場へ作る）。 */
async function giveWorktree(ctx: DaemonContext, taskId: string, branch: string): Promise<string> {
  const path = await createWorktree({
    repoPath: repo,
    worktreePath: worktreePathFor(repo, taskId),
    branch,
    baseBranch: "main",
  });
  await commitStepBoundary(ctx.db, { taskId, taskPatch: { worktree_path: path } });
  return path;
}

test("再投入すると、置き換えた古いタスクの worktree を消し、タスクの記録は残す", async () => {
  const { ctx, events, call, id } = await toActive();
  const [old] = await tasksOf(call);
  const path = await giveWorktree(ctx, old.id, old.branch);
  await call("task.cancel", { task_id: old.id });

  await call("intake.redispatch", { intake_id: id, process_id: "1" });

  assert.equal(existsSync(path), false);
  const kept = (await getTask(ctx.db, old.id))!;
  assert.equal(kept.state, "canceled");
  assert.equal(kept.worktree_path, null);
  assert.ok(
    events.some((e) =>
      e.event === "task.cleanedUp" && e.task_id === old.id && e.outcome === "removed"
    ),
  );
});

test("置き換えた古いタスクの worktree に未コミットの変更があれば、消さずに警告を残す", async () => {
  const { ctx, call, id } = await toActive();
  const [old] = await tasksOf(call);
  const path = await giveWorktree(ctx, old.id, old.branch);
  await writeFile(join(path, "wip.txt"), "作りかけ\n");
  await call("task.cancel", { task_id: old.id });

  await call("intake.redispatch", { intake_id: id, process_id: "1" });

  assert.equal(existsSync(join(path, "wip.txt")), true);
  assert.equal((await getTask(ctx.db, old.id))!.worktree_path, path);
  assert.ok(ctx.warnings.recent().some((w) => w.message.includes("未コミットの変更")));
  assert.equal((await tasksOf(call)).length, 2, "再投入そのものは成功する");
});

test("要確認でないプロセスは再投入できない", async () => {
  const { call, id } = await toActive();
  await assert.rejects(
    () => call("intake.redispatch", { intake_id: id, process_id: "1" }),
    /要確認のプロセスだけ/,
  );
  assert.equal((await tasksOf(call)).length, 1);
});

test("中止（leave）はタスクと sub-issue をそのままにする", async () => {
  const { call, ft, id } = await toActive();
  const canceled = await call<IntakeSummary>("intake.cancel", { intake_id: id, mode: "leave" });
  assert.equal(canceled.state, "canceled");
  assert.equal((await tasksOf(call))[0].state, "queued");
  assert.ok(ft.issues.length > 0);
  assert.ok(ft.issues.every((i) => i.state === "OPEN"));
  assert.equal(ft.calls.some((c) => c.op === "closeIssue"), false);
});

test("中止（stop）はタスクを止め、sub-issue を取りやめとして閉じる", async () => {
  const { ctx, events, call, ft, id } = await toActive();
  const detail = await call<IntakeDetail>("intake.completeHumanProcess", {
    intake_id: id,
    process_id: "3",
    note: "x",
  });
  const [first] = await tasksOf(call);

  const canceled = await call<IntakeSummary>("intake.cancel", { intake_id: id, mode: "stop" });

  assert.equal(canceled.state, "canceled");
  assert.equal((await tasksOf(call))[0].state, "canceled");
  assert.ok(
    events.some((e) =>
      e.event === "task.stateChanged" && e.task_id === first.id && e.from === "queued" &&
      e.to === "canceled"
    ),
  );
  const issueOf = (processId: string) =>
    ft.issues.find((i) => i.ref.url === processOf(detail, processId).sub_issue_url)!;
  for (const processId of ["1", "2", "4"]) {
    assert.equal(issueOf(processId).state, "CLOSED");
    assert.equal(issueOf(processId).closeReason, "not_planned");
  }
  assert.equal(issueOf("3").state, "CLOSED");
  assert.equal(issueOf("3").closeReason, "completed");
  const rows = (await listProcesses(ctx.db, id)).filter((r) => r.retired_at === null);
  assert.ok(rows.every((r) => r.sub_issue_closed === 1));
});

test("中止（stop）で sub-issue を閉じられなくても中止は成功し、警告に残る", async () => {
  const { ctx, call, ft, id } = await toActive();
  ft.failWhen((c) => c.op === "closeIssue");
  const canceled = await call<IntakeSummary>("intake.cancel", { intake_id: id, mode: "stop" });
  assert.equal(canceled.state, "canceled");
  assert.ok(ctx.warnings.recent().some((w) => /sub-issue を閉じられませんでした/.test(w.message)));
});

test("更新すると見張りの 1 周が回り、マージされた下流を投入する", async () => {
  const { call, pw, id } = await toActive();
  await call("intake.completeHumanProcess", { intake_id: id, process_id: "3", note: "x" });
  const [first] = await tasksOf(call);
  pw.prs.set(first.branch, [MERGED]);
  const before = pw.calls.length;

  const detail = await call<IntakeDetail>("intake.refresh", { intake_id: id });

  assert.equal(processOf(detail, "1").state, "merged");
  assert.equal(processOf(detail, "2").state, "running");
  assert.ok(pw.calls.length > before);
});

test("自動 dispatch を一時停止すると投入されず、再開すると投入される", async () => {
  const { ctx, events, call, pw, id } = await toActive();
  const paused = await call<IntakeSummary>("intake.setDispatchPaused", {
    intake_id: id,
    paused: true,
  });
  assert.equal(paused.dispatch_paused, true);
  const [first] = await tasksOf(call);
  pw.prs.set(first.branch, [MERGED]);

  const detail = await call<IntakeDetail>("intake.completeHumanProcess", {
    intake_id: id,
    process_id: "3",
    note: "x",
  });

  const two = processOf(detail, "2");
  assert.equal(two.state, "ready");
  assert.equal((two as { blockedBy: string | null }).blockedBy, "paused");
  assert.equal((await tasksOf(call)).some((t) => t.intake_process_id === "2"), false);

  const resumed = await call<IntakeSummary>("intake.setDispatchPaused", {
    intake_id: id,
    paused: false,
  });
  assert.equal(resumed.dispatch_paused, false);
  await until(async () => (await tasksOf(call)).some((t) => t.intake_process_id === "2"));
  assert.ok(events.some((e) => e.event === "intake.updated" && e.intake_id === id));
  assert.equal((await getIntake(ctx.db, id))!.dispatch_paused, 0);
});

test("自動 dispatch の切り替えは承認前と終端では拒まれる", async () => {
  const { ctx, call } = await setup();
  const started = await toAnswering(ctx, call);
  await assert.rejects(
    () => call("intake.setDispatchPaused", { intake_id: started.id, paused: true }),
    /切り替えられる状態ではありません/,
  );
  await call("intake.cancel", { intake_id: started.id, mode: "leave" });
  await assert.rejects(
    () => call("intake.setDispatchPaused", { intake_id: started.id, paused: false }),
    /切り替えられる状態ではありません/,
  );
  await assert.rejects(
    () => call("intake.setDispatchPaused", { intake_id: started.id }),
    /paused は必須です/,
  );
});

test("完了した Intake の親 Issue を閉じる", async () => {
  const tracker = fakeTracker();
  const { ctx, call } = await setup({ tracker });
  const started = await call<IntakeSummary>("intake.start", { project: repo, issue_url: ISSUE });
  await updateIntake(ctx.db, started.id, { state: "completed" });

  const closed = await call<IntakeSummary>("intake.closeIssue", { intake_id: started.id });

  assert.deepEqual(tracker.closes, [{ url: ISSUE, reason: "completed" }]);
  assert.equal(closed.state, "completed");
});

test("完了していない Intake の親 Issue は閉じられない", async () => {
  const tracker = fakeTracker();
  const { call } = await setup({ tracker });
  const started = await call<IntakeSummary>("intake.start", { project: repo, issue_url: ISSUE });
  await assert.rejects(
    () => call("intake.closeIssue", { intake_id: started.id }),
    /完了した Intake だけ/,
  );
  assert.deepEqual(tracker.closes, []);
});

test("github.status は tracker の結果を返す", async () => {
  const { call } = await setup();
  assert.deepEqual(await call("github.status", { project: repo }), {
    ok: true,
    repo: { id: "R1", nameWithOwner: "o/r" },
  });
});

test("github.issue は tracker から本文を読む", async () => {
  const tracker = fakeTracker({ title: "T1", body: "本文" });
  const { call } = await setup({ tracker });
  const detail = await call<{ url: string; title: string; body: string }>("github.issue", {
    project: repo,
    url: ISSUE,
  });
  assert.equal(detail.title, "T1");
  assert.equal(detail.body, "本文");
  assert.equal(detail.url, ISSUE);
  assert.deepEqual(tracker.reads, [ISSUE]);
});

test("github.issue は未登録のプロジェクトを拒む", async () => {
  const { call } = await setup();
  await assert.rejects(
    () => call("github.issue", { project: "/not-registered", url: ISSUE }),
    /未登録のプロジェクトです/,
  );
});

test("intake.list は project で絞る", async () => {
  const { call } = await setup();
  const otherRoot = await mkdtemp(join(tmpdir(), "doctrine-intake-rpc-other-"));
  try {
    const other = await makeRepo(otherRoot, {
      "README.md": "y\n",
      ".doctrine/project.yaml": "defaultWorkflow: feature\nmaxConcurrent: 1\nbaseBranch: main\n",
      ".doctrine/workflows/feature.yaml":
        "name: feature\nsteps:\n  - id: review\n    type: approval\n    title: 見て\n",
    });
    await call("project.add", { path: other });
    await call("intake.start", { project: repo, issue_url: ISSUE });
    await call("intake.start", { project: other, issue_url: "https://github.com/o/r/issues/2" });

    assert.equal((await call<IntakeSummary[]>("intake.list")).length, 2);
    assert.equal((await call<IntakeSummary[]>("intake.list", { project: repo })).length, 1);
    assert.deepEqual(await call("intake.list", { project: "/not-registered" }), []);
  } finally {
    await rm(otherRoot, { recursive: true, force: true });
  }
});

test("intake.draft は案 1 件を中身込みで返す", async () => {
  const { ctx, call } = await setup();
  const detail = await toReviewing(ctx, call);

  const draft = await call("intake.draft", {
    intake_id: detail.id,
    draft_id: detail.latest_draft!.id,
  });
  assert.deepEqual(draft, detail.latest_draft);
});

test("intake.draft は別の Intake の案を返さない", async () => {
  const { ctx, call } = await setup();
  const detail = await toReviewing(ctx, call);
  const draft_id = detail.latest_draft!.id;

  await assert.rejects(
    () => call("intake.draft", { intake_id: detail.id, draft_id: draft_id + 1000 }),
    /案がありません/,
  );
  await assert.rejects(() => call("intake.draft", { intake_id: "nope", draft_id }));
});

test("intake.processPrompt は投入と同じ関数で prompt を作る", async () => {
  const { ctx, call } = await setup();
  const detail = await toReviewing(ctx, call);

  const { prompt } = await call<{ prompt: string }>("intake.processPrompt", {
    intake_id: detail.id,
    draft_id: detail.latest_draft!.id,
    process_id: "1",
  });
  assert.ok(prompt.includes(ISSUE));
  assert.ok(prompt.includes("## 目的\n集計結果を置く場所を用意する"));
  assert.ok(!prompt.includes("この作業の sub-issue"));
});

test("intake.processPrompt は人の完了が要るプロセスで失敗する", async () => {
  const { ctx, call } = await setup();
  const detail = await toReviewing(ctx, call);

  await assert.rejects(
    () =>
      call("intake.processPrompt", {
        intake_id: detail.id,
        draft_id: detail.latest_draft!.id,
        process_id: "2",
      }),
    /プロセス 3 の完了が記録されていません/,
  );
});

test("intake.processPrompt は人のプロセスと案に無いプロセスを断る", async () => {
  const { ctx, call } = await setup();
  const detail = await toReviewing(ctx, call);
  const params = { intake_id: detail.id, draft_id: detail.latest_draft!.id };

  await assert.rejects(
    () => call("intake.processPrompt", { ...params, process_id: "3" }),
    /人のプロセス/,
  );
  await assert.rejects(
    () => call("intake.processPrompt", { ...params, process_id: "99" }),
    /案にありません/,
  );
});

const reviseAdapter = () =>
  createMockAdapter({
    result: {},
    sequence: [
      questionsOut([question("q1")]),
      pfdOut(example()),
      pfdOut(revised(), [{ commentId: 1, reply: "分けました" }]),
    ],
  });

const REVISE_COMMENTS = [{ target_kind: "process", target_id: "4", body: "画面を分けて" }];

test("改訂に入ると自動 dispatch が止まり、走っているタスクは止めない", async () => {
  const { ctx, events, call, id } = await toActive({ adapter: reviseAdapter() });

  const revising = await call<IntakeSummary>("intake.revise", {
    intake_id: id,
    comments: REVISE_COMMENTS,
  });

  assert.equal(revising.state, "decomposing");
  assert.equal(revising.revising, true);
  assert.ok(
    events.some((e) =>
      e.event === "intake.stateChanged" && e.intake_id === id && e.from === "active" &&
      e.to === "decomposing" && e.revising === true
    ),
  );
  assert.equal((await tasksOf(call))[0].state, "queued");
  const queued = await queuedRuns(ctx, id);
  assert.deepEqual(queued.map((r) => r.purpose), ["revise"]);
  const intake = (await getIntake(ctx.db, id))!;
  assert.equal(intake.claude_session_id, null);
  assert.equal(intake.revision_run_id, queued[0].id);
});

test("改訂中はマージを検知しても投入されない", async () => {
  const { call, pw, id } = await toActive({ adapter: reviseAdapter() });
  await call("intake.completeHumanProcess", { intake_id: id, process_id: "3", note: "x" });
  const [first] = await tasksOf(call);
  await call("intake.revise", { intake_id: id, comments: REVISE_COMMENTS });
  pw.prs.set(first.branch, [MERGED]);

  const detail = await call<IntakeDetail>("intake.refresh", { intake_id: id });

  assert.equal(processOf(detail, "1").state, "merged");
  const two = processOf(detail, "2");
  assert.equal(two.state, "ready");
  assert.equal((two as { blockedBy: string | null }).blockedBy, "revising");
  assert.equal((await tasksOf(call)).length, 1);
});

test("再承認で sub-issue が整えられ、投入が再開する", async () => {
  const { ctx, call, ft, pw, id } = await toActive({ adapter: reviseAdapter() });
  await call("intake.completeHumanProcess", { intake_id: id, process_id: "3", note: "x" });
  const [first] = await tasksOf(call);
  const before = await call<IntakeDetail>("intake.get", { intake_id: id });
  const subIssue4 = processOf(before, "4").sub_issue_url!;

  await call("intake.revise", { intake_id: id, comments: REVISE_COMMENTS });
  await tickUntil(ctx, id, "reviewing");
  const reviewing = await call<IntakeDetail>("intake.get", { intake_id: id });
  const approved = await call<IntakeSummary>("intake.approve", {
    intake_id: id,
    draft_id: reviewing.latest_draft!.id,
    hash: reviewing.latest_draft!.hash,
  });
  await until(() => ctx.intakeWatcher.idle());

  assert.equal(approved.state, "active");
  assert.equal(approved.revising, false);
  const issue4 = ft.issues.find((i) => i.ref.url === subIssue4)!;
  assert.equal(issue4.state, "CLOSED");
  assert.equal(issue4.closeReason, "not_planned");
  const rows = await listProcesses(ctx.db, id);
  assert.notEqual(rows.find((r) => r.process_id === "4")!.retired_at, null);
  const after = await call<IntakeDetail>("intake.get", { intake_id: id });
  assert.deepEqual(after.processes.map((p) => p.id), ["1", "2", "3", "4b"]);
  assert.notEqual(processOf(after, "4b").sub_issue_url, null);

  pw.prs.set(first.branch, [MERGED]);
  await call("intake.refresh", { intake_id: id });
  assert.ok((await tasksOf(call)).some((t) => t.intake_process_id === "2"));
});

test("改訂をやめると元の承認済みの計画に戻る", async () => {
  const { ctx, call, pw, id } = await toActive({ adapter: reviseAdapter() });
  const before = await call<IntakeDetail>("intake.get", { intake_id: id });
  const [first] = await tasksOf(call);

  await call("intake.revise", { intake_id: id, comments: REVISE_COMMENTS });
  await tickUntil(ctx, id, "reviewing");
  const reviewing = await call<IntakeDetail>("intake.get", { intake_id: id });
  const abandoned = await call<IntakeSummary>("intake.abandonRevision", { intake_id: id });

  assert.equal(abandoned.state, "active");
  assert.equal(abandoned.revising, false);
  const after = await call<IntakeDetail>("intake.get", { intake_id: id });
  assert.equal(after.approval!.draft_id, before.approval!.draft_id);
  assert.deepEqual(after.processes.map((p) => p.id), ["1", "2", "3", "4"]);
  assert.equal((await queuedRuns(ctx, id)).length, 0);
  await assert.rejects(
    () =>
      call("intake.approve", {
        intake_id: id,
        draft_id: reviewing.latest_draft!.id,
        hash: reviewing.latest_draft!.hash,
      }),
    /承認できる状態ではありません/,
  );

  await call("intake.completeHumanProcess", { intake_id: id, process_id: "3", note: "x" });
  pw.prs.set(first.branch, [MERGED]);
  await call("intake.refresh", { intake_id: id });
  assert.ok((await tasksOf(call)).some((t) => t.intake_process_id === "2"));
});

test("分解中に改訂をやめると、立っている実行を閉じる", async () => {
  const { ctx, call, id } = await toActive({ adapter: reviseAdapter() });
  await call("intake.revise", { intake_id: id, comments: REVISE_COMMENTS });

  const abandoned = await call<IntakeSummary>("intake.abandonRevision", { intake_id: id });

  assert.equal(abandoned.state, "active");
  const revise = (await listIntakeRuns(ctx.db, id)).filter((r) => r.purpose === "revise");
  assert.deepEqual(revise.map((r) => r.status), ["interrupted"]);
});

test("改訂の RPC は状態とコメントを確かめる", async () => {
  const { ctx, call } = await setup();
  const reviewing = await toReviewing(ctx, call);
  await assert.rejects(
    () => call("intake.revise", { intake_id: reviewing.id, comments: REVISE_COMMENTS }),
    /改訂に入れる状態ではありません/,
  );

  const { call: activeCall, id } = await toActive({ adapter: reviseAdapter() });
  await assert.rejects(
    () => activeCall("intake.revise", { intake_id: id, comments: [] }),
    /コメントが 1 つ以上必要です/,
  );
  await assert.rejects(
    () =>
      activeCall("intake.revise", {
        intake_id: id,
        comments: [{ target_kind: "process", target_id: "9", body: "x" }],
      }),
    /案に無い対象です/,
  );
  await assert.rejects(
    () => activeCall("intake.abandonRevision", { intake_id: id }),
    /改訂中ではありません/,
  );
});
