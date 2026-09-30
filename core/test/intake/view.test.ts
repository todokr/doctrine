import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { getIntake, replaceCurrentTask, upsertPrObservation } from "../../src/db/intakes.ts";
import { insertProject, insertTask, type NewTask } from "../../src/db/tasks.ts";
import { needsHuman, toIntakeDetail } from "../../src/intake/view.ts";
import { INITIAL_WATCH_HEALTH } from "../../src/intake/watch.ts";
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
  for (
    const s of ["investigating", "decomposing", "completed", "canceled"] as IntakeState[]
  ) {
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

  const detail = await toIntakeDetail(db, (await getIntake(db, "i1"))!, INITIAL_WATCH_HEALTH);
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

  const detail = await toIntakeDetail(db, (await getIntake(db, "i1"))!, INITIAL_WATCH_HEALTH);
  assert.equal(detail.processes.find((p) => p.id === "1")!.state, "merged");
  assert.equal(detail.processes.find((p) => p.id === "2")!.state, "merged");
  const p4 = detail.processes.find((p) => p.id === "4")!;
  assert.equal(p4.state, "needs_attention");
  assert.equal((p4 as { reason: string }).reason, "pr_closed");
  assert.equal(detail.progress.done, 2);
});
