import { afterEach, beforeEach, test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeWorktreeTree } from "../../src/core/diff.ts";
import { makeRepo } from "../helpers/repo.ts";

const run = promisify(execFile);
let root: string;
let repo: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "doctrine-diff-"));
  repo = await makeRepo(root, { "README.md": "a\nb\nc\n" });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("write-tree は未コミットと未追跡を含めた今の状態を返す", async () => {
  await writeFile(join(repo, "README.md"), "a\nb\nc\nd\n");
  await writeFile(join(repo, "new.txt"), "x\n");
  const tree = await writeWorktreeTree(repo);
  const { stdout } = await run("git", ["-C", repo, "ls-tree", "-r", "--name-only", tree]);
  assert.deepEqual(stdout.trim().split("\n").sort(), ["README.md", "new.txt"]);
  const { stdout: blob } = await run("git", ["-C", repo, "show", `${tree}:README.md`]);
  assert.equal(blob, "a\nb\nc\nd\n", "コミット済みの内容ではなく worktree の今の内容");
});

test("write-tree は本物の index を汚さない", async () => {
  await writeFile(join(repo, "new.txt"), "x\n");
  const before = (await run("git", ["-C", repo, "status", "--porcelain"])).stdout;
  await writeWorktreeTree(repo);
  const after = (await run("git", ["-C", repo, "status", "--porcelain"])).stdout;
  assert.equal(after, before, "エージェントが同時に走っている worktree を壊さない");
});
