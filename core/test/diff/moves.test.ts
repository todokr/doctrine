import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { detectMoves } from "../../../shared/diff/moves.ts";

const del = (...t: string[]) => t.map((s) => `-${s}`);
const add = (...t: string[]) => t.map((s) => `+${s}`);

/** 1ファイル1 hunk の patch。リネームは oldPath で表す */
function section(path: string, header: string, body: string[], oldPath = path): string {
  return [
    `diff --git a/${oldPath} b/${path}`,
    "index 104f954..967f419 100644",
    `--- a/${oldPath}`,
    `+++ b/${path}`,
    header,
    ...body,
    "",
  ].join("\n");
}

/** src/a.ts の 1〜n 行をすべて消す。行番号の計算を単純にするため、文脈行を持たない */
function removed(path: string, lines: string[]): string {
  return section(path, `@@ -1,${lines.length} +0,0 @@`, del(...lines));
}

/** src/b.ts に 1〜n 行をすべて足す */
function added(path: string, lines: string[]): string {
  return section(path, `@@ -0,0 +1,${lines.length} @@`, add(...lines));
}

const FUNC = [
  "export function total(items: Item[]) {",
  "  let sum = 0;",
  "  for (const i of items) sum += i.price;",
  "  return sum;",
  "}",
];

test("別ファイルへ丸ごと移した関数を1つの移動として返す", () => {
  const patch = section("src/a.ts", "@@ -9,7 +9,2 @@", [" before", ...del(...FUNC), " after"]) +
    section("src/b.ts", "@@ -1,2 +1,7 @@", [" top", ...add(...FUNC), " bottom"]);
  const moves = detectMoves(patch);
  assert.equal(moves.length, 1);
  const m = moves[0];
  assert.equal(m.id, "mv_1");
  assert.deepEqual(m.from, { path: "src/a.ts", startLine: 10, endLine: 14 });
  assert.deepEqual(m.to, { path: "src/b.ts", startLine: 2, endLine: 6 });
  assert.deepEqual(m.runs, [{ fromStart: 10, toStart: 2, lineCount: 5 }]);
  assert.equal(m.edited, false);
  assert.equal(m.indentOnly, false);
});

test("実質的な行が3行に満たない一致は移動としない", () => {
  const two = ["const x = 1;", "const y = 2;"];
  assert.deepEqual(detectMoves(removed("src/a.ts", two) + added("src/b.ts", two)), []);
});

test("括弧だけの行は行数に数えない", () => {
  const lines = ["foo();", "bar();", "}", "}", "});"];
  assert.deepEqual(detectMoves(removed("src/a.ts", lines) + added("src/b.ts", lines)), []);
});

test("同じファイル内の並べ替えも移動として返す", () => {
  const moved = ["const a = 1;", "const b = 2;", "const c = 3;", "const d = 4;"];
  const patch = section("src/a.ts", "@@ -1,6 +1,6 @@", [
    " ctx1",
    ...del(...moved),
    " ctx2",
    ...add(...moved),
  ]);
  const moves = detectMoves(patch);
  assert.equal(moves.length, 1);
  assert.equal(moves[0].from.path, "src/a.ts");
  assert.equal(moves[0].to.path, "src/a.ts");
  assert.deepEqual(moves[0].from, { path: "src/a.ts", startLine: 2, endLine: 5 });
  assert.deepEqual(moves[0].to, { path: "src/a.ts", startLine: 3, endLine: 6 });
});

test("移動の途中で1行変えたときは、一致した行だけを run にして edited を立てる", () => {
  const before = [
    "const s1 = 1;",
    "const s2 = 2;",
    "const s3 = 3;",
    "const s4 = 4;",
    "const s5 = 5;",
    "const s6 = 6;",
  ];
  const after = [...before];
  after[2] = "const s3 = changed;";
  const moves = detectMoves(removed("src/a.ts", before) + added("src/b.ts", after));
  assert.equal(moves.length, 1);
  assert.equal(moves[0].edited, true);
  assert.deepEqual(moves[0].runs, [
    { fromStart: 1, toStart: 1, lineCount: 2 },
    { fromStart: 4, toStart: 4, lineCount: 3 },
  ]);
});

test("ギャップが上限を超えたら合体せず、それぞれ独立した移動になる", () => {
  const a = ["const a1 = 1;", "const a2 = 2;", "const a3 = 3;"];
  const b = ["const b1 = 1;", "const b2 = 2;", "const b3 = 3;"];
  const u = ["u1();", "u2();", "u3();", "u4();", "u5();"];
  const v = ["v1();", "v2();", "v3();", "v4();", "v5();"];
  const moves = detectMoves(
    removed("src/a.ts", [...a, ...u, ...b]) + added("src/b.ts", [...a, ...v, ...b]),
  );
  assert.equal(moves.length, 2);
  for (const m of moves) {
    assert.equal(m.edited, false);
    assert.equal(m.runs.length, 1);
  }
});

test("合体できず単独では最小行数に満たない一致は移動としない", () => {
  const a = ["const a1 = 1;", "const a2 = 2;"];
  const b = ["const b1 = 1;", "const b2 = 2;"];
  const u = ["u1();", "u2();", "u3();", "u4();", "u5();"];
  const v = ["v1();", "v2();", "v3();", "v4();", "v5();"];
  assert.deepEqual(
    detectMoves(removed("src/a.ts", [...a, ...u, ...b]) + added("src/b.ts", [...a, ...v, ...b])),
    [],
  );
});

test("短い共通行があっても長い run が切れない", () => {
  const block = ["const a = f();", "const b = g(a);", "return x;", "log(b);", "done();"];
  const moves = detectMoves(
    removed("src/a.ts", block) + added("src/b.ts", ["return x;", ...block]),
  );
  assert.equal(moves.length, 1);
  assert.equal(moves[0].runs[0].lineCount, 5);
});

test("インデントだけ変えた移動は indentOnly を立てる", () => {
  const before = ["if (ok) {", "run();", "stop();", "}"];
  const after = before.map((l) => `  ${l}`);
  const moves = detectMoves(removed("src/a.ts", before) + added("src/b.ts", after));
  assert.equal(moves.length, 1);
  assert.equal(moves[0].indentOnly, true);
  assert.equal(moves[0].runs.length, 1);
});

test("一部の行だけインデントが変わっても1つの移動になる", () => {
  const before = ["const a = 1;", "const b = 2;", "const c = 3;", "const d = 4;", "const e = 5;"];
  const after = before.map((l, i) => (i === 1 || i === 3 ? `  ${l}` : l));
  const moves = detectMoves(removed("src/a.ts", before) + added("src/b.ts", after));
  assert.equal(moves.length, 1);
  assert.equal(moves[0].indentOnly, true);
});

test("末尾の空白だけの違いは完全一致として扱う", () => {
  const after = [...FUNC];
  after[1] = `${after[1]}  `;
  const moves = detectMoves(removed("src/a.ts", FUNC) + added("src/b.ts", after));
  assert.equal(moves.length, 1);
  assert.equal(moves[0].indentOnly, false);
  assert.equal(moves[0].edited, false);
});

test("非 ASCII のパスは復号して返す", () => {
  const quoted = String.raw`"src/\346\227\245.ts"`;
  const patch = removed("src/a.ts", FUNC) + [
    `diff --git "a/src/\\346\\227\\245.ts" "b/src/\\346\\227\\245.ts"`,
    "index 104f954..967f419 100644",
    `--- "a/${quoted.slice(1)}`,
    `+++ "b/${quoted.slice(1)}`,
    `@@ -0,0 +1,${FUNC.length} @@`,
    ...add(...FUNC),
    "",
  ].join("\n");
  const moves = detectMoves(patch);
  assert.equal(moves.length, 1);
  assert.equal(moves[0].to.path, "src/日.ts");
});

test("リネームされたファイルの中の移動は新しいパスで返す", () => {
  const moved = ["const a = 1;", "const b = 2;", "const c = 3;", "const d = 4;"];
  const patch = section("new.ts", "@@ -1,6 +1,6 @@", [
    " ctx1",
    ...del(...moved),
    " ctx2",
    ...add(...moved),
  ], "old.ts");
  const moves = detectMoves(patch);
  assert.equal(moves.length, 1);
  assert.equal(moves[0].from.path, "new.ts");
  assert.equal(moves[0].to.path, "new.ts");
});

test("---/+++ の無い区画があっても落ちない", () => {
  const noHeaders = [
    "diff --git a/img.png b/img.png",
    "index 1234567..89abcde 100644",
    "Binary files a/img.png and b/img.png differ",
    "diff --git a/old.txt b/new.txt",
    "similarity index 100%",
    "rename from old.txt",
    "rename to new.txt",
    "",
  ].join("\n");
  const moves = detectMoves(noHeaders + removed("src/a.ts", FUNC) + added("src/b.ts", FUNC));
  assert.equal(moves.length, 1);
  assert.equal(moves[0].from.path, "src/a.ts");
});

test("同じ行が大量にある patch でも開始点を打ち切る", () => {
  const same = Array.from({ length: 300 }, () => 'console.log("x");');
  assert.deepEqual(detectMoves(removed("src/a.ts", same) + added("src/b.ts", same)), []);
});

test("同じ patch からは同じ結果が2回出る", () => {
  const patch = removed("src/a.ts", FUNC) + added("src/b.ts", FUNC);
  assert.deepEqual(detectMoves(patch), detectMoves(patch));
});

test("空の patch は空配列", () => {
  assert.deepEqual(detectMoves(""), []);
});
