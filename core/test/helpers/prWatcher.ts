import type { PrFact } from "../../../shared/intake/processStatus.ts";
import type { PrWatcher } from "../../src/tracker/tracker.ts";

export function fakePrWatcher(): {
  prWatcher: PrWatcher;
  /** ブランチ → PR。無いブランチは空配列で返す。 */
  prs: Map<string, PrFact[]>;
  /** pullRequests に渡されたブランチの一覧（呼び出しごと）。 */
  calls: string[][];
  /** pullRequests に渡された projectPath（呼び出しごと。calls と同じ順）。 */
  paths: string[];
  /** true の間、pullRequests を reject する。 */
  failing: { on: boolean };
  /** 入っているパスの呼び出しだけ reject する。 */
  failingPaths: Set<string>;
} {
  const prs = new Map<string, PrFact[]>();
  const calls: string[][] = [];
  const paths: string[] = [];
  const failing = { on: false };
  const failingPaths = new Set<string>();
  const prWatcher: PrWatcher = {
    pullRequests: (projectPath, branches) => {
      calls.push([...branches]);
      paths.push(projectPath);
      if (failing.on || failingPaths.has(projectPath)) {
        return Promise.reject(new Error("偽の PrWatcher の失敗"));
      }
      return Promise.resolve(new Map(branches.map((b) => [b, prs.get(b) ?? []])));
    },
  };
  return { prWatcher, prs, calls, paths, failing, failingPaths };
}
