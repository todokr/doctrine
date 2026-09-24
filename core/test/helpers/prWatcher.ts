import type { PrFact } from "../../../shared/intake/processStatus.ts";
import type { PrWatcher } from "../../src/tracker/tracker.ts";

export function fakePrWatcher(): {
  prWatcher: PrWatcher;
  /** ブランチ → PR。無いブランチは空配列で返す。 */
  prs: Map<string, PrFact[]>;
  /** pullRequests に渡されたブランチの一覧（呼び出しごと）。 */
  calls: string[][];
  /** true の間、pullRequests を reject する。 */
  failing: { on: boolean };
} {
  const prs = new Map<string, PrFact[]>();
  const calls: string[][] = [];
  const failing = { on: false };
  const prWatcher: PrWatcher = {
    pullRequests: (_projectPath, branches) => {
      calls.push([...branches]);
      if (failing.on) return Promise.reject(new Error("偽の PrWatcher の失敗"));
      return Promise.resolve(new Map(branches.map((b) => [b, prs.get(b) ?? []])));
    },
  };
  return { prWatcher, prs, calls, failing };
}
