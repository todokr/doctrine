import { afterEach, test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyApproval, decide, runTask } from "../../src/core/engine.ts";
import { parseWorkflow } from "../../src/workflow/schema.ts";
import { DatabaseSync } from "node:sqlite";
import { openDb, openDbOn } from "../../src/db/migrate.ts";
import { getTask, insertProject, insertTask } from "../../src/db/tasks.ts";
import { getStepOutputs, getStepRun, listStepRuns } from "../../src/db/stepRuns.ts";
import { createMockAdapter } from "../../src/adapter/mock.ts";
import type { Db } from "../../src/db/schema.ts";
import { makeRepo } from "../helpers/repo.ts";

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
      feed: "テストが失敗した:\\n{{ steps.test.stderr }}"
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

test("degraded でもワークフローは止まらない", () => {
  assert.deepEqual(
    decide({ workflow: wf, currentStepId: "implement", outcome: "degraded", attempts: 1 }),
    { kind: "next", stepId: "test" },
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
      feed: "テストが失敗した:\\n{{ steps.test.stderr }}"
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
      feed: "レビューで却下された:\\n{{ steps.review.stdout }}"
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
  assert.equal((await getStepOutputs(db, "t1")).review.stdout, "命名が変です");
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
      feed: "レビューで却下された:\\n{{ steps.review.stdout }}"
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
      feed: "だめ:\\n{{ steps.review.stdout }}"
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
  assert.deepEqual(reviews.map((r) => r.status), ["failed", "failed"]);
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
    outputs.filter((o) => reviews.some((r) => r.id === o.step_run_id)).map((o) => o.stdout),
    ["1回目の指摘", "2回目の指摘"],
  );
  // テンプレート変数は今までどおり最新の実行を指す。
  assert.equal((await getStepOutputs(db, "t1")).review.stdout, "2回目の指摘");
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
