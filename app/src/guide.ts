// task.guide の応答を画面の形に落とす。副作用を持たない（テストは guide.test.ts）
import type { Guide, GuideLocation, Risk } from "../../shared/guide/schema.ts";
import { validateGuide } from "../../shared/guide/validate.ts";
import type { TaskGuide } from "../../shared/protocol.ts";
import type { DiffFile } from "./types";

/** 画面が持つガイド。デーモンの TaskGuide をアプリ側の検証に通した後の形。 */
export type GuideView =
  | { kind: "none" }
  | { kind: "missing" }
  | { kind: "too_large"; size: number }
  | { kind: "broken"; issues: string[] }
  | { kind: "ok"; guide: Guide; createdAt: string; stale: boolean };

/**
 * status が ok でも、デーモンの guide は型の注釈にすぎない（版のずれで形が違うことがある）
 * ので、もう一度 validateGuide を通す。too_large は「壊れている」と別の事実なので混ぜない。
 */
export function receiveGuide(res: TaskGuide): GuideView {
  switch (res.status) {
    case "none":
    case "missing":
      return { kind: res.status };
    case "too_large":
      return { kind: "too_large", size: res.size };
    case "broken":
      return { kind: "broken", issues: res.issues };
    case "ok": {
      const v = validateGuide(res.guide);
      if (!v.ok) return { kind: "broken", issues: v.issues };
      return { kind: "ok", guide: v.guide, createdAt: res.createdAt, stale: res.stale };
    }
  }
}

const uniq = (paths: string[]): string[] => [...new Set(paths)];

/** 箇所の並びが指すパス。出現順・重複なし。 */
export function locationPaths(locations: { path: string }[]): string[] {
  return uniq(locations.map((l) => l.path));
}

/** 読む順のグループ1つが指すパス。出現順・重複なし。 */
export function groupPaths(group: Guide["readingOrder"][number]): string[] {
  return locationPaths(group.locations);
}

/** impact の強い順 */
export const IMPACT_ORDER: readonly Risk["impact"][] = ["high", "medium", "low"];

/** impact の強い順に並べる。同じ impact の中はガイドに書かれた順（安定ソート）。元の配列は変えない */
export function sortRisks(risks: readonly Risk[]): Risk[] {
  return [...risks].sort((a, b) => IMPACT_ORDER.indexOf(a.impact) - IMPACT_ORDER.indexOf(b.impact));
}

/** 既定で開いて出すものと畳むものに分ける。considered と low は畳む。どちらも sortRisks の順 */
export function splitRisks(risks: readonly Risk[]): { shown: Risk[]; folded: Risk[] } {
  const sorted = sortRisks(risks);
  const isFolded = (r: Risk) => r.kind === "considered" || r.impact === "low";
  return { shown: sorted.filter((r) => !isFolded(r)), folded: sorted.filter(isFolded) };
}

/**
 * 箇所を、画面上の飛び先（data-anchor の値）に解決する。今の diff に無ければ null。
 * hunk 付きは id が一致する hunk（id はパスを含んで決まるので path は見ない）、
 * パスだけはそのファイルの見出し（`file:<path>`）。
 */
export function locationAnchor(
  files: readonly DiffFile[],
  loc: GuideLocation,
): { anchor: string; file: DiffFile; hunk: number | null } | null {
  if (loc.hunk !== undefined) {
    for (const file of files) {
      const hunk = file.hunks.findIndex((h) => h.id === loc.hunk);
      if (hunk >= 0) return { anchor: loc.hunk, file, hunk };
    }
    return null;
  }
  // コピー（C）の old_path は元のファイルが残っているので、一致に使わない
  const file = files.find((f) => f.path === loc.path || (f.status === "R" && f.old_path === loc.path));
  return file ? { anchor: `file:${file.path}`, file, hunk: null } : null;
}
