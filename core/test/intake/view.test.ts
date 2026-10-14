import { test } from "node:test";
import assert from "node:assert/strict";
import { getIntake, replaceCurrentTask, upsertPrObservation } from "../../src/db/intakes.ts";
import { insertProject, insertTask, type NewTask } from "../../src/db/tasks.ts";
import { needsHuman, toIntakeDetail } from "../../src/intake/view.ts";
import { INITIAL_WATCH_HEALTH } from "../../src/intake/watch.ts";
import { loadWorkflowFromDisk } from "../../src/workflow/load.ts";
import { fakeWorkflowLoader } from "../helpers/watcher.ts";
import { example } from "./pfd/fixture.ts";
import { PARENT_URL, seedActive } from "./watchFixture.ts";
import type { IntakeState } from "../../../shared/intake/state.ts";
import type { ProcessStatus } from "../../../shared/intake/processStatus.ts";

test("人の入力を待つ状態は needsHuman になる", () => {
  for (const s of ["answering", "reviewing", "needs_attention"] as IntakeState[]) {
    assert.equal(needsHuman(s, []), true, s);
  }
});

test("投入前後の状態は、プロセスの状態によらず needsHuman にならない", () => {
  const statuses: ProcessStatus[] = [{ state: "your_turn" }];
  for (const s of ["investigating", "decomposing", "completed", "canceled"] as IntakeState[]) {
    assert.equal(needsHuman(s, statuses), false, s);
  }
});

test("active は、あなたの番か要確認のプロセスがあるときだけ needsHuman になる", () => {
  assert.equal(needsHuman("active", [{ state: "waiting", missing: ["x"] }]), false);
  assert.equal(needsHuman("active", []), false);
  assert.equal(needsHuman("active", [{ state: "your_turn" }]), true);
  assert.equal(
    needsHuman("active", [{ state: "needs_attention", taskId: "t", reason: "no_pr" }]),
    true,
  );
});

function newTaskFor(id: string, projectId: number, processId: string): NewTask {
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
    issue_url: `https://github.com/o/r/issues/${100 + Number(processId)}`,
    parent_issue_url: PARENT_URL,
  };
}

async function mergeTask(
  db: Parameters<typeof getIntake>[0],
  taskId: string,
  baseRef: string,
): Promise<void> {
  await upsertPrObservation(db, {
    task_id: taskId,
    pr_number: Number(taskId.slice(1)) || 1,
    pr_url: `https://github.com/o/r/pull/${taskId}`,
    state: "MERGED",
    base_ref: baseRef,
    merged_at: "2026-09-21T00:00:00.000Z",
    merge_commit: `commit-${taskId}`,
  });
}

test("プロジェクトが 2 つある workspace でも、承認後のプロセスの状態を返す", async () => {
  const pfd = example();
  pfd.processes.find((p) => p.id === "2")!.project = "api";
  pfd.processes.find((p) => p.id === "4")!.project = "api";
  const { db, workspaceId } = await seedActive(pfd);
  await insertProject(db, {
    workspace_id: workspaceId,
    name: "api",
    path: "/api",
    default_workflow: "api-flow",
    max_concurrent: 1,
    base_branch: "develop",
    setup: null,
  });

  const detail = await toIntakeDetail(
    db,
    (await getIntake(db, "i1"))!,
    INITIAL_WATCH_HEALTH,
    loadWorkflowFromDisk,
  );
  assert.equal(detail.processes.length, 4);
  assert.equal(detail.processes.find((p) => p.id === "1")!.state, "ready");
  assert.equal(detail.processes.find((p) => p.id === "3")!.state, "your_turn");
  assert.equal(detail.progress.total, 4);
});

test("merged は、プロセスごとにそのプロジェクトの baseBranch で判定する", async () => {
  const pfd = example();
  pfd.processes.find((p) => p.id === "2")!.project = "api";
  pfd.processes.find((p) => p.id === "4")!.project = "api";
  const { db, projectId, workspaceId } = await seedActive(pfd);
  const apiId = await insertProject(db, {
    workspace_id: workspaceId,
    name: "api",
    path: "/api",
    default_workflow: "api-flow",
    max_concurrent: 1,
    base_branch: "develop",
    setup: null,
  });

  await insertTask(db, newTaskFor("t1", projectId, "1"));
  await replaceCurrentTask(db, "i1", "1", null, "t1");
  await mergeTask(db, "t1", "main");

  await insertTask(db, newTaskFor("t2", apiId, "2"));
  await replaceCurrentTask(db, "i1", "2", null, "t2");
  await mergeTask(db, "t2", "develop");

  await insertTask(db, newTaskFor("t4", apiId, "4"));
  await replaceCurrentTask(db, "i1", "4", null, "t4");
  await mergeTask(db, "t4", "main");

  const detail = await toIntakeDetail(
    db,
    (await getIntake(db, "i1"))!,
    INITIAL_WATCH_HEALTH,
    loadWorkflowFromDisk,
  );
  assert.equal(detail.processes.find((p) => p.id === "1")!.state, "merged");
  assert.equal(detail.processes.find((p) => p.id === "2")!.state, "merged");
  const p4 = detail.processes.find((p) => p.id === "4")!;
  assert.equal(p4.state, "needs_attention");
  assert.equal((p4 as { reason: string }).reason, "pr_closed");
  assert.equal(detail.progress.done, 2);
});

const RAIL_YAML =
  'name: feature\nsteps:\n  - id: a\n    type: command\n    run: "true"\n  - id: review\n    type: approval\n    title: 見て\n';

test("プロセスのいまのタスクの帯を、pin されたワークフローと step_runs から組む", async () => {
  const { db, projectId } = await seedActive();
  await insertTask(db, {
    ...newTaskFor("t1", projectId, "1"),
    workflow_yaml: RAIL_YAML,
    workflow_setup: null,
  });
  await replaceCurrentTask(db, "i1", "1", null, "t1");
  await db.updateTable("tasks").set({ current_step_id: "review" }).where("id", "=", "t1").execute();
  for (const step_id of ["a", "gone"]) {
    await db
      .insertInto("step_runs")
      .values({
        task_id: "t1",
        step_id,
        attempt: 1,
        status: "success",
        exit_code: 0,
        started_at: "2026-10-14T00:00:00.000Z",
        ended_at: "2026-10-14T00:01:00.000Z",
        log_path: "",
        review_tree: null,
        goto_step_id: null,
      })
      .execute();
  }

  const detail = await toIntakeDetail(
    db,
    (await getIntake(db, "i1"))!,
    INITIAL_WATCH_HEALTH,
    fakeWorkflowLoader(RAIL_YAML),
  );
  const rail = detail.processes.find((p) => p.id === "1")!.rail!;
  assert.deepEqual(
    rail.map((n) => [n.id, n.status, n.current, n.unknown]),
    [
      ["a", "success", false, false],
      ["review", "pending", true, false],
      ["gone", "success", false, true],
    ],
  );
  assert.equal(detail.processes.find((p) => p.id === "2")!.rail, null);
});

test("ワークフローを読めないタスクの帯は null で、intake.get は失敗しない", async () => {
  const { db, projectId } = await seedActive();
  await insertTask(db, newTaskFor("t1", projectId, "1"));
  await replaceCurrentTask(db, "i1", "1", null, "t1");
  const detail = await toIntakeDetail(db, (await getIntake(db, "i1"))!, INITIAL_WATCH_HEALTH, () =>
    Promise.reject(new Error("読めない")),
  );
  assert.equal(detail.processes.find((p) => p.id === "1")!.rail, null);
});
