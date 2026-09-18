import { afterEach, test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { join } from "@std/path";
import { MAX_REVIEW_FILE_BYTES, readReviewFiles } from "../../src/core/reviewFiles.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => Deno.remove(d, { recursive: true })));
});

async function worktree(files: Record<string, string> = {}): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "doctrine-reviewfiles-" });
  dirs.push(root);
  const wt = join(root, "wt");
  await Deno.mkdir(wt, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const path = join(wt, rel);
    await Deno.mkdir(join(path, ".."), { recursive: true });
    await Deno.writeTextFile(path, content);
  }
  return wt;
}

test("宣言されたファイルの本文が返る", async () => {
  const wt = await worktree({ ".doctrine-out/plan.md": "# 計画\n\n- やる\n" });
  const [file] = await readReviewFiles(wt, [".doctrine-out/plan.md"]);
  assert.equal(file.status, "ok");
  assert.equal(file.path, ".doctrine-out/plan.md", "宣言されたとおりのパスを返す");
  if (file.status !== "ok") throw new Error("unreachable");
  assert.equal(file.content, "# 計画\n\n- やる\n");
  assert.equal(file.size, new TextEncoder().encode("# 計画\n\n- やる\n").byteLength);
});

test("宣言された順に、宣言された数だけ返る", async () => {
  const wt = await worktree({ "a.md": "a", "b.md": "b" });
  const files = await readReviewFiles(wt, ["b.md", "missing.md", "a.md"]);
  assert.deepEqual(files.map((f) => f.path), ["b.md", "missing.md", "a.md"]);
  assert.deepEqual(files.map((f) => f.status), ["ok", "missing", "ok"]);
});

test("無いファイルは missing（中身も大きさも持たない）", async () => {
  const wt = await worktree();
  const [file] = await readReviewFiles(wt, [".doctrine-out/plan.md"]);
  assert.deepEqual(file, { path: ".doctrine-out/plan.md", status: "missing" });
});

test("ディレクトリを宣言しても missing", async () => {
  const wt = await worktree({ "docs/a.md": "a" });
  const [file] = await readReviewFiles(wt, ["docs"]);
  assert.equal(file.status, "missing");
});

test("64KB を超えたら中身を返さず too_large（大きさは返す）", async () => {
  const big = "あ".repeat(MAX_REVIEW_FILE_BYTES); // UTF-8 で3バイト/文字
  const wt = await worktree({ "big.md": big });
  const [file] = await readReviewFiles(wt, ["big.md"]);
  assert.equal(file.status, "too_large");
  if (file.status !== "too_large") throw new Error("unreachable");
  assert.ok(file.size > MAX_REVIEW_FILE_BYTES);
  assert.equal("content" in file, false, "中身は返さない");
});

test("ちょうど 64KB は読める", async () => {
  const wt = await worktree({ "edge.md": "a".repeat(MAX_REVIEW_FILE_BYTES) });
  const [file] = await readReviewFiles(wt, ["edge.md"]);
  assert.equal(file.status, "ok");
});

test("UTF-8 として読めなければ binary", async () => {
  const wt = await worktree();
  await Deno.writeFile(join(wt, "logo.png"), new Uint8Array([0x89, 0x50, 0x4e, 0xff, 0xfe]));
  const [file] = await readReviewFiles(wt, ["logo.png"]);
  assert.equal(file.status, "binary");
  if (file.status !== "binary") throw new Error("unreachable");
  assert.equal(file.size, 5);
});

test("worktree の外を指すシンボリックリンクは outside_worktree", async () => {
  const wt = await worktree();
  const secret = join(wt, "..", "secret.txt");
  await Deno.writeTextFile(secret, "とても秘密\n");
  await Deno.mkdir(join(wt, ".doctrine-out"), { recursive: true });
  await Deno.symlink(secret, join(wt, ".doctrine-out", "plan.md"));

  const [file] = await readReviewFiles(wt, [".doctrine-out/plan.md"]);
  assert.deepEqual(file, { path: ".doctrine-out/plan.md", status: "outside_worktree" });
});

test("worktree の中を指すシンボリックリンクは読める", async () => {
  const wt = await worktree({ "docs/plan.md": "# 計画\n" });
  await Deno.symlink(join(wt, "docs", "plan.md"), join(wt, "plan.md"));
  const [file] = await readReviewFiles(wt, ["plan.md"]);
  assert.equal(file.status, "ok");
});

test("worktree と同じ接頭辞のディレクトリは配下と誤判定しない", async () => {
  const wt = await worktree();
  // wt は <root>/wt。兄弟の <root>/wt-evil は startsWith(wt) を通ってしまう。
  const evil = `${wt}-evil`;
  await Deno.mkdir(evil, { recursive: true });
  await Deno.writeTextFile(join(evil, "x.md"), "よそのファイル\n");
  await Deno.symlink(join(evil, "x.md"), join(wt, "x.md"));

  const [file] = await readReviewFiles(wt, ["x.md"]);
  assert.equal(file.status, "outside_worktree");
});

test("worktree そのものが無ければ、宣言された全件が missing", async () => {
  const files = await readReviewFiles("/nonexistent/worktree", ["a.md", "b.md"]);
  assert.deepEqual(files, [
    { path: "a.md", status: "missing" },
    { path: "b.md", status: "missing" },
  ]);
});

test("1件の失敗が他の件を巻き込まない", async () => {
  const wt = await worktree({ "ok.md": "読める\n" });
  await Deno.mkdir(join(wt, "locked"), { recursive: true });
  await Deno.writeTextFile(join(wt, "locked", "a.md"), "x");
  await Deno.chmod(join(wt, "locked"), 0o000);
  try {
    const files = await readReviewFiles(wt, ["locked/a.md", "ok.md"]);
    assert.equal(files[0].status, "missing", "読めないものは missing に倒す");
    assert.equal(files[1].status, "ok", "他の件は読める");
  } finally {
    await Deno.chmod(join(wt, "locked"), 0o755);
  }
});
