import { join } from "@std/path";
import { ghTracker } from "../github/ghTracker.ts";
import { linearTracker } from "../linear/linearTracker.ts";
import type { Tracker, TrackerOf } from "../tracker/tracker.ts";
import { parseProjectConfig } from "../workflow/project.ts";

export function trackerFor(o: {
  linearApiKey: string | undefined;
  /** テストで差し替える。既定は ghTracker() を 1 つ作って使い回す */
  github?: Tracker;
  /** テストで差し替える。既定は linearTracker */
  linear?: (o: { apiKey: string | undefined; team: string }) => Tracker;
}): TrackerOf {
  const github = o.github ?? ghTracker();
  const linear = o.linear ?? linearTracker;
  // project.yaml を書き換えたらデーモンの再起動なしで効くよう、呼ぶたびに読む
  return async (projectPath) => {
    const path = join(projectPath, ".doctrine", "project.yaml");
    const text = await Deno.readTextFile(path).catch(() => {
      throw new Error(`project.yaml がありません: ${path}`);
    });
    const { tracker } = parseProjectConfig(text);
    if (tracker.kind === "linear") {
      return linear({ apiKey: o.linearApiKey, team: tracker.team });
    }
    return github;
  };
}
