// ガイドが hunk を指す id を、unified diff の patch から計算する。
// コアと WebView が同じ patch から同じ id を得るため、依存を持たない同期の純関数にしてある
import { headerPath } from "../diff/patchPath.ts";

/** ガイドが指す hunk 1件。id は「パス + 本文」から決まり、行番号がずれても変わらない */
export type GuideHunk = {
  /** `h_` + 16進。同じパス・同じ本文の hunk が複数あるときは、2件目以降の末尾に `_2` `_3` が付く */
  id: string;
  /** リネームなら新しいパス。C クォートは復号済みで、task.diff の files[].path と同じ形 */
  path: string;
  /** `@@ -1,4 +1,4 @@ function foo()` の行そのもの。id には含めない */
  header: string;
};

const FILE_HEAD = /^diff --git /;
// 件数は省略されうる（`@@ -0,0 +1 @@` が実在する）
const HUNK_HEAD = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;

/**
 * patch から hunk の一覧を出現順に返す。パスの決まらないファイル（バイナリ・100% リネーム）は
 * hunk を持たないので一覧に出ない。
 *
 * 本文の切り出しは app の parsePatch と同じ規則（先頭が空白・+・- の行だけ。
 * `\ No newline` は入れない）。前提は git 既定の `a/` `b/` 接頭辞。
 */
export function listHunks(patch: string): GuideHunk[] {
  const hunks: GuideHunk[] = [];
  const seen = new Map<string, number>();

  // `diff --git` を見てから最初の `@@` を見るまでの間だけ true。hunk 本文で `-- foo` を削除すると
  // `--- foo` が、`++ x` を追加すると `+++ x` が現れるので、この間でしか `---` / `+++` を読まない
  let inFileHeader = false;
  let minus = "";
  let plus = "";
  let path = "";
  let current: { path: string; header: string; body: string[] } | null = null;

  const closeHunk = () => {
    if (!current) return;
    const base = "h_" + hashHex(`${current.path}\0${current.body.join("\n")}`);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    // 1件目は素のままにして、その hunk だけを含む patch から得た id と一致させる
    hunks.push({ id: n === 1 ? base : `${base}_${n}`, path: current.path, header: current.header });
    current = null;
  };

  for (const line of patch.split("\n")) {
    if (FILE_HEAD.test(line)) {
      closeHunk();
      inFileHeader = true;
      minus = "";
      plus = "";
      path = "";
      continue;
    }
    if (inFileHeader) {
      if (line.startsWith("--- ")) {
        minus = line.slice(4);
        continue;
      }
      if (line.startsWith("+++ ")) {
        plus = line.slice(4);
        continue;
      }
    }
    if (HUNK_HEAD.test(line)) {
      closeHunk();
      if (inFileHeader) {
        path = headerPath(minus, plus);
        inFileHeader = false;
      }
      current = { path, header: line, body: [] };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("\\")) continue;
    const c = line[0];
    if (c === " " || c === "+" || c === "-") current.body.push(line);
    else closeHunk();
  }
  closeHunk();
  return hunks;
}

/**
 * cyrb53（53bit）を UTF-8 のバイト列にかけて16進14桁にする。id は同じ入力から同じ短い名前を
 * 得るためのもので、改竄の検知には使わない。crypto.subtle は非同期で、画面の純関数から
 * 呼べないので使わない
 */
function hashHex(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (const b of new TextEncoder().encode(s)) {
    h1 = Math.imul(h1 ^ b, 2654435761);
    h2 = Math.imul(h2 ^ b, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return n.toString(16).padStart(14, "0");
}
