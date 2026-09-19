import type { Db } from "./schema.ts";

/**
 * タスクのロール別セッションIDを引く。無ければ undefined
 * （そのロールではまだ agent ステップが start していない）。
 */
export async function getSessionId(
  db: Db,
  taskId: string,
  role: string,
): Promise<string | undefined> {
  const row = await db.selectFrom("task_sessions").select("session_id")
    .where("task_id", "=", taskId).where("role", "=", role)
    .executeTakeFirst();
  return row?.session_id;
}
