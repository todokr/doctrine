// patch のテキストだけから、削除された行と追加された行の一致（＝コードの移動）を見つける。
// task.diff の応答にも #57 の PR から読んだ diff にも同じものが効くよう、依存を持たない
// 同期の純関数にしてある。テキストとしての一致だけを扱い、意味的な同等性は見ない
import { headerPath } from "./patchPath.ts";

/** 移動の片側。行番号は実ファイルの行番号（1始まり・その側のもの） */
export type MoveSide = { path: string; startLine: number; endLine: number };

/** 完全に一致した1続き。行番号はそれぞれの側の開始行 */
export type MoveRun = { fromStart: number; toStart: number; lineCount: number };

export type MovedBlock = {
  /** `mv_` + 1始まりの連番。同じ patch からは常に同じ id が同じ順で出る */
  id: string;
  /** 削除された側（旧ファイルの行番号） */
  from: MoveSide;
  /** 追加された側（新ファイルの行番号） */
  to: MoveSide;
  runs: MoveRun[];
  /** runs の間に一致しなかった行が挟まっている＝移動しつつ中身も変えた */
  edited: boolean;
  /** 一致がインデントを無視したものを含む */
  indentOnly: boolean;
};

export type MoveOptions = {
  /** ブロック全体で要る「実質的な行」の数。既定 3 */
  minLines?: number;
  /** 2つの run を1つのブロックに合体してよいギャップの行数。既定 3 */
  maxGapLines?: number;
  /** 同じ本文の行がこの数を超えて出るときは、その行を起点にしない。既定 200 */
  maxCandidates?: number;
};

const FILE_HEAD = /^diff --git /;
const HUNK_HEAD = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
// 括弧・区切り記号だけの行は、偶然の一致が多いので「実質的な行」に数えない
const PUNCTUATION_ONLY = /^[{}()[\];,]*$/;

/** patch の1行。norm は前後の空白を落とした本文、text は末尾の空白だけを落とした本文 */
type Line = { path: string; no: number; norm: string; text: string };

/** 1つの run（極大な一致）。i / j は dels / adds の添字 */
type Cand = { i: number; j: number; n: number; substantive: number };

export function detectMoves(patch: string, opts: MoveOptions = {}): MovedBlock[] {
  const { minLines = 3, maxGapLines = 3, maxCandidates = 200 } = opts;
  const { dels, adds } = collectLines(patch);
  if (dels.length === 0 || adds.length === 0) return [];

  const picked = pickRuns(dels, adds, maxCandidates);

  // 同じパスの対ごとに、両側で順序が保たれる run を1つのブロックにまとめる
  const pairs = new Map<string, Cand[]>();
  for (const r of picked) {
    const key = `${dels[r.i].path}\0${adds[r.j].path}`;
    const list = pairs.get(key);
    if (list) list.push(r);
    else pairs.set(key, [r]);
  }
  const groups: Cand[][] = [];
  for (const runs of pairs.values()) groups.push(...mergeRuns(dels, adds, runs, maxGapLines));

  const blocks = groups
    .filter((g) => g.reduce((s, r) => s + r.substantive, 0) >= minLines)
    .sort((a, b) => a[0].i - b[0].i || a[0].j - b[0].j);

  return blocks.map((g, k) => toBlock(dels, adds, g, `mv_${k + 1}`));
}

function collectLines(patch: string): { dels: Line[]; adds: Line[] } {
  const dels: Line[] = [];
  const adds: Line[] = [];
  // `diff --git` を見てから最初の `@@` を見るまでの間だけ true。hunk 本文で `-- foo` を削除すると
  // `--- foo` が現れるので、この間でしか `---` / `+++` を読まない（listHunks と同じ）
  let inFileHeader = false;
  let inHunk = false;
  let minus = "";
  let plus = "";
  let path = "";
  let oldNo = 0;
  let newNo = 0;

  const line = (no: number, body: string): Line | null => {
    if (path === "") return null;
    const text = body.trimEnd();
    return { path, no, norm: text.trimStart(), text };
  };

  for (const raw of patch.split("\n")) {
    if (FILE_HEAD.test(raw)) {
      inFileHeader = true;
      inHunk = false;
      minus = "";
      plus = "";
      path = "";
      continue;
    }
    if (inFileHeader) {
      if (raw.startsWith("--- ")) {
        minus = raw.slice(4);
        continue;
      }
      if (raw.startsWith("+++ ")) {
        plus = raw.slice(4);
        continue;
      }
    }
    const head = raw.match(HUNK_HEAD);
    if (head) {
      if (inFileHeader) {
        path = headerPath(minus, plus);
        inFileHeader = false;
      }
      oldNo = Number(head[1]);
      newNo = Number(head[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk || raw.startsWith("\\")) continue;
    const c = raw[0];
    if (c === "-") {
      const l = line(oldNo, raw.slice(1));
      if (l) dels.push(l);
      oldNo++;
    } else if (c === "+") {
      const l = line(newNo, raw.slice(1));
      if (l) adds.push(l);
      newNo++;
    } else if (c === " ") {
      oldNo++;
      newNo++;
    } else {
      inHunk = false;
    }
  }
  return { dels, adds };
}

const isSubstantive = (norm: string) => !PUNCTUATION_ONLY.test(norm);

/** lines[k] が lines[k-1] の次の行（同じファイルで行番号が1つ進む）か */
const follows = (lines: Line[], k: number) =>
  k > 0 && lines[k].path === lines[k - 1].path && lines[k].no === lines[k - 1].no + 1;

/**
 * 極大な一致を全部数え上げ、実質的な行の多いものから、既に採った run と重ならないものだけを採る。
 * 前から貪欲に消費すると、`return x;` のような短い共通行が先に消費されて長い run が途中で切れる
 */
function pickRuns(dels: Line[], adds: Line[], maxCandidates: number): Cand[] {
  const addsByNorm = new Map<string, number[]>();
  adds.forEach((l, j) => {
    const list = addsByNorm.get(l.norm);
    if (list) list.push(j);
    else addsByNorm.set(l.norm, [j]);
  });
  const delCount = new Map<string, number>();
  for (const l of dels) delCount.set(l.norm, (delCount.get(l.norm) ?? 0) + 1);

  const cands: Cand[] = [];
  dels.forEach((d, i) => {
    const js = addsByNorm.get(d.norm);
    if (!js) return;
    if (js.length > maxCandidates || delCount.get(d.norm)! > maxCandidates) return;
    for (const j of js) {
      // 直前の行どうしも一致しているなら、この対は前の run の途中で、起点ではない
      if (follows(dels, i) && follows(adds, j) && dels[i - 1].norm === adds[j - 1].norm) continue;
      let n = 1;
      let substantive = isSubstantive(d.norm) ? 1 : 0;
      while (
        i + n < dels.length && j + n < adds.length &&
        follows(dels, i + n) && follows(adds, j + n) &&
        dels[i + n].norm === adds[j + n].norm
      ) {
        if (isSubstantive(dels[i + n].norm)) substantive++;
        n++;
      }
      cands.push({ i, j, n, substantive });
    }
  });
  cands.sort((a, b) => b.substantive - a.substantive || b.n - a.n || a.i - b.i || a.j - b.j);

  const usedDel = new Uint8Array(dels.length);
  const usedAdd = new Uint8Array(adds.length);
  const picked: Cand[] = [];
  for (const c of cands) {
    let free = true;
    for (let k = 0; k < c.n && free; k++) free = !usedDel[c.i + k] && !usedAdd[c.j + k];
    if (!free) continue;
    for (let k = 0; k < c.n; k++) usedDel[c.i + k] = usedAdd[c.j + k] = 1;
    picked.push(c);
  }
  return picked;
}

/**
 * 同じパスの対の run を、両側で順序が保たれ、両側のギャップが maxGapLines 以内のものだけ
 * 合体する。片側だけ順序が入れ替わっている run は別のブロックにする
 */
function mergeRuns(dels: Line[], adds: Line[], runs: Cand[], maxGapLines: number): Cand[][] {
  const sorted = [...runs].sort((a, b) => a.i - b.i);
  const groups: Cand[][] = [];
  for (const r of sorted) {
    let best: Cand[] | null = null;
    let bestGap = Infinity;
    for (const g of groups) {
      const last = g[g.length - 1];
      const fromGap = dels[r.i].no - (dels[last.i + last.n - 1].no + 1);
      const toGap = adds[r.j].no - (adds[last.j + last.n - 1].no + 1);
      if (fromGap < 0 || toGap < 0 || fromGap > maxGapLines || toGap > maxGapLines) continue;
      if (fromGap + toGap < bestGap) {
        best = g;
        bestGap = fromGap + toGap;
      }
    }
    if (best) best.push(r);
    else groups.push([r]);
  }
  return groups;
}

function toBlock(dels: Line[], adds: Line[], g: Cand[], id: string): MovedBlock {
  const first = g[0];
  const last = g[g.length - 1];
  const indentOnly = g.some((r) => {
    for (let k = 0; k < r.n; k++) if (dels[r.i + k].text !== adds[r.j + k].text) return true;
    return false;
  });
  return {
    id,
    from: {
      path: dels[first.i].path,
      startLine: dels[first.i].no,
      endLine: dels[last.i + last.n - 1].no,
    },
    to: {
      path: adds[first.j].path,
      startLine: adds[first.j].no,
      endLine: adds[last.j + last.n - 1].no,
    },
    runs: g.map((r) => ({ fromStart: dels[r.i].no, toStart: adds[r.j].no, lineCount: r.n })),
    edited: g.length > 1,
    indentOnly,
  };
}
