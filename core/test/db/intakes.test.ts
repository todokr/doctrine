import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { openDb } from "../../src/db/migrate.ts";
import { insertProject, insertTask } from "../../src/db/tasks.ts";
import {
  answerQuestionSet,
  findOpenIntakeByIssue,
  getDraft,
  getIntake,
  getIntakeRun,
  getPrObservation,
  insertApproval,
  insertComments,
  insertDraft,
  insertIntake,
  insertIntakeRun,
  insertProcesses,
  insertQuestionSet,
  IntakeStateConflictError,
  latestApproval,
  latestDraft,
  listComments,
  listDrafts,
  listIntakeRuns,
  listIntakes,
  listProcesses,
  listQuestionSets,
  replaceCurrentTask,
  updateIntake,
  updateIntakeRun,
  updateProcess,
  upsertPrObservation,
} from "../../src/db/intakes.ts";
import type { Db } from "../../src/db/schema.ts";

const ISSUE = "https://github.com/o/r/issues/1";

async function fixture(): Promise<{ d: Db; projectId: number; runId: number }> {
  const d = await openDb(":memory:");
  const projectId = await insertProject(d, {
    path: "/repo",
    default_workflow: "f",
    max_concurrent: 1,
    base_branch: "main",
    setup: null,
  });
  await insertIntake(d, {
    id: "i1",
    project_id: projectId,
    issue_url: ISSUE,
    issue_node_id: "I_1",
    issue_title: "T",
  });
  const runId = await insertIntakeRun(d, {
    intake_id: "i1",
    purpose: "investigate",
    attempt: 1,
    status: "queued",
    started_at: null,
    log_path: "",
  });
  return { d, projectId, runId };
}

function newDraft(runId: number, intakeId = "i1") {
  return { intake_id: intakeId, run_id: runId, pfd: "{}", hash: "h", replies: "[]" };
}

function newTask(id: string, projectId: number) {
  return {
    id,
    project_id: projectId,
    title: "T",
    prompt: "P",
    workflow_name: "f",
    branch: `b-${id}`,
    priority: 2,
    intake_id: "i1",
    intake_process_id: "p1",
  };
}

test("Intake は investigating・revising 0・dispatch_paused 0 で作られる", async () => {
  const { d } = await fixture();
  const i = (await getIntake(d, "i1"))!;
  assert.equal(i.state, "investigating");
  assert.equal(i.revising, 0);
  assert.equal(i.dispatch_paused, 0);
  assert.equal(i.attention_reason, null);
  assert.equal(i.issue_url, ISSUE);
  assert.equal(i.created_at, i.updated_at);
  assert.equal(await getIntake(d, "nope"), undefined);
});

test("findOpenIntakeByIssue は終わった Intake を返さない", async () => {
  const { d, projectId } = await fixture();
  assert.equal((await findOpenIntakeByIssue(d, ISSUE))?.id, "i1");

  await updateIntake(d, "i1", { state: "canceled" });
  assert.equal(await findOpenIntakeByIssue(d, ISSUE), undefined);

  await insertIntake(d, {
    id: "i2",
    project_id: projectId,
    issue_url: ISSUE,
    issue_node_id: "I_1",
    issue_title: "T",
  });
  assert.equal((await findOpenIntakeByIssue(d, ISSUE))?.id, "i2");
});

test("同じ Issue の終わっていない Intake は 2 つ作れない", async () => {
  const { d, projectId } = await fixture();
  await assert.rejects(
    () =>
      insertIntake(d, {
        id: "i2",
        project_id: projectId,
        issue_url: ISSUE,
        issue_node_id: "I_1",
        issue_title: "T",
      }),
    /UNIQUE/,
  );
});

test("listIntakes は既定で終わった Intake を除き、includeClosed で含める", async () => {
  const { d, projectId } = await fixture();
  const other = await insertProject(d, {
    path: "/other",
    default_workflow: "f",
    max_concurrent: 1,
    base_branch: "main",
    setup: null,
  });
  await insertIntake(d, {
    id: "i2",
    project_id: projectId,
    issue_url: "https://github.com/o/r/issues/2",
    issue_node_id: "I_2",
    issue_title: "T",
  });
  await insertIntake(d, {
    id: "i3",
    project_id: other,
    issue_url: "https://github.com/o/other/issues/1",
    issue_node_id: "I_3",
    issue_title: "T",
  });
  await updateIntake(d, "i1", { state: "completed" });

  assert.deepEqual((await listIntakes(d)).map((i) => i.id), ["i2", "i3"]);
  assert.deepEqual((await listIntakes(d, { includeClosed: true })).map((i) => i.id), [
    "i1",
    "i2",
    "i3",
  ]);
  assert.deepEqual((await listIntakes(d, { projectId: other })).map((i) => i.id), ["i3"]);
  assert.deepEqual(
    (await listIntakes(d, { projectId, includeClosed: true })).map((i) => i.id),
    ["i1", "i2"],
  );
});

test("updateIntake は requireState が一致すれば書き、updated_at を進める", async () => {
  const { d } = await fixture();
  const before = (await getIntake(d, "i1"))!;
  await new Promise((r) => setTimeout(r, 5));
  await updateIntake(d, "i1", { state: "answering", child_pid: 42 }, {
    requireState: "investigating",
  });
  const after = (await getIntake(d, "i1"))!;
  assert.equal(after.state, "answering");
  assert.equal(after.child_pid, 42);
  assert.ok(after.updated_at > before.updated_at);
  assert.equal(after.created_at, before.created_at);
});

test("updateIntake は requireState が食い違えば IntakeStateConflictError を投げ、何も書かない", async () => {
  const { d } = await fixture();
  await updateIntake(d, "i1", { state: "answering" });
  const before = (await getIntake(d, "i1"))!;

  await assert.rejects(
    () => updateIntake(d, "i1", { state: "active" }, { requireState: "reviewing" }),
    (e: unknown) => {
      assert.ok(e instanceof IntakeStateConflictError);
      assert.equal(e.intakeId, "i1");
      assert.equal(e.expected, "reviewing");
      assert.equal(e.actual, "answering");
      return true;
    },
  );
  assert.deepEqual({ ...(await getIntake(d, "i1"))! }, { ...before });
});

test("存在しない Intake への requireState 付きの更新は actual が null の IntakeStateConflictError", async () => {
  const { d } = await fixture();
  await assert.rejects(
    () => updateIntake(d, "nope", { state: "answering" }, { requireState: "investigating" }),
    (e: unknown) => {
      assert.ok(e instanceof IntakeStateConflictError);
      assert.equal(e.actual, null);
      return true;
    },
  );
});

test("実行は queued で立て、閉じるときに結果を書く", async () => {
  const { d, runId } = await fixture();
  const queued = (await getIntakeRun(d, runId))!;
  assert.equal(queued.status, "queued");
  assert.equal(queued.started_at, null);
  assert.equal(queued.purpose, "investigate");

  await updateIntakeRun(d, runId, { status: "running", started_at: "2026-09-21T00:00:00.000Z" });
  await updateIntakeRun(d, runId, {
    status: "failed",
    ended_at: "2026-09-21T00:01:00.000Z",
    issues: '["no_input"]',
    cost_usd: 0.5,
  });
  const closed = (await getIntakeRun(d, runId))!;
  assert.equal(closed.status, "failed");
  assert.equal(closed.started_at, "2026-09-21T00:00:00.000Z");
  assert.equal(closed.ended_at, "2026-09-21T00:01:00.000Z");
  assert.equal(closed.issues, '["no_input"]');
  assert.equal(closed.cost_usd, 0.5);

  const second = await insertIntakeRun(d, {
    intake_id: "i1",
    purpose: "decompose",
    attempt: 1,
    status: "running",
    started_at: "2026-09-21T00:02:00.000Z",
    log_path: "/logs/2",
  });
  assert.deepEqual((await listIntakeRuns(d, "i1")).map((r) => r.id), [runId, second]);
  assert.equal(await getIntakeRun(d, 999), undefined);
});

test("回答は一度だけ書ける", async () => {
  const { d, runId } = await fixture();
  const id = await insertQuestionSet(d, { intake_id: "i1", run_id: runId, questions: '["q"]' });
  const [unanswered] = await listQuestionSets(d, "i1");
  assert.equal(unanswered.answers, null);
  assert.equal(unanswered.answered_at, null);

  assert.equal(await answerQuestionSet(d, id, '["a1"]'), true);
  const [answered] = await listQuestionSets(d, "i1");
  assert.equal(answered.answers, '["a1"]');
  assert.notEqual(answered.answered_at, null);

  assert.equal(await answerQuestionSet(d, id, '["a2"]'), false);
  const [again] = await listQuestionSets(d, "i1");
  assert.equal(again.answers, '["a1"]');
  assert.equal(again.answered_at, answered.answered_at);
});

test("案の seq は Intake ごとに 1 から振られ、latestDraft は最後の案を返す", async () => {
  const { d, projectId, runId } = await fixture();
  await insertIntake(d, {
    id: "i2",
    project_id: projectId,
    issue_url: "https://github.com/o/r/issues/2",
    issue_node_id: "I_2",
    issue_title: "T",
  });
  const run2 = await insertIntakeRun(d, {
    intake_id: "i2",
    purpose: "decompose",
    attempt: 1,
    status: "queued",
    started_at: null,
    log_path: "",
  });

  const a = await insertDraft(d, newDraft(runId));
  const b = await insertDraft(d, newDraft(runId));
  const c = await insertDraft(d, newDraft(run2, "i2"));
  assert.deepEqual([a.seq, b.seq, c.seq], [1, 2, 1]);
  assert.equal(a.replies, "[]");

  assert.equal((await latestDraft(d, "i1"))?.id, b.id);
  assert.equal((await latestDraft(d, "i2"))?.id, c.id);
  assert.deepEqual((await listDrafts(d, "i1")).map((x) => x.seq), [1, 2]);
  assert.equal((await getDraft(d, a.id))?.hash, "h");
  assert.equal(await latestDraft(d, "nope"), undefined);
});

test("同じ Intake に同じ seq の案は入らない", async () => {
  const { d, runId } = await fixture();
  await insertDraft(d, newDraft(runId));
  await assert.rejects(
    () =>
      d.insertInto("intake_drafts").values({
        ...newDraft(runId),
        seq: 1,
        created_at: "2026-09-21T00:00:00.000Z",
      }).execute(),
    /UNIQUE/,
  );
});

test("コメントの target_id は whole のときだけ null", async () => {
  const { d, runId } = await fixture();
  const draft = await insertDraft(d, newDraft(runId));

  await insertComments(d, "i1", draft.id, []);
  assert.deepEqual(await listComments(d, "i1"), []);

  await insertComments(d, "i1", draft.id, [
    { target_kind: "whole", target_id: null, body: "全体" },
    { target_kind: "process", target_id: "p1", body: "p1 へ" },
  ]);
  const rows = await listComments(d, "i1");
  assert.deepEqual(rows.map((r) => [r.target_kind, r.target_id, r.body, r.draft_id]), [
    ["whole", null, "全体", draft.id],
    ["process", "p1", "p1 へ", draft.id],
  ]);

  await assert.rejects(
    () => insertComments(d, "i1", draft.id, [{ target_kind: "whole", target_id: "p1", body: "x" }]),
    /CHECK/,
  );
  await assert.rejects(
    () =>
      insertComments(d, "i1", draft.id, [{ target_kind: "artifact", target_id: null, body: "x" }]),
    /CHECK/,
  );
  assert.equal((await listComments(d, "i1")).length, 2, "落ちた挿入は何も残さない");
});

test("latestApproval は最後の承認を返す", async () => {
  const { d, runId } = await fixture();
  assert.equal(await latestApproval(d, "i1"), undefined);
  const a = await insertDraft(d, newDraft(runId));
  const b = await insertDraft(d, { ...newDraft(runId), hash: "h2" });
  await insertApproval(d, { intake_id: "i1", draft_id: a.id, hash: "h" });
  const second = await insertApproval(d, { intake_id: "i1", draft_id: b.id, hash: "h2" });
  const latest = (await latestApproval(d, "i1"))!;
  assert.equal(latest.id, second);
  assert.equal(latest.draft_id, b.id);
  assert.equal(latest.hash, "h2");
});

test("承認のプロセスは (intake_id, process_id) で 1 行", async () => {
  const { d } = await fixture();
  await insertProcesses(d, "i1", []);
  assert.deepEqual(await listProcesses(d, "i1"), []);

  await insertProcesses(d, "i1", ["p2", "p1"]);
  const rows = await listProcesses(d, "i1");
  assert.deepEqual(rows.map((r) => r.process_id), ["p1", "p2"]);
  assert.ok(rows.every((r) => r.sub_issue_closed === 0 && r.current_task_id === null));
  assert.ok(rows.every((r) => r.retired_at === null && r.sub_issue_url === null));

  await assert.rejects(() => insertProcesses(d, "i1", ["p1"]), /UNIQUE|PRIMARY KEY/);
});

test("updateProcess は指定したプロセスの列だけを書く", async () => {
  const { d } = await fixture();
  await insertProcesses(d, "i1", ["p1", "p2"]);
  await updateProcess(d, "i1", "p1", {
    sub_issue_url: "https://github.com/o/r/issues/2",
    sub_issue_closed: 1,
    retired_at: "2026-09-21T00:00:00.000Z",
  });
  const [p1, p2] = await listProcesses(d, "i1");
  assert.equal(p1.sub_issue_url, "https://github.com/o/r/issues/2");
  assert.equal(p1.sub_issue_closed, 1);
  assert.equal(p1.retired_at, "2026-09-21T00:00:00.000Z");
  assert.equal(p2.sub_issue_url, null);
  assert.equal(p2.retired_at, null);
});

test("replaceCurrentTask は読んだ値と一致するときだけ置き換える", async () => {
  const { d, projectId } = await fixture();
  await insertProcesses(d, "i1", ["p1"]);
  await insertTask(d, newTask("t1", projectId));
  await insertTask(d, newTask("t2", projectId));
  const current = async () => (await listProcesses(d, "i1"))[0].current_task_id;

  assert.equal(await replaceCurrentTask(d, "i1", "p1", null, "t1"), true);
  assert.equal(await current(), "t1");

  assert.equal(await replaceCurrentTask(d, "i1", "p1", null, "t2"), false);
  assert.equal(await current(), "t1");

  assert.equal(await replaceCurrentTask(d, "i1", "p1", "t1", "t2"), true);
  assert.equal(await current(), "t2");
});

test("PR の観測は task_id ごとに最新で上書きされる", async () => {
  const { d, projectId } = await fixture();
  await insertTask(d, newTask("t1", projectId));
  assert.equal(await getPrObservation(d, "t1"), undefined);

  const base = {
    task_id: "t1",
    pr_number: 7,
    pr_url: "https://github.com/o/r/pull/7",
    base_ref: "main",
  };
  await upsertPrObservation(d, { ...base, state: "OPEN", merged_at: null, merge_commit: null });
  assert.equal((await getPrObservation(d, "t1"))?.state, "OPEN");

  await upsertPrObservation(d, {
    ...base,
    state: "MERGED",
    merged_at: "2026-09-21T01:00:00.000Z",
    merge_commit: "abc123",
  });
  const merged = (await getPrObservation(d, "t1"))!;
  assert.equal(merged.state, "MERGED");
  assert.equal(merged.merge_commit, "abc123");
  assert.equal(
    (await d.selectFrom("pr_observations").selectAll().execute()).length,
    1,
    "行は増えない",
  );
});
