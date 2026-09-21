import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod/v4";
import type { Guide, GuideLocation } from "../../../shared/guide/schema.ts";
import { validateGuide } from "../../../shared/guide/validate.ts";
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

/** guide.json の上限。超えたら中身を返さない。 */
export const MAX_GUIDE_BYTES = 256 * 1024;

/**
 * 封筒の外側だけを見るスキーマ。guide の中身は validateGuide に渡す。
 * guideSchema を直接当てると validateGuide の整合性検査（id の重複・参照先の実在）を飛ばす。
 */
export const guideEnvelopeSchema = z.strictObject({
  tree: z.string(),
  createdAt: z.string(),
  guide: z.unknown(),
});

/** guide.json の読み出し結果。broken の issues は validateGuide の issues と同じ形。 */
export type GuideRead =
  | { status: "missing" }
  | { status: "too_large"; size: number }
  | { status: "broken"; issues: string[] }
  | { status: "ok"; envelope: GuideEnvelope };

/** worktree の guide.json を読む。例外は投げず、読めなかった理由を status で返す。 */
export async function readGuideFile(worktreePath: string): Promise<GuideRead> {
  const path = join(worktreePath, GUIDE_RELPATH);

  let size: number;
  try {
    const stat = await Deno.stat(path);
    if (!stat.isFile) return { status: "missing" };
    size = stat.size;
  } catch {
    return { status: "missing" };
  }
  if (size > MAX_GUIDE_BYTES) return { status: "too_large", size };

  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch {
    return { status: "missing" };
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { status: "broken", issues: [`JSON として読めません: ${(e as Error).message}`] };
  }

  // 誤りの文面は validateGuide と同じ日本語ロケールに揃える
  const envelope = guideEnvelopeSchema.safeParse(json, { error: z.locales.ja().localeError });
  if (!envelope.success) {
    return {
      status: "broken",
      issues: envelope.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    };
  }

  const validated = validateGuide(envelope.data.guide);
  if (!validated.ok) return { status: "broken", issues: validated.issues };
  return {
    status: "ok",
    envelope: {
      tree: envelope.data.tree,
      createdAt: envelope.data.createdAt,
      guide: validated.guide,
    },
  };
}

export async function writeGuideFile(worktreePath: string, envelope: GuideEnvelope): Promise<void> {
  const path = join(worktreePath, GUIDE_RELPATH);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(envelope, null, 2));
}
