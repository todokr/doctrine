import type { Db, ProjectRow, TaskRow, TaskState } from "./schema.ts";

export type { ProjectRow, TaskRow, TaskState } from "./schema.ts";

export type NewTask = {
  id: string;
  project_id: number;
  title: string;
  prompt: string;
  workflow_name: string;
  branch: string;
  priority: number;
};

export async function insertProject(db: Db, p: Omit<ProjectRow, "id">): Promise<number> {
  const r = await db.insertInto("projects").values(p).executeTakeFirstOrThrow();
  return Number(r.insertId);
}

export function getProject(db: Db, id: number): Promise<ProjectRow | undefined> {
  return db.selectFrom("projects").selectAll().where("id", "=", id).executeTakeFirst();
}

export function getProjectByPath(db: Db, path: string): Promise<ProjectRow | undefined> {
  return db.selectFrom("projects").selectAll().where("path", "=", path).executeTakeFirst();
}

export function listProjects(db: Db): Promise<ProjectRow[]> {
  return db.selectFrom("projects").selectAll().orderBy("id").execute();
}

export async function insertTask(db: Db, t: NewTask): Promise<TaskRow> {
  const now = new Date().toISOString();
  await db.insertInto("tasks")
    .values({ ...t, state: "queued", created_at: now, updated_at: now })
    .execute();
  return (await getTask(db, t.id))!;
}

export function getTask(db: Db, id: string): Promise<TaskRow | undefined> {
  return db.selectFrom("tasks").selectAll().where("id", "=", id).executeTakeFirst();
}

export function listTasks(
  db: Db,
  filter: { projectId?: number; state?: TaskState } = {},
): Promise<TaskRow[]> {
  return db.selectFrom("tasks").selectAll()
    .$if(filter.projectId !== undefined, (q) => q.where("project_id", "=", filter.projectId!))
    .$if(filter.state !== undefined, (q) => q.where("state", "=", filter.state!))
    .orderBy("created_at").orderBy("id")
    .execute();
}

export function attemptCount(task: TaskRow, stepId: string): number {
  const counts = JSON.parse(task.attempt_counts) as Record<string, number>;
  return counts[stepId] ?? 0;
}

export function withAttempt(task: TaskRow, stepId: string): string {
  const counts = JSON.parse(task.attempt_counts) as Record<string, number>;
  counts[stepId] = (counts[stepId] ?? 0) + 1;
  return JSON.stringify(counts);
}
