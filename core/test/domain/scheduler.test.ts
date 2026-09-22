import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { openDb } from "../../src/db/migrate.ts";
import { getTask, insertProject, insertTask, type TaskState } from "../../src/db/tasks.ts";
import {
  currentUsage,
  hasActiveRateLimit,
  releaseDueIntakeRateLimited,
  releaseDueRateLimited,
  releaseDueWaiting,
  selectAdmissible,
  selectAdmissibleIntakeRuns,
} from "../../src/domain/scheduler.ts";
import {
  getIntake,
  insertIntake,
  insertIntakeRun,
  type IntakeRunStatus,
  type IntakeState,
  listIntakeRuns,
  updateIntake,
} from "../../src/db/intakes.ts";
import type { Db } from "../../src/db/schema.ts";

async function fixture(maxConcurrent = 1) {
  const d = await openDb(":memory:");
  const p = await insertProject(d, {
    path: "/repo",
    default_workflow: "f",
    max_concurrent: maxConcurrent,
    base_branch: "main",
    setup: null,
  });
  return { d, p };
}

async function add(
  d: Db,
  p: number,
  id: string,
  opts: { priority?: number; state?: TaskState; resumed?: number; createdAt?: string } = {},
) {
  await insertTask(d, {
    id,
    project_id: p,
    title: id,
    prompt: "x",
    workflow_name: "f",
    branch: `b/${id}`,
    priority: opts.priority ?? 2,
  });
  if (opts.state) {
    await d.updateTable("tasks").set({ state: opts.state }).where("id", "=", id).execute();
  }
  if (opts.resumed) await d.updateTable("tasks").set({ resumed: 1 }).where("id", "=", id).execute();
  if (opts.createdAt) {
    await d.updateTable("tasks").set({ created_at: opts.createdAt }).where("id", "=", id).execute();
  }
}

test("枠が空いていれば queued を返す", async () => {
  const { d, p } = await fixture();
  await add(d, p, "t1");
  assert.deepEqual((await selectAdmissible(d)).map((t) => t.id), ["t1"]);
});

test("プロジェクト枠が埋まっていれば返さない", async () => {
  const { d, p } = await fixture(1);
  await add(d, p, "running1", { state: "running" });
  await add(d, p, "t2");
  assert.deepEqual(await selectAdmissible(d), []);
});

test("suspended はプロジェクト枠を握り続ける（飢餓が起きない）", async () => {
  const { d, p } = await fixture(1);
  await add(d, p, "waiting", { state: "suspended" });
  await add(d, p, "newcomer");
  assert.deepEqual(
    await selectAdmissible(d),
    [],
    "承認待ちのタスクがいる間、同じプロジェクトの新規タスクは割り込めない",
  );
});

test("paused もプロジェクト枠を握り続ける", async () => {
  const { d, p } = await fixture(1);
  await add(d, p, "held", { state: "paused" });
  await add(d, p, "newcomer");
  assert.deepEqual(await selectAdmissible(d), []);
});

test("suspended は全体枠を握らない", async () => {
  const { d, p } = await fixture(1);
  const p2 = await insertProject(d, {
    path: "/other",
    default_workflow: "f",
    max_concurrent: 1,
    base_branch: "main",
    setup: null,
  });
  for (const id of ["a", "b", "c", "d"]) await add(d, p, id, { state: "suspended" });
  await add(d, p2, "other");
  assert.deepEqual(
    (await selectAdmissible(d, 4)).map((t) => t.id),
    ["other"],
    "4本が承認待ちでも全体枠は空いている",
  );
});

test("全体枠の上限を超えて返さない", async () => {
  const d = await openDb(":memory:");
  const projects: number[] = [];
  for (const n of [1, 2, 3, 4, 5]) {
    projects.push(
      await insertProject(d, {
        path: `/p${n}`,
        default_workflow: "f",
        max_concurrent: 1,
        base_branch: "main",
        setup: null,
      }),
    );
  }
  for (const [i, p] of projects.entries()) await add(d, p, `t${i}`);
  assert.equal((await selectAdmissible(d, 4)).length, 4);
});

test("再開したタスクが行列の先頭に入る", async () => {
  const d = await openDb(":memory:");
  const p1 = await insertProject(d, {
    path: "/a",
    default_workflow: "f",
    max_concurrent: 1,
    base_branch: "main",
    setup: null,
  });
  const p2 = await insertProject(d, {
    path: "/b",
    default_workflow: "f",
    max_concurrent: 1,
    base_branch: "main",
    setup: null,
  });
  await add(d, p1, "newer", { createdAt: "2026-01-01T00:00:00Z" });
  await add(d, p2, "resumed-later", { createdAt: "2026-06-01T00:00:00Z", resumed: 1 });
  assert.deepEqual(
    (await selectAdmissible(d, 1)).map((t) => t.id),
    ["resumed-later"],
    "進行中の仕事を新規の仕事より先に終わらせる",
  );
});

test("優先度 → 作成時刻のFIFO", async () => {
  const d = await openDb(":memory:");
  const ps: number[] = [];
  for (const n of ["a", "b", "c"]) {
    ps.push(
      await insertProject(d, {
        path: `/${n}`,
        default_workflow: "f",
        max_concurrent: 1,
        base_branch: "main",
        setup: null,
      }),
    );
  }
  await add(d, ps[0], "p2-old", { priority: 2, createdAt: "2026-01-01T00:00:00Z" });
  await add(d, ps[1], "p0-new", { priority: 0, createdAt: "2026-09-01T00:00:00Z" });
  await add(d, ps[2], "p2-new", { priority: 2, createdAt: "2026-09-02T00:00:00Z" });
  assert.deepEqual((await selectAdmissible(d, 3)).map((t) => t.id), ["p0-new", "p2-old", "p2-new"]);
});

// --- 上限待ち（2026-09-19-rate-limit-wait-design.md） ------------------------

const UNTIL = "2026-09-19T03:20:00.000Z";

async function addRateLimited(d: Db, p: number, id: string, until = UNTIL) {
  await add(d, p, id);
  await d.updateTable("tasks").set({ state: "rate_limited", rate_limited_until: until })
    .where("id", "=", id).execute();
}

async function addWaiting(d: Db, p: number, id: string, until = "2026-09-22T03:20:00.000Z") {
  await add(d, p, id, { state: "waiting" });
  await d.updateTable("tasks").set({ waiting_until: until }).where("id", "=", id).execute();
}

test("rate_limited は全体枠を数えず、プロジェクト枠は数える", async () => {
  const { d, p } = await fixture(2);
  await addRateLimited(d, p, "waiting");
  const usage = await currentUsage(d);
  assert.equal(usage.global, 0, "待っている間はマシンもAPIも使っていない");
  assert.equal(usage.byProject.get(p), 1, "worktree とブランチは握ったまま");
});

test("期限が来ていなければ解放しない", async () => {
  const { d, p } = await fixture();
  await addRateLimited(d, p, "waiting");
  assert.deepEqual(await releaseDueRateLimited(d, new Date("2026-09-19T03:19:59.000Z")), []);
  assert.equal((await getTask(d, "waiting"))?.state, "rate_limited");
});

test("期限が来たら queued に戻し、戻したidを返す", async () => {
  const { d, p } = await fixture(3);
  await addRateLimited(d, p, "late", "2026-09-19T05:00:00.000Z");
  await addRateLimited(d, p, "early", "2026-09-19T03:20:00.000Z");
  assert.deepEqual(
    await releaseDueRateLimited(d, new Date("2026-09-19T04:00:00.000Z")),
    ["early"],
    "期限の来たものだけ",
  );
  const t = (await getTask(d, "early"))!;
  assert.equal(t.state, "queued");
  assert.equal(t.rate_limited_until, null);
  assert.equal(t.resumed, 1);
  assert.equal((await getTask(d, "late"))?.state, "rate_limited");
});

test("上限待ちがいるかどうかを状態から数える", async () => {
  const { d, p } = await fixture();
  assert.equal(await hasActiveRateLimit(d), false);
  await addRateLimited(d, p, "waiting");
  assert.equal(await hasActiveRateLimit(d), true);
  await releaseDueRateLimited(d, new Date("2026-09-19T04:00:00.000Z"));
  assert.equal(await hasActiveRateLimit(d), false);
});

test("waiting は全体枠を数えず、プロジェクト枠は数える", async () => {
  const { d, p } = await fixture(2);
  await addWaiting(d, p, "w");
  const usage = await currentUsage(d);
  assert.equal(usage.global, 0);
  assert.equal(usage.byProject.get(p), 1, "PR を開いたままの worktree を握っている");
});

test("期限の来た waiting だけを queued に戻す", async () => {
  const { d, p } = await fixture(3);
  await addWaiting(d, p, "late", "2026-09-22T05:00:00.000Z");
  await addWaiting(d, p, "early", "2026-09-22T03:20:00.000Z");
  assert.deepEqual(await releaseDueWaiting(d, new Date("2026-09-22T04:00:00.000Z")), ["early"]);
  const t = (await getTask(d, "early"))!;
  assert.equal(t.state, "queued");
  assert.equal(t.waiting_until, null);
  assert.equal(t.resumed, 1, "進行中の仕事として行列の先頭に入る");
  assert.equal((await getTask(d, "late"))?.state, "waiting");
});

test("占有数はカウンタではなく running から導出する", async () => {
  const { d, p } = await fixture(2);
  await add(d, p, "r1", { state: "running" });
  await add(d, p, "s1", { state: "suspended" });
  const usage = await currentUsage(d);
  assert.equal(usage.global, 1);
  assert.equal(usage.byProject.get(p), 2);
});

async function addIntake(
  d: Db,
  p: number,
  id: string,
  o: { state?: IntakeState; rateLimitedUntil?: string } = {},
) {
  await insertIntake(d, {
    id,
    project_id: p,
    issue_url: `https://github.com/o/r/issues/${id}`,
    issue_node_id: `N${id}`,
    issue_title: id,
  });
  await updateIntake(d, id, {
    state: o.state ?? "investigating",
    rate_limited_until: o.rateLimitedUntil ?? null,
  });
}

async function addRun(d: Db, intakeId: string, status: IntakeRunStatus, attempt = 1) {
  return await insertIntakeRun(d, {
    intake_id: intakeId,
    purpose: "investigate",
    attempt,
    status,
    started_at: null,
    log_path: `/logs/${intakeId}.log`,
  });
}

test("Intake の実行は全体枠だけを数える", async () => {
  const { d, p } = await fixture();
  await addIntake(d, p, "i1");
  await addRun(d, "i1", "running");
  await addRun(d, "i1", "queued");
  const usage = await currentUsage(d);
  assert.equal(usage.global, 1);
  assert.equal(usage.byProject.size, 0);
});

test("Intake の実行で全体枠が埋まればタスクを受け付けない", async () => {
  const { d, p } = await fixture();
  await addIntake(d, p, "i1");
  await addRun(d, "i1", "running");
  await add(d, p, "t1");
  assert.deepEqual(await selectAdmissible(d, 1), []);
});

test("selectAdmissibleIntakeRuns は全体枠の空きまで返す", async () => {
  const { d, p } = await fixture(3);
  await addIntake(d, p, "i1");
  await addIntake(d, p, "i2");
  await addIntake(d, p, "i3");
  const first = await addRun(d, "i1", "queued");
  await addRun(d, "i2", "queued");
  await addRun(d, "i3", "queued");
  await add(d, p, "r1", { state: "running" });
  const admitted = await selectAdmissibleIntakeRuns(d, 2);
  assert.deepEqual(admitted.map((r) => r.id), [first]);
});

test("Intake の上限待ちも hasActiveRateLimit に数える", async () => {
  const { d, p } = await fixture();
  await addIntake(d, p, "i1");
  assert.equal(await hasActiveRateLimit(d), false);
  await updateIntake(d, "i1", { rate_limited_until: "2026-09-19T04:00:00.000Z" });
  assert.equal(await hasActiveRateLimit(d), true);
});

test("releaseDueIntakeRateLimited は期限の来たものだけ戻す", async () => {
  const { d, p } = await fixture();
  await addIntake(d, p, "due", { rateLimitedUntil: "2026-09-19T03:00:00.000Z" });
  await addIntake(d, p, "later", { rateLimitedUntil: "2026-09-19T09:00:00.000Z" });
  await addRun(d, "due", "rate_limited", 2);
  await addRun(d, "later", "rate_limited", 1);

  const released = await releaseDueIntakeRateLimited(d, {
    logRoot: "/logs",
    now: new Date("2026-09-19T04:00:00.000Z"),
  });
  assert.deepEqual(released, ["due"]);
  assert.equal((await getIntake(d, "due"))!.rate_limited_until, null);
  assert.equal((await getIntake(d, "later"))!.rate_limited_until, "2026-09-19T09:00:00.000Z");

  const dueRuns = await listIntakeRuns(d, "due");
  assert.equal(dueRuns.length, 2);
  assert.equal(dueRuns[1].status, "queued");
  assert.equal(dueRuns[1].purpose, "investigate");
  // 上限待ちからの再開では attempt を進めない
  assert.equal(dueRuns[1].attempt, 2);
  assert.equal((await listIntakeRuns(d, "later")).length, 1);
});

test("終わった Intake の上限待ちは数えず、戻さず、受け付けない", async () => {
  const { d, p } = await fixture();
  await addIntake(d, p, "gone", {
    state: "canceled",
    rateLimitedUntil: "2026-09-19T03:00:00.000Z",
  });
  await addRun(d, "gone", "queued");
  assert.equal(await hasActiveRateLimit(d), false);
  assert.deepEqual(
    await releaseDueIntakeRateLimited(d, {
      logRoot: "/logs",
      now: new Date("2026-09-19T04:00:00.000Z"),
    }),
    [],
  );
  assert.deepEqual(await selectAdmissibleIntakeRuns(d, 4), []);
});
