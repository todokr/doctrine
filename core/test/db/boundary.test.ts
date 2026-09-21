import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { openDb } from "../../src/db/migrate.ts";
import { getTask, insertProject, insertTask } from "../../src/db/tasks.ts";
import { getStepOutputs, listStepRuns } from "../../src/db/stepRuns.ts";
import {
  commitStepBoundary,
  DENIAL_VALUE_CHARS,
  MAX_DENIALS,
  OUTPUT_TAIL_BYTES,
  StateConflictError,
} from "../../src/db/boundary.ts";
import type { PermissionDenial } from "../../../shared/protocol.ts";
import type { StepRunStatus } from "../../src/db/stepRuns.ts";

async function fixture() {
  const d = await openDb(":memory:");
  const pid = await insertProject(d, {
    path: "/repo",
    default_workflow: "f",
    max_concurrent: 1,
    base_branch: "main",
    setup: null,
  });
  await insertTask(d, {
    id: "t1",
    project_id: pid,
    title: "T",
    prompt: "P",
    workflow_name: "f",
    branch: "b",
    priority: 2,
  });
  return d;
}

test("タスク更新とステップ実行記録が同時に書かれる", async () => {
  const d = await fixture();
  await commitStepBoundary(d, {
    taskId: "t1",
    taskPatch: { state: "running", current_step_id: "test" },
    stepRun: {
      step_id: "test",
      attempt: 1,
      status: "success",
      exit_code: 0,
      started_at: "2026-09-12T00:00:00Z",
      ended_at: "2026-09-12T00:00:01Z",
      log_path: "/logs/t1/test.1.log",
    },
    outputs: { last_stdout: "ok", last_stderr: "", exit_code: 0 },
  });
  assert.equal((await getTask(d, "t1"))?.current_step_id, "test");
  assert.equal((await listStepRuns(d, "t1")).length, 1);
  assert.equal((await getStepOutputs(d, "t1")).test.last_stdout, "ok");
  assert.equal((await getStepOutputs(d, "t1")).test.exitCode, "0");
});

test("ステップ実行の挿入が失敗したらタスク更新も巻き戻る", async () => {
  const d = await fixture();
  await assert.rejects(() =>
    commitStepBoundary(d, {
      taskId: "missing-task",
      taskPatch: { state: "running" },
      stepRun: {
        step_id: "x",
        attempt: 1,
        status: "success",
        exit_code: 0,
        started_at: "a",
        ended_at: "b",
        log_path: "/l",
      },
    })
  );
  assert.equal((await getTask(d, "t1"))?.state, "queued");
});

test("実タスクの更新もステップ実行の失敗で巻き戻る", async () => {
  const d = await fixture();
  await assert.rejects(() =>
    commitStepBoundary(d, {
      taskId: "t1",
      taskPatch: { state: "running", current_step_id: "test" },
      stepRun: {
        step_id: "test",
        attempt: 1,
        status: "bogus" as StepRunStatus, // CHECK制約違反でINSERTを失敗させる
        exit_code: 0,
        started_at: "a",
        ended_at: "b",
        log_path: "/l",
      },
    })
  );
  assert.equal((await getTask(d, "t1"))?.state, "queued");
  assert.equal((await getTask(d, "t1"))?.current_step_id, null);
  assert.equal((await listStepRuns(d, "t1")).length, 0);
});

test("開始時に running で挿入し、終了時に同じ行を更新する", async () => {
  const d = await fixture();
  const id = (await commitStepBoundary(d, {
    taskId: "t1",
    taskPatch: { state: "running", current_step_id: "test" },
    stepRun: {
      step_id: "test",
      attempt: 1,
      status: "running",
      exit_code: null,
      started_at: "2026-09-12T00:00:00Z",
      ended_at: null,
      log_path: "/l",
    },
  }))!;
  assert.equal((await listStepRuns(d, "t1"))[0].status, "running");
  await commitStepBoundary(d, {
    taskId: "t1",
    taskPatch: {},
    stepRunUpdate: { id, status: "success", exit_code: 0, ended_at: "2026-09-12T00:00:05Z" },
    outputs: { last_stdout: "ok", last_stderr: "", exit_code: 0 },
  });
  const rows = await listStepRuns(d, "t1");
  assert.equal(rows.length, 1, "行は増えない");
  assert.equal(rows[0].status, "success");
  assert.equal(rows[0].ended_at, "2026-09-12T00:00:05Z");
});

test("ステップ実行のidを返す（イベントが載せる id）", async () => {
  const d = await fixture();
  const id = await commitStepBoundary(d, {
    taskId: "t1",
    taskPatch: {},
    stepRun: {
      step_id: "test",
      attempt: 1,
      status: "success",
      exit_code: 0,
      started_at: "a",
      ended_at: "b",
      log_path: "/l",
    },
  });
  assert.equal(id, (await listStepRuns(d, "t1"))[0].id);
  assert.equal(
    await commitStepBoundary(d, { taskId: "t1", taskPatch: { state: "running" } }),
    null,
  );
});

// step_outputs の主キーが step_run_id になったので、同じステップを2回実行しても
// 出力は上書きされず2行残る。{{ steps.<id> }} が最新の実行を指すのは getStepOutputs
// が step_id ごとに最大の step_run_id を選ぶからで、古い行を潰すからではない。
test("{{ steps.<id> }} は最新の実行の出力を指し、過去の実行の出力も残る", async () => {
  const d = await fixture();
  const base = {
    step_id: "test",
    attempt: 1,
    status: "failed" as const,
    exit_code: 1,
    started_at: "a",
    ended_at: "b",
    log_path: "/l",
  };
  await commitStepBoundary(d, {
    taskId: "t1",
    taskPatch: {},
    stepRun: base,
    outputs: { last_stdout: "1回目", last_stderr: "", exit_code: 1 },
  });
  await commitStepBoundary(d, {
    taskId: "t1",
    taskPatch: {},
    stepRun: { ...base, attempt: 2, status: "success", exit_code: 0 },
    outputs: { last_stdout: "2回目", last_stderr: "", exit_code: 0 },
  });
  assert.equal((await getStepOutputs(d, "t1")).test.last_stdout, "2回目");
  assert.equal((await listStepRuns(d, "t1")).length, 2);
  const outputs = await d.selectFrom("step_outputs").select("last_stdout").orderBy("step_run_id")
    .execute();
  assert.deepEqual(outputs.map((o) => o.last_stdout), ["1回目", "2回目"], "1回目の出力も残る");
});

test("巨大な出力は末尾だけ保存する", async () => {
  const d = await fixture();
  const huge = "x".repeat(OUTPUT_TAIL_BYTES * 3) + "END";
  await commitStepBoundary(d, {
    taskId: "t1",
    taskPatch: {},
    stepRun: {
      step_id: "test",
      attempt: 1,
      status: "success",
      exit_code: 0,
      started_at: "a",
      ended_at: "b",
      log_path: "/l",
    },
    outputs: { last_stdout: huge, last_stderr: "", exit_code: 0 },
  });
  const saved = (await getStepOutputs(d, "t1")).test.last_stdout;
  assert.ok(saved.length <= OUTPUT_TAIL_BYTES + 3);
  assert.ok(saved.endsWith("END"));
});

test("巨大な日本語出力はUTF-8バイト数で末尾を切る", async () => {
  const d = await fixture();
  const huge = "あ".repeat(20000) + "終";
  await commitStepBoundary(d, {
    taskId: "t1",
    taskPatch: {},
    stepRun: {
      step_id: "test",
      attempt: 1,
      status: "success",
      exit_code: 0,
      started_at: "a",
      ended_at: "b",
      log_path: "/l",
    },
    outputs: { last_stdout: huge, last_stderr: "", exit_code: 0 },
  });
  const saved = (await getStepOutputs(d, "t1")).test.last_stdout;
  assert.ok(Buffer.byteLength(saved, "utf8") <= OUTPUT_TAIL_BYTES);
  assert.ok(saved.endsWith("終"));
});

test("末尾を切った結果に文字化け(U+FFFD)を含まない", async () => {
  const d = await fixture();
  const huge = "あ".repeat(20000) + "終";
  await commitStepBoundary(d, {
    taskId: "t1",
    taskPatch: {},
    stepRun: {
      step_id: "test",
      attempt: 1,
      status: "success",
      exit_code: 0,
      started_at: "a",
      ended_at: "b",
      log_path: "/l",
    },
    outputs: { last_stdout: huge, last_stderr: "", exit_code: 0 },
  });
  const saved = (await getStepOutputs(d, "t1")).test.last_stdout;
  assert.equal(saved.includes("�"), false);
});

test("上限ちょうど・未満の出力はそのまま保存される", async () => {
  const d = await fixture();
  const exact = "x".repeat(OUTPUT_TAIL_BYTES);
  const under = "x".repeat(OUTPUT_TAIL_BYTES - 1);
  await commitStepBoundary(d, {
    taskId: "t1",
    taskPatch: {},
    stepRun: {
      step_id: "a",
      attempt: 1,
      status: "success",
      exit_code: 0,
      started_at: "a",
      ended_at: "b",
      log_path: "/l",
    },
    outputs: { last_stdout: exact, last_stderr: "", exit_code: 0 },
  });
  await commitStepBoundary(d, {
    taskId: "t1",
    taskPatch: {},
    stepRun: {
      step_id: "b",
      attempt: 1,
      status: "success",
      exit_code: 0,
      started_at: "a",
      ended_at: "b",
      log_path: "/l",
    },
    outputs: { last_stdout: under, last_stderr: "", exit_code: 0 },
  });
  const outputs = await getStepOutputs(d, "t1");
  assert.equal(outputs.a.last_stdout, exact);
  assert.equal(outputs.b.last_stdout, under);
});

test("requireState が実際の状態と一致すれば書く", async () => {
  const d = await fixture();
  await commitStepBoundary(d, {
    taskId: "t1",
    requireState: "queued",
    taskPatch: { state: "running" },
  });
  assert.equal((await getTask(d, "t1"))?.state, "running");
});

test("requireState が食い違えば StateConflictError を投げ、タスク・実行記録・出力のどれも書かない", async () => {
  const d = await fixture();
  const before = (await getTask(d, "t1"))!;
  await assert.rejects(
    () =>
      commitStepBoundary(d, {
        taskId: "t1",
        requireState: "running",
        taskPatch: { state: "completed", current_step_id: "test" },
        stepRun: {
          step_id: "test",
          attempt: 1,
          status: "success",
          exit_code: 0,
          started_at: "a",
          ended_at: "b",
          log_path: "/l",
        },
        outputs: { last_stdout: "ok", last_stderr: "", exit_code: 0 },
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
      step_id: "test",
      attempt: 1,
      status: "bogus" as StepRunStatus, // CHECK制約違反で2文目を失敗させる
      exit_code: 0,
      started_at: "a",
      ended_at: "b",
      log_path: "/l",
    },
  });
  const seen = getTask(d, "t1");
  await assert.rejects(() => failing);
  assert.equal((await seen)?.state, "queued");
});

/** running の行を立ててから stepRunUpdate で閉じ、閉じた行の permission_denials を返す。 */
async function closeWithDenials(denials: PermissionDenial[] | undefined): Promise<string | null> {
  const d = await fixture();
  const id = await commitStepBoundary(d, {
    taskId: "t1",
    taskPatch: {},
    stepRun: {
      step_id: "a",
      attempt: 1,
      status: "running",
      exit_code: null,
      started_at: "a",
      ended_at: null,
      log_path: "/l",
    },
  });
  await commitStepBoundary(d, {
    taskId: "t1",
    taskPatch: {},
    stepRunUpdate: {
      id: id!,
      status: "success",
      exit_code: 0,
      ended_at: "b",
      ...(denials === undefined ? {} : { permission_denials: denials }),
    },
  });
  return (await listStepRuns(d, "t1"))[0].permission_denials;
}

function denial(command: string): PermissionDenial {
  return { tool_name: "Bash", tool_use_id: "tu", input: { command } };
}

test("権限拒否は step_runs に JSON で入る", async () => {
  const raw = await closeWithDenials([denial("git push"), denial("rm -rf /")]);
  assert.deepEqual(JSON.parse(raw!), {
    total: 2,
    denials: [denial("git push"), denial("rm -rf /")],
  });
});

test("拒否が無ければ列は NULL", async () => {
  assert.equal(await closeWithDenials([]), null);
  assert.equal(await closeWithDenials(undefined), null);
});

test("拒否が多いときは先頭 MAX_DENIALS 件だけ残し、件数は total に残る", async () => {
  const many = Array.from({ length: MAX_DENIALS + 1 }, (_, i) => denial(`cmd ${i}`));
  const saved = JSON.parse((await closeWithDenials(many))!);
  assert.equal(saved.total, MAX_DENIALS + 1);
  assert.equal(saved.denials.length, MAX_DENIALS);
  assert.deepEqual(saved.denials[0], many[0]);
});

test("長い入力は先頭を残して切られる", async () => {
  const saved = JSON.parse(
    (await closeWithDenials([denial("x".repeat(DENIAL_VALUE_CHARS + 100))]))!,
  );
  const command: string = saved.denials[0].input.command;
  assert.ok(command.length <= DENIAL_VALUE_CHARS);
  assert.ok(command.startsWith("xxx"));
});

test("入力のネストした値は切らない", async () => {
  const nested = { a: { b: "y".repeat(DENIAL_VALUE_CHARS + 100) } };
  const saved = JSON.parse(
    (await closeWithDenials([
      { tool_name: "T", tool_use_id: null, input: nested },
    ]))!,
  );
  assert.deepEqual(saved.denials[0].input, nested);
});
