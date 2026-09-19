import { getProject, type TaskRow } from "../db/tasks.ts";
import type { Db } from "../db/schema.ts";
import { commitStepBoundary, StateConflictError } from "../db/boundary.ts";
import { holdsGlobalSlot, holdsProjectSlot } from "./states.ts";

export const DEFAULT_GLOBAL_LIMIT = 4;

export type SlotUsage = { global: number; byProject: Map<number, number> };

/** カウンタは持たない。状態から数える。持てば必ず状態とズレる。 */
export async function currentUsage(db: Db): Promise<SlotUsage> {
  const rows = await db.selectFrom("tasks").select(["project_id", "state"])
    .where("state", "in", ["running", "suspended", "paused", "rate_limited"])
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
 * 期限の来た上限待ちを queued に戻す。戻したタスクのidを返す（呼び出し側が
 * task.stateChanged を配る。配らないとアプリは次の取り直しまで上限待ちのまま見える）。
 *
 * 待ちは runTask の中で sleep せず、タスク行の rate_limited_until と tick で表す。
 * sleep にすると、デーモンを再起動した瞬間に待ちが消えてタスクが永久に止まる。
 */
export async function releaseDueRateLimited(
  db: Db,
  now: Date = new Date(),
): Promise<string[]> {
  const due = await db.selectFrom("tasks").select("id")
    .where("state", "=", "rate_limited")
    .where("rate_limited_until", "<=", now.toISOString())
    .orderBy("rate_limited_until", "asc")
    .execute();

  const released: string[] = [];
  for (const { id } of due) {
    try {
      await commitStepBoundary(db, {
        taskId: id,
        requireState: "rate_limited",
        // 進行中の仕事なので行列の先頭に入る（承認からの再開と同じ扱い）。
        taskPatch: { state: "queued", resumed: 1, rate_limited_until: null },
      });
      released.push(id);
    } catch (e) {
      // 読んでから書くまでに人が pause / cancel した。新しい状態を所有しているのは
      // 先に書いた側なので、上書きせずに見送る。
      if (!(e instanceof StateConflictError)) throw e;
    }
  }
  return released;
}

/** 上限待ちのタスクが1件でもいるか。上限はアカウント全体に掛かる。 */
export async function hasActiveRateLimit(db: Db): Promise<boolean> {
  const row = await db.selectFrom("tasks").select("id")
    .where("state", "=", "rate_limited").executeTakeFirst();
  return row !== undefined;
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
