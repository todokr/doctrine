// task.guide の応答を画面の形に落とす。副作用を持たない（テストは guide.test.ts）
import type { Guide } from "../../shared/guide/schema.ts";
import { validateGuide } from "../../shared/guide/validate.ts";
import type { TaskGuide } from "../../shared/protocol.ts";

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
