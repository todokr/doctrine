import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { openDb } from "../../src/db/migrate.ts";
import { insertProject, insertTask } from "../../src/db/tasks.ts";
import { selectAdmissible, currentUsage } from "../../src/core/scheduler.ts";
import type { DatabaseSync } from "node:sqlite";

function fixture(maxConcurrent = 1) {
  const d = openDb(":memory:");
  const p = insertProject(d, {
    path: "/repo", default_workflow: "f", max_concurrent: maxConcurrent, base_branch: "main", setup: null,
  });
  return { d, p };
}

function add(d: DatabaseSync, p: number, id: string, opts: { priority?: number; state?: string; resumed?: number; createdAt?: string } = {}) {
  insertTask(d, { id, project_id: p, title: id, prompt: "x", workflow_name: "f", branch: `b/${id}`, priority: opts.priority ?? 2 });
  if (opts.state) d.prepare("UPDATE tasks SET state = ? WHERE id = ?").run(opts.state, id);
  if (opts.resumed) d.prepare("UPDATE tasks SET resumed = 1 WHERE id = ?").run(id);
  if (opts.createdAt) d.prepare("UPDATE tasks SET created_at = ? WHERE id = ?").run(opts.createdAt, id);
}

test("枠が空いていれば queued を返す", () => {
  const { d, p } = fixture();
  add(d, p, "t1");
  assert.deepEqual(selectAdmissible(d).map((t) => t.id), ["t1"]);
});

test("プロジェクト枠が埋まっていれば返さない", () => {
  const { d, p } = fixture(1);
  add(d, p, "running1", { state: "running" });
  add(d, p, "t2");
  assert.deepEqual(selectAdmissible(d), []);
});

test("suspended はプロジェクト枠を握り続ける（飢餓が起きない）", () => {
  const { d, p } = fixture(1);
  add(d, p, "waiting", { state: "suspended" });
  add(d, p, "newcomer");
  assert.deepEqual(selectAdmissible(d), [],
    "承認待ちのタスクがいる間、同じプロジェクトの新規タスクは割り込めない");
});

test("paused もプロジェクト枠を握り続ける", () => {
  const { d, p } = fixture(1);
  add(d, p, "held", { state: "paused" });
  add(d, p, "newcomer");
  assert.deepEqual(selectAdmissible(d), []);
});

test("suspended は全体枠を握らない", () => {
  const { d, p } = fixture(1);
  const p2 = insertProject(d, { path: "/other", default_workflow: "f", max_concurrent: 1, base_branch: "main", setup: null });
  for (const id of ["a", "b", "c", "d"]) add(d, p, id, { state: "suspended" });
  add(d, p2, "other");
  assert.deepEqual(selectAdmissible(d, 4).map((t) => t.id), ["other"],
    "4本が承認待ちでも全体枠は空いている");
});

test("全体枠の上限を超えて返さない", () => {
  const d = openDb(":memory:");
  const projects = [1, 2, 3, 4, 5].map((n) =>
    insertProject(d, { path: `/p${n}`, default_workflow: "f", max_concurrent: 1, base_branch: "main", setup: null }));
  projects.forEach((p, i) => add(d, p, `t${i}`));
  assert.equal(selectAdmissible(d, 4).length, 4);
});

test("再開したタスクが行列の先頭に入る", () => {
  const d = openDb(":memory:");
  const p1 = insertProject(d, { path: "/a", default_workflow: "f", max_concurrent: 1, base_branch: "main", setup: null });
  const p2 = insertProject(d, { path: "/b", default_workflow: "f", max_concurrent: 1, base_branch: "main", setup: null });
  add(d, p1, "newer", { createdAt: "2026-01-01T00:00:00Z" });
  add(d, p2, "resumed-later", { createdAt: "2026-06-01T00:00:00Z", resumed: 1 });
  assert.deepEqual(selectAdmissible(d, 1).map((t) => t.id), ["resumed-later"],
    "進行中の仕事を新規の仕事より先に終わらせる");
});

test("優先度 → 作成時刻のFIFO", () => {
  const d = openDb(":memory:");
  const ps = ["a", "b", "c"].map((n) =>
    insertProject(d, { path: `/${n}`, default_workflow: "f", max_concurrent: 1, base_branch: "main", setup: null }));
  add(d, ps[0], "p2-old", { priority: 2, createdAt: "2026-01-01T00:00:00Z" });
  add(d, ps[1], "p0-new", { priority: 0, createdAt: "2026-09-01T00:00:00Z" });
  add(d, ps[2], "p2-new", { priority: 2, createdAt: "2026-09-02T00:00:00Z" });
  assert.deepEqual(selectAdmissible(d, 3).map((t) => t.id), ["p0-new", "p2-old", "p2-new"]);
});

test("占有数はカウンタではなく running から導出する", () => {
  const { d, p } = fixture(2);
  add(d, p, "r1", { state: "running" });
  add(d, p, "s1", { state: "suspended" });
  const usage = currentUsage(d);
  assert.equal(usage.global, 1);
  assert.equal(usage.byProject.get(p), 2);
});
