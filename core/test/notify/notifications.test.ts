import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { openDb, openDbOn } from "../../src/db/migrate.ts";
import { insertProject, insertTask } from "../../src/db/tasks.ts";
import { insertIntake } from "../../src/db/intakes.ts";
import type { Db } from "../../src/db/schema.ts";
import type { ServerEvent } from "../../../shared/protocol.ts";
import type { Workflow } from "../../src/workflow/schema.ts";
import { createWarningLog } from "../../src/daemon/warnings.ts";
import { createMockNotifier, type MockNotifier } from "../../src/notify/mock.ts";
import { createEventNotifier, issueNumberOf } from "../../src/notify/notifications.ts";

const workflow: Workflow = {
  name: "f",
  steps: [
    { id: "impl", type: "agent", prompt: "x" },
    { id: "review", type: "approval", title: "差分を見る" },
  ],
} as Workflow;

async function seed(db: Db) {
  const project_id = await insertProject(db, {
    path: "/work/myproj",
    default_workflow: "f",
    max_concurrent: 1,
    base_branch: "main",
    setup: null,
  });
  await insertTask(db, {
    id: "t1",
    title: "ログインを直す",
    prompt: "p",
    workflow_name: "f",
    branch: "b1",
    priority: 0,
    project_id,
  });
  await insertIntake(db, {
    id: "i1",
    issue_url: "https://github.com/o/r/issues/54",
    issue_node_id: "N1",
    issue_title: "通知を出す",
    project_id,
  });
  await insertIntake(db, {
    id: "i2",
    issue_url: "https://linear.app/acme/issue/ENG-12/tsuchi",
    issue_node_id: "N2",
    issue_title: "Linear の件",
    project_id,
  });
}

async function setup(o: {
  notifier?: MockNotifier;
  workflowOf?: () => Promise<Workflow>;
  db?: Db;
} = {}) {
  const db = o.db ?? await openDb(":memory:");
  await seed(db);
  const mock = o.notifier ?? createMockNotifier();
  const events: ServerEvent[] = [];
  const written: string[] = [];
  const warnings = createWarningLog({
    broadcast: (ev) => events.push(ev),
    write: (l) => written.push(l),
  });
  const notifier = createEventNotifier({
    db,
    workflowOf: o.workflowOf ?? (() => Promise.resolve(workflow)),
    notifier: mock,
    warnings,
  });
  const setStep = (id: string | null) =>
    db.updateTable("tasks").set({ current_step_id: id }).where("id", "=", "t1").execute();
  return { db, mock, events, written, notifier, setStep };
}

const suspended: ServerEvent = {
  event: "task.stateChanged",
  task_id: "t1",
  from: "running",
  to: "suspended",
};
const failed: ServerEvent = {
  event: "task.stateChanged",
  task_id: "t1",
  from: "running",
  to: "failed",
};
const intakeEv = (intake_id: string, to: string, revising = false) =>
  ({
    event: "intake.stateChanged",
    intake_id,
    from: "investigating",
    to,
    revising,
  }) as ServerEvent;

test("approval で suspended に入ったらレビュー待ちとステップの title を 1 通送る", async () => {
  const s = await setup();
  await s.setStep("review");
  await s.notifier.handle(suspended);
  assert.deepEqual(s.mock.calls, [
    { title: "doctrine", body: "[myproj] ログインを直す — レビュー待ち: 差分を見る" },
  ]);
});

test("approval 以外のステップで suspended に入ったらレビュー待ちだけを送る", async () => {
  const s = await setup();
  await s.setStep("impl");
  await s.notifier.handle(suspended);
  assert.equal(s.mock.calls[0].body, "[myproj] ログインを直す — レビュー待ち");
});

test("current_step_id が無い suspended もレビュー待ちだけを送る", async () => {
  const s = await setup();
  await s.notifier.handle(suspended);
  assert.equal(s.mock.calls[0].body, "[myproj] ログインを直す — レビュー待ち");
});

test("ワークフローが読めなくても suspended は通知する", async () => {
  const s = await setup({ workflowOf: () => Promise.reject(new Error("壊れた")) });
  await s.setStep("review");
  await s.notifier.handle(suspended);
  assert.equal(s.mock.calls[0].body, "[myproj] ログインを直す — レビュー待ち");
  assert.equal(s.written.length, 0);
});

test("suspended に入るたびに 1 通ずつ送る", async () => {
  const s = await setup();
  await s.notifier.handle(suspended);
  await s.notifier.handle(suspended);
  assert.equal(s.mock.calls.length, 2);
});

test("failed に入ったら失敗を 1 通送る", async () => {
  const s = await setup();
  await s.notifier.handle(failed);
  assert.deepEqual(s.mock.calls, [{ title: "doctrine", body: "[myproj] ログインを直す — 失敗" }]);
});

test("削除を拒否した後始末を 1 通送る", async () => {
  const s = await setup();
  await s.notifier.handle({
    event: "task.cleanedUp",
    task_id: "t1",
    outcome: "refused",
    worktree_path: "/w",
    warning: "未コミットの変更\n2行目",
  });
  assert.deepEqual(s.mock.calls, [
    { title: "doctrine", body: "[myproj] ログインを直す — worktree の削除を拒否" },
  ]);
});

test("Intake の回答待ち・レビュー待ち・要確認・完了をそれぞれ 1 通送る", async () => {
  const s = await setup();
  for (const to of ["answering", "reviewing", "needs_attention", "completed"]) {
    await s.notifier.handle(intakeEv("i1", to));
  }
  assert.deepEqual(s.mock.calls.map((c) => c.body), [
    "[myproj] #54 通知を出す — 回答待ち",
    "[myproj] #54 通知を出す — レビュー待ち",
    "[myproj] #54 通知を出す — 要確認",
    "[myproj] #54 通知を出す — 完了",
  ]);
});

test("改訂中の Intake の遷移も同じ文面で送る", async () => {
  const s = await setup();
  await s.notifier.handle(intakeEv("i1", "reviewing", true));
  assert.equal(s.mock.calls[0].body, "[myproj] #54 通知を出す — レビュー待ち");
});

test("Issue 番号が取れない URL では # を省く", async () => {
  const s = await setup();
  await s.notifier.handle(intakeEv("i2", "needs_attention"));
  assert.equal(s.mock.calls[0].body, "[myproj] Linear の件 — 要確認");
});

test("通知しないイベントでは送らない", async () => {
  const s = await setup();
  const evs: ServerEvent[] = [
    ...["completed", "canceled", "rate_limited", "waiting", "paused", "queued", "running"].map(
      (to) => ({ event: "task.stateChanged", task_id: "t1", from: "running", to }) as ServerEvent,
    ),
    { event: "task.cleanedUp", task_id: "t1", outcome: "removed", worktree_path: "/w" },
    ...["investigating", "decomposing", "active", "canceled"].map((to) => intakeEv("i1", to)),
    { event: "log.line" } as unknown as ServerEvent,
    { event: "daemon.warning" } as unknown as ServerEvent,
    { event: "ratelimit.sample" } as unknown as ServerEvent,
    { event: "intake.updated", intake_id: "i1" } as unknown as ServerEvent,
    { event: "intake.logLine" } as unknown as ServerEvent,
    { event: "stepRun.started" } as unknown as ServerEvent,
    { event: "stepRun.finished", status: "success" } as unknown as ServerEvent,
  ];
  for (const ev of evs) await s.notifier.handle(ev);
  assert.equal(s.mock.calls.length, 0);
  assert.equal(s.written.length, 0);
});

test("行が無いタスク・Intake のイベントは黙って落とす", async () => {
  const s = await setup();
  await s.notifier.handle({ ...failed, task_id: "nope" } as ServerEvent);
  await s.notifier.handle(intakeEv("nope", "completed"));
  assert.equal(s.mock.calls.length, 0);
  assert.equal(s.written.length, 0);
});

test("送出に失敗したら 1 回だけ警告し、以後は送出を試みない", async () => {
  const s = await setup({
    notifier: createMockNotifier({ fail: new Error("osascript: not found") }),
  });
  for (let i = 0; i < 3; i++) await s.notifier.handle(failed);
  assert.equal(s.mock.calls.length, 1);
  assert.equal(s.written.length, 1);
  assert.match(s.written[0], /OS 通知を送れませんでした.*osascript: not found/);
  assert.equal(s.events.filter((e) => e.event === "daemon.warning").length, 1);
});

test("並行した送出が両方失敗しても警告は 1 回", async () => {
  const s = await setup({ notifier: createMockNotifier({ fail: new Error("boom") }) });
  await Promise.all([s.notifier.handle(failed), s.notifier.handle(suspended)]);
  assert.equal(s.written.length, 1);
});

test("handle は DB の読み取りが失敗しても reject しない", async () => {
  const sqlite = new DatabaseSync(":memory:");
  const db = await openDbOn(sqlite);
  const s = await setup({ db });
  const prepare = sqlite.prepare.bind(sqlite);
  sqlite.prepare = ((sql: string) => {
    if (sql.includes('from "tasks"')) throw new Error("DBが壊れた");
    return prepare(sql);
  }) as typeof prepare;
  await s.notifier.handle(failed);
  assert.equal(s.mock.calls.length, 0);
  assert.equal(s.written.length, 0);
});

test("issueNumberOf は GitHub の Issue URL から番号を取る", () => {
  assert.equal(issueNumberOf("https://github.com/o/r/issues/54"), "54");
  assert.equal(issueNumberOf("https://github.com/o/r/issues/54/"), "54");
  assert.equal(issueNumberOf("https://linear.app/acme/issue/ENG-12/tsuchi"), null);
});
