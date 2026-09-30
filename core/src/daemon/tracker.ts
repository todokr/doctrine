import { basename, join } from "@std/path";
import { ghTracker } from "../github/ghTracker.ts";
import { linearTracker } from "../linear/linearTracker.ts";
import { type Tracker, type TrackerOf, WorkspaceConfigError } from "../tracker/tracker.ts";
import { workspaceTracker } from "../tracker/workspaceTracker.ts";
import {
  type LinearStateNames,
  parseWorkspaceConfig,
  type TrackerConfig,
  WORKSPACE_YAML,
} from "../workflow/workspace.ts";
import { WorkflowValidationError } from "../workflow/schema.ts";

export function trackerFor(o: {
  linearApiKey: string | undefined;
  /** テストで差し替える。既定は ghTracker() を 1 つ作って使い回す */
  github?: Tracker;
  /** テストで差し替える。既定は linearTracker */
  linear?: (o: { apiKey: string | undefined; team: string; states?: LinearStateNames }) => Tracker;
}): TrackerOf {
  const github = o.github ?? ghTracker();
  const linear = o.linear ?? linearTracker;
  // workspace.yaml を書き換えたらデーモンの再起動なしで効くよう、呼ぶたびに読む
  return async (ws) => {
    const config = await readTrackerConfig(ws.path);
    const tracker = config.kind === "linear"
      ? linear({
        apiKey: o.linearApiKey,
        team: config.team,
        ...(config.states ? { states: config.states } : {}),
      })
      : github;
    return workspaceTracker(ws, tracker);
  };
}

/** <workspacePath>/.doctrine/workspace.yaml の tracker。無い・読めないときは WorkspaceConfigError を投げる。 */
export async function readTrackerConfig(workspacePath: string): Promise<TrackerConfig> {
  const path = join(workspacePath, WORKSPACE_YAML);
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      throw new WorkspaceConfigError(
        "workspace_config_missing",
        `workspace.yaml がありません: ${path}`,
      );
    }
    throw e;
  }
  try {
    return parseWorkspaceConfig(text, basename(workspacePath)).tracker;
  } catch (e) {
    if (e instanceof WorkflowValidationError) {
      throw new WorkspaceConfigError(
        "workspace_config_invalid",
        `workspace.yaml を読めません: ${path}\n${e.message}`,
      );
    }
    throw e;
  }
}
