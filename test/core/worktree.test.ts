import { test, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorktree, removeWorktree, hasUncommittedChanges, findOrphans,
  branchNameFor, slugify, UncommittedChangesError,
} from "../../src/core/worktree.ts";

const run = promisify(execFile);
let repo: string;
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "doctrine-test-"));
  repo = join(root, "repo");
  await run("git", ["init", "-b", "main", repo]);
  await run("git", ["-C", repo, "config", "user.email", "t@example.com"]);
  await run("git", ["-C", repo, "config", "user.name", "t"]);
  await writeFile(join(repo, "README.md"), "hi\n");
  await run("git", ["-C", repo, "add", "."]);
  await run("git", ["-C", repo, "commit", "-m", "init"]);
});

afterEach(async () => { await rm(root, { recursive: true, force: true }); });

test("ブランチ名を作る", () => {
  assert.equal(branchNameFor("abc123", "ログイン画面を直す"), "doctrine/abc123-ログイン画面を直す");
  assert.equal(slugify("Fix the login screen!"), "fix-the-login-screen");
  assert.equal(slugify("  a///b  "), "a-b");
  assert.ok(slugify("x".repeat(100)).length <= 40);
});

test("baseBranch から worktree とブランチを生やす", async () => {
  const wt = join(root, "wt", "t1");
  await createWorktree({ repoPath: repo, worktreePath: wt, branch: "doctrine/t1-x", baseBranch: "main" });
  assert.ok((await stat(join(wt, "README.md"))).isFile());
  const { stdout } = await run("git", ["-C", wt, "rev-parse", "--abbrev-ref", "HEAD"]);
  assert.equal(stdout.trim(), "doctrine/t1-x");
});

test("worktree はリポジトリの外に作られる", async () => {
  const wt = join(root, "wt", "t1");
  await createWorktree({ repoPath: repo, worktreePath: wt, branch: "doctrine/t1-x", baseBranch: "main" });
  assert.equal(wt.startsWith(repo), false);
});

test("未コミットの変更を検出する", async () => {
  const wt = join(root, "wt", "t1");
  await createWorktree({ repoPath: repo, worktreePath: wt, branch: "doctrine/t1-x", baseBranch: "main" });
  assert.equal(await hasUncommittedChanges(wt), false);
  await writeFile(join(wt, "dirty.txt"), "x");
  assert.equal(await hasUncommittedChanges(wt), true);
});

test("未コミットの変更があるとき force なしの削除は拒否する", async () => {
  const wt = join(root, "wt", "t1");
  await createWorktree({ repoPath: repo, worktreePath: wt, branch: "doctrine/t1-x", baseBranch: "main" });
  await writeFile(join(wt, "dirty.txt"), "x");
  await assert.rejects(
    () => removeWorktree({ repoPath: repo, worktreePath: wt, force: false }),
    UncommittedChangesError,
  );
  assert.ok((await stat(wt)).isDirectory());
});

test("force なら汚れた worktree も削除する", async () => {
  const wt = join(root, "wt", "t1");
  await createWorktree({ repoPath: repo, worktreePath: wt, branch: "doctrine/t1-x", baseBranch: "main" });
  await writeFile(join(wt, "dirty.txt"), "x");
  await removeWorktree({ repoPath: repo, worktreePath: wt, force: true });
  await assert.rejects(() => stat(wt));
});

test("worktree を削除してもブランチは残る", async () => {
  const wt = join(root, "wt", "t1");
  await createWorktree({ repoPath: repo, worktreePath: wt, branch: "doctrine/t1-x", baseBranch: "main" });
  await removeWorktree({ repoPath: repo, worktreePath: wt, force: false });
  const { stdout } = await run("git", ["-C", repo, "branch", "--list", "doctrine/t1-x"]);
  assert.match(stdout, /doctrine\/t1-x/);
});

test("DBに対応のない worktree を孤児として報告する", async () => {
  const known = join(root, "wt", "known");
  const orphan = join(root, "wt", "orphan");
  await createWorktree({ repoPath: repo, worktreePath: known, branch: "doctrine/a", baseBranch: "main" });
  await createWorktree({ repoPath: repo, worktreePath: orphan, branch: "doctrine/b", baseBranch: "main" });
  const orphans = await findOrphans(repo, [known]);
  assert.deepEqual(orphans, [orphan]);
});
