import type { DatabaseSync } from "node:sqlite";

export type TaskState =
  | "queued" | "running" | "suspended" | "paused" | "completed" | "failed" | "canceled";

export type ProjectRow = {
  id: number; path: string; default_workflow: string;
  max_concurrent: number; base_branch: string; setup: string | null;
};

export type TaskRow = {
  id: string; project_id: number; title: string; prompt: string; workflow_name: string;
  state: TaskState; current_step_id: string | null; attempt_counts: string;
  branch: string; worktree_path: string | null; claude_session_id: string | null;
  child_pid: number | null; child_started_at: string | null;
  priority: number; resumed: number; created_at: string; updated_at: string;
};

export type NewTask = {
  id: string; project_id: number; title: string; prompt: string;
  workflow_name: string; branch: string; priority: number;
};

export function insertProject(db: DatabaseSync, p: Omit<ProjectRow, "id">): number {
  const r = db.prepare(
    `INSERT INTO projects (path, default_workflow, max_concurrent, base_branch, setup)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(p.path, p.default_workflow, p.max_concurrent, p.base_branch, p.setup);
  return Number(r.lastInsertRowid);
}

export function getProject(db: DatabaseSync, id: number): ProjectRow | undefined {
  return db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
}

export function getProjectByPath(db: DatabaseSync, path: string): ProjectRow | undefined {
  return db.prepare("SELECT * FROM projects WHERE path = ?").get(path) as ProjectRow | undefined;
}

export function listProjects(db: DatabaseSync): ProjectRow[] {
  return db.prepare("SELECT * FROM projects ORDER BY id").all() as ProjectRow[];
}

export function insertTask(db: DatabaseSync, t: NewTask): TaskRow {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO tasks (id, project_id, title, prompt, workflow_name, state,
                        branch, priority, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
  ).run(t.id, t.project_id, t.title, t.prompt, t.workflow_name, t.branch, t.priority, now, now);
  return getTask(db, t.id)!;
}

export function getTask(db: DatabaseSync, id: string): TaskRow | undefined {
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
}

export function listTasks(
  db: DatabaseSync,
  filter: { projectId?: number; state?: TaskState } = {},
): TaskRow[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (filter.projectId !== undefined) { where.push("project_id = ?"); args.push(filter.projectId); }
  if (filter.state !== undefined) { where.push("state = ?"); args.push(filter.state); }
  const sql = `SELECT * FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""}
               ORDER BY created_at, id`;
  return db.prepare(sql).all(...args) as TaskRow[];
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
