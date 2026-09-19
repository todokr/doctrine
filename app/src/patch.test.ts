import { describe, expect, test } from "vitest";
import { SAMPLE_DIFF } from "./fixtures";
import { buildDiff, parsePatch } from "./patch";
import type { TaskDiff } from "./types";

const find = (path: string) => buildDiff(SAMPLE_DIFF).find((f) => f.path === path)!;

describe("buildDiff", () => {
  test("files の順と件数をそのまま保つ", () => {
    expect(buildDiff(SAMPLE_DIFF).map((f) => f.path)).toEqual(SAMPLE_DIFF.files.map((f) => f.path));
  });

  test("変更されたファイルの hunk を patch から組み立てる", () => {
    const f = find("src/keep.ts");
    expect(f.hunks).toHaveLength(1);
    expect(f.hunks[0]).toMatchObject({ old: 1, new: 1 });
    expect(f.hunks[0].body.split("\n")).toEqual([
      " /* 先頭の",
      "    ブロックコメント */",
      "-export const greet = (name: string) => `hello ${name}`;",
      "-const n = 1;",
      "+export const greet = (name: string) => `hi ${name}!`;",
      "+const n = 2;",
    ]);
  });

  test("件数が省略された hunk ヘッダ（@@ -0,0 +1 @@）も読む", () => {
    expect(find("src/added.ts").hunks[0]).toMatchObject({ old: 0, new: 1, body: "+new file" });
  });

  test("バイナリは hunk を持たず、行数も持たない", () => {
    const f = find("logo.png");
    expect(f.binary).toBe(true);
    expect(f.hunks).toEqual([]);
    expect(f).not.toHaveProperty("additions");
  });

  test("中身の変わらないリネームは、リネーム元を保ったまま hunk が空になる", () => {
    const f = find("src/renamed.ts");
    expect(f.status === "R" && f.old_path).toBe("src/moved.ts");
    expect(f.hunks).toEqual([]);
    expect(f.cutOff).toBe(false);
  });

  test("打ち切りで patch が尽きたファイルは、変更なしではなく cutOff として出る", () => {
    const truncated: TaskDiff = {
      ...SAMPLE_DIFF,
      // src/keep.ts の hunk の途中で切れた patch
      patch: SAMPLE_DIFF.patch.slice(0, SAMPLE_DIFF.patch.indexOf("diff --git a/src/moved.ts")),
      truncated: true,
    };
    const files = buildDiff(truncated);
    expect(files.map((f) => f.cutOff)).toEqual([false, false, false, false, true]);
  });

  test("patch のファイル数が files を超えていたら、突き合わせの前提が崩れているので落とす", () => {
    const broken: TaskDiff = { ...SAMPLE_DIFF, files: SAMPLE_DIFF.files.slice(0, 1) };
    expect(() => buildDiff(broken)).toThrow(/patch のファイル数/);
  });
});

describe("parsePatch", () => {
  test("「改行で終わっていない」の注記は行として数えない", () => {
    const patch = `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1,2 +1,2 @@
 keep
-old
\\ No newline at end of file
+new
\\ No newline at end of file
`;
    expect(parsePatch(patch)[0].hunks[0].body.split("\n")).toEqual([" keep", "-old", "+new"]);
  });

  test("種別の変わったファイル（symlink → 通常ファイル）の2区画を1つにまとめる", () => {
    // --name-status は T の1件で返すのに、patch は削除と作成の2区画に分かれる。
    // 分かれたまま数えると files[] より区画が多くなり、突き合わせが落ちる
    const patch = `diff --git a/link b/link
deleted file mode 120000
index 1de5659..0000000
--- a/link
+++ /dev/null
@@ -1 +0,0 @@
-target
\\ No newline at end of file
diff --git a/link b/link
new file mode 100644
index 0000000..2a79fdf
--- /dev/null
+++ b/link
@@ -0,0 +1 @@
+now a real file
`;
    const sections = parsePatch(patch);
    expect(sections).toHaveLength(1);
    expect(sections[0].hunks.map((h) => h.body)).toEqual(["-target", "+now a real file"]);
  });

  test("1ファイルに複数の hunk があれば、それぞれの開始行を持つ", () => {
    const patch = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,2 +1,2 @@
 a
-b
+B
@@ -20,2 +20,3 @@
 c
+d
`;
    expect(parsePatch(patch)[0].hunks.map((h) => [h.old, h.new])).toEqual([[1, 1], [20, 20]]);
  });
});
