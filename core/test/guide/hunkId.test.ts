import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { listHunks } from "../../../shared/guide/hunkId.ts";

/** 1ファイル1 hunk の patch。@@ の行と追加行だけ差し替えられる */
function onePatch(opts: { header?: string; added?: string; path?: string } = {}): string {
  const { header = "@@ -1,3 +1,3 @@", added = "+b", path = "src/keep.ts" } = opts;
  return `diff --git a/${path} b/${path}
index 104f954..967f419 100644
--- a/${path}
+++ b/${path}
${header}
 ctx
-a
${added}
`;
}

test("同じ patch からは同じ id が出る", () => {
  const patch = onePatch();
  const first = listHunks(patch);
  assert.equal(first.length, 1);
  assert.match(first[0].id, /^h_[0-9a-f]{14}$/);
  assert.deepEqual(listHunks(patch), first);
});

test("hunk ヘッダの行番号と後ろの文字だけが違っても id は同じ", () => {
  const a = listHunks(onePatch({ header: "@@ -1,3 +1,3 @@" }));
  const b = listHunks(onePatch({ header: "@@ -10,3 +12,3 @@ function foo()" }));
  assert.equal(a[0].id, b[0].id);
  assert.equal(a[0].header, "@@ -1,3 +1,3 @@");
  assert.equal(b[0].header, "@@ -10,3 +12,3 @@ function foo()");
});

test("本文が1行違えば id は変わる", () => {
  const a = listHunks(onePatch({ added: "+a" }));
  const b = listHunks(onePatch({ added: "+b" }));
  assert.notEqual(a[0].id, b[0].id);
});

test("パスが違えば本文が同じでも id は変わる", () => {
  const a = listHunks(onePatch({ path: "src/a.ts" }));
  const b = listHunks(onePatch({ path: "src/b.ts" }));
  assert.notEqual(a[0].id, b[0].id);
});

test("同じファイルに本文が同じ hunk が2つあっても id が衝突しない", () => {
  const patch = `diff --git a/src/keep.ts b/src/keep.ts
index 104f954..967f419 100644
--- a/src/keep.ts
+++ b/src/keep.ts
@@ -1,2 +1,2 @@
-a
+b
@@ -50,2 +50,2 @@
-a
+b
@@ -90,2 +90,2 @@
-a
+b
`;
  const hunks = listHunks(patch);
  assert.equal(hunks.length, 3);
  assert.equal(hunks[1].id, `${hunks[0].id}_2`);
  assert.equal(hunks[2].id, `${hunks[0].id}_3`);

  const single = listHunks(`diff --git a/src/keep.ts b/src/keep.ts
--- a/src/keep.ts
+++ b/src/keep.ts
@@ -1,2 +1,2 @@
-a
+b
`);
  assert.equal(hunks[0].id, single[0].id);
});

test("リネーム・新規・削除・バイナリが混ざっても落ちず、hunk の無いファイルは一覧に出ない", () => {
  const patch = `diff --git a/logo.png b/logo.png
index 742c16a..674f206 100644
Binary files a/logo.png and b/logo.png differ
diff --git a/src/added.ts b/src/added.ts
new file mode 100644
index 0000000..fa49b07
--- /dev/null
+++ b/src/added.ts
@@ -0,0 +1 @@
+new file
diff --git a/src/gone.ts b/src/gone.ts
deleted file mode 100644
index 3367afd..0000000
--- a/src/gone.ts
+++ /dev/null
@@ -1 +0,0 @@
-old
diff --git a/src/keep.ts b/src/keep.ts
index 104f954..967f419 100644
--- a/src/keep.ts
+++ b/src/keep.ts
@@ -1,4 +1,4 @@
 /* 先頭の
    ブロックコメント */
-const n = 1;
+const n = 2;
diff --git a/src/moved.ts b/src/renamed.ts
similarity index 100%
rename from src/moved.ts
rename to src/renamed.ts
diff --git a/src/old2.ts b/src/renamed2.ts
similarity index 80%
rename from src/old2.ts
rename to src/renamed2.ts
index 1111111..2222222 100644
--- a/src/old2.ts
+++ b/src/renamed2.ts
@@ -1 +1 @@
-x
+y
\\ No newline at end of file
`;
  const hunks = listHunks(patch);
  assert.deepEqual(
    hunks.map((h) => h.path),
    ["src/added.ts", "src/gone.ts", "src/keep.ts", "src/renamed2.ts"],
  );
  assert.equal(new Set(hunks.map((h) => h.id)).size, 4);
});

test("\\ No newline の行は本文に入れない", () => {
  const withNote = listHunks(`diff --git a/f b/f
--- a/f
+++ b/f
@@ -1 +1 @@
-x
\\ No newline at end of file
+y
`);
  const without = listHunks(`diff --git a/f b/f
--- a/f
+++ b/f
@@ -1 +1 @@
-x
+y
`);
  assert.equal(withNote[0].id, without[0].id);
});

test("hunk の中の --- / +++ で始まる行をパスと読み違えない", () => {
  const patch = `diff --git a/src/keep.ts b/src/keep.ts
index 104f954..967f419 100644
--- a/src/keep.ts
+++ b/src/keep.ts
@@ -1,3 +1,3 @@
--- not a path
+++ not a path
 ctx
`;
  const hunks = listHunks(patch);
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].path, "src/keep.ts");
});

test("C クォートされたパスを復号して files[].path と同じ形にする", () => {
  const patch =
    `diff --git "a/\\346\\227\\245\\346\\234\\254\\350\\252\\236.ts" "b/\\346\\227\\245\\346\\234\\254\\350\\252\\236.ts"
index 104f954..967f419 100644
--- "a/\\346\\227\\245\\346\\234\\254\\350\\252\\236.ts"
+++ "b/\\346\\227\\245\\346\\234\\254\\350\\252\\236.ts"
@@ -1 +1 @@
-a
+b
`;
  const hunks = listHunks(patch);
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].path, "日本語.ts");
});

test("diff --git の無い patch でも落ちず、パスは空になる", () => {
  const hunks = listHunks(`@@ -1 +1 @@
-a
+b
`);
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].path, "");
});
