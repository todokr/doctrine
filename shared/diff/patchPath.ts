// patch の `--- ` / `+++ ` の2行から、その区画が指すパスを決める。
// hunk の id と移動の検出が同じパスを得るため、依存を持たない同期の純関数にしてある

/** 削除（`+++ /dev/null`）のときだけ `--- a/…` を使う。リネームは `+++ b/新` が新しいパスになる */
export function headerPath(minus: string, plus: string): string {
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
