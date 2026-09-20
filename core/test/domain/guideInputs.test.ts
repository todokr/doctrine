import { afterEach, beforeEach, test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectGuideInputs, GUIDE_HUNKS_RELPATH } from "../../src/domain/guideInputs.ts";
import { ensureDoctrineOutExcluded } from "../../src/domain/worktree.ts";
import { listHunks } from "../../../shared/guide/hunkId.ts";
import { makeRepo } from "../helpers/repo.ts";

const run = promisify(execFile);
let root: string;
let repo: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "doctrine-guide-inputs-"));
  repo = await makeRepo(root, { "README.md": "a\nb\nc\n" });
  // 呼ばないと、書き出した hunk 一覧自身が次の captureTree に混ざる。
  await ensureDoctrineOutExcluded(repo);
  await run("git", ["-C", repo, "switch", "-c", "work"]);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const collect = () => collectGuideInputs({ worktreePath: repo, baseBranch: "main" });

test("コミット済みの変更が hunk の一覧に出る", async () => {
  await writeFile(join(repo, "README.md"), "a\nb\nc\nd\n");
  await run("git", ["-C", repo, "commit", "-am", "edit"]);
  const r = await collect();
  assert.ok(r.hunks.length > 0);
  assert.equal(r.hunks[0].path, "README.md");
  assert.match(r.hunks[0].id, /^h_[0-9a-f]{14}$/);
});

test("未コミット・未追跡の変更も hunk の一覧に出る", async () => {
  await writeFile(join(repo, "new.ts"), "export const x = 1;\n");
  const r = await collect();
  assert.ok(r.hunks.some((h) => h.path === "new.ts"));
});

test("hunk の一覧を .doctrine-out/ にファイルで書く", async () => {
  await writeFile(join(repo, "README.md"), "a\nb\nc\nd\n");
  const r = await collect();
  const written = JSON.parse(await readFile(join(repo, GUIDE_HUNKS_RELPATH), "utf8"));
  assert.deepEqual(written, r.hunks);
});

test("書いた一覧は patch から listHunks した結果と一致する", async () => {
  await writeFile(join(repo, "README.md"), "a\nb\nc\nd\n");
  const r = await collect();
  assert.deepEqual(listHunks(r.patch), r.hunks);
});

test("書き出した一覧はツリーに入らない", async () => {
  await writeFile(join(repo, "README.md"), "a\nb\nc\nd\n");
  const first = await collect();
  const second = await collect();
  assert.equal(second.tree, first.tree);
  assert.ok(second.hunks.every((h) => !h.path.includes(".doctrine-out/")));
});

test("変更が無ければ hunk の一覧は空で、ファイルは書かれる", async () => {
  const r = await collect();
  assert.deepEqual(r.hunks, []);
  assert.equal(r.patch, "");
  assert.equal(await readFile(join(repo, GUIDE_HUNKS_RELPATH), "utf8"), "[]");
});

test("tree と mergeBase はどちらもオブジェクトのハッシュとして返る", async () => {
  await writeFile(join(repo, "README.md"), "a\nb\nc\nd\n");
  const r = await collect();
  assert.match(r.tree, /^[0-9a-f]{40}$/);
  assert.match(r.mergeBase, /^[0-9a-f]{40}$/);
});
