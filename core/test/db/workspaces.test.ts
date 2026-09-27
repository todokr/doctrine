import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { openDb } from "../../src/db/migrate.ts";
import { insertProject } from "../../src/db/tasks.ts";
import {
  getWorkspace,
  getWorkspaceByPath,
  insertWorkspace,
  listProjectsOf,
  listWorkspaces,
  projectNameFrom,
} from "../../src/db/workspaces.ts";
import { seedProject } from "../helpers/project.ts";

test("projectNameFrom は [a-z0-9-]+ に丸める", () => {
  assert.equal(projectNameFrom("My_Repo"), "my-repo");
  assert.equal(projectNameFrom("assured-tp"), "assured-tp");
  assert.equal(projectNameFrom("--Foo.Bar--"), "foo-bar");
});

test("projectNameFrom は丸めて空になれば project", () => {
  assert.equal(projectNameFrom("___"), "project");
  assert.equal(projectNameFrom(""), "project");
});

test("insertWorkspace で入れた行を id と path で引ける", async () => {
  const d = await openDb(":memory:");
  const id = await insertWorkspace(d, { path: "/w/tp", name: "tp" });
  const expected = { id, path: "/w/tp", name: "tp" };
  assert.deepEqual({ ...(await getWorkspace(d, id)) }, expected);
  assert.deepEqual({ ...(await getWorkspaceByPath(d, "/w/tp")) }, expected);
  assert.equal(await getWorkspaceByPath(d, "/nope"), undefined);
});

test("workspaces.path は重ならない", async () => {
  const d = await openDb(":memory:");
  await insertWorkspace(d, { path: "/w/tp", name: "tp" });
  await assert.rejects(insertWorkspace(d, { path: "/w/tp", name: "tp2" }), /UNIQUE/);
});

test("listWorkspaces は id 順", async () => {
  const d = await openDb(":memory:");
  await insertWorkspace(d, { path: "/b", name: "b" });
  await insertWorkspace(d, { path: "/a", name: "a" });
  assert.deepEqual((await listWorkspaces(d)).map((w) => w.path), ["/b", "/a"]);
});

test("listProjectsOf は他の workspace のプロジェクトを返さない", async () => {
  const d = await openDb(":memory:");
  const a = await seedProject(d, { path: "/a" });
  const b = await seedProject(d, { path: "/b" });
  assert.deepEqual((await listProjectsOf(d, a.workspace_id)).map((p) => p.path), ["/a"]);
  assert.deepEqual((await listProjectsOf(d, b.workspace_id)).map((p) => p.path), ["/b"]);
});

test("同じ workspace に同じ名前のプロジェクトは入らず、存在しない workspace も指せない", async () => {
  const d = await openDb(":memory:");
  const w1 = await insertWorkspace(d, { path: "/w1", name: "w1" });
  const w2 = await insertWorkspace(d, { path: "/w2", name: "w2" });
  const project = (workspace_id: number, path: string) => ({
    workspace_id,
    name: "a",
    path,
    default_workflow: "f",
    max_concurrent: 1,
    base_branch: "main",
    setup: null,
  });
  await insertProject(d, project(w1, "/x"));
  await assert.rejects(insertProject(d, project(w1, "/y")), /UNIQUE/);
  await insertProject(d, project(w2, "/z"));
  await assert.rejects(insertProject(d, project(999, "/q")), /FOREIGN KEY/);
});

test("seedProject は workspace とプロジェクトを 1 つずつ入れる", async () => {
  const d = await openDb(":memory:");
  const row = await seedProject(d, { path: "/w/My_Repo" });
  assert.equal(row.name, "my-repo");
  assert.equal(row.default_workflow, "f");
  const w = await getWorkspace(d, row.workspace_id);
  assert.equal(w?.path, "/w/My_Repo");
  assert.equal(w?.name, "My_Repo");
});
