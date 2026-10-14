import { test } from "node:test";
import assert from "node:assert/strict";
import { getIntake, listProcesses, upsertPrObservation } from "../../src/db/intakes.ts";
import { getTask, listTasks } from "../../src/db/tasks.ts";
import { openDb } from "../../src/db/migrate.ts";
import {
  completeHumanProcess,
  type IntakeTransition,
  reviseIntake,
  setDispatchPaused,
  startIntake,
} from "../../src/intake/commands.ts";
import { insertDirectIntake, redispatchProcess } from "../../src/intake/dispatch.ts";
import { toIntakeDetail } from "../../src/intake/view.ts";
import { createIntakeWatcher, INITIAL_WATCH_HEALTH } from "../../src/intake/watch.ts";
import { seedProject } from "../helpers/project.ts";
import { fakeTracker as statefulTracker } from "../helpers/fakeTracker.ts";
import { fakePrWatcher } from "../helpers/prWatcher.ts";
import { constTrackerOf, fakeTracker } from "../helpers/tracker.ts";
import { fakeBaseSync, fakeWorkflowLoader } from "../helpers/watcher.ts";
import { DIRECT_WORKFLOW, PARENT_URL, seedDirect } from "./watchFixture.ts";

test("direct: Intake は active で、プロセス main とタスク 1 本を持つ", async () => {
  const { db, projectId, taskId } = await seedDirect();
  const intake = (await getIntake(db, "d1"))!;
  assert.equal(intake.mode, "direct");
  assert.equal(intake.state, "active");
  const rows = await listProcesses(db, "d1");
  assert.deepEqual(
    rows.map((r) => [r.process_id, r.sub_issue_url]),
    [["main", null]],
  );
  const task = (await getTask(db, taskId))!;
  assert.equal(task.project_id, projectId);
  assert.equal(task.title, "直す");
  assert.equal(task.prompt, `# 直す\n\n${PARENT_URL}\n\n本文`);
  assert.equal(task.workflow_name, "feature");
  assert.equal(task.workflow_yaml, DIRECT_WORKFLOW);
  assert.equal(task.issue_url, PARENT_URL);
  assert.equal(task.parent_issue_url, null);
  assert.equal(task.intake_id, "d1");
  assert.equal(task.intake_process_id, "main");
});

test("direct: タスクを入れられなければ、Intake もプロセスも残らない", async () => {
  const { db } = await seedDirect();
  const project = {
    ...(await db.selectFrom("projects").selectAll().executeTakeFirstOrThrow()),
    id: 9999,
  };
  const loaded = await fakeWorkflowLoader(DIRECT_WORKFLOW)("/repo", "feature");
  await assert.rejects(() =>
    insertDirectIntake(db, {
      intake: {
        id: "d2",
        workspace_id: project.workspace_id,
        issue_url: "https://github.com/o/r/issues/2",
        issue_node_id: "I_2",
        issue_title: "別",
      },
      project,
      issue: { url: "https://github.com/o/r/issues/2", title: "別", body: "" },
      pin: { workflow_yaml: loaded.text, workflow_setup: null },
    }),
  );
  assert.equal(await getIntake(db, "d2"), undefined);
  assert.deepEqual(await listProcesses(db, "d2"), []);
});

test("direct: intake.get はプロセス main 1 つと帯を返し、PR のマージで merged になる", async () => {
  const { db, taskId } = await seedDirect();
  const loader = fakeWorkflowLoader(DIRECT_WORKFLOW);
  const before = await toIntakeDetail(
    db,
    (await getIntake(db, "d1"))!,
    INITIAL_WATCH_HEALTH,
    loader,
  );
  assert.equal(before.mode, "direct");
  assert.equal(before.approval, null);
  assert.deepEqual(before.progress, { done: 0, total: 1 });
  assert.equal(before.needs_human, false);
  const main = before.processes[0];
  assert.equal(before.processes.length, 1);
  assert.equal(main.id, "main");
  assert.equal(main.state, "running");
  assert.equal(main.sub_issue_url, null);
  assert.deepEqual(main.task_ids, [taskId]);
  assert.deepEqual(
    main.rail!.map((n) => n.id),
    ["a", "review"],
  );

  await upsertPrObservation(db, {
    task_id: taskId,
    pr_number: 7,
    pr_url: "https://github.com/o/r/pull/7",
    state: "MERGED",
    base_ref: "main",
    merged_at: "2026-10-14T00:00:00.000Z",
    merge_commit: "c7",
  });
  const after = await toIntakeDetail(
    db,
    (await getIntake(db, "d1"))!,
    INITIAL_WATCH_HEALTH,
    loader,
  );
  assert.equal(after.processes[0].state, "merged");
  assert.deepEqual(after.progress, { done: 1, total: 1 });
});

test("direct: タスクが止まると要確認になり、needs_human が立つ", async () => {
  const { db, taskId } = await seedDirect();
  await db.updateTable("tasks").set({ state: "failed" }).where("id", "=", taskId).execute();
  const detail = await toIntakeDetail(
    db,
    (await getIntake(db, "d1"))!,
    INITIAL_WATCH_HEALTH,
    fakeWorkflowLoader(DIRECT_WORKFLOW),
  );
  const main = detail.processes[0];
  assert.equal(main.state, "needs_attention");
  assert.equal("reason" in main && main.reason, "task_stopped");
  assert.equal(detail.needs_human, true);
});

async function startDirect(loadWorkflow = fakeWorkflowLoader(DIRECT_WORKFLOW)) {
  const db = await openDb(":memory:");
  const project = await seedProject(db, { path: "/repo", default_workflow: "feature" });
  const wt = {
    tracker: fakeTracker({ title: "直す", body: "本文" }),
    projectPathFor: () => Promise.resolve("/repo"),
  };
  const started = () =>
    startIntake(
      db,
      wt,
      {
        workspaceId: project.workspace_id,
        issueUrl: PARENT_URL,
        logRoot: "/tmp/doctrine-test-logs",
        mode: "direct",
      },
      { loadWorkflow },
    );
  return { db, started };
}

test("startIntake: direct は調査を立てず、Intake・プロセス・タスクを作る", async () => {
  const { db, started } = await startDirect();
  const { intake, alreadyActive } = await started();
  assert.equal(alreadyActive, false);
  assert.equal(intake.state, "active");
  assert.equal(intake.mode, "direct");
  assert.deepEqual(await db.selectFrom("intake_runs").selectAll().execute(), []);
  const [main] = await listProcesses(db, intake.id);
  assert.equal((await getTask(db, main.current_task_id!))!.title, "直す");
});

test("startIntake: ワークフローを読めなければ direct の開始は失敗し、何も作らない", async () => {
  const { db, started } = await startDirect(() => Promise.reject(new Error("YAML が壊れている")));
  await assert.rejects(started, /YAML が壊れている/);
  assert.deepEqual(await db.selectFrom("intakes").selectAll().execute(), []);
  assert.deepEqual(await db.selectFrom("tasks").selectAll().execute(), []);
});

test("startIntake: 同じ Issue の direct がまだ終わっていなければ、それを返す", async () => {
  const { started } = await startDirect();
  const first = await started();
  const second = await started();
  assert.equal(second.alreadyActive, true);
  assert.equal(second.intake.id, first.intake.id);
});

async function watchDirect() {
  const seeded = await seedDirect();
  const ft = statefulTracker();
  const pw = fakePrWatcher();
  const transitions: IntakeTransition[] = [];
  const watcher = createIntakeWatcher({
    db: seeded.db,
    trackerOf: constTrackerOf(ft.tracker),
    prWatcher: pw.prWatcher,
    baseSync: fakeBaseSync().baseSync,
    loadWorkflow: fakeWorkflowLoader(DIRECT_WORKFLOW),
    onStateChanged: (t) => transitions.push(t),
    onUpdated: () => {},
  });
  return { ...seeded, ft, pw, watcher, transitions };
}

const merged = (baseRef: string) => ({
  number: 7,
  url: "https://github.com/o/r/pull/7",
  state: "MERGED" as const,
  baseRef,
  mergedAt: "2026-10-14T00:00:00.000Z",
  mergeCommit: "c7",
});

test("見張り: direct は sub-issue を作らず、PR のマージで completed にする", async () => {
  const s = await watchDirect();
  await s.watcher.request(s.workspaceId);
  assert.equal((await getIntake(s.db, "d1"))!.state, "active");
  assert.equal(s.ft.calls.filter((c) => c.op === "createSubIssue").length, 0);

  const task = (await getTask(s.db, s.taskId))!;
  s.pw.prs.set(task.branch, [merged("main")]);
  await s.watcher.request(s.workspaceId);
  const row = (await getIntake(s.db, "d1"))!;
  assert.equal(row.state, "completed");
  assert.notEqual(row.ended_at, null);
  assert.deepEqual(
    s.transitions.map((t) => [t.from, t.to]),
    [["active", "completed"]],
  );
  assert.equal((await listTasks(s.db)).length, 1);
});

test("見張り: direct の PR が base_branch 以外へマージされても完了にしない", async () => {
  const s = await watchDirect();
  const task = (await getTask(s.db, s.taskId))!;
  s.pw.prs.set(task.branch, [merged("release")]);
  await s.watcher.request(s.workspaceId);
  assert.equal((await getIntake(s.db, "d1"))!.state, "active");
  assert.deepEqual(s.transitions, []);
});

const DEPS = { loadWorkflow: fakeWorkflowLoader(DIRECT_WORKFLOW) };

test("direct: 止まったタスクを再投入すると、同じプロセス main に新しいタスクができ、古いタスクは残る", async () => {
  const { db, taskId } = await seedDirect();
  await db.updateTable("tasks").set({ state: "failed" }).where("id", "=", taskId).execute();
  const { taskId: next, replacedTaskId } = await redispatchProcess(
    db,
    { intakeId: "d1", processId: "main" },
    DEPS,
  );
  assert.equal(replacedTaskId, taskId);
  assert.notEqual(next, taskId);
  const task = (await getTask(db, next))!;
  assert.equal(task.title, "直す");
  assert.equal(task.prompt, `# 直す\n\n${PARENT_URL}\n\n本文`);
  assert.equal(task.issue_url, PARENT_URL);
  assert.equal(task.parent_issue_url, null);
  assert.equal(task.intake_process_id, "main");
  assert.equal((await listProcesses(db, "d1"))[0].current_task_id, next);
  assert.equal((await getTask(db, taskId))!.intake_process_id, "main");
});

test("direct: 走っているタスクは再投入できない", async () => {
  const { db } = await seedDirect();
  await assert.rejects(
    () => redispatchProcess(db, { intakeId: "d1", processId: "main" }, DEPS),
    /要確認のプロセスだけを再投入できます: main（running）/,
  );
});

test("direct: 改訂・自動投入の一時停止・人の完了は拒まれ、状態は変わらない", async () => {
  const { db } = await seedDirect();
  await assert.rejects(
    () => reviseIntake(db, { intakeId: "d1", comments: [], logRoot: "/tmp/x" }),
    /direct の Intake は改訂できません/,
  );
  await assert.rejects(
    () => setDispatchPaused(db, { intakeId: "d1", paused: true }),
    /direct の Intake には自動投入がありません/,
  );
  await assert.rejects(
    () => completeHumanProcess(db, { intakeId: "d1", processId: "main", note: "x" }),
    /人のプロセスではありません/,
  );
  const row = (await getIntake(db, "d1"))!;
  assert.equal(row.state, "active");
  assert.equal(row.revising, 0);
  assert.equal(row.dispatch_paused, 0);
});
