// ガイドと diff から、読む順の並びを作る。副作用を持たない（テストは flow.test.ts）
import type { DiffFile, Guide, GuideLocation, Risk } from "./types";

export type ReadingGroup = Guide["readingOrder"][number];

/** ガイドの読む順のどこにも入っていないもの */
export type UnguidedItem =
  /** 読む順が指していない hunk。index は file.hunks の添字 */
  | { kind: "hunk"; file: DiffFile; index: number }
  /** hunk を持たず（バイナリ・名前だけ）、読む順がパスでも指していないファイル */
  | { kind: "file"; file: DiffFile }
  /** 打ち切りで中身が届いておらず、照合できないファイル */
  | { kind: "cutOff"; file: DiffFile };

export type Unguided = {
  /** files の順、同じファイルの中は hunk の順 */
  items: UnguidedItem[];
  /** diff が打ち切られている。items を「ガイドの見落とし」と断定できない */
  truncated: boolean;
};

/** 流れの中の1ファイルぶん。同じファイルの続けて並ぶ hunk は1つにまとめる */
export type FlowChunk = {
  file: DiffFile;
  /** file.hunks の添字、出す順。hunk を持たないファイルは空 */
  hunks: number[];
  /** このファイルがこれより前の chunk に出ている（見出しに「続き」を付ける） */
  continued: boolean;
};

export type FlowGroup = {
  /** readingOrder の添字 */
  index: number;
  group: ReadingGroup;
  chunks: FlowChunk[];
  /** 前のグループで既に出した箇所。ここでは出さず、出したグループの添字を示す */
  repeats: { location: GuideLocation; at: number }[];
  /** 今の diff に無い箇所 */
  absent: GuideLocation[];
};

export type ReadingFlow = {
  groups: FlowGroup[];
  /** 「ガイドが触れていない変更」。空でも必ずある */
  tail: { chunks: FlowChunk[]; unguided: Unguided };
};

type Placed = {
  groups: FlowGroup[];
  /** 置いた hunk の id → 置いたグループの添字 */
  hunks: Map<string, number>;
  /** 置いた hunk を持たないファイルのパス → 置いたグループの添字 */
  files: Map<string, number>;
};

/**
 * 読む順の location を diff の hunk とファイルに割り当てる。
 *
 * - 配置の根拠は readingOrder だけ。risks の location は「いつ読むか」を言わないので数えない
 * - `{ path, hunk }` は id が一致する hunk 1 つ（id はパスを含んで決まるので path は見ない）
 * - `{ path }` は、パスが一致するファイル（リネームは旧名でも一致）の hunk を patch の順に全部。
 *   hunk を持たないファイル（バイナリ・名前だけ・打ち切り）は、ファイル 1 件として扱う
 * - 同じ hunk・ファイルを指す location は先勝ち。後のグループでは出さず repeats に入れる。
 *   ファイル全体の location がまだ置いていない hunk を持つときは、残りだけを出す
 * - diff のどの hunk・ファイルにも一致しない location は absent（見落としではない）
 */
function place(guide: Guide, files: DiffFile[]): Placed {
  const byId = new Map<string, { file: DiffFile; index: number }>();
  for (const file of files) file.hunks.forEach((h, index) => byId.set(h.id, { file, index }));
  // コピー（C）の old_path は元のファイルが残っているので、一致に使わない
  const byPath = (path: string) => files.filter((f) => f.path === path || (f.status === "R" && f.old_path === path));

  const hunks = new Map<string, number>();
  const placedFiles = new Map<string, number>();

  const groups = guide.readingOrder.map((group, gi): FlowGroup => {
    const chunks: FlowChunk[] = [];
    const repeats: FlowGroup["repeats"] = [];
    const absent: GuideLocation[] = [];

    const take = (file: DiffFile, index: number | null) => {
      let chunk = chunks.at(-1);
      if (index === null) {
        chunks.push({ file, hunks: [], continued: false });
        return;
      }
      if (chunk?.file !== file || chunk.hunks.length === 0) {
        chunk = { file, hunks: [], continued: false };
        chunks.push(chunk);
      }
      chunk.hunks.push(index);
    };

    for (const loc of group.locations) {
      if (loc.hunk !== undefined) {
        const found = byId.get(loc.hunk);
        if (!found) {
          absent.push(loc);
          continue;
        }
        const owner = hunks.get(loc.hunk);
        if (owner !== undefined) {
          repeats.push({ location: loc, at: owner });
          continue;
        }
        hunks.set(loc.hunk, gi);
        take(found.file, found.index);
        continue;
      }

      const matched = byPath(loc.path);
      if (matched.length === 0) {
        absent.push(loc);
        continue;
      }
      let placedAny = false;
      let owner: number | undefined;
      for (const file of matched) {
        if (file.hunks.length === 0) {
          const prev = placedFiles.get(file.path);
          if (prev !== undefined) {
            owner ??= prev;
            continue;
          }
          placedFiles.set(file.path, gi);
          take(file, null);
          placedAny = true;
          continue;
        }
        file.hunks.forEach((h, index) => {
          const prev = hunks.get(h.id);
          if (prev !== undefined) {
            owner ??= prev;
            return;
          }
          hunks.set(h.id, gi);
          take(file, index);
          placedAny = true;
        });
      }
      if (!placedAny && owner !== undefined) repeats.push({ location: loc, at: owner });
    }
    return { index: gi, group, chunks, repeats, absent };
  });

  return { groups, hunks, files: placedFiles };
}

/** place の補集合。読む順に置かれなかった hunk とファイルを、files の順に返す */
function complement(files: DiffFile[], placed: Placed, truncated: boolean): Unguided {
  const items: UnguidedItem[] = [];
  for (const file of files) {
    if (file.hunks.length === 0) {
      if (placed.files.has(file.path)) continue;
      items.push({ kind: file.cutOff ? "cutOff" : "file", file });
      continue;
    }
    file.hunks.forEach((h, index) => {
      if (!placed.hunks.has(h.id)) items.push({ kind: "hunk", file, index });
    });
  }
  return { items, truncated };
}

/** ガイドの読む順が触れていない変更。リネームは新旧どちらの名前で指しても一致とみなす */
export function findUnguided(files: DiffFile[], guide: Guide, truncated: boolean): Unguided {
  return complement(files, place(guide, files), truncated);
}

/** 同じファイルの続けて並ぶ hunk を 1 つの chunk にまとめる */
function tailChunks(items: UnguidedItem[]): FlowChunk[] {
  const chunks: FlowChunk[] = [];
  for (const item of items) {
    const last = chunks.at(-1);
    if (item.kind === "hunk") {
      if (last && last.file === item.file && last.hunks.length > 0) last.hunks.push(item.index);
      else chunks.push({ file: item.file, hunks: [item.index], continued: false });
    } else {
      chunks.push({ file: item.file, hunks: [], continued: false });
    }
  }
  return chunks;
}

/**
 * ガイドの読む順に、diff の hunk を組み直す。diff のすべての hunk（と hunk を持たないファイル）は、
 * いずれかのグループか末尾（ガイドが触れていない変更）に、ちょうど 1 回ずつ出る。
 * chunk の file は渡された DiffFile そのもの（moves などを落とさない）。
 */
export function readingFlow(guide: Guide, files: DiffFile[], truncated: boolean): ReadingFlow {
  const placed = place(guide, files);
  const unguided = complement(files, placed, truncated);
  const tail = { chunks: tailChunks(unguided.items), unguided };

  const seen = new Set<string>();
  for (const chunk of [...placed.groups.flatMap((g) => g.chunks), ...tail.chunks]) {
    chunk.continued = seen.has(chunk.file.path);
    seen.add(chunk.file.path);
  }
  return { groups: placed.groups, tail };
}

/** hunk とファイルに紐づくリスク。hunk を指す location は hunk に、パスだけの location はファイルに付ける */
export function risksAt(guide: Guide): { byHunk: Map<string, Risk[]>; byPath: Map<string, Risk[]> } {
  const byHunk = new Map<string, Risk[]>();
  const byPath = new Map<string, Risk[]>();
  const add = (m: Map<string, Risk[]>, key: string, risk: Risk) => {
    const list = m.get(key);
    if (!list) m.set(key, [risk]);
    else if (!list.includes(risk)) list.push(risk);
  };
  for (const risk of guide.risks) {
    for (const loc of risk.locations) {
      if (loc.hunk !== undefined) add(byHunk, loc.hunk, risk);
      else add(byPath, loc.path, risk);
    }
  }
  return { byHunk, byPath };
}
