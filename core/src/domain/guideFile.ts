import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Guide, GuideLocation } from "../../../shared/guide/schema.ts";
import type { GuideHunk } from "../../../shared/guide/hunkId.ts";
import type { DiffFile } from "./diff.ts";

/** ガイドを置く、worktree からの相対パス。 */
export const GUIDE_RELPATH = ".doctrine-out/guide.json";

/** どの時点の worktree を説明しているかと一緒に置くための封筒。tree と createdAt は doctrine が書く。 */
export type GuideEnvelope = { tree: string; createdAt: string; guide: Guide };

/**
 * ガイドが指す箇所が、この時点の diff に実在するかを確かめる。
 *
 * 見るのは locationSchema を持つ節（readingOrder[].locations と risks[].locations）だけ。
 * hunk は id とパスの対で照合する（id だけだと、実在する id を別ファイルに貼ったガイドが通る）。
 * hunk を省いた場所は、そのパスが変更ファイルにあることだけを見る。
 * 落ちた理由は validateGuide の issues と同じ形で、最初の1件で打ち切らず全件返す。
 */
export function checkGuideLocations(
  guide: Guide,
  inputs: { hunks: GuideHunk[]; files: DiffFile[] },
): string[] {
  const hunkPath = new Map(inputs.hunks.map((h) => [h.id, h.path]));
  const filePaths = new Set(inputs.files.map((f) => f.path));
  const issues: string[] = [];

  const check = (where: string, loc: GuideLocation) => {
    if (loc.hunk === undefined) {
      if (!filePaths.has(loc.path)) {
        issues.push(`${where}: 変更に含まれないファイルです: ${loc.path}`);
      }
      return;
    }
    const path = hunkPath.get(loc.hunk);
    if (path === undefined) {
      issues.push(`${where}: 存在しない hunk の id です: ${loc.hunk}`);
    } else if (path !== loc.path) {
      issues.push(
        `${where}: hunk ${loc.hunk} のパスは ${path} ですが、${loc.path} が指定されています`,
      );
    }
  };

  guide.readingOrder.forEach((g, i) =>
    g.locations.forEach((loc, j) => check(`readingOrder.${i}.locations.${j}`, loc))
  );
  guide.risks.forEach((r, i) =>
    r.locations.forEach((loc, j) => check(`risks.${i}.locations.${j}`, loc))
  );
  return issues;
}

export async function writeGuideFile(worktreePath: string, envelope: GuideEnvelope): Promise<void> {
  const path = join(worktreePath, GUIDE_RELPATH);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(envelope, null, 2));
}
