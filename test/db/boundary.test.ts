import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { openDb } from "../../src/db/migrate.ts";
import { insertProject, insertTask, getTask } from "../../src/db/tasks.ts";
import { listStepRuns, getStepOutputs } from "../../src/db/stepRuns.ts";
import { commitStepBoundary, OUTPUT_TAIL_BYTES, StateConflictError } from "../../src/db/boundary.ts";
import type { StepRunStatus } from "../../src/db/stepRuns.ts";

async function fixture() {
  const d = await openDb(":memory:");
  const pid = await insertProject(d, { path: "/repo", default_workflow: "f", max_concurrent: 1, base_branch: "main", setup: null });
  await insertTask(d, { id: "t1", project_id: pid, title: "T", prompt: "P", workflow_name: "f", branch: "b", priority: 2 });
  return d;
}

test("タスク更新とステップ実行記録が同時に書かれる", async () => {
  const d = await fixture();
  await commitStepBoundary(d, {
    taskId: "t1",
    taskPatch: { state: "running", current_step_id: "test" },
    stepRun: {
      step_id: "test", attempt: 1, status: "success", exit_code: 0,
      started_at: "2026-09-12T00:00:00Z", ended_at: "2026-09-12T00:00:01Z",
      log_path: "/logs/t1/test.1.log",
    },
    outputs: { step_id: "test", stdout: "ok", stderr: "", exit_code: 0 },
  });
  assert.equal((await getTask(d, "t1"))?.current_step_id, "test");
  assert.equal((await listStepRuns(d, "t1")).length, 1);
  assert.equal((await getStepOutputs(d, "t1")).test.stdout, "ok");
  assert.equal((await getStepOutputs(d, "t1")).test.exitCode, "0");
});

test("ステップ実行の挿入が失敗したらタスク更新も巻き戻る", async () => {
  const d = await fixture();
  await assert.rejects(() => commitStepBoundary(d, {
    taskId: "missing-task",
    taskPatch: { state: "running" },
    stepRun: {
      step_id: "x", attempt: 1, status: "success", exit_code: 0,
      started_at: "a", ended_at: "b", log_path: "/l",
    },
  }));
  assert.equal((await getTask(d, "t1"))?.state, "queued");
});

test("実タスクの更新もステップ実行の失敗で巻き戻る", async () => {
  const d = await fixture();
  await assert.rejects(() => commitStepBoundary(d, {
    taskId: "t1",
    taskPatch: { state: "running", current_step_id: "test" },
    stepRun: {
      step_id: "test", attempt: 1,
      status: "bogus" as StepRunStatus, // CHECK制約違反でINSERTを失敗させる
      exit_code: 0, started_at: "a", ended_at: "b", log_path: "/l",
    },
  }));
  assert.equal((await getTask(d, "t1"))?.state, "queued");
  assert.equal((await getTask(d, "t1"))?.current_step_id, null);
  assert.equal((await listStepRuns(d, "t1")).length, 0);
});

test("開始時に running で挿入し、終了時に同じ行を更新する", async () => {
  const d = await fixture();
  const id = (await commitStepBoundary(d, {
    taskId: "t1", taskPatch: { state: "running", current_step_id: "test" },
    stepRun: { step_id: "test", attempt: 1, status: "running", exit_code: null,
               started_at: "2026-09-12T00:00:00Z", ended_at: null, log_path: "/l" },
  }))!;
  assert.equal((await listStepRuns(d, "t1"))[0].status, "running");
  await commitStepBoundary(d, {
    taskId: "t1", taskPatch: {},
    stepRunUpdate: { id, status: "success", exit_code: 0, ended_at: "2026-09-12T00:00:05Z" },
    outputs: { step_id: "test", stdout: "ok", stderr: "", exit_code: 0 },
  });
  const rows = await listStepRuns(d, "t1");
  assert.equal(rows.length, 1, "行は増えない");
  assert.equal(rows[0].status, "success");
  assert.equal(rows[0].ended_at, "2026-09-12T00:00:05Z");
});

test("ステップ実行のidを返す（イベントが載せる id）", async () => {
  const d = await fixture();
  const id = await commitStepBoundary(d, {
    taskId: "t1", taskPatch: {},
    stepRun: { step_id: "test", attempt: 1, status: "success", exit_code: 0, started_at: "a", ended_at: "b", log_path: "/l" },
  });
  assert.equal(id, (await listStepRuns(d, "t1"))[0].id);
  assert.equal(await commitStepBoundary(d, { taskId: "t1", taskPatch: { state: "running" } }), null);
});

test("同じステップの2回目の出力は上書きされる", async () => {
  const d = await fixture();
  const base = { step_id: "test", attempt: 1, status: "failed" as const, exit_code: 1, started_at: "a", ended_at: "b", log_path: "/l" };
  await commitStepBoundary(d, { taskId: "t1", taskPatch: {}, stepRun: base, outputs: { step_id: "test", stdout: "1回目", stderr: "", exit_code: 1 } });
  await commitStepBoundary(d, { taskId: "t1", taskPatch: {}, stepRun: { ...base, attempt: 2, status: "success", exit_code: 0 }, outputs: { step_id: "test", stdout: "2回目", stderr: "", exit_code: 0 } });
  assert.equal((await getStepOutputs(d, "t1")).test.stdout, "2回目");
  assert.equal((await listStepRuns(d, "t1")).length, 2);
});

test("巨大な出力は末尾だけ保存する", async () => {
  const d = await fixture();
  const huge = "x".repeat(OUTPUT_TAIL_BYTES * 3) + "END";
  await commitStepBoundary(d, {
    taskId: "t1", taskPatch: {},
    stepRun: { step_id: "test", attempt: 1, status: "success", exit_code: 0, started_at: "a", ended_at: "b", log_path: "/l" },
    outputs: { step_id: "test", stdout: huge, stderr: "", exit_code: 0 },
  });
  const saved = (await getStepOutputs(d, "t1")).test.stdout;
  assert.ok(saved.length <= OUTPUT_TAIL_BYTES + 3);
  assert.ok(saved.endsWith("END"));
});

test("巨大な日本語出力はUTF-8バイト数で末尾を切る", async () => {
  const d = await fixture();
  const huge = "あ".repeat(20000) + "終";
  await commitStepBoundary(d, {
    taskId: "t1", taskPatch: {},
    stepRun: { step_id: "test", attempt: 1, status: "success", exit_code: 0, started_at: "a", ended_at: "b", log_path: "/l" },
    outputs: { step_id: "test", stdout: huge, stderr: "", exit_code: 0 },
  });
  const saved = (await getStepOutputs(d, "t1")).test.stdout;
  assert.ok(Buffer.byteLength(saved, "utf8") <= OUTPUT_TAIL_BYTES);
  assert.ok(saved.endsWith("終"));
});

test("末尾を切った結果に文字化け(U+FFFD)を含まない", async () => {
  const d = await fixture();
  const huge = "あ".repeat(20000) + "終";
  await commitStepBoundary(d, {
    taskId: "t1", taskPatch: {},
    stepRun: { step_id: "test", attempt: 1, status: "success", exit_code: 0, started_at: "a", ended_at: "b", log_path: "/l" },
    outputs: { step_id: "test", stdout: huge, stderr: "", exit_code: 0 },
  });
  const saved = (await getStepOutputs(d, "t1")).test.stdout;
  assert.equal(saved.includes("�"), false);
});

test("上限ちょうど・未満の出力はそのまま保存される", async () => {
  const d = await fixture();
  const exact = "x".repeat(OUTPUT_TAIL_BYTES);
  const under = "x".repeat(OUTPUT_TAIL_BYTES - 1);
  await commitStepBoundary(d, {
    taskId: "t1", taskPatch: {},
    stepRun: { step_id: "a", attempt: 1, status: "success", exit_code: 0, started_at: "a", ended_at: "b", log_path: "/l" },
    outputs: { step_id: "a", stdout: exact, stderr: "", exit_code: 0 },
  });
  await commitStepBoundary(d, {
    taskId: "t1", taskPatch: {},
    stepRun: { step_id: "b", attempt: 1, status: "success", exit_code: 0, started_at: "a", ended_at: "b", log_path: "/l" },
    outputs: { step_id: "b", stdout: under, stderr: "", exit_code: 0 },
  });
  const outputs = await getStepOutputs(d, "t1");
  assert.equal(outputs.a.stdout, exact);
  assert.equal(outputs.b.stdout, under);
});

test("requireState が実際の状態と一致すれば書く", async () => {
  const d = await fixture();
  await commitStepBoundary(d, { taskId: "t1", requireState: "queued", taskPatch: { state: "running" } });
  assert.equal((await getTask(d, "t1"))?.state, "running");
});

test("requireState が食い違えば StateConflictError を投げ、タスク・実行記録・出力のどれも書かない", async () => {
  const d = await fixture();
  const before = (await getTask(d, "t1"))!;
  await assert.rejects(
    () => commitStepBoundary(d, {
      taskId: "t1", requireState: "running",
      taskPatch: { state: "completed", current_step_id: "test" },
      stepRun: { step_id: "test", attempt: 1, status: "success", exit_code: 0, started_at: "a", ended_at: "b", log_path: "/l" },
      outputs: { step_id: "test", stdout: "ok", stderr: "", exit_code: 0 },
    }),
    (e) => e instanceof StateConflictError && e.expected === "running" && e.actual === "queued",
  );
  assert.deepEqual(await getTask(d, "t1"), before);
  assert.deepEqual(await listStepRuns(d, "t1"), []);
  assert.deepEqual(await getStepOutputs(d, "t1"), {});
});

/**
 * 接続は1本で、トランザクションは文と文の間に await を挟む。排他が無いと、
 * 途中で割り込んだ読み取りが同じ接続上のコミット前の値を見てしまう。
 */
test("トランザクションの途中に他のクエリは割り込まない（巻き戻る書き込みは外から見えない）", async () => {
  const d = await fixture();
  const failing = commitStepBoundary(d, {
    taskId: "t1",
    taskPatch: { state: "running" },
    stepRun: {
      step_id: "test", attempt: 1,
      status: "bogus" as StepRunStatus, // CHECK制約違反で2文目を失敗させる
      exit_code: 0, started_at: "a", ended_at: "b", log_path: "/l",
    },
  });
  const seen = getTask(d, "t1");
  await assert.rejects(() => failing);
  assert.equal((await seen)?.state, "queued");
});
