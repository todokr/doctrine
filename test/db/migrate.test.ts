import { test } from "vitest";
import assert from "node:assert/strict";
import { openDb } from "../../src/db/migrate.ts";
import { insertProject, insertTask, getTask, listTasks } from "../../src/db/tasks.ts";

function db() {
  return openDb(":memory:");
}

function seed(d: ReturnType<typeof db>) {
  return insertProject(d, {
    path: "/repo", default_workflow: "feature", max_concurrent: 1, base_branch: "main", setup: null,
  });
}

test("マイグレーションで5つのテーブルができる", () => {
  const d = db();
  const names = d.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all().map((r) => (r as { name: string }).name);
  for (const t of ["projects", "rate_limit_samples", "step_outputs", "step_runs", "tasks"]) {
    assert.ok(names.includes(t), `${t} が無い: ${names.join(",")}`);
  }
});

test("タスクは queued で作られる", () => {
  const d = db();
  const pid = seed(d);
  const t = insertTask(d, {
    id: "t1", project_id: pid, title: "T", prompt: "P",
    workflow_name: "feature", branch: "doctrine/t1-t", priority: 2,
  });
  assert.equal(t.state, "queued");
  assert.equal(t.worktree_path, null);
  assert.equal(t.child_pid, null);
  assert.equal(t.resumed, 0);
  assert.equal(getTask(d, "t1")?.title, "T");
});

test("state でフィルタできる", () => {
  const d = db();
  const pid = seed(d);
  insertTask(d, { id: "t1", project_id: pid, title: "a", prompt: "p", workflow_name: "f", branch: "b1", priority: 2 });
  insertTask(d, { id: "t2", project_id: pid, title: "b", prompt: "p", workflow_name: "f", branch: "b2", priority: 2 });
  d.prepare("UPDATE tasks SET state='running' WHERE id='t2'").run();
  assert.deepEqual(listTasks(d, { state: "queued" }).map((t) => t.id), ["t1"]);
});

test("同じidのタスクは作れない", () => {
  const d = db();
  const pid = seed(d);
  insertTask(d, { id: "t1", project_id: pid, title: "a", prompt: "p", workflow_name: "f", branch: "b1", priority: 2 });
  assert.throws(() => insertTask(d, { id: "t1", project_id: pid, title: "a", prompt: "p", workflow_name: "f", branch: "b1", priority: 2 }));
});
