// vite-node（vitest）は node:sqlite をNodeの builtinModules 一覧から
// 判定しており、実験的モジュールのため一覧に無く外部化に失敗する
// （"Failed to load url sqlite" になる）。静的 import ではなく
// process.getBuiltinModule で実行時に取得することで回避する。
import type { DatabaseSync } from "node:sqlite";
type SqliteModule = typeof import("node:sqlite");
const { DatabaseSync: DatabaseSyncCtor } = process.getBuiltinModule("node:sqlite") as SqliteModule;

const DDL = `
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  default_workflow TEXT NOT NULL,
  max_concurrent INTEGER NOT NULL DEFAULT 1,
  base_branch TEXT NOT NULL DEFAULT 'main',
  setup TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  workflow_name TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN
    ('queued','running','suspended','paused','completed','failed','canceled')),
  current_step_id TEXT,
  attempt_counts TEXT NOT NULL DEFAULT '{}',
  branch TEXT NOT NULL,
  worktree_path TEXT,
  claude_session_id TEXT,
  child_pid INTEGER,
  child_started_at TEXT,
  priority INTEGER NOT NULL DEFAULT 2,
  resumed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id, state);

CREATE TABLE IF NOT EXISTS step_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  step_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','success','failed','degraded')),
  exit_code INTEGER,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  log_path TEXT NOT NULL,
  cost_usd REAL,
  num_turns INTEGER,
  duration_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_step_runs_task ON step_runs(task_id, id);

CREATE TABLE IF NOT EXISTS step_outputs (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  step_id TEXT NOT NULL,
  stdout TEXT NOT NULL,
  stderr TEXT NOT NULL,
  exit_code INTEGER,
  PRIMARY KEY (task_id, step_id)
);

CREATE TABLE IF NOT EXISTS rate_limit_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  observed_at TEXT NOT NULL,
  window TEXT NOT NULL,
  utilization REAL NOT NULL,
  resets_at TEXT
);
`;

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSyncCtor(path);
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(DDL);
  return db;
}
