import type { Db, ProjectRow, WorkspaceRow } from "./schema.ts";

export type { WorkspaceRow } from "./schema.ts";

export async function insertWorkspace(
  db: Db,
  w: { path: string; name: string },
): Promise<number> {
  const r = await db.insertInto("workspaces").values(w).executeTakeFirstOrThrow();
  return Number(r.insertId);
}

export function getWorkspace(db: Db, id: number): Promise<WorkspaceRow | undefined> {
  return db.selectFrom("workspaces").selectAll().where("id", "=", id).executeTakeFirst();
}

export function getWorkspaceByPath(db: Db, path: string): Promise<WorkspaceRow | undefined> {
  return db.selectFrom("workspaces").selectAll().where("path", "=", path).executeTakeFirst();
}

/** id 順。 */
export function listWorkspaces(db: Db): Promise<WorkspaceRow[]> {
  return db.selectFrom("workspaces").selectAll().orderBy("id").execute();
}

/** その workspace のプロジェクトだけを id 順に返す。 */
export function listProjectsOf(db: Db, workspaceId: number): Promise<ProjectRow[]> {
  return db.selectFrom("projects").selectAll()
    .where("workspace_id", "=", workspaceId).orderBy("id").execute();
}

/** 第 1 段の Intake が使うプロジェクト。workspace のプロジェクトがちょうど 1 つでなければ投げる（第 2 段で消す）。 */
export async function soleProjectOf(db: Db, workspaceId: number): Promise<ProjectRow> {
  const projects = await listProjectsOf(db, workspaceId);
  if (projects.length > 1) {
    throw new Error("プロジェクトが複数ある workspace の Intake はまだ扱えません");
  }
  if (projects.length === 0) {
    throw new Error(`workspace ${workspaceId} にプロジェクトがありません`);
  }
  return projects[0];
}

/** 名前を [a-z0-9-]+ に丸める。空になれば "project"。 */
export function projectNameFrom(dirName: string): string {
  return dirName.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
}
