import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { openDb } from "../../src/db/migrate.ts";
import { insertProject, insertTask, type TaskState } from "../../src/db/tasks.ts";
import { currentUsage, selectAdmissible } from "../../src/core/scheduler.ts";
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

test("占有数はカウンタではなく running から導出する", async () => {
  const { d, p } = await fixture(2);
  await add(d, p, "r1", { state: "running" });
  await add(d, p, "s1", { state: "suspended" });
  const usage = await currentUsage(d);
  assert.equal(usage.global, 1);
  assert.equal(usage.byProject.get(p), 2);
});
