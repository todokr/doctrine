import { fakeBaseSync, fakeWorkflowLoader } from "../helpers/watcher.ts";
import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import type { PrFact } from "../../../shared/intake/processStatus.ts";
import type { Pfd } from "../../../shared/intake/pfd.ts";
import type { TrackerKind } from "../../../shared/intake/tracker.ts";
import {
  getIntake,
  getPrObservation,
  listProcesses,
  updateIntake,
  updateProcess,
} from "../../src/db/intakes.ts";
import type { Db } from "../../src/db/schema.ts";
import { getProject, getTask, listTasks } from "../../src/db/tasks.ts";
import { ghPrWatcher } from "../../src/github/ghPrWatcher.ts";
import { ghTracker } from "../../src/github/ghTracker.ts";
import type { IntakeTransition } from "../../src/intake/commands.ts";
import { dispatchIntake } from "../../src/intake/dispatch.ts";
import {
  choosePr,
  createIntakeWatcher,
  INITIAL_WATCH_HEALTH,
  observePullRequests,
} from "../../src/intake/watch.ts";
import { closeSubIssuesOnCancel } from "../../src/intake/subIssueSync.ts";
import { toIntakeDetail } from "../../src/intake/view.ts";
import { fakeGh, parseGraphqlArgs } from "../helpers/gh.ts";
import { fakeTracker } from "../helpers/fakeTracker.ts";
import { constTrackerOf } from "../helpers/tracker.ts";
import type { TrackerOf } from "../../src/tracker/tracker.ts";
import { fakePrWatcher } from "../helpers/prWatcher.ts";
import { until } from "../helpers/repo.ts";
import { example } from "./pfd/fixture.ts";
import { PARENT_URL, seedActive } from "./watchFixture.ts";

function pr(number: number, state: PrFact["state"], baseRef = "main"): PrFact {
  return {
    number,
    url: `https://github.com/o/r/pull/${number}`,
    state,
    baseRef,
    mergedAt: state === "MERGED" ? "2026-09-21T00:00:00.000Z" : null,
    mergeCommit: state === "MERGED" ? `c${number}` : null,
  };
}

test("choosePr: baseBranch へマージされたものを最優先に選ぶ", () => {
  const chosen = choosePr([pr(3, "CLOSED"), pr(2, "MERGED"), pr(4, "OPEN")], "main");
  assert.equal(chosen?.number, 2);
});

test("choosePr: baseBranch 以外へのマージより OPEN を選ぶ", () => {
  const chosen = choosePr([pr(3, "CLOSED"), pr(4, "OPEN"), pr(5, "MERGED", "release")], "main");
  assert.equal(chosen?.number, 4);
});

test("choosePr: PR が無ければ null", () => {
  assert.equal(choosePr([], "main"), null);
});

async function seedDispatched(): Promise<{ db: Db; projectId: number; branch: string }> {
  const { db, projectId } = await seedActive();
  await updateProcess(db, "i1", "1", { sub_issue_url: "https://github.com/o/r/issues/101" });
  await dispatchIntake(db, "i1", { loadWorkflow: fakeWorkflowLoader() });
  return { db, projectId, branch: (await listTasks(db))[0].branch };
}

test("observePullRequests: 選んだ PR を記録し、変わらなければ changed に入れない", async () => {
  const { db, projectId, branch } = await seedDispatched();
  const project = (await getProject(db, projectId))!;
  const pw = fakePrWatcher();
  pw.prs.set(branch, [pr(7, "OPEN")]);

  const first = await observePullRequests(db, pw.prWatcher, project);
  assert.deepEqual([...first.changedIntakeIds], ["i1"]);
  const taskId = (await listTasks(db))[0].id;
  assert.equal((await getPrObservation(db, taskId))?.state, "OPEN");

  const second = await observePullRequests(db, pw.prWatcher, project);
  assert.equal(second.changedIntakeIds.size, 0);
  assert.deepEqual(pw.calls, [[branch], [branch]]);
});

test("observePullRequests: baseBranch へのマージを観測したタスクは、以後引かない", async () => {
  const { db, projectId, branch } = await seedDispatched();
  const project = (await getProject(db, projectId))!;
  const pw = fakePrWatcher();
  pw.prs.set(branch, [pr(7, "MERGED")]);
  await observePullRequests(db, pw.prWatcher, project);
  await observePullRequests(db, pw.prWatcher, project);
  assert.equal(pw.calls.length, 1);
});

test("observePullRequests: 対象が無ければ gh を呼ばない", async () => {
  const { db, projectId } = await seedActive();
  const pw = fakePrWatcher();
  await observePullRequests(db, pw.prWatcher, (await getProject(db, projectId))!);
  assert.equal(pw.calls.length, 0);
});

test("observePullRequests: pullRequests の失敗は投げる", async () => {
  const { db, projectId } = await seedDispatched();
  const pw = fakePrWatcher();
  pw.failing.on = true;
  await assert.rejects(observePullRequests(db, pw.prWatcher, (await getProject(db, projectId))!));
});

const now = () => new Date().toISOString();

async function setup(pfd: Pfd = example(), o: { kind?: TrackerKind } = {}) {
  const seeded = await seedActive(pfd);
  const ft = fakeTracker({ kind: o.kind });
  const pw = fakePrWatcher();
  const base = fakeBaseSync();
  const updated: string[] = [];
  const transitions: IntakeTransition[] = [];
  const watcher = createIntakeWatcher({
    db: seeded.db,
    trackerOf: constTrackerOf(ft.tracker),
    prWatcher: pw.prWatcher,
    baseSync: base.baseSync,
    loadWorkflow: fakeWorkflowLoader(),
    onStateChanged: (t) => transitions.push(t),
    onUpdated: (id) => updated.push(id),
  });
  return { ...seeded, ft, pw, base, watcher, updated, transitions };
}

/** そのプロセスの current_task_id のタスクのブランチに、MERGED の PR を 1 件置く。 */
async function mergeOf(
  pw: ReturnType<typeof fakePrWatcher>,
  db: Db,
  processId: string,
  baseRef = "main",
): Promise<void> {
  const row = (await listProcesses(db, "i1")).find((r) => r.process_id === processId)!;
  const task = (await getTask(db, row.current_task_id!))!;
  pw.prs.set(task.branch, [pr(10 + Number(processId), "MERGED", baseRef)]);
}

async function finishHuman3(db: Db): Promise<void> {
  await updateProcess(db, "i1", "3", {
    human_note: "ログイン 1 回を 1 利用と数える",
    human_done_at: now(),
  });
}

async function currentTask(db: Db, processId: string): Promise<string | null> {
  return (await listProcesses(db, "i1")).find((r) => r.process_id === processId)!.current_task_id;
}

test("承認直後の 1 周で、sub-issue を作り、プロセス 1 だけをタスクにする", async () => {
  const { db, projectId, ft, watcher, updated } = await setup();
  await watcher.request(projectId);
  const tasks = await listTasks(db);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].intake_process_id, "1");
  assert.equal(await currentTask(db, "1"), tasks[0].id);
  for (const id of ["2", "3", "4"]) assert.equal(await currentTask(db, id), null);
  assert.equal(ft.issues.length, 4);
  assert.ok(updated.includes("i1"));
});

test("投入したタスクはプロセス名・既定のワークフロー・紐づけの項目を持つ", async () => {
  const { db, projectId, watcher } = await setup();
  await watcher.request(projectId);
  const [task] = await listTasks(db);
  const subIssueUrl = (await listProcesses(db, "i1")).find((r) => r.process_id === "1")!
    .sub_issue_url;
  assert.equal(task.title, "マイグレーションを書く");
  assert.equal(task.workflow_name, "feature");
  assert.equal(task.priority, 2);
  assert.equal(task.state, "queued");
  assert.ok(task.branch.startsWith(`doctrine/${task.id}-`));
  assert.equal(task.intake_id, "i1");
  assert.equal(task.issue_url, subIssueUrl);
  assert.equal(task.parent_issue_url, PARENT_URL);
  const lines = task.prompt.split("\n");
  assert.equal(lines[0], `${PARENT_URL} 親`);
  assert.equal(lines[1], `この作業の sub-issue: ${subIssueUrl}`);
});

test("同じ周をもう一度回しても、同じプロセスのタスクは増えない", async () => {
  const { db, projectId, watcher } = await setup();
  await watcher.request(projectId);
  await watcher.request(projectId);
  assert.equal((await listTasks(db)).length, 1);
});

test("sub-issue が作れなかったプロセスは投入せず、失敗を健康状態に出し、治れば次の周で投入する", async () => {
  const { db, projectId, ft, watcher } = await setup();
  ft.failWhen((c) => c.op === "createSubIssue");
  await watcher.request(projectId);
  assert.equal((await listTasks(db)).length, 0);
  assert.equal(watcher.health(projectId).consecutiveFailures, 1);
  assert.match(watcher.health(projectId).lastError!, /sub-issue/);
  assert.equal((await getIntake(db, "i1"))!.state, "active");

  ft.heal();
  await watcher.request(projectId);
  assert.equal((await listTasks(db)).length, 1);
  assert.equal(watcher.health(projectId).consecutiveFailures, 0);
  assert.notEqual(watcher.health(projectId).lastSucceededAt, null);
});

/** setup と同じ組み立てで、trackerOf だけ差し替える。 */
async function setupWith(trackerOf: TrackerOf) {
  const seeded = await seedActive(example());
  const base = fakeBaseSync();
  const watcher = createIntakeWatcher({
    db: seeded.db,
    trackerOf,
    prWatcher: fakePrWatcher().prWatcher,
    baseSync: base.baseSync,
    loadWorkflow: fakeWorkflowLoader(),
    onStateChanged: () => {},
    onUpdated: () => {},
  });
  return { ...seeded, base, watcher };
}

test("見張りはプロジェクトのパスで Tracker を引く", async () => {
  const ft = fakeTracker();
  const paths: string[] = [];
  const { projectId, watcher } = await setupWith((path) => {
    paths.push(path);
    return Promise.resolve(ft.tracker);
  });
  await watcher.request(projectId);
  assert.deepEqual(paths, ["/repo"]);
  assert.equal(ft.issues.length, 4);
});

test("Tracker を引けない周も baseBranch の取り込みは続け、失敗を健康状態に出す", async () => {
  const { db, projectId, base, watcher } = await setupWith(() =>
    Promise.reject(new Error("project.yaml がありません"))
  );
  await watcher.request(projectId);
  assert.equal(base.fetches, 1);
  assert.equal((await listTasks(db)).length, 0);
  assert.match(
    watcher.health(projectId).lastError!,
    /sub-issue の同期: project\.yaml がありません/,
  );
  assert.equal(watcher.health(projectId).consecutiveFailures, 1);
});

test("PR の見張りが失敗しても Intake は止まらず、連続失敗の回数が増える", async () => {
  const { db, projectId, pw, watcher } = await setup();
  await watcher.request(projectId);
  pw.failing.on = true;
  await watcher.request(projectId);
  await watcher.request(projectId);
  assert.equal(watcher.health(projectId).consecutiveFailures, 2);
  assert.equal((await getIntake(db, "i1"))!.state, "active");

  pw.failing.on = false;
  await mergeOf(pw, db, "1");
  await watcher.request(projectId);
  assert.equal(watcher.health(projectId).consecutiveFailures, 0);
  const observed = await getPrObservation(db, (await currentTask(db, "1"))!);
  assert.equal(observed?.state, "MERGED");
});

test("baseBranch へのマージを検知すると下流を投入する", async () => {
  const { db, projectId, pw, watcher } = await setup();
  await watcher.request(projectId);
  await finishHuman3(db);
  await mergeOf(pw, db, "1");
  await watcher.request(projectId);
  const tasks = await listTasks(db);
  const task2 = tasks.filter((t) => t.intake_process_id === "2");
  assert.equal(task2.length, 1);
  assert.match(task2[0].prompt, /人が決めたこと:/);
  assert.match(task2[0].prompt, /ログイン 1 回を 1 利用と数える/);
  assert.equal(tasks.some((t) => t.intake_process_id === "4"), false);
});

test("origin の baseBranch を取り込めなかった周は投入せず、失敗を健康状態に出す", async () => {
  const { db, projectId, base, watcher } = await setup();
  base.fetchError = new Error("Could not resolve host: github.com");
  await watcher.request(projectId);
  assert.deepEqual(await listTasks(db), []);
  assert.equal(watcher.health(projectId).consecutiveFailures, 1);
  assert.match(watcher.health(projectId).lastError!, /github\.com/);

  base.fetchError = null;
  await watcher.request(projectId);
  assert.equal((await listTasks(db)).filter((t) => t.intake_process_id === "1").length, 1);
});

test("上流のマージのコミットが origin の baseBranch に入るまで、下流を投入しない", async () => {
  const { db, projectId, pw, base, watcher } = await setup();
  await watcher.request(projectId);
  await finishHuman3(db);
  await mergeOf(pw, db, "1");
  base.missing.add("c11");
  await watcher.request(projectId);
  assert.equal((await listTasks(db)).some((t) => t.intake_process_id === "2"), false);
  assert.equal(watcher.health(projectId).consecutiveFailures, 0, "取り込みの遅れは失敗ではない");

  base.missing.delete("c11");
  await watcher.request(projectId);
  assert.equal((await listTasks(db)).filter((t) => t.intake_process_id === "2").length, 1);
  assert.ok(base.fetches >= 3, "周ごとに取り込む");
});

test("マージされても、人のプロセスが終わっていなければ下流は投入しない", async () => {
  const { db, projectId, pw, watcher } = await setup();
  await watcher.request(projectId);
  await mergeOf(pw, db, "1");
  await watcher.request(projectId);
  assert.equal((await listTasks(db)).length, 1);
});

test("baseBranch 以外へのマージでは下流を投入しない", async () => {
  const { db, projectId, pw, watcher } = await setup();
  await watcher.request(projectId);
  await finishHuman3(db);
  await mergeOf(pw, db, "1", "release");
  await watcher.request(projectId);
  assert.equal((await listTasks(db)).length, 1);
  const row = (await getIntake(db, "i1"))!;
  const detail = await toIntakeDetail(db, row, watcher.health(projectId));
  const p1 = detail.processes.find((p) => p.id === "1")!;
  assert.equal(p1.state, "needs_attention");
  assert.equal("reason" in p1 && p1.reason, "pr_closed");
});

test("末端の成果物が揃うと完了にし、親 Issue は閉じない", async () => {
  const { db, projectId, ft, pw, watcher, transitions } = await setup();
  await watcher.request(projectId);
  await finishHuman3(db);
  for (const id of ["1", "2", "4"]) {
    await mergeOf(pw, db, id);
    await watcher.request(projectId);
  }
  const row = (await getIntake(db, "i1"))!;
  assert.equal(row.state, "completed");
  assert.notEqual(row.ended_at, null);
  assert.deepEqual(
    transitions.map((t) => [t.from, t.to]),
    [["active", "completed"]],
  );
  assert.equal(ft.calls.some((c) => c.op === "closeIssue" && c.url === PARENT_URL), false);

  const before = pw.calls.length;
  await watcher.request(projectId);
  assert.equal(pw.calls.length, before);
});

test("active な Intake が無いプロジェクトでは gh を呼ばない", async () => {
  const { db, projectId, ft, pw, watcher } = await setup();
  await updateIntake(db, "i1", { state: "canceled" });
  await watcher.request(projectId);
  assert.equal(ft.calls.length, 0);
  assert.equal(pw.calls.length, 0);
  assert.deepEqual(watcher.health(projectId), INITIAL_WATCH_HEALTH);
});

test("dispatch_paused の Intake は投入しない", async () => {
  const { db, projectId, ft, watcher } = await setup();
  await updateIntake(db, "i1", { dispatch_paused: 1 });
  await watcher.request(projectId);
  assert.equal((await listTasks(db)).length, 0);
  assert.equal(ft.issues.length, 4);
});

test("改訂中の Intake は PR のマージを観測するが、下流を投入しない", async () => {
  const { db, projectId, pw, watcher } = await setup();
  await watcher.request(projectId);
  await finishHuman3(db);
  await updateIntake(db, "i1", { state: "decomposing", revising: 1 });
  await mergeOf(pw, db, "1");
  await watcher.request(projectId);

  const task1 = (await currentTask(db, "1"))!;
  assert.equal((await getPrObservation(db, task1))?.state, "MERGED");
  assert.equal((await listTasks(db)).length, 1);

  await updateIntake(db, "i1", { state: "active", revising: 0 });
  await watcher.request(projectId);
  assert.equal((await listTasks(db)).filter((t) => t.intake_process_id === "2").length, 1);
});

test("終わった Intake は revising が残っていても PR を観測しない", async () => {
  const { db, projectId, pw, watcher } = await setup();
  await watcher.request(projectId);
  await updateIntake(db, "i1", { state: "canceled", revising: 1 });
  await mergeOf(pw, db, "1");
  const before = pw.calls.length;
  await watcher.request(projectId);
  assert.equal(pw.calls.length, before);
});

test("改訂中の Intake の sub-issue は触らない", async () => {
  const { db, projectId, ft, watcher } = await setup();
  await watcher.request(projectId);
  await updateIntake(db, "i1", { state: "decomposing", revising: 1 });
  await updateProcess(db, "i1", "4", { retired_at: now() });
  const before = ft.calls.length;

  await watcher.request(projectId);

  const sub = ft.calls.slice(before).filter((c) =>
    c.op === "createSubIssue" || c.op === "updateIssue" || c.op === "closeIssue"
  );
  assert.deepEqual(sub, []);
});

test("走っている周の最中に届いた要求は、その周が終わった後にもう 1 周回す", async () => {
  const { projectId, pw, watcher } = await setup();
  await watcher.request(projectId);
  assert.equal(pw.calls.length, 0);

  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => release = resolve);
  const inner = pw.prWatcher.pullRequests;
  pw.prWatcher.pullRequests = async (path, branches) => {
    const result = await inner(path, branches);
    await gate;
    return result;
  };

  const first = watcher.request(projectId);
  await until(() => pw.calls.length === 1);
  const second = watcher.request(projectId);
  release();
  await Promise.all([first, second]);
  assert.equal(pw.calls.length, 2);
});

test("偽の gh: ghTracker と ghPrWatcher を通して、承認直後の投入とマージの後の下流の投入が起きる", async () => {
  const { db, projectId } = await seedActive();
  const nodes: { id: string; url: string; state: string; body: string }[] = [];
  let n = 100;
  let mergedBranch = false;
  const gh = fakeGh((a) => {
    if (a[0] === "repo" && a[1] === "view") return JSON.stringify({ id: "R_1" });
    if (a[0] !== "api" || a[1] !== "graphql") return undefined;
    const g = parseGraphqlArgs(a);
    if (/pullRequests/.test(g.query)) {
      const found = mergedBranch
        ? [{
          number: 7,
          url: "https://github.com/o/r/pull/7",
          state: "MERGED",
          baseRefName: "main",
          mergedAt: "2026-09-21T00:00:00Z",
          mergeCommit: { oid: "abc" },
        }]
        : [];
      return JSON.stringify({ data: { repository: { b0: { nodes: found } } } });
    }
    if (/createIssue/.test(g.query)) {
      n++;
      const node = {
        id: `I_${n}`,
        url: `https://github.com/o/r/issues/${n}`,
        state: "OPEN",
        body: g.raw.body,
      };
      nodes.push(node);
      return JSON.stringify({ data: { createIssue: { issue: { id: node.id, url: node.url } } } });
    }
    if (/subIssues/.test(g.query)) {
      return JSON.stringify({ data: { node: { subIssues: { nodes } } } });
    }
    return undefined;
  });
  const watcher = createIntakeWatcher({
    db,
    trackerOf: constTrackerOf(ghTracker(gh.run)),
    prWatcher: ghPrWatcher(gh.run),
    baseSync: fakeBaseSync().baseSync,
    loadWorkflow: fakeWorkflowLoader(),
    onStateChanged: () => {},
    onUpdated: () => {},
  });

  await watcher.request(projectId);
  const creates = gh.calls.filter((c) => /createIssue/.test(parseGraphqlArgs(c.args).query));
  assert.equal(creates.length, 4);
  assert.equal((await listTasks(db)).length, 1);

  await finishHuman3(db);
  mergedBranch = true;
  await watcher.request(projectId);
  const tasks = await listTasks(db);
  assert.deepEqual(tasks.map((t) => t.intake_process_id).toSorted(), ["1", "2"]);
});

/** プロセス 1 の sub-issue への closeIssue の呼び出し。 */
async function closesOfProcess1(db: Db, ft: ReturnType<typeof fakeTracker>) {
  const url = (await listProcesses(db, "i1")).find((r) => r.process_id === "1")!.sub_issue_url;
  return ft.calls.filter((c) => c.op === "closeIssue" && c.url === url);
}

async function subIssueOf(db: Db, ft: ReturnType<typeof fakeTracker>, processId: string) {
  const url = (await listProcesses(db, "i1")).find((r) => r.process_id === processId)!
    .sub_issue_url;
  return ft.issues.find((i) => i.ref.url === url)!;
}

/** 見張りの周を回さず、マージの観測だけを作る。 */
async function observeMerge1(s: Awaited<ReturnType<typeof setup>>): Promise<void> {
  await s.watcher.request(s.projectId);
  await mergeOf(s.pw, s.db, "1");
  await observePullRequests(s.db, s.pw.prWatcher, (await getProject(s.db, s.projectId))!);
}

const CANCEL = { projectPath: "/repo", intakeId: "i1", baseBranch: "main" };

test("中止: PR の Closes で閉じないトラッカーでは、マージ済みのプロセスの sub-issue も completed で閉じる", async () => {
  const s = await setup(example(), { kind: "linear" });
  await observeMerge1(s);
  const out = await closeSubIssuesOnCancel(s.db, s.ft.tracker, CANCEL);
  assert.ok(out.closed.includes("1"));
  assert.deepEqual(out.failures, []);
  assert.equal((await subIssueOf(s.db, s.ft, "1")).closeReason, "completed");
  for (const id of ["2", "3", "4"]) {
    assert.equal((await subIssueOf(s.db, s.ft, id)).closeReason, "not_planned");
  }
  for (const r of await listProcesses(s.db, "i1")) assert.equal(r.sub_issue_closed, 1);
});

test("中止: PR の Closes で閉じるトラッカーでは、マージ済みのプロセスの sub-issue に触らない", async () => {
  const s = await setup();
  await observeMerge1(s);
  const out = await closeSubIssuesOnCancel(s.db, s.ft.tracker, CANCEL);
  assert.ok(!out.closed.includes("1"));
  assert.deepEqual(await closesOfProcess1(s.db, s.ft), []);
  const p1 = (await listProcesses(s.db, "i1")).find((r) => r.process_id === "1")!;
  assert.equal(p1.sub_issue_closed, 0);
  for (const id of ["2", "3", "4"]) {
    assert.equal((await subIssueOf(s.db, s.ft, id)).closeReason, "not_planned");
  }
});

test("中止: 見張りがすでに閉じたマージ済みの sub-issue はもう閉じない", async () => {
  const s = await setup(example(), { kind: "linear" });
  await s.watcher.request(s.projectId);
  await mergeOf(s.pw, s.db, "1");
  await s.watcher.request(s.projectId);
  await closeSubIssuesOnCancel(s.db, s.ft.tracker, CANCEL);
  assert.equal((await closesOfProcess1(s.db, s.ft)).length, 1);
});

test("Linear のプロジェクトでは、baseBranch へのマージを検知して sub-issue を completed で 1 回だけ閉じる", async () => {
  const s = await setup(example(), { kind: "linear" });
  await s.watcher.request(s.projectId);
  await mergeOf(s.pw, s.db, "1");
  const before = s.updated.length;
  await s.watcher.request(s.projectId);
  await s.watcher.request(s.projectId);
  const closes = await closesOfProcess1(s.db, s.ft);
  assert.equal(closes.length, 1);
  assert.equal(closes[0].op === "closeIssue" && closes[0].reason, "completed");
  const p1 = (await listProcesses(s.db, "i1")).find((r) => r.process_id === "1")!;
  assert.equal(p1.sub_issue_closed, 1);
  assert.equal((await subIssueOf(s.db, s.ft, "1")).state, "CLOSED");
  for (const id of ["2", "4"]) assert.equal((await subIssueOf(s.db, s.ft, id)).state, "OPEN");
  assert.ok(s.updated.slice(before).includes("i1"));
  assert.equal(s.watcher.health(s.projectId).consecutiveFailures, 0);
});

test("GitHub のプロジェクトでは、マージを検知しても sub-issue を閉じない", async () => {
  const s = await setup();
  await s.watcher.request(s.projectId);
  await mergeOf(s.pw, s.db, "1");
  await s.watcher.request(s.projectId);
  assert.deepEqual(s.ft.calls.filter((c) => c.op === "closeIssue"), []);
  const p1 = (await listProcesses(s.db, "i1")).find((r) => r.process_id === "1")!;
  assert.equal(p1.sub_issue_closed, 0);
});

test("Linear のプロジェクトでも、baseBranch 以外へのマージでは sub-issue を閉じない", async () => {
  const s = await setup(example(), { kind: "linear" });
  await s.watcher.request(s.projectId);
  await mergeOf(s.pw, s.db, "1", "release");
  await s.watcher.request(s.projectId);
  assert.deepEqual(s.ft.calls.filter((c) => c.op === "closeIssue"), []);
  const p1 = (await listProcesses(s.db, "i1")).find((r) => r.process_id === "1")!;
  assert.equal(p1.sub_issue_closed, 0);
});

test("マージした sub-issue を閉じられなければ失敗を健康状態に出し、次の周で閉じる", async () => {
  const s = await setup(example(), { kind: "linear" });
  await s.watcher.request(s.projectId);
  await mergeOf(s.pw, s.db, "1");
  s.ft.failWhen((c) => c.op === "closeIssue");
  await s.watcher.request(s.projectId);
  const p1 = async () => (await listProcesses(s.db, "i1")).find((r) => r.process_id === "1")!;
  assert.equal((await p1()).sub_issue_closed, 0);
  assert.equal(s.watcher.health(s.projectId).consecutiveFailures, 1);
  assert.match(s.watcher.health(s.projectId).lastError!, /sub-issue（close）/);

  s.ft.heal();
  await s.watcher.request(s.projectId);
  assert.equal((await p1()).sub_issue_closed, 1);
  assert.equal(s.watcher.health(s.projectId).consecutiveFailures, 0);
  const closes = await closesOfProcess1(s.db, s.ft);
  assert.equal(closes.length, 2);
  assert.equal(closes[1].op === "closeIssue" && closes[1].reason, "completed");
});
