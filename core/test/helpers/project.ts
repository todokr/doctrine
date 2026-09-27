import { basename } from "@std/path";
import type { Db, ProjectRow } from "../../src/db/schema.ts";
import { getProject, insertProject } from "../../src/db/tasks.ts";
import { insertWorkspace, projectNameFrom } from "../../src/db/workspaces.ts";

/** workspace（root = path）とプロジェクト 1 つを入れ、プロジェクトの行を返す。 */
export async function seedProject(db: Db, p: {
  path: string;
  name?: string;
  default_workflow?: string;
  max_concurrent?: number;
  base_branch?: string;
  setup?: string | null;
}): Promise<ProjectRow> {
  const dir = basename(p.path);
  const workspace_id = await insertWorkspace(db, { path: p.path, name: dir });
  const id = await insertProject(db, {
    workspace_id,
    name: p.name ?? projectNameFrom(dir),
    path: p.path,
    default_workflow: p.default_workflow ?? "f",
    max_concurrent: p.max_concurrent ?? 1,
    base_branch: p.base_branch ?? "main",
    setup: p.setup ?? null,
  });
  return (await getProject(db, id))!;
}
