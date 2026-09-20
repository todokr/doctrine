import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type GuideHunk, listHunks } from "../../../shared/guide/hunkId.ts";
import { computeDiff, type DiffFile, mergeBase } from "./diff.ts";
import { captureTree } from "./reviewTree.ts";

/** hunk の一覧を置く、worktree からの相対パス。 */
export const GUIDE_HUNKS_RELPATH = ".doctrine-out/guide-hunks.json";

export type GuideInputs = {
  /** captureTree の結果。guide.json の封筒の tree に入る値。 */
  tree: string;
  /** base ブランチとの共通祖先。プロンプトに書く diff の起点。 */
  mergeBase: string;
  /** ガイドが指せる hunk の全件。ファイルにも同じものを書く。 */
  hunks: GuideHunk[];
  /** hunk 一覧の元になった patch。後続の検証がそのまま使う。 */
  patch: string;
  /**
   * 同じ diff の変更ファイル。パスの実在はこちらで見る（バイナリやモード変更だけの
   * ファイルは hunk を持たないため）。
   */
  files: DiffFile[];
  truncated: boolean;
};

/**
 * ガイド作成に doctrine が渡す入力のうち、diff から作るものを集める。
 *
 * 範囲は task.diff（handlers.ts）と同じ merge-base からツリーまで。ツリーのハッシュは
 * コミットでなくても git diff が tree-ish として受けるので、toRef にそのまま渡せる。
 *
 * 一覧をファイルに置くのは、hunk が多いとプロンプトに全部は載らないため。
 * エージェントは Read でこのファイルを引く。
 */
export async function collectGuideInputs(o: {
  worktreePath: string;
  baseBranch: string;
}): Promise<GuideInputs> {
  const base = await mergeBase(o.worktreePath, o.baseBranch);
  const tree = await captureTree(o.worktreePath);
  const { files, patch, truncated } = await computeDiff({
    worktreePath: o.worktreePath,
    fromRef: base,
    toRef: tree,
  });
  const hunks = listHunks(patch);

  // 書き出しは captureTree の後。順序に依らず .doctrine-out/ はツリーに入らないが、前提にしない。
  const path = join(o.worktreePath, GUIDE_HUNKS_RELPATH);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(hunks, null, 2));

  return { tree, mergeBase: base, hunks, patch, files, truncated };
}
