import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { getIntake, listProcesses, upsertPrObservation } from "../../src/db/intakes.ts";
import { getTask } from "../../src/db/tasks.ts";
import { insertDirectIntake } from "../../src/intake/dispatch.ts";
import { toIntakeDetail } from "../../src/intake/view.ts";
import { INITIAL_WATCH_HEALTH } from "../../src/intake/watch.ts";
import { fakeWorkflowLoader } from "../helpers/watcher.ts";
import { DIRECT_WORKFLOW, PARENT_URL, seedDirect } from "./watchFixture.ts";

test("direct: Intake は active で、プロセス main とタスク 1 本を持つ", async () => {
  const { db, projectId, taskId } = await seedDirect();
  const intake = (await getIntake(db, "d1"))!;
  assert.equal(intake.mode, "direct");
  assert.equal(intake.state, "active");
  const rows = await listProcesses(db, "d1");
  assert.deepEqual(rows.map((r) => [r.process_id, r.sub_issue_url]), [["main", null]]);
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
    })
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
  assert.deepEqual(main.rail!.map((n) => n.id), ["a", "review"]);

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
