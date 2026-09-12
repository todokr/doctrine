import { test } from "vitest";
import assert from "node:assert/strict";
import { openDb } from "../../src/db/migrate.ts";
import { insertProject, insertTask, getTask } from "../../src/db/tasks.ts";
import { commitStepBoundary } from "../../src/db/boundary.ts";
import type { Workflow } from "../../src/workflow/schema.ts";
import {
  isSameChild, killStaleChild, recoverOnStartup, type ProcessProbe, type WorkflowLookup,
} from "../../src/core/recovery.ts";

function fixture() {
  const db = openDb(":memory:");
  const p = insertProject(db, { path: "/repo", default_workflow: "f", max_concurrent: 1, base_branch: "main", setup: null });
  insertTask(db, { id: "t1", project_id: p, title: "T", prompt: "P", workflow_name: "f", branch: "b", priority: 2 });
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
  assert.deepEqual(actions, [{ taskId: "t1", action: "resume-agent" }]);
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
  assert.deepEqual(actions, [{ taskId: "t1", action: "rerun-command" }]);
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
  assert.deepEqual(actions, [{ taskId: "t1", action: "rerun-command" }]);
});

test("running でないタスクには触らない", async () => {
  const db = fixture();
  commitStepBoundary(db, { taskId: "t1", taskPatch: { state: "suspended" } });
  assert.deepEqual(await recoverOnStartup(db, probe({}), lookupWF), []);
  assert.equal(getTask(db, "t1")?.state, "suspended");
});
