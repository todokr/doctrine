import { afterEach, test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyApproval, decide, type EngineDeps, runTask } from "../../src/domain/engine.ts";
import { releaseDueRateLimited, releaseDueWaiting } from "../../src/domain/scheduler.ts";
import type { AgentEvent, AgentResult } from "../../src/adapter/types.ts";
import { parseWorkflow } from "../../src/workflow/schema.ts";
import { DatabaseSync } from "node:sqlite";
import { openDb, openDbOn } from "../../src/db/migrate.ts";
import { getTask, insertProject, insertTask } from "../../src/db/tasks.ts";
import { getStepOutputs, getStepRun, listStepRuns } from "../../src/db/stepRuns.ts";
import { createMockAdapter } from "../../src/adapter/mock.ts";
import type { Db } from "../../src/db/schema.ts";
import { makeRepo, until } from "../helpers/repo.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

const wf = parseWorkflow(`
name: feature
steps:
  - id: implement
    type: agent
    prompt: "{{ task.prompt }}"
  - id: test
    type: command
    run: pnpm test
    onFailure:
      goto: implement
      maxAttempts: 3
      feed: "テストが失敗した:\\n{{ steps.test.last_stderr }}"
  - id: review
    type: approval
    title: "確認してください"
    onReject:
      goto: implement
      maxAttempts: 5
  - id: open-pr
    type: command
    run: gh pr create --fill
`).workflow;

test("成功したら次のステップへ", () => {
  assert.deepEqual(
    decide({ workflow: wf, currentStepId: "implement", outcome: "success", attempts: 1 }),
    { kind: "next", stepId: "test" },
  );
});

test("最後のステップが成功したら completed", () => {
  assert.deepEqual(
    decide({ workflow: wf, currentStepId: "open-pr", outcome: "success", attempts: 1 }),
    { kind: "complete" },
  );
});

test("失敗したら onFailure.goto へ戻り、feed を渡す", () => {
  const d = decide({ workflow: wf, currentStepId: "test", outcome: "failed", attempts: 1 });
  assert.equal(d.kind, "goto");
  assert.equal((d as { stepId: string }).stepId, "implement");
  assert.match((d as { feed: string }).feed, /テストが失敗した/);
});

test("maxAttempts を超えたら failed", () => {
  const d = decide({ workflow: wf, currentStepId: "test", outcome: "failed", attempts: 3 });
  assert.equal(d.kind, "fail");
  assert.match((d as { reason: string }).reason, /maxAttempts/);
});

test("onExhausted: suspend なら maxAttempts を超えても failed にせず escalate", () => {
  const w = parseWorkflow(`
name: f
steps:
  - id: a
    type: command
    run: "true"
  - id: b
    type: command
    run: "false"
    onFailure: { goto: a, maxAttempts: 2, onExhausted: suspend }
`).workflow;
  assert.equal(decide({ workflow: w, currentStepId: "b", outcome: "failed", attempts: 2 }).kind, "escalate");
  assert.equal(decide({ workflow: w, currentStepId: "b", outcome: "failed", attempts: 1 }).kind, "goto");
});

test("onFailure が無いステップの失敗は即 failed", () => {
  const d = decide({ workflow: wf, currentStepId: "open-pr", outcome: "failed", attempts: 1 });
  assert.equal(d.kind, "fail");
});

test("approval ステップに来たら suspend", () => {
  assert.deepEqual(
    decide({ workflow: wf, currentStepId: "review", outcome: "suspended", attempts: 1 }),
    { kind: "suspend" },
  );
});

// --- runTask / applyApproval ---------------------------------------------

async function taskFixture(workflowYaml: string) {
  const root = await mkdtemp(join(tmpdir(), "doctrine-engine-"));
  roots.push(root);
  const db = await openDb(":memory:");
  const pid = await insertProject(db, {
    path: root,
    default_workflow: "f",
    max_concurrent: 1,
    base_branch: "main",
    setup: null,
  });
  await insertTask(db, {
    id: "t1",
    project_id: pid,
    title: "T",
    prompt: "直して",
    workflow_name: "f",
    branch: "doctrine/t1-t",
    priority: 2,
  });
  await db.updateTable("tasks").set({ state: "running", worktree_path: root }).where(
    "id",
    "=",
    "t1",
  ).execute();
  return { db, root, workflow: parseWorkflow(workflowYaml).workflow };
}

/**
 * applyApproval が queued にしたタスクを、スケジューラが拾って running にしたのと
 * 同じ状態にする（本物のスケジューラは別タスクの範囲。ここではテストのために
 * 直接書き換える）。runTask は running のタスクを進める前提なので、
 * queued のまま2回目の runTask を呼ぶのはテストの都合としても不正確。
 */
async function toRunning(db: Db, taskId: string): Promise<void> {
  await db.updateTable("tasks").set({ state: "running" }).where("id", "=", taskId).execute();
}

test("成功する2ステップを通して completed になる", async () => {
  const { db, root, workflow } = await taskFixture(`
name: f
steps:
  - id: a
    type: command
    run: "true"
  - id: b
    type: command
    run: "true"
`);
  await runTask(db, "t1", workflow, {
    db,
    adapter: createMockAdapter({ result: {} }),
    logRoot: join(root, "logs"),
    globalLimit: 4,
  });
  assert.equal((await getTask(db, "t1"))?.state, "completed");
  assert.deepEqual((await listStepRuns(db, "t1")).map((r) => [r.step_id, r.status]), [[
    "a",
    "success",
  ], ["b", "success"]]);
});

const ISSUE_ECHO = `
name: f
steps:
  - id: a
    type: command
    run: "printf '%s|%s|%s' '{{ issue.url }}' '{{ issue.parent_url }}' '{{ issue.closes }}'"
`;

test("command ステップの issue 系統はタスクの issue_url・parent_issue_url から展開される", async () => {
  const { db, root, workflow } = await taskFixture(ISSUE_ECHO);
  // intake_id は入れない（CHECK は issue_url / parent_issue_url に掛からない）。
  await db.updateTable("tasks").set({
    issue_url: "https://github.com/o/r/issues/2",
    parent_issue_url: "https://github.com/o/r/issues/1",
  }).where("id", "=", "t1").execute();
  await runTask(db, "t1", workflow, {
    db,
    adapter: createMockAdapter({ result: {} }),
    logRoot: join(root, "logs"),
    globalLimit: 4,
  });
  assert.equal((await getTask(db, "t1"))?.state, "completed");
  assert.equal(
    (await getStepOutputs(db, "t1")).a.last_stdout.trimEnd(),
    "https://github.com/o/r/issues/2|https://github.com/o/r/issues/1|Closes https://github.com/o/r/issues/2",
  );
});

test("紐づけの無いタスクでは command ステップの issue 系統が空文字になる", async () => {
  const { db, root, workflow } = await taskFixture(ISSUE_ECHO);
  await runTask(db, "t1", workflow, {
    db,
    adapter: createMockAdapter({ result: {} }),
    logRoot: join(root, "logs"),
    globalLimit: 4,
  });
  assert.equal((await getTask(db, "t1"))?.state, "completed");
  assert.equal((await getStepOutputs(db, "t1")).a.last_stdout.trimEnd(), "||");
});

// 元の brief のテストは「テストが失敗したらエージェントに差し戻し、2周目で通る」と
// 銘打ちながら、常に成功するモックと「常に見つからないファイルを見る」コマンドを
// 組み合わせていたため、名前どおりには決して通らず、実際には
// 「3回試して直らなければ failed」という別の主張を検証していた。
// ここでは2つのテストに分け、それぞれの名前が検証する内容と一致するようにする。
// - 「2回目で成功する」: resume されたエージェント呼び出しの副作用として実際に
//   done ファイルを作り、test ステップが2回目で通ることを検証する。
// - 「maxAttempts を使い切ったら failed になる」: コマンドが常に失敗する
//   ワークフローで、規定回数試したあと failed で終わることを検証する。
test("テストが失敗したらエージェントに差し戻し、2回目で成功する", async () => {
  const { db, root, workflow } = await taskFixture(`
name: f
steps:
  - id: implement
    type: agent
    prompt: "{{ task.prompt }}"
  - id: test
    type: command
    run: "test -f {{ worktree.path }}/done"
    onFailure:
      goto: implement
      maxAttempts: 3
      feed: "テストが失敗した:\\n{{ steps.test.last_stderr }}"
`);
  const adapter = createMockAdapter({ result: { ok: true, text: "やった" } });
  // 2回目の resume（差し戻し後の実装）で実際に done ファイルを作る。
  const origResume = adapter.resume;
  adapter.resume = (sessionId, prompt, opts) => {
    // 同期的に書く: resume は AgentRun を同期で返すため、この後すぐ test ステップの
    // コマンドが spawn される。非同期書き込みだと done ファイルの存在がスケジューラ
    // 依存になり、テストの主張（2回目で確実に見つかる）が保証されなくなる。
    writeFileSync(join(root, "done"), "");
    return origResume(sessionId, prompt, opts);
  };

  await runTask(db, "t1", workflow, { db, adapter, logRoot: join(root, "logs"), globalLimit: 4 });

  const runs = await listStepRuns(db, "t1");
  assert.equal(
    runs.filter((r) => r.step_id === "implement").length,
    2,
    "実装ステップへ2回目に戻って成功する",
  );
  assert.equal((await getTask(db, "t1"))?.state, "completed");
});

test("maxAttempts を使い切ったら failed になる", async () => {
  const { db, root, workflow } = await taskFixture(`
name: f
steps:
  - id: implement
    type: agent
    prompt: "{{ task.prompt }}"
  - id: test
    type: command
    run: "false"
    onFailure:
      goto: implement
      maxAttempts: 3
      feed: "テストが失敗した"
`);
  await runTask(db, "t1", workflow, {
    db,
    adapter: createMockAdapter({ result: { ok: true, text: "やった" } }),
    logRoot: join(root, "logs"),
    globalLimit: 4,
  });
  const runs = await listStepRuns(db, "t1");
  assert.equal(
    runs.filter((r) => r.step_id === "test").length,
    3,
    "test ステップは maxAttempts 回まで試す",
  );
  assert.equal((await getTask(db, "t1"))?.state, "failed");
});

// 既定ワークフローの plan-gate（grep で verdict を見るゲート）が reject で非0終了し
// plan に戻る筋書き。ワークフローとしては失敗ではなく差し戻しなので、記録もそう読める
// 必要がある（status は failed ではなく bounced）。
test("onFailure の goto が発火した実行は bounced として閉じ、タスクは失敗しない", async () => {
  const { db, root, workflow } = await taskFixture(`
name: f
steps:
  - id: plan
    type: agent
    prompt: "{{ task.prompt }}"
  - id: plan-gate
    type: command
    run: "test -f {{ worktree.path }}/approved"
    onFailure:
      goto: plan
      maxAttempts: 3
      feed: "指摘があります"
`);
  const adapter = createMockAdapter({ result: { ok: true, text: "計画" } });
  // 差し戻し後の2周目で通るようにする（同期で書く理由は上のテストと同じ）。
  const origResume = adapter.resume;
  adapter.resume = (sessionId, prompt, opts) => {
    writeFileSync(join(root, "approved"), "");
    return origResume(sessionId, prompt, opts);
  };

  await runTask(db, "t1", workflow, { db, adapter, logRoot: join(root, "logs"), globalLimit: 4 });

  const gates = (await listStepRuns(db, "t1")).filter((r) => r.step_id === "plan-gate");
  assert.equal(gates.length, 2);
  assert.equal(gates[0].status, "bounced");
  assert.equal(gates[0].goto_step_id, "plan");
  assert.ok(gates[0].exit_code !== 0, `差し戻しでも終了コードは非0: ${gates[0].exit_code}`);
  assert.equal(gates[1].status, "success", "2周目は通る");
  assert.equal(gates[1].goto_step_id, null);
  assert.equal((await getTask(db, "t1"))?.state, "completed", "差し戻しはタスクの失敗ではない");
});

test("差し戻すたびに bounced 行の attempt が増え、使い切った最後だけ failed になる", async () => {
  const { db, root, workflow } = await taskFixture(`
name: f
steps:
  - id: implement
    type: agent
    prompt: "p"
  - id: test
    type: command
    run: "false"
    onFailure:
      goto: implement
      maxAttempts: 3
      feed: "だめ"
`);
  await runTask(db, "t1", workflow, {
    db,
    adapter: createMockAdapter({ result: { ok: true, text: "やった" } }),
    logRoot: join(root, "logs"),
    globalLimit: 4,
  });

  const tests = (await listStepRuns(db, "t1")).filter((r) => r.step_id === "test");
  assert.deepEqual(tests.map((r) => [r.attempt, r.status, r.goto_step_id]), [
    [1, "bounced", "implement"],
    [2, "bounced", "implement"],
    // 3回目は分岐先が無い（maxAttempts を使い切った）ので本当の失敗。
    [3, "failed", null],
  ]);
  assert.equal((await getTask(db, "t1"))?.state, "failed");
});

test("onFailure の無いステップの失敗は今までどおり failed（分岐先を持たない）", async () => {
  const { db, root, workflow } = await taskFixture(`
name: f
steps:
  - id: build
    type: command
    run: "false"
`);
  await runTask(db, "t1", workflow, {
    db,
    adapter: createMockAdapter({ result: {} }),
    logRoot: join(root, "logs"),
    globalLimit: 4,
  });
  const runs = await listStepRuns(db, "t1");
  assert.deepEqual(runs.map((r) => [r.status, r.goto_step_id]), [["failed", null]]);
  assert.equal((await getTask(db, "t1"))?.state, "failed");
});

test("却下で goto した approval 行は bounced、使い切った却下は failed", async () => {
  const { db, root, workflow } = await taskFixture(`
name: f
steps:
  - id: implement
    type: command
    run: "true"
  - id: review
    type: approval
    title: "見て"
    onReject:
      goto: implement
      maxAttempts: 2
`);
  const deps = {
    db,
    adapter: createMockAdapter({ result: {} }),
    logRoot: join(root, "logs"),
    globalLimit: 4,
  };

  await runTask(db, "t1", workflow, deps);
  await applyApproval(db, "t1", { approved: false, comment: "1回目" }, workflow);
  await toRunning(db, "t1");
  await runTask(db, "t1", workflow, deps);
  await applyApproval(db, "t1", { approved: false, comment: "2回目" }, workflow);

  const reviews = (await listStepRuns(db, "t1")).filter((r) => r.step_id === "review");
  assert.deepEqual(reviews.map((r) => [r.status, r.goto_step_id]), [
    ["bounced", "implement"],
    ["failed", null],
  ]);
  assert.equal((await getTask(db, "t1"))?.state, "failed");
});

test("差し戻しでは resume が使われる（会話が継続する）", async () => {
  const { db, root, workflow } = await taskFixture(`
name: f
steps:
  - id: implement
    type: agent
    prompt: "{{ task.prompt }}"
  - id: test
    type: command
    run: "false"
    onFailure:
      goto: implement
      maxAttempts: 2
      feed: "落ちた"
`);
  const adapter = createMockAdapter({ result: { ok: true, text: "やった" } });
  await runTask(db, "t1", workflow, { db, adapter, logRoot: join(root, "logs"), globalLimit: 4 });
  assert.equal(adapter.calls[0].kind, "start");
  assert.equal(adapter.calls[1].kind, "resume", "やり直しではなく会話の継続");
  assert.equal(adapter.calls[1].prompt, "落ちた");
});

test("2つ目の agent ステップは同じ session id で resume される", async () => {
  const { db, root, workflow } = await taskFixture(`
name: f
steps:
  - id: implement
    type: agent
    prompt: "実装して"
  - id: review
    type: agent
    prompt: "レビューして"
`);
  const adapter = createMockAdapter({ result: { ok: true, text: "done" } });
  await runTask(db, "t1", workflow, { db, adapter, logRoot: join(root, "logs"), globalLimit: 4 });

  assert.equal(adapter.calls.length, 2);
  assert.equal(adapter.calls[0].kind, "start");
  assert.equal(
    adapter.calls[1].kind,
    "resume",
    "同じ session id で2度 start すると、CLI が拒否するか会話が継続しない",
  );
  assert.equal(adapter.calls[1].sessionId, adapter.calls[0].sessionId);
});

test("異なる session を持つ agent ステップは独立した会話になる", async () => {
  const { db, root, workflow } = await taskFixture(`
name: f
steps:
  - id: plan
    type: agent
    session: planner
    prompt: "計画して"
  - id: implement
    type: agent
    session: implementer
    prompt: "実装して"
`);
  const adapter = createMockAdapter({ result: { ok: true, text: "done" } });
  await runTask(db, "t1", workflow, { db, adapter, logRoot: join(root, "logs"), globalLimit: 4 });

  assert.equal(adapter.calls.length, 2);
  assert.equal(adapter.calls[0].kind, "start");
  assert.equal(
    adapter.calls[1].kind,
    "start",
    "role が違うので implementer は自分の会話を持たない",
  );
  assert.notEqual(
    adapter.calls[1].sessionId,
    adapter.calls[0].sessionId,
    "ロールごとに別の session id",
  );
});

test("session ごとに独立した会話が保たれる（別ロールを挟んでも取り違えない）", async () => {
  const { db, root, workflow } = await taskFixture(`
name: f
steps:
  - id: implement
    type: agent
    session: implementer
    prompt: "実装して"
  - id: review
    type: agent
    session: reviewer
    prompt: "レビューして"
  - id: test
    type: command
    run: "false"
    onFailure:
      goto: implement
      maxAttempts: 2
      feed: "指摘があった"
`);
  const adapter = createMockAdapter({ result: { ok: true, text: "done" } });
  await runTask(db, "t1", workflow, { db, adapter, logRoot: join(root, "logs"), globalLimit: 4 });

  // implement(start) -> review(start) -> test(失敗) -> implement(resume) -> review(resume)
  // -> test(失敗、maxAttempts=2 を使い切って failed)
  assert.equal(adapter.calls.length, 4);
  assert.equal(adapter.calls[0].kind, "start");
  assert.equal(adapter.calls[1].kind, "start");
  assert.equal(adapter.calls[2].kind, "resume");
  assert.equal(adapter.calls[3].kind, "resume");
  assert.equal(adapter.calls[2].sessionId, adapter.calls[0].sessionId, "implementer の会話が続く");
  assert.equal(adapter.calls[3].sessionId, adapter.calls[1].sessionId, "reviewer の会話が続く");
  assert.notEqual(
    adapter.calls[0].sessionId,
    adapter.calls[1].sessionId,
    "ロールごとに別の session id",
  );
  assert.equal((await getTask(db, "t1"))?.state, "failed", "maxAttempts を使い切って failed");
});

test("先行する command ステップは session を消費しない（最初の agent は start）", async () => {
  const { db, root, workflow } = await taskFixture(`
name: f
steps:
  - id: prepare
    type: command
    run: "true"
  - id: implement
    type: agent
    prompt: "実装して"
`);
  const adapter = createMockAdapter({ result: { ok: true, text: "done" } });
  await runTask(db, "t1", workflow, { db, adapter, logRoot: join(root, "logs"), globalLimit: 4 });

  assert.equal(adapter.calls.length, 1);
  assert.equal(
    adapter.calls[0].kind,
    "start",
    "project.setup は全ワークフローの先頭に入る。ここで session を使ったことにすると、" +
      "最初の agent が一度も start していない id で resume してしまう",
  );
});

test("command ステップの失敗から agent へ goto しても、最初の agent は start", async () => {
  const { db, root, workflow } = await taskFixture(`
name: f
steps:
  - id: build
    type: command
    run: "false"
    onFailure:
      goto: repair
      maxAttempts: 2
      feed: "壊れた"
  - id: repair
    type: agent
    prompt: "直して"
`);
  const adapter = createMockAdapter({ result: { ok: true, text: "done" } });
  await runTask(db, "t1", workflow, { db, adapter, logRoot: join(root, "logs"), globalLimit: 4 });

  assert.equal(adapter.calls[0].kind, "start", "feed があることは会話が既にあることを意味しない");
});

// --- 利用上限（2026-09-19-rate-limit-wait-design.md） -----------------------

/** 今から min 分後に明ける、飽和した5時間枠のイベント。 */
function saturated(min = 5): AgentEvent {
  return {
    kind: "rateLimit",
    window: "five_hour",
    utilization: 1,
    resetsAt: new Date(Date.now() + min * 60_000).toISOString(),
  };
}

/** 上限で打ち切られた実行（イベントを流して exit 1 で終わる）。 */
const HIT: Partial<AgentResult> = { ok: false, exitCode: 1, text: "", stderrTail: "" };
const OK: Partial<AgentResult> = { ok: true, text: "やった" };

type Events = { onStateChanged: string[]; onStepRunFinished: string[] };

function recorder(): { events: Events; deps: Partial<EngineDeps> } {
  const events: Events = { onStateChanged: [], onStepRunFinished: [] };
  return {
    events,
    deps: {
      onStateChanged: (_id, from, to) => events.onStateChanged.push(`${from} -> ${to}`),
      onStepRunFinished: (_id, _runId, stepId, status) =>
        events.onStepRunFinished.push(`${stepId}:${status}`),
    },
  };
}

const AGENT_ONLY = `
name: f
steps:
  - id: implement
    type: agent
    prompt: "{{ task.prompt }}"
`;

/** 上限を「待たない」と決めたとき、onFailure にやり直させないことを見るためのワークフロー。 */
const AGENT_WITH_RETRY = `
name: f
steps:
  - id: implement
    type: agent
    prompt: "{{ task.prompt }}"
    onFailure:
      goto: implement
      maxAttempts: 3
      feed: "もう一度"
`;

test("上限に当たった agent ステップは失敗ではなく rate_limited として待つ", async () => {
  const { db, root, workflow } = await taskFixture(AGENT_ONLY);
  const hit = saturated();
  const adapter = createMockAdapter({
    eventsSequence: [[hit]],
    result: {},
    sequence: [HIT],
  });
  const { events, deps } = recorder();

  await runTask(db, "t1", workflow, {
    db,
    adapter,
    logRoot: join(root, "logs"),
    globalLimit: 4,
    ...deps,
  });

  const task = (await getTask(db, "t1"))!;
  assert.equal(task.state, "rate_limited");
  assert.equal(task.rate_limited_until, hit.kind === "rateLimit" ? hit.resetsAt : null);
  assert.equal(task.child_pid, null);

  const runs = await listStepRuns(db, "t1");
  assert.deepEqual(runs.map((r) => [r.step_id, r.status, r.attempt]), [[
    "implement",
    "rate_limited",
    1,
  ]]);
  assert.equal(task.attempt_counts, JSON.stringify({ implement: 1 }));
  assert.deepEqual(events.onStateChanged, ["running -> rate_limited"]);
  assert.deepEqual(events.onStepRunFinished, ["implement:rate_limited"]);

  const outputs = await getStepOutputs(db, "t1");
  assert.match(outputs.implement.last_stderr, /利用上限/);

  const samples = await db.selectFrom("rate_limit_samples").selectAll().execute();
  assert.deepEqual(
    samples.map((s) => [s.window, s.utilization]),
    [["five_hour", 1]],
    "記録側は今までどおり（読み取りを足しただけ）",
  );
});

test("期限が来たら queued に戻り、同じ会話を resume してワークフローが完走する", async () => {
  const { db, root, workflow } = await taskFixture(`
name: f
steps:
  - id: plan
    type: agent
    prompt: "計画して"
  - id: implement
    type: agent
    prompt: "実装して"
`);
  // 1回目（plan）は成功、2回目（implement）で上限、3回目は成功。
  const adapter = createMockAdapter({
    eventsSequence: [[], [saturated()]],
    result: {},
    sequence: [OK, HIT, OK],
  });
  const deps = { db, adapter, logRoot: join(root, "logs"), globalLimit: 4 };

  await runTask(db, "t1", workflow, deps);
  const waiting = (await getTask(db, "t1"))!;
  assert.equal(waiting.state, "rate_limited");

  // 期限より前の tick では解放しない。
  assert.deepEqual(
    await releaseDueRateLimited(db, new Date(Date.parse(waiting.rate_limited_until!) - 1000)),
    [],
  );
  assert.equal((await getTask(db, "t1"))?.state, "rate_limited");

  assert.deepEqual(
    await releaseDueRateLimited(db, new Date(Date.parse(waiting.rate_limited_until!) + 1000)),
    ["t1"],
  );
  const released = (await getTask(db, "t1"))!;
  assert.equal(released.state, "queued");
  assert.equal(released.rate_limited_until, null);
  assert.equal(released.resumed, 1, "進行中の仕事として行列の先頭に入る");

  await toRunning(db, "t1");
  await runTask(db, "t1", workflow, deps);

  assert.equal((await getTask(db, "t1"))?.state, "completed");
  assert.equal(adapter.calls[2].kind, "resume", "同じ会話の続き");
  assert.equal(adapter.calls[2].sessionId, adapter.calls[1].sessionId);

  const implement = (await listStepRuns(db, "t1")).filter((r) => r.step_id === "implement");
  assert.deepEqual(implement.map((r) => [r.status, r.attempt]), [["rate_limited", 1], [
    "success",
    1,
  ]], "上限はワークフロー上の試行ではないので attempt は進まない");
  assert.equal(
    implement[0].log_path,
    implement[1].log_path,
    "同じ会話の続きは同じログに追記される",
  );
  assert.equal(
    (await getTask(db, "t1"))?.attempt_counts,
    JSON.stringify({ plan: 1, implement: 1 }),
  );
});

test("最初の呼び出しで上限に当たったら、会話を作り直して start からやり直す", async () => {
  const { db, root, workflow } = await taskFixture(AGENT_ONLY);
  const adapter = createMockAdapter({
    eventsSequence: [[saturated()]],
    result: {},
    sequence: [HIT, OK],
  });
  const deps = { db, adapter, logRoot: join(root, "logs"), globalLimit: 4 };

  await runTask(db, "t1", workflow, deps);
  assert.deepEqual(
    await db.selectFrom("task_sessions").selectAll().execute(),
    [],
    "会話が作られたかは分からないので、記録は取り消す",
  );

  const until = (await getTask(db, "t1"))!.rate_limited_until!;
  await releaseDueRateLimited(db, new Date(Date.parse(until) + 1000));
  await toRunning(db, "t1");
  await runTask(db, "t1", workflow, deps);

  assert.equal((await getTask(db, "t1"))?.state, "completed");
  assert.equal(adapter.calls[1].kind, "start");
  assert.notEqual(adapter.calls[1].sessionId, adapter.calls[0].sessionId, "新しい会話");
});

test("feed 付きで入ったステップで上限に当たっても feed を失わない", async () => {
  const { db, root, workflow } = await taskFixture(`
name: f
steps:
  - id: build
    type: command
    run: "false"
    onFailure:
      goto: repair
      maxAttempts: 2
      feed: "壊れた: {{ steps.build.exitCode }}"
  - id: repair
    type: agent
    prompt: "直して"
`);
  const adapter = createMockAdapter({
    eventsSequence: [[saturated()]],
    result: {},
    sequence: [HIT, OK],
  });
  const deps = { db, adapter, logRoot: join(root, "logs"), globalLimit: 4 };

  await runTask(db, "t1", workflow, deps);
  const waiting = (await getTask(db, "t1"))!;
  assert.equal(waiting.state, "rate_limited");
  assert.equal(waiting.pending_feed, "壊れた: 1");

  await releaseDueRateLimited(db, new Date(Date.parse(waiting.rate_limited_until!) + 1000));
  await toRunning(db, "t1");
  await runTask(db, "t1", workflow, deps);

  assert.equal(adapter.calls[1].prompt, adapter.calls[0].prompt);
  assert.equal(adapter.calls[1].prompt, "壊れた: 1");
  assert.equal((await getTask(db, "t1"))?.pending_feed, null, "消費は一度きり");
});

test("feed 無しのステップで上限に当たっても pending_feed は書かれない", async () => {
  const { db, root, workflow } = await taskFixture(AGENT_ONLY);
  const adapter = createMockAdapter({
    eventsSequence: [[saturated()]],
    result: {},
    sequence: [HIT, OK],
  });
  const deps = { db, adapter, logRoot: join(root, "logs"), globalLimit: 4 };

  await runTask(db, "t1", workflow, deps);
  assert.equal(
    (await getTask(db, "t1"))?.pending_feed,
    null,
    "展開済みの step.prompt を入れると、再開時の入力が DB 由来に変わってしまう",
  );

  const until = (await getTask(db, "t1"))!.rate_limited_until!;
  await releaseDueRateLimited(db, new Date(Date.parse(until) + 1000));
  await toRunning(db, "t1");
  await runTask(db, "t1", workflow, deps);
  assert.equal(adapter.calls[1].prompt, "直して", "再開時に step.prompt がその時点で展開される");
});

test("resetsAt が6時間より先なら、onFailure があっても待たずに failed にする", async () => {
  const { db, root, workflow } = await taskFixture(AGENT_WITH_RETRY);
  const far = saturated(7 * 60);
  const adapter = createMockAdapter({
    eventsSequence: [[far]],
    result: {},
    sequence: [HIT],
  });
  await runTask(db, "t1", workflow, { db, adapter, logRoot: join(root, "logs"), globalLimit: 4 });

  const task = (await getTask(db, "t1"))!;
  assert.equal(task.state, "failed");
  const outputs = await getStepOutputs(db, "t1");
  assert.match(
    outputs.implement.last_stderr,
    new RegExp(far.kind === "rateLimit" ? far.resetsAt! : ""),
    "board 上で普通の失敗と区別が付くように resetsAt を残す",
  );
  assert.equal(
    adapter.calls.length,
    1,
    "閉じていると分かっている枠に対して、onFailure で何度も起動し直さない",
  );
  assert.equal(task.attempt_counts, JSON.stringify({ implement: 1 }));
  assert.deepEqual((await listStepRuns(db, "t1")).map((r) => r.status), ["failed"]);
});

test("同じステップで連続して上限に当たり続けたら failed にする", async () => {
  const { db, root, workflow } = await taskFixture(AGENT_WITH_RETRY);
  // 既に5回連続で上限に当たっている記録を作る（1回ずつ回すと上限の意味が変わらない）。
  await db.updateTable("tasks").set({ attempt_counts: JSON.stringify({ implement: 1 }) })
    .where("id", "=", "t1").execute();
  for (let i = 0; i < 5; i++) {
    await db.insertInto("step_runs").values({
      task_id: "t1",
      step_id: "implement",
      attempt: 1,
      status: "rate_limited",
      exit_code: 1,
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
      log_path: "",
      review_tree: null,
    }).execute();
  }
  const adapter = createMockAdapter({
    eventsSequence: [[saturated()]],
    result: {},
    sequence: [HIT],
  });
  await runTask(db, "t1", workflow, { db, adapter, logRoot: join(root, "logs"), globalLimit: 4 });

  const task = (await getTask(db, "t1"))!;
  assert.equal(task.state, "failed");
  assert.match((await getStepOutputs(db, "t1")).implement.last_stderr, /連続して 5 回/);
  assert.equal(adapter.calls.length, 1, "onFailure でやり直さない");
  assert.equal(
    task.attempt_counts,
    JSON.stringify({ implement: 1 }),
    "上限はワークフロー本来の試行回数を食わない",
  );
});

test("上限と無関係な失敗は今までどおり onFailure の分岐に進む", async () => {
  const { db, root, workflow } = await taskFixture(`
name: f
steps:
  - id: implement
    type: agent
    prompt: "直して"
    onFailure:
      goto: implement
      maxAttempts: 2
      feed: "もう一度"
`);
  // 飽和したサンプルはあるが、この実行が始まる前のもの（別タスクが残した行）。
  await db.insertInto("rate_limit_samples").values({
    observed_at: new Date(Date.now() - 60_000).toISOString(),
    window: "five_hour",
    utilization: 1,
    resets_at: new Date(Date.now() + 60 * 60_000).toISOString(),
  }).execute();
  const adapter = createMockAdapter({ result: {}, sequence: [HIT, HIT] });

  await runTask(db, "t1", workflow, { db, adapter, logRoot: join(root, "logs"), globalLimit: 4 });

  assert.equal((await getTask(db, "t1"))?.state, "failed");
  assert.deepEqual(
    (await listStepRuns(db, "t1")).map((r) => r.status),
    ["bounced", "failed"],
    "実行開始より前に観測された行は根拠にしない（1回目は onFailure で差し戻し、2回目で使い切る）",
  );
  assert.equal(adapter.calls[1].prompt, "もう一度");
});

test("上限のイベントが取れなくても、実行開始以降のサンプルがあれば待つ", async () => {
  const { db, root, workflow } = await taskFixture(AGENT_ONLY);
  const resetsAt = new Date(Date.now() + 10 * 60_000).toISOString();
  const adapter = createMockAdapter({ result: {}, sequence: [HIT] });
  // 実行中に別経路（他タスクの実行）で観測された飽和。イベントは自分には来ていない。
  // 観測時刻は実行開始時刻ちょうどにする（同じミリ秒に落ちても拾えること = 比較が >=）。
  const origStart = adapter.start;
  adapter.start = (prompt, opts) => {
    const run = origStart(prompt, opts);
    db.insertInto("rate_limit_samples").values({
      observed_at: run.startedAt,
      window: "five_hour",
      utilization: 1,
      resets_at: resetsAt,
    }).execute();
    return run;
  };

  await runTask(db, "t1", workflow, { db, adapter, logRoot: join(root, "logs"), globalLimit: 4 });

  const task = (await getTask(db, "t1"))!;
  assert.equal(task.state, "rate_limited");
  assert.equal(task.rate_limited_until, resetsAt);
});

test("command ステップの失敗は上限判定に掛からない", async () => {
  const { db, root, workflow } = await taskFixture(`
name: f
steps:
  - id: build
    type: command
    run: "false"
`);
  await db.insertInto("rate_limit_samples").values({
    observed_at: new Date(Date.now() + 60_000).toISOString(),
    window: "five_hour",
    utilization: 1,
    resets_at: new Date(Date.now() + 60 * 60_000).toISOString(),
  }).execute();

  await runTask(db, "t1", workflow, {
    db,
    adapter: createMockAdapter({ result: {} }),
    logRoot: join(root, "logs"),
    globalLimit: 4,
  });
  assert.equal((await getTask(db, "t1"))?.state, "failed");
});

test("承認待ちの間にワークフローが書き換わり、承認ステップが消えたらエラーになる", async () => {
  const { db, root, workflow } = await taskFixture(`
name: f
steps:
  - id: implement
    type: command
    run: "true"
  - id: review
    type: approval
    title: "見て"
`);
  const adapter = createMockAdapter({ result: {} });
  await runTask(db, "t1", workflow, { db, adapter, logRoot: join(root, "logs"), globalLimit: 4 });
  assert.equal((await getTask(db, "t1"))?.state, "suspended");
  const runsBefore = (await listStepRuns(db, "t1")).length;

  // 承認待ちの間に YAML が書き換えられ、review ステップが消えた状態。
  // handlers は承認のたびにディスクから読み直すので、これが渡ってくる。
  const edited = parseWorkflow(`
name: f
steps:
  - id: implement
    type: command
    run: "true"
`).workflow;

  await assert.rejects(
    () => applyApproval(db, "t1", { approved: true, comment: "" }, edited),
    /review/,
    "見つからないステップ名を名指しして落ちる",
  );
  const t = (await getTask(db, "t1"))!;
  assert.equal(t.state, "suspended", "書き込みは一切起きない");
  assert.equal(t.current_step_id, "review");
  assert.equal(
    (await listStepRuns(db, "t1")).length,
    runsBefore,
    "steps[-1 + 1] は steps[0]。黙って先頭からやり直してはいけない",
  );
});

test("approval に来たら suspended で止まる", async () => {
  const { db, root, workflow } = await taskFixture(`
name: f
steps:
  - id: review
    type: approval
    title: "見て"
  - id: after
    type: command
    run: "true"
`);
  await runTask(db, "t1", workflow, {
    db,
    adapter: createMockAdapter({ result: {} }),
    logRoot: join(root, "logs"),
    globalLimit: 4,
  });
  const t = (await getTask(db, "t1"))!;
  assert.equal(t.state, "suspended");
  assert.equal(t.current_step_id, "review");
});

test("承認すると queued に戻り、行列の先頭に入る", async () => {
  const { db, root, workflow } = await taskFixture(`
name: f
steps:
  - id: review
    type: approval
    title: "見て"
  - id: after
    type: command
    run: "true"
`);
  await runTask(db, "t1", workflow, {
    db,
    adapter: createMockAdapter({ result: {} }),
    logRoot: join(root, "logs"),
    globalLimit: 4,
  });
  await applyApproval(db, "t1", { approved: true, comment: "" }, workflow);
  const t = (await getTask(db, "t1"))!;
  assert.equal(t.state, "queued");
  assert.equal(t.resumed, 1);
  assert.equal(t.current_step_id, "after");
});

test("却下コメントが approval ステップの stdout として保存される", async () => {
  const { db, root, workflow } = await taskFixture(`
name: f
steps:
  - id: implement
    type: agent
    prompt: "p"
  - id: review
    type: approval
    title: "見て"
    onReject:
      goto: implement
      maxAttempts: 3
      feed: "レビューで却下された:\\n{{ steps.review.last_stdout }}"
`);
  await runTask(db, "t1", workflow, {
    db,
    adapter: createMockAdapter({ result: {} }),
    logRoot: join(root, "logs"),
    globalLimit: 4,
  });
  await applyApproval(db, "t1", { approved: false, comment: "命名が変です" }, workflow);
  const t = (await getTask(db, "t1"))!;
  assert.equal(t.state, "queued");
  assert.equal(t.current_step_id, "implement");
  assert.equal((await getStepOutputs(db, "t1")).review.last_stdout, "命名が変です");
});

test("却下の feed が resume するエージェントに実際に渡る（保存されているだけでは足りない）", async () => {
  const { db, root, workflow } = await taskFixture(`
name: f
steps:
  - id: implement
    type: agent
    prompt: "p"
  - id: review
    type: approval
    title: "見て"
    onReject:
      goto: implement
      maxAttempts: 3
      feed: "レビューで却下された:\\n{{ steps.review.last_stdout }}"
`);
  const adapter = createMockAdapter({ result: {} });
  await runTask(db, "t1", workflow, { db, adapter, logRoot: join(root, "logs"), globalLimit: 4 });
  await applyApproval(db, "t1", { approved: false, comment: "命名が変です" }, workflow);

  // 承認待ちの間の runTask 呼び出しは終わっている。ここが新しい runTask 呼び出しで、
  // ローカル変数の pendingFeed は無 — DB の pending_feed から引き継げているかを見る。
  await toRunning(db, "t1"); // スケジューラが queued を拾って running にした想定
  await runTask(db, "t1", workflow, { db, adapter, logRoot: join(root, "logs"), globalLimit: 4 });

  assert.equal(adapter.calls.length, 2);
  assert.equal(adapter.calls[1].kind, "resume", "差し戻し後の実装は会話の継続");
  assert.match(adapter.calls[1].prompt, /レビューで却下された/);
  assert.match(adapter.calls[1].prompt, /命名が変です/);
});

test("onReject.maxAttempts を使い切ったら、goto を続けず failed になる", async () => {
  const { db, root, workflow } = await taskFixture(`
name: f
steps:
  - id: implement
    type: agent
    prompt: "p"
  - id: review
    type: approval
    title: "見て"
    onReject:
      goto: implement
      maxAttempts: 3
      feed: "だめ:\\n{{ steps.review.last_stdout }}"
`);
  const adapter = createMockAdapter({ result: {} });

  await runTask(db, "t1", workflow, { db, adapter, logRoot: join(root, "logs"), globalLimit: 4 });
  await applyApproval(db, "t1", { approved: false, comment: "1回目" }, workflow);
  assert.equal((await getTask(db, "t1"))?.state, "queued", "1回目の却下: まだ goto できる");

  await toRunning(db, "t1");
  await runTask(db, "t1", workflow, { db, adapter, logRoot: join(root, "logs"), globalLimit: 4 });
  await applyApproval(db, "t1", { approved: false, comment: "2回目" }, workflow);
  assert.equal((await getTask(db, "t1"))?.state, "queued", "2回目の却下: まだ goto できる");

  await toRunning(db, "t1");
  await runTask(db, "t1", workflow, { db, adapter, logRoot: join(root, "logs"), globalLimit: 4 });
  await applyApproval(db, "t1", { approved: false, comment: "3回目" }, workflow);
  assert.equal(
    (await getTask(db, "t1"))?.state,
    "failed",
    "3回目の却下: maxAttempts(3) を使い切って failed",
  );
});

test("却下を重ねると review ステップの step_run.attempt が増えていく", async () => {
  const { db, root, workflow } = await taskFixture(`
name: f
steps:
  - id: implement
    type: agent
    prompt: "p"
  - id: review
    type: approval
    title: "見て"
    onReject:
      goto: implement
      maxAttempts: 3
      feed: "だめ"
`);
  const adapter = createMockAdapter({ result: {} });

  await runTask(db, "t1", workflow, { db, adapter, logRoot: join(root, "logs"), globalLimit: 4 });
  await applyApproval(db, "t1", { approved: false, comment: "1回目" }, workflow);
  await toRunning(db, "t1");
  await runTask(db, "t1", workflow, { db, adapter, logRoot: join(root, "logs"), globalLimit: 4 });
  await applyApproval(db, "t1", { approved: false, comment: "2回目" }, workflow);

  const reviewRuns = (await listStepRuns(db, "t1")).filter((r) => r.step_id === "review");
  assert.equal(reviewRuns.length, 2);
  assert.ok(
    reviewRuns[0].attempt < reviewRuns[1].attempt,
    `attempt は増えていくはず: ${reviewRuns.map((r) => r.attempt)}`,
  );
});

test("消費した feed は次のステップに漏れない", async () => {
  const { db, root, workflow } = await taskFixture(`
name: f
steps:
  - id: implement
    type: agent
    prompt: "p"
  - id: review
    type: approval
    title: "見て"
    onReject:
      goto: implement
      maxAttempts: 3
      feed: "却下されたコメント固有文字列XYZ"
  - id: after
    type: command
    run: "true"
`);
  const adapter = createMockAdapter({ result: {} });
  await runTask(db, "t1", workflow, { db, adapter, logRoot: join(root, "logs"), globalLimit: 4 });
  await applyApproval(db, "t1", { approved: false, comment: "だめ" }, workflow);
  // ここで pending_feed が立っているはず
  assert.notEqual((await getTask(db, "t1"))?.pending_feed, null);

  // 差し戻し後、implement が resume で feed を受け取り、review へ再度到達して承認する
  await toRunning(db, "t1");
  await runTask(db, "t1", workflow, { db, adapter, logRoot: join(root, "logs"), globalLimit: 4 });
  await applyApproval(db, "t1", { approved: true, comment: "" }, workflow);
  assert.equal((await getTask(db, "t1"))?.pending_feed, null, "消費した feed は残らない");

  // after ステップまで進む runTask 呼び出し。ここでの implement 呼び出しは
  // もう無い（after は command ステップ）ので、代わりに直近の agent 呼び出し
  // （差し戻し直後の resume）にだけ feed 文字列が含まれていたことを確認する。
  await toRunning(db, "t1");
  await runTask(db, "t1", workflow, { db, adapter, logRoot: join(root, "logs"), globalLimit: 4 });
  assert.equal((await getTask(db, "t1"))?.state, "completed");

  const feedCalls = adapter.calls.filter((c) => c.prompt.includes("XYZ"));
  assert.equal(feedCalls.length, 1, "feed を含む呼び出しは差し戻し直後の1回だけ");
});

// states.ts の TRANSITIONS には suspended -> completed を追加済み（round 1 対応）。
// 承認された approval ステップが最後のステップのとき、queued を経由させず直接
// completed にする（待つ理由が無いのに一瞬枠を再取得させないため）。
test("承認ステップが最後のとき、承認すると completed になる", async () => {
  const { db, root, workflow } = await taskFixture(`
name: f
steps:
  - id: review
    type: approval
    title: "見て"
`);
  await runTask(db, "t1", workflow, {
    db,
    adapter: createMockAdapter({ result: {} }),
    logRoot: join(root, "logs"),
    globalLimit: 4,
  });
  await applyApproval(db, "t1", { approved: true, comment: "" }, workflow);
  assert.equal((await getTask(db, "t1"))?.state, "completed");
});

test("ステップ開始時に running の step_run 行が立ち、コールバックへ実IDが渡る", async () => {
  const { db, root, workflow } = await taskFixture(`
name: f
steps:
  - id: a
    type: command
    run: "true"
`);
  const started: { id: number; status: Promise<string> }[] = [];
  const finished: { id: number; stepId: string; status: string }[] = [];
  await runTask(db, "t1", workflow, {
    db,
    adapter: createMockAdapter({ result: {} }),
    logRoot: join(root, "logs"),
    globalLimit: 4,
    onStepRunStarted: (_taskId, stepRunId, stepId, attempt) => {
      // コールバックの時点でDBに running の行が実在することを確認する
      // （クラッシュ復帰は running のまま止まっている行を目印にする）。
      // コールバックは同期なので、ここで発行した読み取りを後で待つ。読み取りは
      // ステップ終了のコミットより先に接続を取るので、この時点の行が見える。
      started.push({ id: stepRunId, status: getStepRun(db, stepRunId).then((r) => r!.status) });
      assert.equal(stepId, "a");
      assert.equal(attempt, 1);
    },
    onStepRunFinished: (_taskId, stepRunId, stepId, status) => {
      finished.push({ id: stepRunId, stepId, status });
    },
  });
  assert.equal(started.length, 1);
  assert.ok(started[0].id > 0, "step_run_id はプレースホルダーの0ではなく実在の行id");
  assert.equal(await started[0].status, "running");
  assert.deepEqual(finished, [{ id: started[0].id, stepId: "a", status: "success" }]);
});

test("onStepRunFinished は記録した status と戻り先・試行回数を渡す", async () => {
  const { db, root, workflow } = await taskFixture(`
name: f
steps:
  - id: implement
    type: agent
    prompt: "p"
  - id: test
    type: command
    run: "false"
    onFailure:
      goto: implement
      maxAttempts: 2
      feed: "だめ"
`);
  const finished: { stepId: string; status: string; goto: string | null; attempt: number }[] = [];
  await runTask(db, "t1", workflow, {
    db,
    adapter: createMockAdapter({ result: { ok: true, text: "やった" } }),
    logRoot: join(root, "logs"),
    globalLimit: 4,
    onStepRunFinished: (_taskId, _stepRunId, stepId, status, gotoStepId, attempt) => {
      finished.push({ stepId, status, goto: gotoStepId, attempt });
    },
  });
  assert.deepEqual(finished.filter((f) => f.stepId === "test"), [
    { stepId: "test", status: "bounced", goto: "implement", attempt: 1 },
    { stepId: "test", status: "failed", goto: null, attempt: 2 },
  ]);
});

test("onReject が無い却下は failed", async () => {
  const { db, root, workflow } = await taskFixture(`
name: f
steps:
  - id: review
    type: approval
    title: "見て"
`);
  await runTask(db, "t1", workflow, {
    db,
    adapter: createMockAdapter({ result: {} }),
    logRoot: join(root, "logs"),
    globalLimit: 4,
  });
  await applyApproval(db, "t1", { approved: false, comment: "だめ" }, workflow);
  assert.equal((await getTask(db, "t1"))?.state, "failed");
});

test("承認待ちでないタスクに applyApproval を呼ぶと例外を投げ、何も書き込まない", async () => {
  const { db, workflow } = await taskFixture(`
name: f
steps:
  - id: review
    type: approval
    title: "見て"
`);
  // taskFixture は state='running' のまま（runTask を呼んでいないので suspended になっていない）。
  const before = (await getTask(db, "t1"))!;
  assert.equal(before.state, "running");

  await assert.rejects(() => applyApproval(db, "t1", { approved: true, comment: "" }, workflow));

  const after = (await getTask(db, "t1"))!;
  assert.deepEqual(
    after,
    before,
    "例外を投げた呼び出しは taskPatch/step_run/outputs のどれも書き込まない",
  );
});

/**
 * ループ先頭の「running か」の読み取りとステップ開始のコミットの間には await がある。
 * その隙に task.cancel が canceled を書いても、ステップを始めてはいけない
 * （放棄したはずの worktree でエージェントが走り出す）。レースなので普通のテストでは
 * 再現しないため、読み取りの直後のクエリに cancel を差し込んで窓を固定する。
 *
 * ステップ開始コミットの requireState: "running" を外すとこのテストは落ちることを
 * 確認済み。差し込み先のクエリが変わると窓を外して素通りし得るので、
 * `injected` の検査を消さないこと。
 */
test("状態を読んだ直後に cancel が届いても、runTask はステップを始めず何も書かない", async () => {
  const root = await mkdtemp(join(tmpdir(), "doctrine-engine-"));
  roots.push(root);
  const sqlite = new DatabaseSync(":memory:");
  const db = await openDbOn(sqlite);
  const pid = await insertProject(db, {
    path: root,
    default_workflow: "f",
    max_concurrent: 1,
    base_branch: "main",
    setup: null,
  });
  await insertTask(db, {
    id: "t1",
    project_id: pid,
    title: "T",
    prompt: "p",
    workflow_name: "f",
    branch: "b",
    priority: 2,
  });
  await db.updateTable("tasks").set({ state: "running", worktree_path: root }).where(
    "id",
    "=",
    "t1",
  ).execute();
  const workflow = parseWorkflow(`
name: f
steps:
  - id: a
    type: agent
    prompt: "p"
`).workflow;

  // runTask はループ先頭で running を読んだ後、テンプレートの文脈を作るために
  // プロジェクトを読む。その瞬間に別の経路（task.cancel）が canceled を書いたことにする。
  const prepare = sqlite.prepare.bind(sqlite);
  let injected = false;
  sqlite.prepare = ((sql: string) => {
    if (!injected && sql.startsWith('select * from "projects"')) {
      injected = true;
      prepare("UPDATE tasks SET state = 'canceled' WHERE id = 't1'").run();
    }
    return prepare(sql);
  }) as typeof prepare;

  const adapter = createMockAdapter({ result: {} });
  await runTask(db, "t1", workflow, { db, adapter, logRoot: join(root, "logs"), globalLimit: 4 });

  assert.ok(injected, "窓に cancel を差し込めていない（テストの前提が崩れている）");
  assert.equal(adapter.calls.length, 0, "cancel 後にエージェントを起動してはいけない");
  assert.deepEqual(await listStepRuns(db, "t1"), [], "cancel 後に step_runs 行を立ててはいけない");
  const t = (await getTask(db, "t1"))!;
  assert.equal(t.state, "canceled");
  assert.equal(t.current_step_id, null, "ステップ開始のコミットは丸ごと書かれない");
  assert.equal(t.attempt_counts, "{}");
});

/**
 * approval 分岐は今回 step_runs を書くようになった上に、書く前に captureTree の
 * 実I/O（git サブプロセス）が挟まるので、非 approval の分岐より「読んでから書くまで」
 * の窓が広い。上の「状態を読んだ直後に cancel が届いても…」と同じやり方（sqlite の
 * クエリに割り込む）は使えない — captureTree は DB へは触らず git を spawn するだけ
 * なので、割り込む先が無い。代わりに Deno.Command を差し替えて、captureTree が
 * 最初の git を spawn する瞬間に cancel を書き込む。
 */
test("captureTree が走っている間に cancel が届いても、awaiting の行を立てない", async () => {
  const root = await mkdtemp(join(tmpdir(), "doctrine-engine-"));
  roots.push(root);
  const repo = await makeRepo(root, { "a.txt": "1\n" }); // captureTree が本物の git を叩けるようにする
  const sqlite = new DatabaseSync(":memory:");
  const db = await openDbOn(sqlite);
  const pid = await insertProject(db, {
    path: repo,
    default_workflow: "f",
    max_concurrent: 1,
    base_branch: "main",
    setup: null,
  });
  await insertTask(db, {
    id: "t1",
    project_id: pid,
    title: "T",
    prompt: "p",
    workflow_name: "f",
    branch: "b",
    priority: 2,
  });
  await db.updateTable("tasks").set({ state: "running", worktree_path: repo }).where(
    "id",
    "=",
    "t1",
  ).execute();
  const workflow = parseWorkflow(`
name: f
steps:
  - id: review
    type: approval
    title: "見て"
`).workflow;

  const OriginalCommand = Deno.Command;
  let injected = false;
  // captureTree が最初に spawn する git（"add -A"）を捉えた瞬間、別の経路
  // （task.cancel）が canceled を書いたことにする。生成した Command 自体は
  // 本物に委ねる（git は実際に走らせ、captureTree の I/O をそのまま踏ませる）。
  Deno.Command = function (
    this: unknown,
    cmd: string | URL,
    options?: Deno.CommandOptions,
  ) {
    if (!injected && cmd === "git") {
      injected = true;
      sqlite.prepare("UPDATE tasks SET state = 'canceled' WHERE id = 't1'").run();
    }
    return new OriginalCommand(cmd, options);
  } as unknown as typeof Deno.Command;

  try {
    const adapter = createMockAdapter({ result: {} });
    await runTask(db, "t1", workflow, { db, adapter, logRoot: join(root, "logs"), globalLimit: 4 });
  } finally {
    Deno.Command = OriginalCommand;
  }

  assert.ok(injected, "窓に cancel を差し込めていない（テストの前提が崩れている）");
  assert.deepEqual(await listStepRuns(db, "t1"), [], "cancel 後に awaiting の行を立ててはいけない");
  const t = (await getTask(db, "t1"))!;
  assert.equal(t.state, "canceled");
  assert.equal(t.attempt_counts, "{}", "attempt を進めるコミットは丸ごと書かれない");
});

test("suspended に入った時点で awaiting の行が立ち、待ち始めた時刻が残る", async () => {
  const { db, root, workflow } = await taskFixture(`
name: f
steps:
  - id: review
    type: approval
    title: "見て"
`);
  await runTask(db, "t1", workflow, {
    db,
    adapter: createMockAdapter({ result: {} }),
    logRoot: join(root, "logs"),
    globalLimit: 4,
  });

  const runs = await listStepRuns(db, "t1");
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "awaiting");
  assert.equal(runs[0].step_id, "review");
  assert.equal(runs[0].attempt, 1);
  assert.equal(runs[0].ended_at, null);
  assert.ok(Date.parse(runs[0].started_at) > 0);
  // attempt の確定は待ち始めた時点へ移った。
  assert.equal((await getTask(db, "t1"))!.attempt_counts, JSON.stringify({ review: 1 }));
});

test("承認は awaiting の行を閉じる（新しい行を足さない）", async () => {
  const { db, root, workflow } = await taskFixture(`
name: f
steps:
  - id: review
    type: approval
    title: "見て"
  - id: after
    type: command
    run: "true"
`);
  await runTask(db, "t1", workflow, {
    db,
    adapter: createMockAdapter({ result: {} }),
    logRoot: join(root, "logs"),
    globalLimit: 4,
  });
  const started = (await listStepRuns(db, "t1"))[0];

  await applyApproval(db, "t1", { approved: true, comment: "" }, workflow);

  const runs = await listStepRuns(db, "t1");
  assert.equal(runs.length, 1);
  assert.equal(runs[0].id, started.id);
  assert.equal(runs[0].status, "success");
  assert.equal(runs[0].exit_code, 0);
  assert.equal(runs[0].started_at, started.started_at);
  assert.ok(runs[0].ended_at !== null);
});

test("2回差し戻すと、両方のコメントと待ち時間が残る", async () => {
  const { db, root, workflow } = await taskFixture(`
name: f
steps:
  - id: implement
    type: command
    run: "true"
  - id: review
    type: approval
    title: "見て"
    onReject:
      goto: implement
      maxAttempts: 5
`);
  const deps = {
    db,
    adapter: createMockAdapter({ result: {} }),
    logRoot: join(root, "logs"),
    globalLimit: 4,
  };

  await runTask(db, "t1", workflow, deps);
  await applyApproval(db, "t1", { approved: false, comment: "1回目の指摘" }, workflow);
  await toRunning(db, "t1");
  await runTask(db, "t1", workflow, deps);
  await applyApproval(db, "t1", { approved: false, comment: "2回目の指摘" }, workflow);

  const reviews = (await listStepRuns(db, "t1")).filter((r) => r.step_id === "review");
  assert.equal(reviews.length, 2);
  assert.deepEqual(reviews.map((r) => r.attempt), [1, 2]);
  // どちらも差し戻し（maxAttempts 5 をまだ使い切っていない）。
  assert.deepEqual(reviews.map((r) => r.status), ["bounced", "bounced"]);
  assert.deepEqual(reviews.map((r) => r.goto_step_id), ["implement", "implement"]);
  // それぞれの待ち時間が引ける（started_at と ended_at が両方ある）。
  for (const r of reviews) {
    assert.ok(r.ended_at !== null);
    assert.ok(Date.parse(r.ended_at!) >= Date.parse(r.started_at));
  }
  // 1回目の待ちは2回目より先に始まっている。
  assert.ok(Date.parse(reviews[0].started_at) <= Date.parse(reviews[1].started_at));

  const outputs = await db.selectFrom("step_outputs").selectAll()
    .orderBy("step_run_id").execute();
  assert.deepEqual(
    outputs.filter((o) => reviews.some((r) => r.id === o.step_run_id)).map((o) => o.last_stdout),
    ["1回目の指摘", "2回目の指摘"],
  );
  // テンプレート変数は今までどおり最新の実行を指す。
  assert.equal((await getStepOutputs(db, "t1")).review.last_stdout, "2回目の指摘");
});

test("ツリーを記録できなくても suspended に入り、警告が出る", async () => {
  const { db, root, workflow } = await taskFixture(`
name: f
steps:
  - id: review
    type: approval
    title: "見て"
`);
  const warnings: string[] = [];
  await runTask(db, "t1", workflow, {
    db,
    adapter: createMockAdapter({ result: {} }),
    logRoot: join(root, "logs"),
    globalLimit: 4,
    onWarning: (_id, message) => warnings.push(message),
  });

  assert.equal((await getTask(db, "t1"))!.state, "suspended");
  assert.equal((await listStepRuns(db, "t1"))[0].review_tree, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /ツリー/);
});

test("awaiting の行が無ければ承認は失敗する", async () => {
  const { db, root, workflow } = await taskFixture(`
name: f
steps:
  - id: review
    type: approval
    title: "見て"
`);
  await runTask(db, "t1", workflow, {
    db,
    adapter: createMockAdapter({ result: {} }),
    logRoot: join(root, "logs"),
    globalLimit: 4,
  });
  await db.deleteFrom("step_runs").where("task_id", "=", "t1").execute();

  await assert.rejects(
    () => applyApproval(db, "t1", { approved: true, comment: "" }, workflow),
    /承認待ちのステップ実行がありません/,
  );
});

// --- 外から止められた実行（task.pause / task.cancel が先に状態を書いた） ------------

/** SIGTERM で止められた子（143 で終わる）。 */
const TERMINATED: Partial<AgentResult> = { ok: false, exitCode: 143, text: "" };

const AGENT_THEN_COMMAND = `${AGENT_ONLY}  - id: after
    type: command
    run: "true"
`;

/**
 * running の行が立つのを待ち、タスクの状態を書き換えてから runTask の終了を待つ。
 * ps を通さずに「ハンドラが先に状態を書いた」状況を作る。
 */
async function stopMidFlight(
  db: Db,
  run: Promise<void>,
  state: "paused" | "canceled",
): Promise<void> {
  await until(async () => (await listStepRuns(db, "t1")).some((r) => r.status === "running"));
  await db.updateTable("tasks").set({ state }).where("id", "=", "t1").execute();
  await run;
}

test("実行中に paused になったら、SIGTERM で失敗した実行は failed ではなく interrupted で閉じる", async () => {
  const { db, root, workflow } = await taskFixture(AGENT_THEN_COMMAND);
  const adapter = createMockAdapter({ result: TERMINATED, delayMs: 200 });
  const { events, deps } = recorder();

  const done = runTask(db, "t1", workflow, {
    db,
    adapter,
    logRoot: join(root, "logs"),
    globalLimit: 4,
    ...deps,
  });
  await stopMidFlight(db, done, "paused");

  const runs = await listStepRuns(db, "t1");
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "interrupted");
  assert.notEqual(runs[0].ended_at, null);
  assert.equal(runs[0].exit_code, 143);
  assert.equal(runs[0].goto_step_id, null);

  const task = (await getTask(db, "t1"))!;
  assert.equal(task.state, "paused");
  assert.equal(task.current_step_id, "implement");
  assert.equal(adapter.calls.length, 1);
  assert.deepEqual(events.onStepRunFinished, ["implement:interrupted"]);
  assert.deepEqual(events.onStateChanged, []);
});

test("onFailure のあるステップを止めても、差し戻し（bounced）とは記録しない", async () => {
  const { db, root, workflow } = await taskFixture(AGENT_WITH_RETRY);
  const adapter = createMockAdapter({ result: TERMINATED, delayMs: 200 });
  const { events, deps } = recorder();

  const done = runTask(db, "t1", workflow, {
    db,
    adapter,
    logRoot: join(root, "logs"),
    globalLimit: 4,
    ...deps,
  });
  await stopMidFlight(db, done, "paused");

  const runs = await listStepRuns(db, "t1");
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "interrupted");
  assert.equal(runs[0].goto_step_id, null);
  assert.equal(adapter.calls.length, 1);
  const task = (await getTask(db, "t1"))!;
  assert.equal(task.state, "paused");
  assert.equal(task.pending_feed, null);
  assert.deepEqual(events.onStepRunFinished, ["implement:interrupted"]);
});

test("実行中に canceled になっても interrupted で閉じ、タスクは canceled のまま", async () => {
  const { db, root, workflow } = await taskFixture(AGENT_ONLY);
  const adapter = createMockAdapter({ result: TERMINATED, delayMs: 200 });

  const done = runTask(db, "t1", workflow, {
    db,
    adapter,
    logRoot: join(root, "logs"),
    globalLimit: 4,
  });
  await stopMidFlight(db, done, "canceled");

  const runs = await listStepRuns(db, "t1");
  assert.deepEqual(runs.map((r) => r.status), ["interrupted"]);
  assert.equal((await getTask(db, "t1"))!.state, "canceled");
});

test("止めた直後に成功で返った実行も interrupted で閉じ、次のステップへ進まない", async () => {
  const { db, root, workflow } = await taskFixture(AGENT_THEN_COMMAND);
  const adapter = createMockAdapter({ result: { ok: true, text: "done" }, delayMs: 200 });

  const done = runTask(db, "t1", workflow, {
    db,
    adapter,
    logRoot: join(root, "logs"),
    globalLimit: 4,
  });
  await stopMidFlight(db, done, "paused");

  const runs = await listStepRuns(db, "t1");
  assert.deepEqual(runs.map((r) => r.status), ["interrupted"]);
  const task = (await getTask(db, "t1"))!;
  assert.equal(task.state, "paused");
  assert.equal(task.current_step_id, "implement");
});

test("上限待ちに入るはずだった実行を止めても、行を running のまま残さない", async () => {
  const { db, root, workflow } = await taskFixture(AGENT_ONLY);
  const adapter = createMockAdapter({
    eventsSequence: [[saturated()]],
    result: {},
    sequence: [HIT],
    delayMs: 200,
  });
  const { events, deps } = recorder();

  const done = runTask(db, "t1", workflow, {
    db,
    adapter,
    logRoot: join(root, "logs"),
    globalLimit: 4,
    ...deps,
  });
  await stopMidFlight(db, done, "paused");

  const runs = await listStepRuns(db, "t1");
  assert.deepEqual(runs.map((r) => r.status), ["interrupted"]);
  const task = (await getTask(db, "t1"))!;
  assert.equal(task.state, "paused");
  assert.equal(task.rate_limited_until, null);
  assert.deepEqual(events.onStepRunFinished, ["implement:interrupted"]);
});

// --- poll ステップ ---------------------------------------------------------

const POLL_WF = `
name: f
steps:
  - id: wait
    type: poll
    run: "exit $(cat verdict)"
    interval: 30s
  - id: after
    type: command
    run: "true"
`;

test("poll が 75 なら waiting で待ち、期限で戻ると同じ行を使い直して attempt を進めない", async () => {
  const { db, root, workflow } = await taskFixture(POLL_WF);
  const deps = { db, adapter: createMockAdapter({ result: {} }), logRoot: join(root, "logs"), globalLimit: 4 };
  writeFileSync(join(root, "verdict"), "75");

  await runTask(db, "t1", workflow, deps);
  const waiting = (await getTask(db, "t1"))!;
  assert.equal(waiting.state, "waiting");
  assert.ok(Date.parse(waiting.waiting_until!) - Date.now() > 25_000, "interval ぶん先");

  // 2周目も「まだ」
  assert.deepEqual(await releaseDueWaiting(db, new Date(Date.parse(waiting.waiting_until!) + 1)), ["t1"]);
  await toRunning(db, "t1");
  await runTask(db, "t1", workflow, deps);
  assert.equal((await getTask(db, "t1"))?.state, "waiting");

  // 3周目でマージされた
  writeFileSync(join(root, "verdict"), "0");
  await releaseDueWaiting(db, new Date(Date.now() + 60_000));
  await toRunning(db, "t1");
  await runTask(db, "t1", workflow, deps);

  const t = (await getTask(db, "t1"))!;
  assert.equal(t.state, "completed");
  const runs = (await listStepRuns(db, "t1")).filter((r) => r.step_id === "wait");
  assert.deepEqual(runs.map((r) => [r.status, r.attempt]), [["success", 1]], "待ちの1周は1行");
  assert.equal(JSON.parse(t.attempt_counts).wait, 1);
});

test("poll が 2 なら分岐せずに canceled になり、行は interrupted で閉じる", async () => {
  const { db, root, workflow } = await taskFixture(POLL_WF);
  writeFileSync(join(root, "verdict"), "2");
  await runTask(db, "t1", workflow, {
    db,
    adapter: createMockAdapter({ result: {} }),
    logRoot: join(root, "logs"),
    globalLimit: 4,
  });
  assert.equal((await getTask(db, "t1"))?.state, "canceled");
  assert.deepEqual((await listStepRuns(db, "t1")).map((r) => r.status), ["interrupted"]);
});

test("poll がそれ以外で落ちたら onFailure へ差し戻す", async () => {
  const { db, root, workflow } = await taskFixture(`
name: f
steps:
  - id: fix
    type: command
    run: "echo 0 > verdict"
  - id: wait
    type: poll
    run: "exit $(cat verdict)"
    onFailure: { goto: fix, maxAttempts: 3 }
`);
  writeFileSync(join(root, "verdict"), "1");
  // wait から始め、1回目は落ちて fix へ戻る。fix が verdict を 0 にするので2回目は通る
  await db.updateTable("tasks").set({ current_step_id: "wait" }).where("id", "=", "t1").execute();
  await runTask(db, "t1", workflow, {
    db,
    adapter: createMockAdapter({ result: {} }),
    logRoot: join(root, "logs"),
    globalLimit: 4,
  });
  assert.equal((await getTask(db, "t1"))?.state, "completed");
  assert.deepEqual(
    (await listStepRuns(db, "t1")).map((r) => [r.step_id, r.status]),
    [["wait", "bounced"], ["fix", "success"], ["wait", "success"]],
  );
});

test("poll が 75 で waiting に入るはずだった実行を止めても、行は running のまま残らず interrupted で閉じる", async () => {
  const { db, root, workflow } = await taskFixture(`
name: f
steps:
  - id: wait
    type: poll
    run: "sleep 0.2; exit $(cat verdict)"
    interval: 30s
`);
  writeFileSync(join(root, "verdict"), "75");
  const { events, deps } = recorder();

  const done = runTask(db, "t1", workflow, {
    db,
    adapter: createMockAdapter({ result: {} }),
    logRoot: join(root, "logs"),
    globalLimit: 4,
    ...deps,
  });
  await stopMidFlight(db, done, "paused");

  const runs = await listStepRuns(db, "t1");
  assert.deepEqual(runs.map((r) => r.status), ["interrupted"]);
  const task = (await getTask(db, "t1"))!;
  assert.equal(task.state, "paused");
  assert.equal(task.waiting_until, null, "waiting へは書き換わっていない");
  assert.deepEqual(events.onStepRunFinished, ["wait:interrupted"]);
  assert.deepEqual(events.onStateChanged, [], "waiting への遷移イベントは出ていない");
});

test("poll が 2 で canceled にするはずだった実行を止めても、タスクの状態は上書きされない", async () => {
  const { db, root, workflow } = await taskFixture(`
name: f
steps:
  - id: wait
    type: poll
    run: "sleep 0.2; exit $(cat verdict)"
    interval: 30s
`);
  writeFileSync(join(root, "verdict"), "2");
  const { events, deps } = recorder();

  const done = runTask(db, "t1", workflow, {
    db,
    adapter: createMockAdapter({ result: {} }),
    logRoot: join(root, "logs"),
    globalLimit: 4,
    ...deps,
  });
  await stopMidFlight(db, done, "paused");

  const runs = await listStepRuns(db, "t1");
  assert.deepEqual(runs.map((r) => r.status), ["interrupted"]);
  const task = (await getTask(db, "t1"))!;
  assert.equal(task.state, "paused", "canceled には上書きされない");
  assert.deepEqual(events.onStepRunFinished, ["wait:interrupted"]);
  assert.deepEqual(events.onStateChanged, [], "canceled への遷移イベントは出ていない");
});

// --- onExhausted: suspend ---------------------------------------------

const ESCALATE_WF = `
name: f
steps:
  - id: fix
    type: command
    run: "true"
  - id: check
    type: command
    run: "exit $(cat verdict)"
    onFailure: { goto: fix, maxAttempts: 2, feed: "直して: {{ steps.check.last_stdout }}", onExhausted: suspend }
`;

test("上限に達すると、そのステップの awaiting の行を立てて suspended になる", async () => {
  const { db, root, workflow } = await taskFixture(ESCALATE_WF);
  writeFileSync(join(root, "verdict"), "1");
  await runTask(db, "t1", workflow, {
    db,
    adapter: createMockAdapter({ result: {} }),
    logRoot: join(root, "logs"),
    globalLimit: 4,
  });
  const t = (await getTask(db, "t1"))!;
  assert.equal(t.state, "suspended");
  assert.equal(t.current_step_id, "check");
  assert.deepEqual(
    (await listStepRuns(db, "t1")).map((r) => [r.step_id, r.status]),
    [["fix", "success"], ["check", "bounced"], ["fix", "success"], ["check", "failed"], ["check", "awaiting"]],
  );
});

test("上限到達の承認は回数を戻して goto 先から続け、feed を渡す", async () => {
  const { db, root, workflow } = await taskFixture(ESCALATE_WF);
  writeFileSync(join(root, "verdict"), "1");
  const deps = { db, adapter: createMockAdapter({ result: {} }), logRoot: join(root, "logs"), globalLimit: 4 };
  await runTask(db, "t1", workflow, deps);

  await applyApproval(db, "t1", { approved: true, comment: "" }, workflow);
  const t = (await getTask(db, "t1"))!;
  assert.equal(t.state, "queued");
  assert.equal(t.current_step_id, "fix");
  assert.equal(JSON.parse(t.attempt_counts).check, undefined, "check の回数を戻す");
  // last_stdout は失敗した check の実行の出力のまま（承認が outputs を上書きしていない証拠）。
  // "exit $(cat verdict)" は標準出力に何も書かないので、展開後は空文字が続く。
  assert.equal(t.pending_feed, "直して: ");
  const last = (await listStepRuns(db, "t1")).at(-1)!;
  assert.deepEqual([last.step_id, last.status, last.goto_step_id], ["check", "bounced", "fix"]);

  writeFileSync(join(root, "verdict"), "0");
  await toRunning(db, "t1");
  await runTask(db, "t1", workflow, deps);
  assert.equal((await getTask(db, "t1"))?.state, "completed");
});

test("上限到達の却下は failed で終える", async () => {
  const { db, root, workflow } = await taskFixture(ESCALATE_WF);
  writeFileSync(join(root, "verdict"), "1");
  await runTask(db, "t1", workflow, {
    db,
    adapter: createMockAdapter({ result: {} }),
    logRoot: join(root, "logs"),
    globalLimit: 4,
  });
  await applyApproval(db, "t1", { approved: false, comment: "手で直す" }, workflow);
  assert.equal((await getTask(db, "t1"))?.state, "failed");
  assert.equal((await listStepRuns(db, "t1")).at(-1)?.status, "failed");
});
