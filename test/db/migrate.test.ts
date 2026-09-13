import { test, afterEach } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { sql } from "kysely";
import { openDb, openDbOn } from "../../src/db/migrate.ts";
import { insertProject, insertTask, getTask, listTasks } from "../../src/db/tasks.ts";
import type { Database, Db } from "../../src/db/schema.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => Deno.remove(d, { recursive: true })));
});

async function tempDbPath(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "doctrine-migrate-" });
  dirs.push(dir);
  return join(dir, "doctrine.db");
}

function db() {
  return openDb(":memory:");
}

function seed(d: Db) {
  return insertProject(d, {
    path: "/repo", default_workflow: "feature", max_concurrent: 1, base_branch: "main", setup: null,
  });
}

/**
 * マイグレーション機構より前の openDb が実行していた DDL（`CREATE TABLE IF NOT EXISTS` のみ）。
 * 手元に残っている古いDBファイルはこの形をしている。変更しないこと。
 */
const LEGACY_DDL = `
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
  pending_feed TEXT,
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

/** pending_feed を足す前の DDL。この時点で作られたDBファイルには、今も pending_feed が無い。 */
const LEGACY_DDL_WITHOUT_PENDING_FEED = `
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

/**
 * schema.ts の型が持つ列の一覧。satisfies により、型に列を足して（または消して）
 * ここを直し忘れるとコンパイルが通らない。実DBの列とは下のテストで突き合わせる。
 * これで「DDL（マイグレーション）と型」の食い違いが実行時まで隠れない。
 */
const COLUMNS = {
  projects: { id: true, path: true, default_workflow: true, max_concurrent: true, base_branch: true, setup: true },
  tasks: {
    id: true, project_id: true, title: true, prompt: true, workflow_name: true, state: true,
    current_step_id: true, attempt_counts: true, branch: true, worktree_path: true,
    claude_session_id: true, child_pid: true, child_started_at: true, pending_feed: true,
    priority: true, resumed: true, created_at: true, updated_at: true,
  },
  step_runs: {
    id: true, task_id: true, step_id: true, attempt: true, status: true, exit_code: true,
    started_at: true, ended_at: true, log_path: true, cost_usd: true, num_turns: true, duration_ms: true,
  },
  step_outputs: { task_id: true, step_id: true, stdout: true, stderr: true, exit_code: true },
  task_sessions: { task_id: true, role: true, session_id: true },
  rate_limit_samples: { id: true, observed_at: true, window: true, utilization: true, resets_at: true },
} satisfies { [T in keyof Database]: { [C in keyof Database[T]]: true } };

type ColumnInfo = { name: string; type: string; notnull: number; dflt_value: string | null; pk: number };

async function columnsOf(d: Db, table: string): Promise<ColumnInfo[]> {
  const { rows } = await sql<ColumnInfo>`SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(${table})`
    .execute(d);
  return rows.map((r) => ({ name: r.name, type: r.type, notnull: r.notnull, dflt_value: r.dflt_value, pk: r.pk }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function appliedMigrations(d: Db): Promise<string[]> {
  const { rows } = await sql<{ name: string }>`SELECT name FROM kysely_migration ORDER BY name`.execute(d);
  return rows.map((r) => r.name);
}

test("マイグレーションで6つのテーブルができる", async () => {
  const d = await db();
  const { rows } = await sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`
    .execute(d);
  const names = rows.map((r) => r.name);
  for (const t of ["projects", "rate_limit_samples", "step_outputs", "step_runs", "task_sessions", "tasks"]) {
    assert.ok(names.includes(t), `${t} が無い: ${names.join(",")}`);
  }
});

test("実DBの列集合は schema.ts の型と一致する", async () => {
  const d = await db();
  for (const [table, cols] of Object.entries(COLUMNS)) {
    const actual = (await columnsOf(d, table)).map((c) => c.name);
    assert.deepEqual(actual, Object.keys(cols).sort(), `${table} の列が型とずれている`);
  }
});

test("タスクは queued で作られる", async () => {
  const d = await db();
  const pid = await seed(d);
  const t = await insertTask(d, {
    id: "t1", project_id: pid, title: "T", prompt: "P",
    workflow_name: "feature", branch: "doctrine/t1-t", priority: 2,
  });
  assert.equal(t.state, "queued");
  assert.equal(t.worktree_path, null);
  assert.equal(t.child_pid, null);
  assert.equal(t.resumed, 0);
  assert.equal((await getTask(d, "t1"))?.title, "T");
});

test("state でフィルタできる", async () => {
  const d = await db();
  const pid = await seed(d);
  await insertTask(d, { id: "t1", project_id: pid, title: "a", prompt: "p", workflow_name: "f", branch: "b1", priority: 2 });
  await insertTask(d, { id: "t2", project_id: pid, title: "b", prompt: "p", workflow_name: "f", branch: "b2", priority: 2 });
  await d.updateTable("tasks").set({ state: "running" }).where("id", "=", "t2").execute();
  assert.deepEqual((await listTasks(d, { state: "queued" })).map((t) => t.id), ["t1"]);
});

test("同じidのタスクは作れない", async () => {
  const d = await db();
  const pid = await seed(d);
  await insertTask(d, { id: "t1", project_id: pid, title: "a", prompt: "p", workflow_name: "f", branch: "b1", priority: 2 });
  await assert.rejects(() => insertTask(d, { id: "t1", project_id: pid, title: "a", prompt: "p", workflow_name: "f", branch: "b1", priority: 2 }));
});

test("ファイルのDBは WAL で開き、外部キー制約が効いている", async () => {
  const d = await openDb(await tempDbPath());
  try {
    const { rows: [mode] } = await sql<{ journal_mode: string }>`PRAGMA journal_mode`.execute(d);
    assert.equal(mode.journal_mode, "wal");
    await assert.rejects(
      () => insertTask(d, { id: "t1", project_id: 999, title: "a", prompt: "p", workflow_name: "f", branch: "b", priority: 2 }),
      /FOREIGN KEY/,
    );
  } finally {
    await d.destroy();
  }
});

test("開き直してもマイグレーションは二度流れず、データは残る", async () => {
  const path = await tempDbPath();
  const first = await openDb(path);
  await seed(first);
  assert.deepEqual(await appliedMigrations(first), ["0001_baseline", "0002_task_sessions"]);
  await first.destroy();

  const second = await openDb(path);
  try {
    assert.deepEqual(await appliedMigrations(second), ["0001_baseline", "0002_task_sessions"]);
    assert.equal((await second.selectFrom("projects").selectAll().execute()).length, 1);
  } finally {
    await second.destroy();
  }
});

/**
 * テストが :memory: しか使わない限り、この経路は決して通らない。
 * 手書き DDL 時代の DBファイルには kysely_migration が無いので、ベースラインが
 * 既存のテーブルに対して流れる。そこで落ちたり、既存の行を失ったりしてはいけない。
 */
test("pending_feed を足す前に作られたDBファイルは、行を保ったまま pending_feed が足される", async () => {
  const path = await tempDbPath();
  const legacy = new DatabaseSync(path);
  legacy.exec(LEGACY_DDL_WITHOUT_PENDING_FEED);
  legacy.prepare("INSERT INTO projects (path, default_workflow) VALUES ('/repo', 'feature')").run();
  legacy.prepare(
    `INSERT INTO tasks (id, project_id, title, prompt, workflow_name, state, branch, created_at, updated_at)
     VALUES ('old', 1, 'T', 'P', 'feature', 'suspended', 'b', 'x', 'x')`,
  ).run();
  legacy.close();

  const d = await openDb(path);
  try {
    assert.deepEqual(await appliedMigrations(d), ["0001_baseline", "0002_task_sessions"]);
    const old = await getTask(d, "old");
    assert.equal(old?.state, "suspended", "既存の行は残る");
    assert.equal(old?.pending_feed, null, "列が足されていて、読める");
    await d.updateTable("tasks").set({ pending_feed: "feed" }).where("id", "=", "old").execute();
    assert.equal((await getTask(d, "old"))?.pending_feed, "feed", "書ける");
  } finally {
    await d.destroy();
  }
});

test("claude_session_id を持つ既存タスクは role \"default\" として task_sessions に移される", async () => {
  const path = await tempDbPath();
  const legacy = new DatabaseSync(path);
  legacy.exec(LEGACY_DDL);
  legacy.prepare("INSERT INTO projects (path, default_workflow) VALUES ('/repo', 'feature')").run();
  legacy.prepare(
    `INSERT INTO tasks (id, project_id, title, prompt, workflow_name, state, branch, claude_session_id, created_at, updated_at)
     VALUES ('old', 1, 'T', 'P', 'feature', 'running', 'b', 'sess-1', 'x', 'x')`,
  ).run();
  legacy.prepare(
    `INSERT INTO tasks (id, project_id, title, prompt, workflow_name, state, branch, created_at, updated_at)
     VALUES ('no-session', 1, 'T', 'P', 'feature', 'queued', 'b2', 'x', 'x')`,
  ).run();
  legacy.close();

  const d = await openDb(path);
  try {
    const rows = await d.selectFrom("task_sessions").selectAll().execute();
    assert.deepEqual(rows.map((r) => ({ task_id: r.task_id, role: r.role, session_id: r.session_id })), [{ task_id: "old", role: "default", session_id: "sess-1" }]);
  } finally {
    await d.destroy();
  }
});

test("手書き DDL 時代のDBを移行した形は、新規に作ったDBの形と一致する", async () => {
  for (const ddl of [LEGACY_DDL, LEGACY_DDL_WITHOUT_PENDING_FEED]) {
    const legacy = new DatabaseSync(":memory:");
    legacy.exec(ddl);
    const migrated = await openDbOn(legacy);
    const fresh = await db();
    try {
      for (const table of Object.keys(COLUMNS)) {
        assert.deepEqual(await columnsOf(migrated, table), await columnsOf(fresh, table), `${table} の形が違う`);
      }
    } finally {
      await migrated.destroy();
      await fresh.destroy();
    }
  }
});
