import { afterEach, beforeEach, test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/db/migrate.ts";
import { getIntake, listIntakeRuns } from "../../src/db/intakes.ts";
import { createHandler, type DaemonContext, tick } from "../../src/daemon/handlers.ts";
import { createMockAdapter } from "../../src/adapter/mock.ts";
import type { AgentAdapter } from "../../src/adapter/types.ts";
import { createWarningLog } from "../../src/daemon/warnings.ts";
import type { IntakeDetail, IntakeSummary, ServerEvent } from "../../../shared/protocol.ts";
import type { IntakeState } from "../../../shared/intake/state.ts";
import type { PrWatcher, Tracker } from "../../src/github/tracker.ts";
import { createIntakeWatcher } from "../../src/intake/watch.ts";
import { fakeTracker as statefulTracker } from "../helpers/fakeTracker.ts";
import { fakePrWatcher } from "../helpers/prWatcher.ts";
import { makeRepo, until } from "../helpers/repo.ts";
import { fakeTracker } from "../helpers/tracker.ts";
import { pfdOut, question, questionsOut } from "../intake/runnerHelper.ts";
import { example } from "../intake/pfd/fixture.ts";

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
    broadcast: (ev) => events.push(ev),
    warnings: createWarningLog({ broadcast: (ev) => events.push(ev), write: () => {} }),
    loadWorkflow: () => Promise.reject(new Error("この試験では使わない")),
    running: new Set(),
    tracker,
    runningIntakeRuns: new Set(),
    intakeWatcher: createIntakeWatcher({
      db,
      tracker,
      prWatcher: o.prWatcher ?? fakePrWatcher().prWatcher,
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
