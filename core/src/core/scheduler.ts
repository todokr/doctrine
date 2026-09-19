import { getProject, type TaskRow } from "../db/tasks.ts";
import type { Db } from "../db/schema.ts";
import { holdsGlobalSlot, holdsProjectSlot } from "./states.ts";

export const DEFAULT_GLOBAL_LIMIT = 4;

export type SlotUsage = { global: number; byProject: Map<number, number> };

/** カウンタは持たない。状態から数える。持てば必ず状態とズレる。 */
export async function currentUsage(db: Db): Promise<SlotUsage> {
  const rows = await db.selectFrom("tasks").select(["project_id", "state"])
    .where("state", "in", ["running", "suspended", "paused"])
    .execute();

  const usage: SlotUsage = { global: 0, byProject: new Map() };
  for (const r of rows) {
    if (holdsGlobalSlot(r.state)) usage.global += 1;
    if (holdsProjectSlot(r.state)) {
      usage.byProject.set(r.project_id, (usage.byProject.get(r.project_id) ?? 0) + 1);
    }
  }
  return usage;
}

/**
 * 受付順: 再開したタスク → 優先度（小さいほど優先） → 作成時刻のFIFO。
 * 両スコープに空きがあるタスクだけを、上限いっぱいまで返す。
 */
export async function selectAdmissible(
  db: Db,
  globalLimit: number = DEFAULT_GLOBAL_LIMIT,
): Promise<TaskRow[]> {
  const usage = await currentUsage(db);
  let globalFree = globalLimit - usage.global;
  if (globalFree <= 0) return [];

  const queued = await db.selectFrom("tasks").selectAll()
    .where("state", "=", "queued")
    .orderBy("resumed", "desc").orderBy("priority", "asc").orderBy("created_at", "asc").orderBy(
      "id",
      "asc",
    )
    .execute();

  const admitted: TaskRow[] = [];
  const projectUsed = new Map(usage.byProject);
  for (const task of queued) {
    if (globalFree <= 0) break;
    const project = await getProject(db, task.project_id);
    if (!project) continue;
    const used = projectUsed.get(task.project_id) ?? 0;
    if (used >= project.max_concurrent) continue;
    admitted.push(task);
    projectUsed.set(task.project_id, used + 1);
    globalFree -= 1;
  }
  return admitted;
}
