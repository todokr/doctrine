import { Buffer } from "node:buffer";
import { afterEach, beforeEach, test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeDiff, mergeBase, writeWorktreeTree } from "../../src/core/diff.ts";
import { ensureDoctrineOutExcluded } from "../../src/core/worktree.ts";
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

/** テストの定型: merge-base から今の worktree まで。 */
function diffNow(patchLimitBytes?: number) {
  return (async () => {
    const [fromRef, toRef] = await Promise.all([
      mergeBase(repo, "main"),
      writeWorktreeTree(repo),
    ]);
    return await computeDiff({ worktreePath: repo, fromRef, toRef, patchLimitBytes });
  })();
}

test("未コミットの変更と未追跡のファイルが files に出る", async () => {
  await writeFile(join(repo, "README.md"), "a\nb\nc\nd\n");
  await writeFile(join(repo, "new.txt"), "x\n");
  const d = await diffNow();
  const byPath = new Map(d.files.map((f) => [f.path, f]));
  assert.equal(byPath.get("README.md")?.status, "M");
  assert.equal(byPath.get("README.md")?.additions, 1);
  assert.equal(byPath.get("README.md")?.deletions, 0);
  assert.equal(byPath.get("README.md")?.binary, false);
  assert.equal(byPath.get("new.txt")?.status, "A");
  assert.equal(byPath.get("new.txt")?.additions, 1);
});

test("削除とリネームを status と old_path で返す", async () => {
  await writeFile(join(repo, "keep.txt"), "1\n2\n3\n4\n5\n6\n7\n8\n");
  await run("git", ["-C", repo, "add", "."]);
  await run("git", ["-C", repo, "commit", "-m", "add keep"]);
  await run("git", ["-C", repo, "mv", "keep.txt", "moved.txt"]);
  await rm(join(repo, "README.md"));
  const d = await diffNow();
  const byPath = new Map(d.files.map((f) => [f.path, f]));
  assert.equal(byPath.get("moved.txt")?.status, "R");
  assert.equal(byPath.get("moved.txt")?.old_path, "keep.txt");
  assert.equal(byPath.get("README.md")?.status, "D");
  assert.equal(byPath.get("README.md")?.old_path, undefined);
});

test("バイナリは binary: true にして行数を数えない", async () => {
  await writeFile(join(repo, "b.bin"), Buffer.from([0, 1, 2, 0, 3]));
  const d = await diffNow();
  const f = d.files.find((x) => x.path === "b.bin")!;
  assert.equal(f.binary, true);
  assert.equal(f.additions, 0);
  assert.equal(f.deletions, 0);
});

test(".doctrine-out/ は diff に出さない", async () => {
  await ensureDoctrineOutExcluded(repo);
  await mkdir(join(repo, ".doctrine-out"), { recursive: true });
  await writeFile(join(repo, ".doctrine-out", "plan.md"), "計画\n");
  const d = await diffNow();
  assert.deepEqual(d.files, []);
});

test("base ブランチが worktree の後に進んでも merge-base を基準にする", async () => {
  await run("git", ["-C", repo, "checkout", "-q", "-b", "task"]);
  await run("git", ["-C", repo, "checkout", "-q", "main"]);
  await writeFile(join(repo, "other.txt"), "other\n");
  await run("git", ["-C", repo, "add", "."]);
  await run("git", ["-C", repo, "commit", "-m", "base moves"]);
  await run("git", ["-C", repo, "checkout", "-q", "task"]);
  await writeFile(join(repo, "mine.txt"), "mine\n");
  const d = await diffNow();
  assert.deepEqual(d.files.map((f) => f.path), ["mine.txt"], "base 側のコミットは混ざらない");
});
