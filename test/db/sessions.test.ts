import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { openDb } from "../../src/db/migrate.ts";
import { insertProject, insertTask } from "../../src/db/tasks.ts";
import { commitStepBoundary } from "../../src/db/boundary.ts";
import { getSessionId } from "../../src/db/sessions.ts";
import type { Db } from "../../src/db/schema.ts";

async function fixture(): Promise<Db> {
  const d = await openDb(":memory:");
  const pid = await insertProject(d, {
    path: "/repo", default_workflow: "f", max_concurrent: 1, base_branch: "main", setup: null,
  });
  await insertTask(d, { id: "t1", project_id: pid, title: "T", prompt: "P", workflow_name: "f", branch: "b", priority: 2 });
  return d;
}

test("セッションが無いロールは undefined", async () => {
  const d = await fixture();
  assert.equal(await getSessionId(d, "t1", "planner"), undefined);
});

test("commitStepBoundary の sessionUpsert で書いたセッションが引ける", async () => {
  const d = await fixture();
  await commitStepBoundary(d, { taskId: "t1", taskPatch: {}, sessionUpsert: { role: "planner", session_id: "s1" } });
  assert.equal(await getSessionId(d, "t1", "planner"), "s1");
});

test("同じロールへの2度目の sessionUpsert は上書きする", async () => {
  const d = await fixture();
  await commitStepBoundary(d, { taskId: "t1", taskPatch: {}, sessionUpsert: { role: "planner", session_id: "s1" } });
  await commitStepBoundary(d, { taskId: "t1", taskPatch: {}, sessionUpsert: { role: "planner", session_id: "s2" } });
  assert.equal(await getSessionId(d, "t1", "planner"), "s2");
});

test("ロールが違えば別のセッションとして残る", async () => {
  const d = await fixture();
  await commitStepBoundary(d, { taskId: "t1", taskPatch: {}, sessionUpsert: { role: "planner", session_id: "s1" } });
  await commitStepBoundary(d, { taskId: "t1", taskPatch: {}, sessionUpsert: { role: "implementer", session_id: "s2" } });
  assert.equal(await getSessionId(d, "t1", "planner"), "s1");
  assert.equal(await getSessionId(d, "t1", "implementer"), "s2");
});
