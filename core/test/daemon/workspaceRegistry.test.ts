import { afterEach, beforeEach, test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/db/migrate.ts";
import type { Db } from "../../src/db/schema.ts";
import { getProject, insertTask, listProjects } from "../../src/db/tasks.ts";
import { insertIntake } from "../../src/db/intakes.ts";
import {
  getWorkspace,
  getWorkspaceByPath,
  listProjectsOf,
  listWorkspaces,
} from "../../src/db/workspaces.ts";
import { addWorkspace, updateWorkspace } from "../../src/daemon/workspaceRegistry.ts";
import { makeRepo } from "../helpers/repo.ts";
import { seedProject } from "../helpers/project.ts";

let rawRoot: string;
let root: string;
let db: Db;

beforeEach(async () => {
  rawRoot = await mkdtemp(join(tmpdir(), "doctrine-wsreg-"));
  root = await realpath(rawRoot);
  db = await openDb(":memory:");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function repoAt(name: string): Promise<string> {
  return await makeRepo(join(root, name), {
    "README.md": "x\n",
    ".doctrine/project.yaml": "defaultWorkflow: feature\nmaxConcurrent: 1\nbaseBranch: main\n",
    ".doctrine/workflows/feature.yaml":
      "name: feature\nsteps:\n  - id: review\n    type: approval\n    title: 見て\n",
  });
}

/** 束ねる root（git 管理外）を作り、workspace.yaml を書く。 */
async function writeTp(yaml: string, dir = "tp"): Promise<string> {
  const tp = join(root, dir);
  await mkdir(join(tp, ".doctrine"), { recursive: true });
  await writeFile(join(tp, ".doctrine", "workspace.yaml"), yaml);
  return tp;
}

const THREE =
  "name: tp\nprojects:\n  terraform: ../a/repo\n  tp: ../b/repo\n  kubernetes: ../c/repo\n";

test("git 管理外の root に 3 つのリポジトリを束ねて登録する", async () => {
  const [a, b, c] = [await repoAt("a"), await repoAt("b"), await repoAt("c")];
  const tp = await writeTp(THREE);
  const r = await addWorkspace(db, tp);
  assert.equal(r.alreadyRegistered, false);
  const rows = await listProjectsOf(db, r.workspaceId);
  assert.deepEqual(rows.map((p) => p.name), ["terraform", "tp", "kubernetes"]);
  assert.deepEqual(rows.map((p) => p.path), [a, b, c]);
  const w = await getWorkspace(db, r.workspaceId);
  assert.equal(w?.name, "tp");
  assert.equal(w?.path, tp);
});

test("root 自身がリポジトリなら workspace.yaml の雛形を書く", async () => {
  const repo = await makeRepo(join(root, "solo"), { "README.md": "x\n" });
  const r = await addWorkspace(db, repo);
  assert.deepEqual(r.created, [
    join(repo, ".doctrine", "workspace.yaml"),
    join(repo, ".doctrine", "workflows", "default.yaml"),
    join(repo, ".doctrine", "project.yaml"),
  ]);
  const rows = await listProjectsOf(db, r.workspaceId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "repo");
  assert.equal(rows[0].path, repo);
});

test("git 管理外の root に workspace.yaml が無ければ投げる", async () => {
  const empty = join(root, "empty");
  await mkdir(empty);
  await assert.rejects(addWorkspace(db, empty), /workspace\.yaml/);
  assert.deepEqual(await listWorkspaces(db), []);
});

test("2 回目の addWorkspace は alreadyRegistered", async () => {
  await repoAt("a");
  const tp = await writeTp("projects:\n  a: ../a/repo\n");
  const first = await addWorkspace(db, tp);
  const second = await addWorkspace(db, tp);
  assert.equal(second.alreadyRegistered, true);
  assert.deepEqual(second.created, []);
  assert.equal(second.workspaceId, first.workspaceId);
  assert.equal((await listWorkspaces(db)).length, 1);
});

test("末尾の / やシンボリックリンク経由のパスでも同じ workspace になる", async () => {
  const a = await repoAt("a");
  const tp = await writeTp("projects:\n  a: ../a/repo\n");
  await addWorkspace(db, join(rawRoot, "tp"));
  assert.ok(await getWorkspaceByPath(db, tp), "実パスで登録される");
  assert.equal((await listProjects(db))[0].path, await realpath(a));

  await symlink(tp, join(root, "link"));
  for (const path of [tp + "/", join(root, "link")]) {
    const r = await addWorkspace(db, path);
    assert.equal(r.alreadyRegistered, true, path);
  }
  assert.equal((await listWorkspaces(db)).length, 1);
  assert.equal((await listProjects(db)).length, 1);
});

test("projects の 2 つが同じ実パスを指すと投げる", async () => {
  await repoAt("a");
  await symlink(join(root, "a"), join(root, "alias"));
  const tp = await writeTp("projects:\n  a: ../a/repo\n  b: ../alias/repo\n");
  await assert.rejects(addWorkspace(db, tp), /同じリポジトリ/);
  assert.deepEqual(await listWorkspaces(db), []);
});

async function seedThree(): Promise<Awaited<ReturnType<typeof seedProject>>[]> {
  const rows = [];
  for (const n of ["a", "b", "c"]) rows.push(await seedProject(db, { path: await repoAt(n) }));
  return rows;
}

test("1 つずつの workspace になっていたリポジトリを吸収する", async () => {
  const seeded = await seedThree();
  const tp = await writeTp(THREE);
  const r = await addWorkspace(db, tp);
  const workspaces = await listWorkspaces(db);
  assert.deepEqual(workspaces.map((w) => w.id), [r.workspaceId]);
  const names = ["terraform", "tp", "kubernetes"];
  for (const [i, s] of seeded.entries()) {
    const p = (await getProject(db, s.id))!;
    assert.equal(p.workspace_id, r.workspaceId);
    assert.equal(p.name, names[i]);
    assert.equal(p.default_workflow, "feature");
  }
});

test("Intake を持つ workspace のリポジトリは吸収せず、何も書かずに投げる", async () => {
  const seeded = await seedThree();
  await insertIntake(db, {
    id: "i1",
    project_id: seeded[1].id,
    issue_url: "https://github.com/o/r/issues/1",
    issue_node_id: "I_1",
    issue_title: "親",
  });
  const tp = await writeTp(THREE);
  await assert.rejects(addWorkspace(db, tp), (e: Error) => {
    assert.match(e.message, /登録済みです/);
    assert.ok(e.message.includes(seeded[1].path));
    return true;
  });
  assert.equal((await listWorkspaces(db)).length, 3);
  for (const s of seeded) {
    assert.equal((await getProject(db, s.id))!.workspace_id, s.workspace_id);
  }
});

test("2 つ以上のプロジェクトを持つ workspace のリポジトリは吸収しない", async () => {
  await repoAt("a");
  await repoAt("b");
  const tp1 = await writeTp("projects:\n  a: ../a/repo\n  b: ../b/repo\n", "tp1");
  await addWorkspace(db, tp1);
  const tp2 = await writeTp("projects:\n  a: ../a/repo\n", "tp2");
  await assert.rejects(addWorkspace(db, tp2), /登録済みです/);
  assert.equal(await getWorkspaceByPath(db, tp2), undefined);
});

test("updateWorkspace は足されたプロジェクトを登録し、消されたプロジェクトを外す", async () => {
  await repoAt("a");
  await repoAt("b");
  const c = await repoAt("c");
  const tp = await writeTp("projects:\n  a: ../a/repo\n  b: ../b/repo\n");
  const { workspaceId } = await addWorkspace(db, tp);
  const before = await listProjectsOf(db, workspaceId);
  await writeTp("projects:\n  a2: ../a/repo\n  c: ../c/repo\n");
  await updateWorkspace(db, tp);
  const rows = await listProjectsOf(db, workspaceId);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, "a2");
  assert.equal(rows[0].id, before[0].id);
  assert.equal(rows[1].name, "c");
  assert.equal(rows[1].path, c);
  assert.equal(await getProject(db, before[1].id), undefined);
});

test("updateWorkspace は project.yaml と workspace の name を読み直す", async () => {
  const a = await repoAt("a");
  const tp = await writeTp("name: tp\nprojects:\n  a: ../a/repo\n");
  const { workspaceId } = await addWorkspace(db, tp);
  await writeFile(
    join(a, ".doctrine", "project.yaml"),
    "defaultWorkflow: feature\nmaxConcurrent: 3\nbaseBranch: main\n",
  );
  await writeTp("name: tp2\nprojects:\n  a: ../a/repo\n");
  await updateWorkspace(db, tp);
  assert.equal((await listProjectsOf(db, workspaceId))[0].max_concurrent, 3);
  assert.equal((await getWorkspace(db, workspaceId))?.name, "tp2");
});

async function addTwoWithTaskOnB(): Promise<{ tp: string; workspaceId: number; bId: number }> {
  await repoAt("a");
  await repoAt("b");
  const tp = await writeTp("projects:\n  a: ../a/repo\n  b: ../b/repo\n");
  const { workspaceId } = await addWorkspace(db, tp);
  const b = (await listProjectsOf(db, workspaceId))[1];
  return { tp, workspaceId, bId: b.id };
}

test("動いているタスクがあるプロジェクトは外さずに投げる", async () => {
  const { tp, workspaceId, bId } = await addTwoWithTaskOnB();
  await insertTask(db, {
    id: "t1",
    project_id: bId,
    title: "T",
    prompt: "p",
    workflow_name: "feature",
    branch: "b1",
    priority: 2,
  });
  await writeTp("projects:\n  a: ../a/repo\n");
  await assert.rejects(updateWorkspace(db, tp), /動いているタスク/);
  assert.equal((await listProjectsOf(db, workspaceId)).length, 2);
});

test("終わったタスクだけがあるプロジェクトも外さずに投げる", async () => {
  const { tp, workspaceId, bId } = await addTwoWithTaskOnB();
  await insertTask(db, {
    id: "t1",
    project_id: bId,
    title: "T",
    prompt: "p",
    workflow_name: "feature",
    branch: "b1",
    priority: 2,
  });
  await db.updateTable("tasks").set({ state: "completed" }).execute();
  await writeTp("projects:\n  a: ../a/repo\n");
  await assert.rejects(updateWorkspace(db, tp), /タスクの記録/);
  assert.equal((await listProjectsOf(db, workspaceId)).length, 2);
});

test("Intake の記録があるプロジェクトは外さずに投げる", async () => {
  const { tp, workspaceId, bId } = await addTwoWithTaskOnB();
  await insertIntake(db, {
    id: "i1",
    project_id: bId,
    issue_url: "https://github.com/o/r/issues/1",
    issue_node_id: "I_1",
    issue_title: "親",
  });
  await writeTp("projects:\n  a: ../a/repo\n");
  await assert.rejects(updateWorkspace(db, tp), /Intake の記録/);
  assert.equal((await listProjectsOf(db, workspaceId)).length, 2);
});

test("未登録の root の updateWorkspace は投げる", async () => {
  await repoAt("a");
  const tp = await writeTp("projects:\n  a: ../a/repo\n");
  await assert.rejects(updateWorkspace(db, tp), /未登録の workspace/);
});

test("相対パスは投げる", async () => {
  await assert.rejects(addWorkspace(db, "tp"), /絶対パス/);
});
