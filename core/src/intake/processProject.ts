import type { Pfd, Process } from "../../../shared/intake/pfd.ts";
import type { Db, ProjectRow } from "../db/schema.ts";
import { listProjectsOf } from "../db/workspaces.ts";

/**
 * プロセス id → その project の名前が指す、workspace のプロジェクト。
 * project が無いか workspace に無いプロセスは入らない。
 */
export async function projectsOfProcesses(
  db: Db,
  workspaceId: number,
  pfd: Pfd,
): Promise<Map<string, ProjectRow>> {
  const byName = new Map((await listProjectsOf(db, workspaceId)).map((p) => [p.name, p]));
  const result = new Map<string, ProjectRow>();
  for (const process of pfd.processes) {
    if (process.project === undefined) continue;
    const project = byName.get(process.project);
    if (project) result.set(process.id, project);
  }
  return result;
}

/** プロセス id → そのプロセスのプロジェクトの base_branch。 */
export function baseBranchesOf(projects: ReadonlyMap<string, ProjectRow>): Map<string, string> {
  return new Map([...projects].map(([id, project]) => [id, project.base_branch]));
}

/** プロジェクトを引けなかったプロセスを見送る理由。 */
export function missingProjectMessage(process: Process): string {
  if (process.project === undefined) {
    return `プロセス ${process.id} に project がありません。改訂で project を足してください`;
  }
  return `プロジェクト ${process.project} は workspace にありません`;
}
