import { join, normalize } from "@std/path";
import { parse as parseYaml, stringify } from "yaml";
import { z } from "zod";
import { formatZodIssues, WorkflowValidationError } from "./schema.ts";
import { type TrackerConfig, trackerSchema } from "./project.ts";

export type WorkspaceProjectEntry = { name: string; path: string };

export type WorkspaceConfig = {
  name: string;
  projects: WorkspaceProjectEntry[];
  tracker: TrackerConfig;
};

export const WORKSPACE_YAML = join(".doctrine", "workspace.yaml");

const PROJECT_NAME = /^[a-z0-9-]+$/;

const schema = z.object({
  name: z.string().min(1).optional(),
  projects: z.record(
    z.string().regex(PROJECT_NAME, "プロジェクトの名前は [a-z0-9-]+ で書いてください"),
    z.string().min(1),
  ).refine((p) => Object.keys(p).length > 0, "projects に 1 つ以上書いてください"),
  tracker: trackerSchema.default({ kind: "github" }),
}).strict();

/** rootDirName は name を省略したときの既定値。projects は書かれた順を保つ。 */
export function parseWorkspaceConfig(yamlText: string, rootDirName: string): WorkspaceConfig {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (e) {
    throw new WorkflowValidationError([`YAMLとして読めません: ${(e as Error).message}`]);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new WorkflowValidationError(formatZodIssues(parsed.error));
  }
  const projects = Object.entries(parsed.data.projects).map(([name, path]) => ({ name, path }));
  const seen = new Map<string, string>();
  for (const p of projects) {
    const key = comparablePath(p.path);
    const other = seen.get(key);
    if (other !== undefined) {
      throw new WorkflowValidationError([
        `projects の ${other} と ${p.name} が同じパス ${key} を指しています`,
      ]);
    }
    seen.set(key, p.name);
  }
  return {
    name: parsed.data.name ?? rootDirName,
    projects,
    tracker: parsed.data.tracker,
  };
}

/** 雛形。projects の順に書く。tracker を渡さなければ書かない（既定の github）。 */
export function workspaceYamlFor(
  projects: WorkspaceProjectEntry[],
  tracker?: TrackerConfig,
): string {
  const obj: Record<string, unknown> = {
    projects: Object.fromEntries(projects.map((p) => [p.name, p.path])),
  };
  if (tracker) obj.tracker = tracker;
  const body = stringify(obj);
  return `# doctrine の workspace 設定（dctl workspace-add が雛形として作成）\n${body}`;
}

/** normalize は末尾の "/" を残すので、重複判定のために 1 つ落とす。 */
function comparablePath(path: string): string {
  const n = normalize(path);
  return n.length > 1 && n.endsWith("/") ? n.slice(0, -1) : n;
}
