import { afterEach, test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureTree, releaseTrees, retainTree, reviewRefName } from "../../src/core/reviewTree.ts";
import { runCommand } from "../../src/util/exec.ts";
import { makeRepo } from "../helpers/repo.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function repo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "doctrine-tree-"));
  roots.push(root);
  return await makeRepo(root, { "a.txt": "1\n" });
}

test("ツリーには未コミットの変更と未追跡のファイルが入る", async () => {
  const r = await repo();
  await writeFile(join(r, "a.txt"), "2\n"); // 追跡済みの変更（未コミット）
  await writeFile(join(r, "new.txt"), "新規\n"); // 未追跡

  const tree = await captureTree(r);

  const { stdout } = await runCommand("git", ["-C", r, "ls-tree", "-r", "--name-only", tree]);
  assert.deepEqual(stdout.trim().split("\n").sort(), ["a.txt", "new.txt"]);
  const { stdout: content } = await runCommand("git", ["-C", r, "show", `${tree}:a.txt`]);
  assert.equal(content, "2\n");
});

test("worktree の index は汚さない", async () => {
  const r = await repo();
  await writeFile(join(r, "new.txt"), "新規\n");

  await captureTree(r);

  // git add していないのだから、未追跡のままでなければならない。
  const { stdout } = await runCommand("git", ["-C", r, "status", "--porcelain"]);
  assert.match(stdout, /\?\? new\.txt/);
});

test("参照を張ったツリーは git gc で消えない", async () => {
  const r = await repo();
  await writeFile(join(r, "new.txt"), "新規\n");
  const tree = await captureTree(r);

  await retainTree({ worktreePath: r, taskId: "t1", stepRunId: 7, tree });
  await runCommand("git", ["-C", r, "gc", "--prune=now", "--aggressive"]);

  const { stdout } = await runCommand("git", ["-C", r, "ls-tree", "-r", "--name-only", tree]);
  assert.ok(stdout.includes("new.txt"));
  const { stdout: refs } = await runCommand("git", [
    "-C",
    r,
    "for-each-ref",
    "--format=%(refname)",
    "refs/doctrine/reviews/t1",
  ]);
  assert.equal(refs.trim(), reviewRefName("t1", 7));
});

test("参照が指すコミットから前回のツリーを引ける", async () => {
  const r = await repo();
  await writeFile(join(r, "new.txt"), "新規\n");
  const tree = await captureTree(r);
  await retainTree({ worktreePath: r, taskId: "t1", stepRunId: 7, tree });

  const { stdout } = await runCommand("git", [
    "-C",
    r,
    "rev-parse",
    `${reviewRefName("t1", 7)}^{tree}`,
  ]);
  assert.equal(stdout.trim(), tree);
});

test("releaseTrees はそのタスクの参照だけを消す", async () => {
  const r = await repo();
  const tree = await captureTree(r);
  await retainTree({ worktreePath: r, taskId: "t1", stepRunId: 1, tree });
  await retainTree({ worktreePath: r, taskId: "t1", stepRunId: 2, tree });
  await retainTree({ worktreePath: r, taskId: "t2", stepRunId: 3, tree });

  await releaseTrees(r, "t1");

  const { stdout } = await runCommand("git", [
    "-C",
    r,
    "for-each-ref",
    "--format=%(refname)",
    "refs/doctrine/reviews",
  ]);
  assert.deepEqual(stdout.trim().split("\n"), [reviewRefName("t2", 3)]);
});

test("参照が1つも無いタスクの releaseTrees は落ちない", async () => {
  const r = await repo();
  await releaseTrees(r, "t-none");
});

test("git リポジトリでなければ captureTree は失敗する", async () => {
  const root = await mkdtemp(join(tmpdir(), "doctrine-tree-"));
  roots.push(root);
  await assert.rejects(() => captureTree(root));
});
