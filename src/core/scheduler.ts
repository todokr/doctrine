import type { DatabaseSync } from "node:sqlite";
import { getProject, type TaskRow } from "../db/tasks.ts";
import { holdsGlobalSlot, holdsProjectSlot } from "./states.ts";

export const DEFAULT_GLOBAL_LIMIT = 4;

export type SlotUsage = { global: number; byProject: Map<number, number> };

/** カウンタは持たない。状態から数える。持てば必ず状態とズレる。 */
export function currentUsage(db: DatabaseSync): SlotUsage {
  const rows = db.prepare(
    "SELECT project_id, state FROM tasks WHERE state IN ('running','suspended','paused')",
  ).all() as { project_id: number; state: TaskRow["state"] }[];

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
export function selectAdmissible(
  db: DatabaseSync, globalLimit: number = DEFAULT_GLOBAL_LIMIT,
): TaskRow[] {
  const usage = currentUsage(db);
  let globalFree = globalLimit - usage.global;
  if (globalFree <= 0) return [];

  const queued = db.prepare(
    `SELECT * FROM tasks WHERE state = 'queued'
     ORDER BY resumed DESC, priority ASC, created_at ASC, id ASC`,
  ).all() as TaskRow[];

  const admitted: TaskRow[] = [];
  const projectUsed = new Map(usage.byProject);
  for (const task of queued) {
    if (globalFree <= 0) break;
    const project = getProject(db, task.project_id);
    if (!project) continue;
    const used = projectUsed.get(task.project_id) ?? 0;
    if (used >= project.max_concurrent) continue;
    admitted.push(task);
    projectUsed.set(task.project_id, used + 1);
    globalFree -= 1;
  }
  return admitted;
}
