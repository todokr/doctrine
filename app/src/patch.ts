// task.diff の応答（ファイルの一覧 + 1本の patch 文字列）を、画面が描ける
// ファイル単位の形に組み立てる。副作用を持たない（テストは patch.test.ts）
import { detectMoves } from "../../shared/diff/moves.ts";
import { listHunks } from "../../shared/guide/hunkId.ts";
import type { TaskDiff } from "../../shared/protocol.ts";
import type { DiffFile, DiffHunk, MovedBlock } from "./types";

/** parsePatch が切り出した hunk。id は buildDiff が listHunks から足す */
type RawHunk = Omit<DiffHunk, "id">;

/** patch を `diff --git` ごとに切った1区画。パスは読まない（parsePatch の注を参照） */
type PatchSection = { header: string; hunks: RawHunk[] };

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
  let hunk: RawHunk | null = null;
  const body: string[] = [];

  const closeHunk = () => {
    if (hunk) hunk.body = body.join("\n");
    body.length = 0;
    hunk = null;
  };

  for (const line of patch.split("\n")) {
    if (FILE_HEAD.test(line)) {
      closeHunk();
      // 種別が変わったファイル（symlink ⇄ 通常ファイル）は、--name-status が
      // 1件（T）で返すのに patch では「削除」と「作成」の2区画に分かれる。
      // 同じヘッダ行が続いたら同じファイルの続きとして1区画にまとめないと、
      // 区画の数が files[] を追い越して突き合わせが壊れる
      const last = sections[sections.length - 1];
      if (last && last.header === line) {
        section = last;
        continue;
      }
      section = { header: line, hunks: [] };
      sections.push(section);
      continue;
    }
    const head = line.match(HUNK_HEAD);
    if (head) {
      closeHunk();
      // `diff --git` の無い patch は task.diff が作らないが、来ても落とさない
      if (!section) {
        section = { header: "", hunks: [] };
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
 *
 * ただし移動（detectMoves）の配布だけは path で結合する。上の懸念はこの結合に当たらない:
 * - 鍵は path しか無い。#57 の PR 経路には files[] が無く、detectMoves の出力を
 *   配れる鍵は path だけ（区画の添字は patch のテキストからしか決まらず、files[] と結べない）
 * - detectMoves のパスは復号済みで、files[].path は parseNameStatus が Map のキーに
 *   している値なので一意。クォートの復元も同名の取り違えも起きない
 * - files[] のどの path にも一致しない move は throw せず落とす。落とした側は普通の
 *   追加・削除として出るだけで、変更は隠れない
 */
export function buildDiff(td: TaskDiff): DiffFile[] {
  const sections = parsePatch(td.patch);
  if (sections.length > td.files.length) {
    throw new Error(
      `patch のファイル数（${sections.length}）が files（${td.files.length}）より多い`,
    );
  }
  // hunk の id は patch 全体の出現順で決まる。parsePatch と listHunks は同じ規則で
  // hunk を切るので、区画を先頭から見て hunk を先頭から割り当てれば 1 対 1 で合う。
  // 件数がずれるのは読み方が 2 つに分かれたときだけで、黙ってずらすと別の hunk を指す
  const ids = listHunks(td.patch).map((h) => h.id);
  const total = sections.reduce((n, sec) => n + sec.hunks.length, 0);
  if (total !== ids.length) {
    throw new Error(`patch の hunk 数（${total}）が id の数（${ids.length}）と合わない`);
  }
  let next = 0;
  const withIds = sections.map((sec) => ({
    ...sec,
    hunks: sec.hunks.map((h): DiffHunk => ({ id: ids[next++], ...h })),
  }));
  const movesByPath = new Map<string, MovedBlock[]>(td.files.map((f) => [f.path, []]));
  for (const m of detectMoves(td.patch)) {
    movesByPath.get(m.from.path)?.push(m);
    if (m.to.path !== m.from.path) movesByPath.get(m.to.path)?.push(m);
  }
  return td.files.map((f, i) => {
    const section = withIds[i];
    return {
      ...f,
      hunks: section?.hunks ?? [],
      moves: movesByPath.get(f.path)!,
      // 打ち切りで patch が尽きた後ろのファイルは、一覧には出るが中身が無い。
      // 「変更が無いファイル」と区別できるよう、ファイルごとに印を持たせる
      cutOff: section === undefined,
    } as DiffFile;
  });
}
