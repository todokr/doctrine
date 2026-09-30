import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import {
  answerQuestionSet,
  insertQuestionSet,
  replaceCurrentTask,
  updateIntake,
  updateProcess,
  upsertPrObservation,
} from "../../src/db/intakes.ts";
import { commitStepBoundary } from "../../src/db/boundary.ts";
import type { Db } from "../../src/db/schema.ts";
import { getTask, insertProject, insertTask, listTasks, type NewTask } from "../../src/db/tasks.ts";
import { commitDispatch, dispatchIntake, redispatchProcess } from "../../src/intake/dispatch.ts";
import { example, withDecision } from "./pfd/fixture.ts";
import { question } from "./runnerHelper.ts";
import { PARENT_URL, seedActive } from "./watchFixture.ts";
import { fakeWorkflowLoader } from "../helpers/watcher.ts";
import type { WorkflowLoader } from "../../src/workflow/load.ts";
import type { Pfd } from "../../../shared/intake/pfd.ts";

const DEPS = { loadWorkflow: fakeWorkflowLoader() };

/** api という名前のプロジェクトを同じ workspace に足す。 */
async function addApi(db: Db, workspaceId: number): Promise<number> {
  return await insertProject(db, {
    workspace_id: workspaceId,
    name: "api",
    path: "/api",
    default_workflow: "api-flow",
    max_concurrent: 1,
    base_branch: "develop",
    setup: null,
  });
}

/** (path, name) を記録し、/repo なら REPO_YAML、/api なら API_YAML を返すローダー。 */
function recordingLoader() {
  const REPO_YAML = 'name: feature\nsteps:\n  - id: a\n    type: command\n    run: "true"\n';
  const API_YAML = 'name: api-flow\nsteps:\n  - id: a\n    type: command\n    run: "true"\n';
  const calls: [string, string][] = [];
  const loadWorkflow: WorkflowLoader = (path, name) => {
    calls.push([path, name]);
    const text = path === "/api" ? API_YAML : REPO_YAML;
    return fakeWorkflowLoader(text)(path, name);
  };
  return { loadWorkflow, calls, REPO_YAML, API_YAML };
}

/** example() にプロセス 5（project: api）と成果物 extra を足す。 */
function withProcess5(pfd: Pfd): Pfd {
  pfd.processes.push({
    id: "5",
    name: "追加の API を実装する",
    actor: "agent",
    project: "api",
    inputs: ["schema"],
    outputs: ["extra"],
    purpose: "追加のデータを外から読めるようにする",
    steps: "GET /extra を足す",
    done_when: "API のテストが通る",
  });
  pfd.artifacts.push({
    id: "extra",
    name: "追加 API",
    given: false,
    description: "追加のデータを返す GET /extra",
    verify: "API のテストが通る",
  });
  return pfd;
}

const SUB = (n: number) => `https://github.com/o/r/issues/${100 + n}`;

async function giveSubIssues(db: Db, ids = ["1", "2", "3", "4"]): Promise<void> {
  for (const id of ids) await updateProcess(db, "i1", id, { sub_issue_url: SUB(Number(id)) });
}

function newTask(id: string, projectId: number, processId = "1"): NewTask {
  return {
    id,
    project_id: projectId,
    title: "t",
    prompt: "p",
    workflow_name: "feature",
    branch: `doctrine/${id}`,
    priority: 2,
    intake_id: "i1",
    intake_process_id: processId,
    issue_url: SUB(Number(processId)),
    parent_issue_url: PARENT_URL,
  };
}

/** プロセス 1 をマージ済み、3 を完了にして、2 が ready になる状態を作る。 */
async function makeProcess2Ready(db: Db, projectId: number): Promise<void> {
  await insertTask(db, newTask("t1", projectId));
  await replaceCurrentTask(db, "i1", "1", null, "t1");
  await upsertPrObservation(db, {
    task_id: "t1",
    pr_number: 5,
    pr_url: "https://github.com/o/r/pull/5",
    state: "MERGED",
    base_ref: "main",
    merged_at: "2026-09-21T00:00:00.000Z",
    merge_commit: "abc",
  });
  await updateProcess(db, "i1", "3", {
    human_note: "ログイン 1 回を 1 利用と数える",
    human_done_at: "2026-09-21T00:00:00.000Z",
  });
  await giveSubIssues(db, ["2"]);
}

test("二重投入: 同じ期待値で 2 回コミットすると 2 回目は巻き戻り、タスクは 1 つだけ残る", async () => {
  const { db, projectId } = await seedActive();
  const a = newTask("A", projectId);
  const b = newTask("B", projectId);
  const args = { intakeId: "i1", processId: "1", expectedTaskId: null };
  assert.equal(await commitDispatch(db, { ...args, task: a }), true);
  assert.equal(await commitDispatch(db, { ...args, task: b }), false);
  assert.equal(await getTask(db, b.id), undefined);
  const row = await db.selectFrom("intake_processes").select("current_task_id")
    .where("process_id", "=", "1").executeTakeFirstOrThrow();
  assert.equal(row.current_task_id, a.id);
});

test("投入の直後に落ちた想定で dispatchIntake を再実行しても、同じプロセスのタスクは 1 つ", async () => {
  const { db } = await seedActive();
  await giveSubIssues(db);
  const first = await dispatchIntake(db, "i1", DEPS);
  assert.deepEqual(first.created.map((c) => c.processId), ["1"]);
  const second = await dispatchIntake(db, "i1", DEPS);
  assert.deepEqual(second.created, []);
  const tasks = (await listTasks(db)).filter((t) => t.intake_process_id === "1");
  assert.equal(tasks.length, 1);
});

test("sub-issue の無いプロセスは投入しない", async () => {
  const { db } = await seedActive();
  const report = await dispatchIntake(db, "i1", DEPS);
  assert.deepEqual(report.created, []);
  assert.equal((await listTasks(db)).length, 0);
});

test("承認の後に案の本文が書き換わっていれば投入しない", async () => {
  const { db } = await seedActive();
  await giveSubIssues(db);
  await db.updateTable("intake_drafts").set({ pfd: "{}" }).execute();
  await assert.rejects(dispatchIntake(db, "i1", DEPS), /承認/);
  assert.equal((await listTasks(db)).length, 0);
});

test("active でない Intake は投入しない", async () => {
  const { db } = await seedActive();
  await giveSubIssues(db);
  await updateIntake(db, "i1", { state: "reviewing" });
  const report = await dispatchIntake(db, "i1", DEPS);
  assert.deepEqual(report.created, []);
});

test("決定の成果物の回答を prompt に載せる", async () => {
  const { db, projectId, runId } = await seedActive(withDecision());
  const setId = await insertQuestionSet(db, {
    intake_id: "i1",
    run_id: runId,
    questions: JSON.stringify([question("q1")]),
    assumptions: "[]",
  });
  await answerQuestionSet(db, setId, {
    answers: JSON.stringify([{ questionId: "q1", optionIds: ["a"], other: null, note: null }]),
    assumption_responses: "[]",
  });
  await makeProcess2Ready(db, projectId);
  const report = await dispatchIntake(db, "i1", DEPS);
  assert.deepEqual(report.created.map((c) => c.processId), ["2"]);
  const task = (await getTask(db, report.created[0].taskId))!;
  assert.match(task.prompt, /集計の方針: 選んだ選択肢: 案A（a）/);
});

test("prompt を組めないプロセスは見送り、ほかのプロセスは投入する", async () => {
  const { db, projectId } = await seedActive(withDecision());
  await makeProcess2Ready(db, projectId);
  const report = await dispatchIntake(db, "i1", DEPS);
  assert.equal(report.created.some((c) => c.processId === "2"), false);
  assert.equal(report.errors.length, 1);
  assert.equal(report.errors[0].processId, "2");
  assert.match(report.errors[0].message, /決定/);
});

test("example() の分解では、承認直後に投入できるのはプロセス 1 だけ", async () => {
  const { db } = await seedActive(example());
  await giveSubIssues(db);
  const report = await dispatchIntake(db, "i1", DEPS);
  assert.deepEqual(report.created.map((c) => c.processId), ["1"]);
});

/** プロセス 1 を投入して、そのタスクを failed にする。 */
async function failProcess1(db: Db): Promise<string> {
  await giveSubIssues(db);
  const report = await dispatchIntake(db, "i1", DEPS);
  const taskId = report.created[0].taskId;
  await commitStepBoundary(db, { taskId, taskPatch: { state: "failed" } });
  return taskId;
}

test("要確認のプロセスを再投入すると、同じプロセスと sub-issue に紐づく新しいタスクができ、古いタスクは残る", async () => {
  const { db } = await seedActive();
  const oldId = await failProcess1(db);

  const { taskId } = await redispatchProcess(db, { intakeId: "i1", processId: "1" }, DEPS);

  const tasks = await listTasks(db);
  assert.equal(tasks.length, 2);
  for (const t of tasks) {
    assert.equal(t.intake_process_id, "1");
    assert.equal(t.issue_url, SUB(1));
  }
  const row = await db.selectFrom("intake_processes").select("current_task_id")
    .where("process_id", "=", "1").executeTakeFirstOrThrow();
  assert.equal(row.current_task_id, taskId);
  assert.notEqual(taskId, oldId);
  assert.equal((await getTask(db, oldId))!.state, "failed");
});

test("要確認でないプロセスは再投入できない", async () => {
  const { db } = await seedActive();
  await giveSubIssues(db);
  await dispatchIntake(db, "i1", DEPS);
  for (const processId of ["1", "2", "3"]) {
    await assert.rejects(
      redispatchProcess(db, { intakeId: "i1", processId }, DEPS),
      /要確認のプロセスだけ/,
    );
  }
  assert.equal((await listTasks(db)).length, 1);
});

test("一時停止中でも再投入できる", async () => {
  const { db } = await seedActive();
  await failProcess1(db);
  await updateIntake(db, "i1", { dispatch_paused: 1 });
  await redispatchProcess(db, { intakeId: "i1", processId: "1" }, DEPS);
  assert.equal((await listTasks(db)).length, 2);
});

test("active でない Intake では再投入できない", async () => {
  const { db } = await seedActive();
  await failProcess1(db);
  await updateIntake(db, "i1", { state: "canceled" });
  await assert.rejects(
    redispatchProcess(db, { intakeId: "i1", processId: "1" }, DEPS),
    /再投入できる状態ではありません/,
  );
  assert.equal((await listTasks(db)).length, 1);
});

test("投入したタスクは既定のワークフローの YAML の中身と project の setup を保存する", async () => {
  const Y = 'name: y\nsteps:\n  - id: a\n    type: command\n    run: "true"\n';
  {
    const { db } = await seedActive();
    await giveSubIssues(db);
    const report = await dispatchIntake(db, "i1", { loadWorkflow: fakeWorkflowLoader(Y) });
    const task = (await getTask(db, report.created[0].taskId))!;
    assert.equal(task.workflow_yaml, Y);
    assert.equal(task.workflow_setup, null);
  }
  {
    const { db, projectId } = await seedActive();
    await db.updateTable("projects").set({ setup: "echo hi" }).where("id", "=", projectId)
      .execute();
    await giveSubIssues(db);
    const report = await dispatchIntake(db, "i1", { loadWorkflow: fakeWorkflowLoader(Y) });
    const task = (await getTask(db, report.created[0].taskId))!;
    assert.equal(task.workflow_setup, "echo hi");
  }
});

test("再投入したタスクも作成時の定義を保存する", async () => {
  const { db } = await seedActive();
  const oldId = await failProcess1(db);
  const Y2 = 'name: y2\nsteps:\n  - id: b\n    type: command\n    run: "true"\n';
  const { taskId } = await redispatchProcess(db, { intakeId: "i1", processId: "1" }, {
    loadWorkflow: fakeWorkflowLoader(Y2),
  });
  assert.equal((await getTask(db, taskId))!.workflow_yaml, Y2);
  assert.notEqual((await getTask(db, oldId))!.workflow_yaml, Y2);
});

test("ワークフローが読めなければ投入せず、タスクを作らない", async () => {
  const { db } = await seedActive();
  await giveSubIssues(db);
  await assert.rejects(
    dispatchIntake(db, "i1", {
      loadWorkflow: () => Promise.reject(new Error("ワークフローがありません: x")),
    }),
    /ワークフロー/,
  );
  assert.equal((await listTasks(db)).length, 0);
});

test("ready なプロセスを、それぞれの project のプロジェクトに、そのプロジェクトのワークフローで作る", async () => {
  const { db, projectId, workspaceId } = await seedActive(withProcess5(example()));
  const apiId = await addApi(db, workspaceId);
  await giveSubIssues(db, ["1", "5"]);
  const loader = recordingLoader();
  const report = await dispatchIntake(db, "i1", { loadWorkflow: loader.loadWorkflow });
  assert.deepEqual(report.created.map((c) => c.processId).sort(), ["1", "5"]);

  const repoTask = (await getTask(db, report.created.find((c) => c.processId === "1")!.taskId))!;
  assert.equal(repoTask.project_id, projectId);
  assert.equal(repoTask.workflow_name, "feature");
  assert.equal(repoTask.workflow_yaml, loader.REPO_YAML);
  const apiTask = (await getTask(db, report.created.find((c) => c.processId === "5")!.taskId))!;
  assert.equal(apiTask.project_id, apiId);
  assert.equal(apiTask.workflow_name, "api-flow");
  assert.equal(apiTask.workflow_yaml, loader.API_YAML);
  assert.deepEqual(
    loader.calls.sort((a, b) => a[0].localeCompare(b[0])),
    [["/api", "api-flow"], ["/repo", "feature"]],
  );
  assert.equal(loader.calls.length, 2);
});

test("上流が自分のプロジェクトの baseBranch にマージされると、下流を別のプロジェクトに作る", async () => {
  const pfd = example();
  pfd.processes.find((p) => p.id === "2")!.project = "api";
  const { db, projectId, workspaceId } = await seedActive(pfd);
  await addApi(db, workspaceId);
  await makeProcess2Ready(db, projectId);
  const report = await dispatchIntake(db, "i1", DEPS);
  assert.deepEqual(report.created.map((c) => c.processId), ["2"]);
  const task = (await getTask(db, report.created[0].taskId))!;
  assert.equal(task.workflow_name, "api-flow");
});

test("project の無い agent のプロセスは errors に入れて見送り、ほかは作る", async () => {
  const pfd = withProcess5(example());
  pfd.processes[0].project = undefined;
  const { db, workspaceId } = await seedActive(pfd);
  await addApi(db, workspaceId);
  await giveSubIssues(db, ["1", "5"]);
  const report = await dispatchIntake(db, "i1", DEPS);
  assert.deepEqual(report.created.map((c) => c.processId), ["5"]);
  assert.equal(report.errors.length, 1);
  assert.equal(report.errors[0].processId, "1");
  assert.match(report.errors[0].message, /project がありません/);
  const tasks = (await listTasks(db)).filter((t) => t.intake_process_id === "1");
  assert.equal(tasks.length, 0);
});

test("workspace から外されたプロジェクトのプロセスは errors に入れて見送る", async () => {
  const { db, projectId } = await seedActive();
  await db.updateTable("projects").set({ name: "renamed" }).where("id", "=", projectId).execute();
  await giveSubIssues(db);
  const report = await dispatchIntake(db, "i1", DEPS);
  assert.deepEqual(report.created, []);
  assert.deepEqual(report.errors, [{
    processId: "1",
    message: "プロジェクト repo は workspace にありません",
  }]);
  assert.equal((await listTasks(db)).length, 0);
});

test("見送るプロセスだけなら、ワークフローを読まない", async () => {
  const { db, projectId } = await seedActive();
  await db.updateTable("projects").set({ name: "renamed" }).where("id", "=", projectId).execute();
  await giveSubIssues(db);
  const loader = recordingLoader();
  await dispatchIntake(db, "i1", { loadWorkflow: loader.loadWorkflow });
  assert.equal(loader.calls.length, 0);
});

test("再投入のタスクもプロセスのプロジェクトに作る", async () => {
  const pfd = example();
  pfd.processes.find((p) => p.id === "1")!.project = "api";
  const { db, workspaceId } = await seedActive(pfd);
  await addApi(db, workspaceId);
  const oldId = await failProcess1(db);
  const loader = recordingLoader();
  const { taskId } = await redispatchProcess(db, { intakeId: "i1", processId: "1" }, {
    loadWorkflow: loader.loadWorkflow,
  });
  const task = (await getTask(db, taskId))!;
  assert.equal(task.workflow_yaml, loader.API_YAML);
  assert.deepEqual(loader.calls, [["/api", "api-flow"]]);
  assert.notEqual(taskId, oldId);
});

test("workspace から外されたプロジェクトのプロセスは再投入できない", async () => {
  const { db, projectId } = await seedActive();
  await failProcess1(db);
  await db.updateTable("projects").set({ name: "renamed" }).where("id", "=", projectId).execute();
  await assert.rejects(
    redispatchProcess(db, { intakeId: "i1", processId: "1" }, DEPS),
    /repo は workspace にありません/,
  );
  assert.equal((await listTasks(db)).length, 1);
});
