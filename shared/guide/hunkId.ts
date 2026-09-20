// ガイドが hunk を指す id を、unified diff の patch から計算する。
// コアと WebView が同じ patch から同じ id を得るため、依存を持たない同期の純関数にしてある

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

/** 削除（`+++ /dev/null`）のときだけ `--- a/…` を使う。リネームは `+++ b/新` が新しいパスになる */
function headerPath(minus: string, plus: string): string {
  const p = plus === "" || plus === "/dev/null" ? minus : plus;
  return stripPrefix(decodeHeaderPath(p));
}

/** `--- ` / `+++ ` のパスは、空白を含むと末尾に TAB が付く。TAB を含むパスは C クォートされる */
function decodeHeaderPath(raw: string): string {
  if (raw.startsWith('"')) return unquote(raw);
  const tab = raw.indexOf("\t");
  return tab < 0 ? raw : raw.slice(0, tab);
}

function stripPrefix(p: string): string {
  return p.startsWith("a/") || p.startsWith("b/") ? p.slice(2) : p;
}

const C_ESCAPES: Record<string, number> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  "\\": 92,
};

/**
 * git の C クォート（`"\346\227\245.ts"`）を復号する。computeDiff は `-z` を付けずに patch を
 * 取るので非 ASCII のパスがクォートされて出るが、files[].path は `--name-status -z` 由来で
 * 生のまま。突き合わせられるよう、8進をバイト列に戻して UTF-8 として読む
 */
function unquote(raw: string): string {
  const inner = raw.endsWith('"') && raw.length >= 2 ? raw.slice(1, -1) : raw.slice(1);
  const enc = new TextEncoder();
  const chars = Array.from(inner);
  const bytes: number[] = [];
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] !== "\\") {
      bytes.push(...enc.encode(chars[i]));
      continue;
    }
    const octal = chars.slice(i + 1, i + 4).join("");
    if (/^[0-7]{3}$/.test(octal)) {
      bytes.push(parseInt(octal, 8));
      i += 3;
    } else if (chars[i + 1] in C_ESCAPES) {
      bytes.push(C_ESCAPES[chars[i + 1]]);
      i++;
    } else {
      bytes.push(92);
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
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
