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
import type { Db } from "../../src/db/schema.ts";
import { getTask, insertTask, listTasks, type NewTask } from "../../src/db/tasks.ts";
import { commitDispatch, dispatchIntake } from "../../src/intake/dispatch.ts";
import { example, withDecision } from "./pfd/fixture.ts";
import { question } from "./runnerHelper.ts";
import { PARENT_URL, seedActive } from "./watchFixture.ts";

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
  const first = await dispatchIntake(db, "i1");
  assert.deepEqual(first.created.map((c) => c.processId), ["1"]);
  const second = await dispatchIntake(db, "i1");
  assert.deepEqual(second.created, []);
  const tasks = (await listTasks(db)).filter((t) => t.intake_process_id === "1");
  assert.equal(tasks.length, 1);
});

test("sub-issue の無いプロセスは投入しない", async () => {
  const { db } = await seedActive();
  const report = await dispatchIntake(db, "i1");
  assert.deepEqual(report.created, []);
  assert.equal((await listTasks(db)).length, 0);
});

test("承認の後に案の本文が書き換わっていれば投入しない", async () => {
  const { db } = await seedActive();
  await giveSubIssues(db);
  await db.updateTable("intake_drafts").set({ pfd: "{}" }).execute();
  await assert.rejects(dispatchIntake(db, "i1"), /承認/);
  assert.equal((await listTasks(db)).length, 0);
});

test("active でない Intake は投入しない", async () => {
  const { db } = await seedActive();
  await giveSubIssues(db);
  await updateIntake(db, "i1", { state: "reviewing" });
  const report = await dispatchIntake(db, "i1");
  assert.deepEqual(report.created, []);
});

test("決定の成果物の回答を prompt に載せる", async () => {
  const { db, projectId, runId } = await seedActive(withDecision());
  const setId = await insertQuestionSet(db, {
    intake_id: "i1",
    run_id: runId,
    questions: JSON.stringify([question("q1")]),
  });
  await answerQuestionSet(
    db,
    setId,
    JSON.stringify([{ questionId: "q1", optionIds: ["a"], other: null, note: null }]),
  );
  await makeProcess2Ready(db, projectId);
  const report = await dispatchIntake(db, "i1");
  assert.deepEqual(report.created.map((c) => c.processId), ["2"]);
  const task = (await getTask(db, report.created[0].taskId))!;
  assert.match(task.prompt, /集計の方針: 選んだ選択肢: 案A（a）/);
});

test("prompt を組めないプロセスは見送り、ほかのプロセスは投入する", async () => {
  const { db, projectId } = await seedActive(withDecision());
  await makeProcess2Ready(db, projectId);
  const report = await dispatchIntake(db, "i1");
  assert.equal(report.created.some((c) => c.processId === "2"), false);
  assert.equal(report.errors.length, 1);
  assert.equal(report.errors[0].processId, "2");
  assert.match(report.errors[0].message, /決定/);
});

test("example() の分解では、承認直後に投入できるのはプロセス 1 だけ", async () => {
  const { db } = await seedActive(example());
  await giveSubIssues(db);
  const report = await dispatchIntake(db, "i1");
  assert.deepEqual(report.created.map((c) => c.processId), ["1"]);
});
