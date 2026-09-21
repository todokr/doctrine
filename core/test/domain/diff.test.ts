import { Buffer } from "node:buffer";
import { afterEach, beforeEach, test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeDiff, mergeBase, truncatePatch } from "../../src/domain/diff.ts";
import { captureTree } from "../../src/domain/reviewTree.ts";
import { ensureDoctrineOutExcluded } from "../../src/domain/worktree.ts";
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

// captureTree 自身の振る舞い（未コミット・未追跡を含む、本物の index を汚さない等）は
// #43 の test/core/reviewTree.test.ts が検証済みなので、ここでは重複させない。
// ただし「index が一度も作られていないリポジトリ」のケースは #43 側に無いので、
// captureTree に張り替えて残す。

test("index が一度も作られていないリポジトリでも空のツリーとして扱う", async () => {
  // makeRepo は最初のコミットまで済ませてしまい、その時点で index ができてしまう。
  // 「index が存在しない」を再現するには、コミットを一度もしない裸のリポジトリが要る。
  const bare = join(root, "no-index");
  await mkdir(bare, { recursive: true });
  await run("git", ["init", "-b", "main", bare]);
  const tree = await captureTree(bare);
  assert.equal(tree, "4b825dc642cb6eb9a060e54bf8d69288fbee4904", "空のツリーの既知の SHA");
});

/** テストの定型: merge-base から今の worktree まで。 */
function diffNow(patchLimitBytes?: number) {
  return (async () => {
    const [fromRef, toRef] = await Promise.all([
      mergeBase(repo, "main"),
      captureTree(repo),
    ]);
    return await computeDiff({ worktreePath: repo, fromRef, toRef, patchLimitBytes });
  })();
}

test("未コミットの変更と未追跡のファイルが files に出る", async () => {
  await writeFile(join(repo, "README.md"), "a\nb\nc\nd\n");
  await writeFile(join(repo, "new.txt"), "x\n");
  const d = await diffNow();
  const byPath = new Map(d.files.map((f) => [f.path, f]));
  const readme = byPath.get("README.md")!;
  assert.equal(readme.status, "M");
  assert.equal(readme.binary, false);
  if (!readme.binary) {
    assert.equal(readme.additions, 1);
    assert.equal(readme.deletions, 0);
  }
  const newTxt = byPath.get("new.txt")!;
  assert.equal(newTxt.status, "A");
  if (!newTxt.binary) {
    assert.equal(newTxt.additions, 1);
  }
});

test("削除とリネームを status と old_path で返す", async () => {
  await writeFile(join(repo, "keep.txt"), "1\n2\n3\n4\n5\n6\n7\n8\n");
  await run("git", ["-C", repo, "add", "."]);
  await run("git", ["-C", repo, "commit", "-m", "add keep"]);
  await run("git", ["-C", repo, "mv", "keep.txt", "moved.txt"]);
  await rm(join(repo, "README.md"));
  const d = await diffNow();
  const byPath = new Map(d.files.map((f) => [f.path, f]));
  const moved = byPath.get("moved.txt")!;
  assert.equal(moved.status, "R");
  if (moved.status === "R") {
    assert.equal(moved.old_path, "keep.txt");
  }
  const readme = byPath.get("README.md")!;
  assert.equal(readme.status, "D");
  assert.ok(!("old_path" in readme), "R 以外は old_path を持たない");
});

test("コピーされたファイルは status C と old_path を返す", async () => {
  await writeFile(join(repo, "keep.txt"), "1\n2\n3\n4\n5\n6\n7\n8\n");
  await run("git", ["-C", repo, "add", "."]);
  await run("git", ["-C", repo, "commit", "-m", "add keep"]);
  await writeFile(join(repo, "copied.txt"), "1\n2\n3\n4\n5\n6\n7\n8\n");
  // -C は同じ diff の中で変更されたファイルからのコピーしか拾わないので、元も1行変える
  await writeFile(join(repo, "keep.txt"), "1\n2\n3\n4\n5\n6\n7\nchanged\n");
  const d = await diffNow();
  const byPath = new Map(d.files.map((f) => [f.path, f]));
  const copied = byPath.get("copied.txt")!;
  assert.equal(copied.status, "C");
  if (copied.status === "C") {
    assert.equal(copied.old_path, "keep.txt");
  }
  assert.equal(byPath.get("keep.txt")!.status, "M");
  assert.ok(!("old_path" in byPath.get("keep.txt")!), "C 以外は old_path を持たない");
});

test("バイナリは binary: true にして行数を数えない", async () => {
  await writeFile(join(repo, "b.bin"), Buffer.from([0, 1, 2, 0, 3]));
  const d = await diffNow();
  const f = d.files.find((x) => x.path === "b.bin")!;
  assert.equal(f.binary, true);
  // 0 ではなくフィールドごと無いことを確認する
  // — 0 だと「1行も変わっていないテキスト」と見分けがつかなくなるのが、
  // この union で無くしたかった不正な状態そのもの。
  assert.ok(!("additions" in f), "additions を持たない");
  assert.ok(!("deletions" in f), "deletions を持たない");
});

test(".doctrine-out/ は diff に出さない", async () => {
  await ensureDoctrineOutExcluded(repo);
  await mkdir(join(repo, ".doctrine-out"), { recursive: true });
  await writeFile(join(repo, ".doctrine-out", "plan.md"), "計画\n");
  const d = await diffNow();
  assert.deepEqual(d.files, []);
});

test("誤ってコミットされた .doctrine-out/ も pathspec 側の除外で diff に出さない", async () => {
  // ensureDoctrineOutExcluded を呼ばずに .doctrine-out/ を普通に commit する
  // — exclude 設定が無い/漏れているリポジトリを再現する。exclude が効かない状況でも
  // pathspec 側の除外だけで隠せることを確かめる（二重化の片方だけを検証する既存テストと対）。
  await mkdir(join(repo, ".doctrine-out"), { recursive: true });
  await writeFile(join(repo, ".doctrine-out", "x"), "1\n");
  await run("git", ["-C", repo, "add", ".doctrine-out/x"]);
  await run("git", ["-C", repo, "commit", "-m", "誤ってコミットされた .doctrine-out/x"]);

  await writeFile(join(repo, ".doctrine-out", "x"), "2\n");
  const d = await diffNow();
  assert.deepEqual(d.files, [], "committed 済みでも pathspec の exclude が効く");
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

test("上限を超えた patch は改行境界で切って truncated を立てる", async () => {
  const lines = Array.from({ length: 300 }, (_, i) => `line ${i}\n`).join("");
  await writeFile(join(repo, "big.txt"), lines);
  const d = await diffNow(300);
  assert.equal(d.truncated, true);
  assert.ok(d.patch.endsWith("\n"), "行の途中で切ると unified diff のパーサが壊れる");
  assert.ok(new TextEncoder().encode(d.patch).length <= 300);
  assert.deepEqual(d.files.map((f) => f.path), ["big.txt"], "files は打ち切らない");
  const big = d.files[0];
  if (!big.binary) {
    assert.equal(big.additions, 300, "行数も打ち切らない");
  }
});

test("上限以内なら truncated は false のまま patch を全部返す", async () => {
  await writeFile(join(repo, "README.md"), "a\nb\nc\nd\n");
  const d = await diffNow();
  assert.equal(d.truncated, false);
  assert.match(d.patch, /^\+d$/m);
});

test("改行が無い長い1行は UTF-8 の文字境界まで戻して切る", () => {
  const text = "日".repeat(100); // 1文字3バイト、改行なし
  // 99 は文字の切れ目ちょうど、100・101 は文字の途中
  for (const limit of [99, 100, 101]) {
    const r = truncatePatch(text, limit);
    assert.equal(r.truncated, true, `limit=${limit}`);
    assert.ok(!r.patch.includes("�"), `limit=${limit}: 置換文字が混ざっている`);
    assert.ok(
      new TextEncoder().encode(r.patch).length <= limit,
      `limit=${limit}: 再エンコードすると上限を超える`,
    );
  }
  // 切れ目ちょうどの 99 は1文字も余分に捨てない
  assert.equal(truncatePatch(text, 99).patch, "日".repeat(33));
});
