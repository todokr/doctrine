// task.diff の応答（ファイルの一覧 + 1本の patch 文字列）を、画面が描ける
// ファイル単位の形に組み立てる。副作用を持たない（テストは patch.test.ts）
import type { TaskDiff } from "../../shared/protocol.ts";
import type { DiffFile, DiffHunk } from "./types";

/** patch を `diff --git` ごとに切った1区画。パスは読まない（下の PatchSection の注を参照） */
type PatchSection = { hunks: DiffHunk[] };

const FILE_HEAD = /^diff --git /;
const HUNK_HEAD = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * patch を区画に切り、それぞれの hunk を取り出す。
 *
 * **区画からパスを読まない。** `diff --git` のパスは git の C クォート
 * （日本語のファイル名なら `"\346\227\245..."`）で出ることがあり、ここで
 * 復元すると task.diff の files[] と食い違う余地ができる。突き合わせは
 * buildDiff が添字で行う。
 */
export function parsePatch(patch: string): PatchSection[] {
  const sections: PatchSection[] = [];
  let section: PatchSection | null = null;
  let hunk: DiffHunk | null = null;
  const body: string[] = [];

  const closeHunk = () => {
    if (hunk) hunk.body = body.join("\n");
    body.length = 0;
    hunk = null;
  };

  for (const line of patch.split("\n")) {
    if (FILE_HEAD.test(line)) {
      closeHunk();
      section = { hunks: [] };
      sections.push(section);
      continue;
    }
    const head = line.match(HUNK_HEAD);
    if (head) {
      closeHunk();
      // `diff --git` の無い patch は task.diff が作らないが、来ても落とさない
      if (!section) {
        section = { hunks: [] };
        sections.push(section);
      }
      hunk = { old: Number(head[1]), new: Number(head[2]), body: "" };
      section.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    // 「改行で終わっていない」の注記は行ではない。本文に混ぜると diffLines が
    // 1行ぶん余計に数え、以降の行番号とコメントの紐付けが全部ずれる
    if (line.startsWith("\\")) continue;
    // git は空の文脈行も1文字の空白で出すので、本当に空の行は hunk の外側
    // （patch 末尾の改行など）でしかない
    const c = line[0];
    if (c === " " || c === "+" || c === "-") body.push(line);
    else closeHunk();
  }
  closeHunk();
  return sections;
}

/**
 * ファイルの一覧と patch を突き合わせて、画面が描く形にする。
 *
 * 添字で突き合わせる。`computeDiff` は --name-status・--numstat・patch を
 * 同じ引数・同じ pathspec で走らせるので、3つの出力のファイルの順は必ず一致する。
 * パスで引くとクォートの復元が要るうえ、同名が起きたときに静かに間違える。
 */
export function buildDiff(td: TaskDiff): DiffFile[] {
  const sections = parsePatch(td.patch);
  if (sections.length > td.files.length) {
    throw new Error(
      `patch のファイル数（${sections.length}）が files（${td.files.length}）より多い`,
    );
  }
  return td.files.map((f, i) => {
    const section = sections[i];
    return {
      ...f,
      hunks: section?.hunks ?? [],
      // 打ち切りで patch が尽きた後ろのファイルは、一覧には出るが中身が無い。
      // 「変更が無いファイル」と区別できるよう、ファイルごとに印を持たせる
      cutOff: section === undefined,
    } as DiffFile;
  });
}
