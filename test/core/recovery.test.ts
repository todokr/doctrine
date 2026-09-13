import { test } from "vitest";
import assert from "node:assert/strict";
import { openDb } from "../../src/db/migrate.ts";
import { insertProject, insertTask, getTask } from "../../src/db/tasks.ts";
import { commitStepBoundary } from "../../src/db/boundary.ts";
import { listStepRuns } from "../../src/db/stepRuns.ts";
import type { Workflow } from "../../src/workflow/schema.ts";
import {
  isSameChild, killStaleChild, recoverOnStartup, psLstartCommand,
  type ProcessProbe, type WorkflowLookup,
} from "../../src/core/recovery.ts";

function fixture(taskIds: string[] = ["t1"]) {
  const db = openDb(":memory:");
  const p = insertProject(db, { path: "/repo", default_workflow: "f", max_concurrent: 1, base_branch: "main", setup: null });
  for (const id of taskIds) {
    insertTask(db, { id, project_id: p, title: "T", prompt: "P", workflow_name: "f", branch: "b", priority: 2 });
  }
  return db;
}

function probe(map: Record<number, string | null>, killed: { pid: number; signal: NodeJS.Signals }[] = []): ProcessProbe {
  return {
    startTimeOf: async (pid) => map[pid] ?? null,
    kill: (pid, signal) => { killed.push({ pid, signal }); },
  };
}

test("pidと開始時刻が一致すれば同一のプロセス", () => {
  assert.ok(isSameChild({ pid: 100, startedAt: "2026-09-12T00:00:00.000Z" }, "2026-09-12T00:00:00.000Z"));
});

test("開始時刻が違えば別プロセス（pidの再利用）", () => {
  assert.equal(isSameChild({ pid: 100, startedAt: "2026-09-12T00:00:00.000Z" }, "2026-09-12T09:00:00.000Z"), false);
});

test("プロセスが存在しなければ同一ではない", () => {
  assert.equal(isSameChild({ pid: 100, startedAt: "2026-09-12T00:00:00.000Z" }, null), false);
});

test("秒未満のずれは許容する", () => {
  assert.ok(isSameChild({ pid: 1, startedAt: "2026-09-12T00:00:00.000Z" }, "2026-09-12T00:00:01.500Z", 2000));
});

test("生き残った子プロセスを殺す", async () => {
  const db = fixture();
  commitStepBoundary(db, { taskId: "t1", taskPatch: { state: "running", child_pid: 4242, child_started_at: "2026-09-12T00:00:00.000Z" } });
  const killed: { pid: number; signal: NodeJS.Signals }[] = [];
  const r = await killStaleChild(getTask(db, "t1")!, probe({ 4242: "2026-09-12T00:00:00.000Z" }, killed));
  assert.equal(r, "killed");
  assert.deepEqual(killed, [{ pid: 4242, signal: "SIGKILL" }]);
});

test("既定のシグナルは SIGKILL、呼び出し側が指定すればそれが probe.kill に届く", async () => {
  const db = fixture();
  commitStepBoundary(db, { taskId: "t1", taskPatch: { state: "running", child_pid: 4242, child_started_at: "2026-09-12T00:00:00.000Z" } });
  const killed: { pid: number; signal: NodeJS.Signals }[] = [];
  const r = await killStaleChild(getTask(db, "t1")!, probe({ 4242: "2026-09-12T00:00:00.000Z" }, killed), "SIGTERM");
  assert.equal(r, "killed");
  assert.deepEqual(killed, [{ pid: 4242, signal: "SIGTERM" }], "pause/cancel は SIGTERM を渡せる必要がある");
});

test("pidが再利用されていたら殺さない", async () => {
  const db = fixture();
  commitStepBoundary(db, { taskId: "t1", taskPatch: { state: "running", child_pid: 4242, child_started_at: "2026-09-12T00:00:00.000Z" } });
  const killed: { pid: number; signal: NodeJS.Signals }[] = [];
  const r = await killStaleChild(getTask(db, "t1")!, probe({ 4242: "2026-09-12T12:00:00.000Z" }, killed));
  assert.equal(r, "mismatch");
  assert.deepEqual(killed, [], "無関係のプロセスを殺してはならない");
});

test("pidの記録がなければ何もしない", async () => {
  const db = fixture();
  const r = await killStaleChild(getTask(db, "t1")!, probe({}));
  assert.equal(r, "none");
});

test("spawn失敗時の記録（pid <= 0）は絶対に probe.kill へ渡さない", async () => {
  const db = fixture();
  commitStepBoundary(db, { taskId: "t1", taskPatch: { state: "running", child_pid: -1, child_started_at: "2026-09-12T00:00:00.000Z" } });
  const killed: { pid: number; signal: NodeJS.Signals }[] = [];
  const r = await killStaleChild(getTask(db, "t1")!, probe({ [-1]: "2026-09-12T00:00:00.000Z" }, killed));
  assert.equal(r, "none");
  assert.deepEqual(killed, []);
});

const WF: Workflow = {
  name: "f",
  steps: [
    { id: "implement", type: "agent", prompt: "do it" },
    { id: "test", type: "command", run: "pnpm test" },
  ],
};
const lookupWF: WorkflowLookup = () => WF;

test("起動時、running のタスクは全部古いものとして扱う（agent ステップの途中で中断）", async () => {
  const db = fixture();
  commitStepBoundary(db, {
    taskId: "t1",
    taskPatch: { state: "running", current_step_id: "implement", claude_session_id: "s1", child_pid: 4242, child_started_at: "2026-09-12T00:00:00.000Z" },
    stepRun: { step_id: "implement", attempt: 1, status: "running", exit_code: null, started_at: "a", ended_at: "b", log_path: "/l" },
  });
  const actions = await recoverOnStartup(db, probe({ 4242: "2026-09-12T00:00:00.000Z" }), lookupWF);
  assert.deepEqual(actions, [{ taskId: "t1", outcome: "recovered", action: "resume-agent" }]);
  const t = getTask(db, "t1")!;
  assert.equal(t.state, "queued", "枠を取り直してから再開する");
  assert.equal(t.resumed, 1, "再開は行列の先頭");
  assert.equal(t.child_pid, null);
});

test("command ステップで落ちていたら頭から再実行する（先行する agent ステップの session_id が残っていても）", async () => {
  const db = fixture();
  // claude_session_id は agent ステップ由来で既に残っているが、中断したのは command ステップ。
  // session_id の有無だけでは判別できないことをこのテストで確認する。
  commitStepBoundary(db, {
    taskId: "t1",
    taskPatch: { state: "running", current_step_id: "test", claude_session_id: "s1" },
    stepRun: { step_id: "test", attempt: 1, status: "running", exit_code: null, started_at: "a", ended_at: "b", log_path: "/l" },
  });
  const actions = await recoverOnStartup(db, probe({}), lookupWF);
  assert.deepEqual(actions, [{ taskId: "t1", outcome: "recovered", action: "rerun-command" }]);
});

test("ワークフローが引けない（YAML削除・壊れたなど）場合は安全側（command 再実行）に倒す", async () => {
  const db = fixture();
  commitStepBoundary(db, {
    taskId: "t1",
    taskPatch: { state: "running", current_step_id: "implement", claude_session_id: "s1" },
    stepRun: { step_id: "implement", attempt: 1, status: "running", exit_code: null, started_at: "a", ended_at: "b", log_path: "/l" },
  });
  const lookupMissing: WorkflowLookup = () => undefined;
  const actions = await recoverOnStartup(db, probe({}), lookupMissing);
  assert.deepEqual(actions, [{ taskId: "t1", outcome: "recovered", action: "rerun-command" }]);
});

test("running でないタスクには触らない", async () => {
  const db = fixture();
  commitStepBoundary(db, { taskId: "t1", taskPatch: { state: "suspended" } });
  assert.deepEqual(await recoverOnStartup(db, probe({}), lookupWF), []);
  assert.equal(getTask(db, "t1")?.state, "suspended");
});

function runningTaskPatch(stepId: string) {
  return {
    state: "running" as const,
    current_step_id: stepId,
    child_pid: null,
    child_started_at: null,
  };
}

test("probe.startTimeOf が1件目で例外を投げても、残りは救済され失敗が報告される", async () => {
  const db = fixture(["t1", "t2", "t3"]);
  for (const id of ["t1", "t2", "t3"]) {
    commitStepBoundary(db, {
      taskId: id,
      taskPatch: runningTaskPatch("implement"),
      stepRun: { step_id: "implement", attempt: 1, status: "running", exit_code: null, started_at: "a", ended_at: "b", log_path: "/l" },
    });
  }
  // t1 だけ child_pid を持たせ、probe.startTimeOf がそれに対して例外を投げるようにする。
  commitStepBoundary(db, { taskId: "t1", taskPatch: { child_pid: 9999, child_started_at: "2026-09-12T00:00:00.000Z" } });

  const throwingProbe: ProcessProbe = {
    startTimeOf: async (pid) => {
      if (pid === 9999) throw new Error("ps が失敗しました（テスト用）");
      return null;
    },
    kill: () => {},
  };

  const results = await recoverOnStartup(db, throwingProbe, lookupWF);
  const byId = new Map(results.map((r) => [r.taskId, r]));

  assert.equal(byId.get("t1")?.outcome, "failed");
  assert.match((byId.get("t1") as { error: string }).error, /ps が失敗しました/);
  assert.equal(byId.get("t2")?.outcome, "recovered");
  assert.equal(byId.get("t3")?.outcome, "recovered");
  assert.deepEqual(byId.get("t2"), { taskId: "t2", outcome: "recovered", action: "resume-agent" });
  assert.deepEqual(byId.get("t3"), { taskId: "t3", outcome: "recovered", action: "resume-agent" });

  // 実際に queued まで進んだことを確認する（返り値だけでなく状態そのものを見る）。
  assert.equal(getTask(db, "t2")!.state, "queued");
  assert.equal(getTask(db, "t3")!.state, "queued");
  // t1 は復帰できないと分かったので、running のまま枠を専有し続けるのではなく
  // failed（終端・両スロット非専有・一覧に見える）に倒す。
  assert.equal(getTask(db, "t1")!.state, "failed");
});

test("lookupWorkflow が1件で例外を投げても、残りは救済され失敗が報告される", async () => {
  const db = fixture(["t1", "t2", "t3"]);
  for (const id of ["t1", "t2", "t3"]) {
    commitStepBoundary(db, {
      taskId: id,
      taskPatch: runningTaskPatch("implement"),
      stepRun: { step_id: "implement", attempt: 1, status: "running", exit_code: null, started_at: "a", ended_at: "b", log_path: "/l" },
    });
  }

  const throwingLookup: WorkflowLookup = (task) => {
    if (task.id === "t2") throw new Error("ワークフローYAMLが壊れています（テスト用）");
    return WF;
  };

  const results = await recoverOnStartup(db, probe({}), throwingLookup);
  const byId = new Map(results.map((r) => [r.taskId, r]));

  assert.equal(byId.get("t2")?.outcome, "failed");
  assert.match((byId.get("t2") as { error: string }).error, /ワークフローYAMLが壊れています/);
  assert.deepEqual(byId.get("t1"), { taskId: "t1", outcome: "recovered", action: "resume-agent" });
  assert.deepEqual(byId.get("t3"), { taskId: "t3", outcome: "recovered", action: "resume-agent" });

  assert.equal(getTask(db, "t1")!.state, "queued");
  assert.equal(getTask(db, "t3")!.state, "queued");
  assert.equal(getTask(db, "t2")!.state, "failed");
});

test("defaultProbe が使う ps コマンドはロケール・タイムゾーンを固定する", () => {
  const { cmd, args, env } = psLstartCommand(4242);
  assert.equal(cmd, "ps");
  assert.deepEqual(args, ["-o", "lstart=", "-p", "4242"]);
  assert.equal(env.LC_ALL, "C");
  assert.equal(env.TZ, "UTC");
});

test("復帰に成功したら、中断した step_runs 行を running のまま残さない", async () => {
  const db = fixture();
  commitStepBoundary(db, {
    taskId: "t1",
    taskPatch: { state: "running", current_step_id: "implement" },
    stepRun: { step_id: "implement", attempt: 1, status: "running", exit_code: null, started_at: "a", ended_at: null, log_path: "/l" },
  });
  await recoverOnStartup(db, probe({}), lookupWF);
  const runs = listStepRuns(db, "t1");
  assert.equal(runs.length, 1);
  assert.notEqual(runs[0].status, "running");
  assert.ok(runs[0].ended_at !== null, "ended_at が入っている必要がある");
});

test("復帰に失敗しても、中断した step_runs 行を running のまま残さない", async () => {
  const db = fixture();
  commitStepBoundary(db, {
    taskId: "t1",
    taskPatch: { state: "running", current_step_id: "implement" },
    stepRun: { step_id: "implement", attempt: 1, status: "running", exit_code: null, started_at: "a", ended_at: null, log_path: "/l" },
  });
  const throwingLookup: WorkflowLookup = () => { throw new Error("壊れている（テスト用）"); };
  const results = await recoverOnStartup(db, probe({}), throwingLookup);
  assert.equal(results[0]?.outcome, "failed");
  const runs = listStepRuns(db, "t1");
  assert.equal(runs.length, 1);
  assert.notEqual(runs[0].status, "running");
  assert.ok(runs[0].ended_at !== null);
});

test("running のまま残っている step_runs 行が無ければ、何も書き足さずに復帰する", async () => {
  const db = fixture();
  // current_step_id はあるが、対応する step_runs 行を一切作らない
  // （approval からの queued 経由など、step_run 行が無いまま running になったケースを模す）。
  commitStepBoundary(db, { taskId: "t1", taskPatch: { state: "running", current_step_id: "implement" } });
  const actions = await recoverOnStartup(db, probe({}), lookupWF);
  assert.deepEqual(actions, [{ taskId: "t1", outcome: "recovered", action: "resume-agent" }]);
  assert.deepEqual(listStepRuns(db, "t1"), []);
});

test("running の step_runs 行が複数あっても、最後の running 行だけを閉じ、既に終わっている行はそのまま", async () => {
  const db = fixture();
  commitStepBoundary(db, {
    taskId: "t1",
    taskPatch: { current_step_id: "implement" },
    stepRun: { step_id: "implement", attempt: 1, status: "failed", exit_code: 1, started_at: "a", ended_at: "b", log_path: "/l1" },
  });
  commitStepBoundary(db, {
    taskId: "t1",
    taskPatch: { state: "running", current_step_id: "implement" },
    stepRun: { step_id: "implement", attempt: 2, status: "running", exit_code: null, started_at: "c", ended_at: null, log_path: "/l2" },
  });
  await recoverOnStartup(db, probe({}), lookupWF);
  const runs = listStepRuns(db, "t1");
  assert.equal(runs.length, 2);
  // 最初の（既に終わっている）行はそのまま。
  assert.equal(runs[0].status, "failed");
  assert.equal(runs[0].ended_at, "b");
  // 2件目（running だった行）だけが閉じられている。
  assert.notEqual(runs[1].status, "running");
  assert.ok(runs[1].ended_at !== null);
});
