import { afterEach, beforeEach, test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { openDb } from "../../src/db/migrate.ts";
import type { Db } from "../../src/db/schema.ts";
import { detectWorkspace } from "../../src/daemon/workspaceDetect.ts";
import { addWorkspace } from "../../src/daemon/workspaceRegistry.ts";
import { makeRepo } from "../helpers/repo.ts";

const run = promisify(execFile);

let root: string;
let db: Db;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "doctrine-wsdetect-")));
  db = await openDb(":memory:");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** dir 自身を git リポジトリのルートにする（makeRepo は <dir>/repo に作るので使えない）。 */
async function initRepoAt(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  await run("git", ["init", "-b", "main", dir]);
  await run("git", ["-C", dir, "config", "user.email", "t@e.com"]);
  await run("git", ["-C", dir, "config", "user.name", "t"]);
  await writeFile(join(dir, "README.md"), "x\n");
  await run("git", ["-C", dir, "add", "."]);
  await run("git", ["-C", dir, "commit", "-m", "init"]);
  return dir;
}

test("リポジトリのルートを選ぶと isRepoRoot で repositories は空", async () => {
  const repo = await makeRepo(join(root, "repo"), { "README.md": "x\n" });
  const r = await detectWorkspace(db, repo);
  assert.equal(r.isRepoRoot, true);
  assert.deepEqual(r.repositories, []);
  assert.equal(r.existing, null);
  assert.equal(r.alreadyRegistered, false);
});

test("git 管理外のディレクトリなら直下のリポジトリを名前順に返し、suggestedName を丸める", async () => {
  const myRepo = await initRepoAt(join(root, "My_Repo"));
  const zzz = await initRepoAt(join(root, "zzz"));
  const r = await detectWorkspace(db, root);
  assert.equal(r.isRepoRoot, false);
  assert.deepEqual(r.repositories, [
    { dir: myRepo, suggestedName: "my-repo" },
    { dir: zzz, suggestedName: "zzz" },
  ]);
});

test("直下にリポジトリが無ければ repositories は空", async () => {
  await mkdir(join(root, "notrepo"));
  const r = await detectWorkspace(db, root);
  assert.deepEqual(r.repositories, []);
});

test("リポジトリのサブディレクトリなら投げる", async () => {
  const repo = await makeRepo(join(root, "repo"), { "README.md": "x\n" });
  await mkdir(join(repo, "sub"));
  await assert.rejects(detectWorkspace(db, join(repo, "sub")), /サブディレクトリ/);
});

test("workspace.yaml があれば existing に中身が入る", async () => {
  await makeRepo(join(root, "a"), { "README.md": "x\n" });
  const tp = join(root, "tp");
  await mkdir(join(tp, ".doctrine"), { recursive: true });
  await writeFile(join(tp, ".doctrine", "workspace.yaml"), "name: tp\nprojects:\n  a: ../a/repo\n");
  const r = await detectWorkspace(db, tp);
  assert.deepEqual(r.existing, {
    name: "tp",
    projects: { a: "../a/repo" },
    tracker: { kind: "github" },
  });
});

test("workspace.yaml が読めなければ投げる", async () => {
  const tp = join(root, "tp2");
  await mkdir(join(tp, ".doctrine"), { recursive: true });
  // projects が空 = スキーマで落ちる
  await writeFile(join(tp, ".doctrine", "workspace.yaml"), "projects: {}\n");
  await assert.rejects(detectWorkspace(db, tp));
});

test("登録済みなら alreadyRegistered", async () => {
  const a = await makeRepo(join(root, "a"), { "README.md": "x\n" });
  await addWorkspace(db, a);
  const r = await detectWorkspace(db, a);
  assert.equal(r.alreadyRegistered, true);
});
