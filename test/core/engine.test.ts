import { test, afterEach } from "vitest";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide, runTask, applyApproval } from "../../src/core/engine.ts";
import { parseWorkflow } from "../../src/workflow/schema.ts";
import { openDb } from "../../src/db/migrate.ts";
import { insertProject, insertTask, getTask } from "../../src/db/tasks.ts";
import { getStepOutputs, getStepRun, listStepRuns } from "../../src/db/stepRuns.ts";
import { createMockAdapter } from "../../src/adapter/mock.ts";

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
  assert.deepEqual(decide({ workflow: wf, currentStepId: "implement", outcome: "success", attempts: 1 }),
    { kind: "next", stepId: "test" });
});

test("最後のステップが成功したら completed", () => {
  assert.deepEqual(decide({ workflow: wf, currentStepId: "open-pr", outcome: "success", attempts: 1 }),
    { kind: "complete" });
});

test("degraded でもワークフローは止まらない", () => {
  assert.deepEqual(decide({ workflow: wf, currentStepId: "implement", outcome: "degraded", attempts: 1 }),
    { kind: "next", stepId: "test" });
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
  assert.deepEqual(decide({ workflow: wf, currentStepId: "review", outcome: "suspended", attempts: 1 }),
    { kind: "suspend" });
});

// --- runTask / applyApproval ---------------------------------------------

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function taskFixture(workflowYaml: string) {
  const root = await mkdtemp(join(tmpdir(), "doctrine-engine-"));
  roots.push(root);
  const db = openDb(":memory:");
  const pid = insertProject(db, { path: root, default_workflow: "f", max_concurrent: 1, base_branch: "main", setup: null });
  insertTask(db, { id: "t1", project_id: pid, title: "T", prompt: "直して", workflow_name: "f", branch: "doctrine/t1-t", priority: 2 });
  db.prepare("UPDATE tasks SET state='running', worktree_path=? WHERE id='t1'").run(root);
  return { db, root, workflow: parseWorkflow(workflowYaml).workflow };
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
    db, adapter: createMockAdapter({ result: {} }), logRoot: join(root, "logs"), globalLimit: 4,
  });
  assert.equal(getTask(db, "t1")?.state, "completed");
  assert.deepEqual(listStepRuns(db, "t1").map((r) => [r.step_id, r.status]), [["a", "success"], ["b", "success"]]);
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

  const runs = listStepRuns(db, "t1");
  assert.equal(runs.filter((r) => r.step_id === "implement").length, 2, "実装ステップへ2回目に戻って成功する");
  assert.equal(getTask(db, "t1")?.state, "completed");
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
    db, adapter: createMockAdapter({ result: { ok: true, text: "やった" } }),
    logRoot: join(root, "logs"), globalLimit: 4,
  });
  const runs = listStepRuns(db, "t1");
  assert.equal(runs.filter((r) => r.step_id === "test").length, 3, "test ステップは maxAttempts 回まで試す");
  assert.equal(getTask(db, "t1")?.state, "failed");
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
    db, adapter: createMockAdapter({ result: {} }), logRoot: join(root, "logs"), globalLimit: 4,
  });
  const t = getTask(db, "t1")!;
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
  await runTask(db, "t1", workflow, { db, adapter: createMockAdapter({ result: {} }), logRoot: join(root, "logs"), globalLimit: 4 });
  applyApproval(db, "t1", { approved: true, comment: "" }, workflow);
  const t = getTask(db, "t1")!;
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
  await runTask(db, "t1", workflow, { db, adapter: createMockAdapter({ result: {} }), logRoot: join(root, "logs"), globalLimit: 4 });
  applyApproval(db, "t1", { approved: false, comment: "命名が変です" }, workflow);
  const t = getTask(db, "t1")!;
  assert.equal(t.state, "queued");
  assert.equal(t.current_step_id, "implement");
  assert.equal(getStepOutputs(db, "t1").review.stdout, "命名が変です");
});

// states.ts の TRANSITIONS では suspended -> completed は許可されていない
// （suspended: ["queued","canceled","failed"]）。しかし applyApproval は
// 承認された approval ステップが最後のステップだったとき、commitStepBoundary で
// 直接 completed を書き込んでおり、assertTransition を経由しない
// （brief の実装そのままで、states.ts はこのタスクでは変更禁止）。
// このテストはその経路が実際に完走することの記録であって、状態機械としての
// 正しさを保証するものではない。suspended -> completed を許可された遷移として
// states.ts に追加するか、applyApproval 側で別の経路にするかは、レビューで
// 判断してほしい（このコミットでは変更しない）。
test("承認ステップが最後のとき、承認すると completed になる（state machine 未経由の既知の経路）", async () => {
  const { db, root, workflow } = await taskFixture(`
name: f
steps:
  - id: review
    type: approval
    title: "見て"
`);
  await runTask(db, "t1", workflow, { db, adapter: createMockAdapter({ result: {} }), logRoot: join(root, "logs"), globalLimit: 4 });
  applyApproval(db, "t1", { approved: true, comment: "" }, workflow);
  assert.equal(getTask(db, "t1")?.state, "completed");
});

test("ステップ開始時に running の step_run 行が立ち、コールバックへ実IDが渡る", async () => {
  const { db, root, workflow } = await taskFixture(`
name: f
steps:
  - id: a
    type: command
    run: "true"
`);
  const started: { id: number; status: string }[] = [];
  const finished: { id: number; stepId: string; status: string }[] = [];
  await runTask(db, "t1", workflow, {
    db, adapter: createMockAdapter({ result: {} }), logRoot: join(root, "logs"), globalLimit: 4,
    onStepRunStarted: (_taskId, stepRunId, stepId, attempt) => {
      // コールバックの時点でDBに running の行が実在することを確認する
      // （クラッシュ復帰は running のまま止まっている行を目印にする）。
      started.push({ id: stepRunId, status: getStepRun(db, stepRunId)!.status });
      assert.equal(stepId, "a");
      assert.equal(attempt, 1);
    },
    onStepRunFinished: (_taskId, stepRunId, stepId, status) => {
      finished.push({ id: stepRunId, stepId, status });
    },
  });
  assert.equal(started.length, 1);
  assert.ok(started[0].id > 0, "step_run_id はプレースホルダーの0ではなく実在の行id");
  assert.equal(started[0].status, "running");
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
  await runTask(db, "t1", workflow, { db, adapter: createMockAdapter({ result: {} }), logRoot: join(root, "logs"), globalLimit: 4 });
  applyApproval(db, "t1", { approved: false, comment: "だめ" }, workflow);
  assert.equal(getTask(db, "t1")?.state, "failed");
});

test("承認待ちでないタスクに applyApproval を呼ぶと例外を投げ、何も書き込まない", async () => {
  const { db, root, workflow } = await taskFixture(`
name: f
steps:
  - id: review
    type: approval
    title: "見て"
`);
  // taskFixture は state='running' のまま（runTask を呼んでいないので suspended になっていない）。
  const before = getTask(db, "t1")!;
  assert.equal(before.state, "running");

  assert.throws(() => applyApproval(db, "t1", { approved: true, comment: "" }, workflow));

  const after = getTask(db, "t1")!;
  assert.deepEqual(after, before, "例外を投げた呼び出しは taskPatch/step_run/outputs のどれも書き込まない");
});
