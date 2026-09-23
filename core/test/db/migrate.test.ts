import { afterEach, test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { sql } from "kysely";
import { openDb, openDbOn } from "../../src/db/migrate.ts";
import { getTask, insertProject, insertTask, listTasks } from "../../src/db/tasks.ts";
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
    path: "/repo",
    default_workflow: "feature",
    max_concurrent: 1,
    base_branch: "main",
    setup: null,
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
  projects: {
    id: true,
    path: true,
    default_workflow: true,
    max_concurrent: true,
    base_branch: true,
    setup: true,
  },
  tasks: {
    id: true,
    project_id: true,
    title: true,
    prompt: true,
    workflow_name: true,
    state: true,
    current_step_id: true,
    attempt_counts: true,
    branch: true,
    worktree_path: true,
    claude_session_id: true,
    child_pid: true,
    child_started_at: true,
    pending_feed: true,
    rate_limited_until: true,
    priority: true,
    resumed: true,
    created_at: true,
    updated_at: true,
    intake_id: true,
    intake_process_id: true,
    issue_url: true,
    parent_issue_url: true,
    workflow_yaml: true,
    workflow_setup: true,
  },
  step_runs: {
    id: true,
    task_id: true,
    step_id: true,
    attempt: true,
    status: true,
    exit_code: true,
    started_at: true,
    ended_at: true,
    log_path: true,
    cost_usd: true,
    num_turns: true,
    duration_ms: true,
    review_tree: true,
    goto_step_id: true,
    permission_denials: true,
  },
  step_outputs: { step_run_id: true, last_stdout: true, last_stderr: true, exit_code: true },
  task_sessions: { task_id: true, role: true, session_id: true },
  rate_limit_samples: {
    id: true,
    observed_at: true,
    window: true,
    utilization: true,
    resets_at: true,
  },
  intakes: {
    id: true,
    project_id: true,
    issue_url: true,
    issue_node_id: true,
    issue_title: true,
    state: true,
    revising: true,
    attention_reason: true,
    dispatch_paused: true,
    worktree_path: true,
    claude_session_id: true,
    child_pid: true,
    child_started_at: true,
    rate_limited_until: true,
    revision_run_id: true,
    created_at: true,
    updated_at: true,
    ended_at: true,
  },
  intake_runs: {
    id: true,
    intake_id: true,
    purpose: true,
    attempt: true,
    status: true,
    started_at: true,
    ended_at: true,
    log_path: true,
    cost_usd: true,
    num_turns: true,
    duration_ms: true,
    output: true,
    issues: true,
    permission_denials: true,
  },
  intake_question_sets: {
    id: true,
    intake_id: true,
    run_id: true,
    questions: true,
    assumptions: true,
    answers: true,
    assumption_responses: true,
    created_at: true,
    answered_at: true,
  },
  intake_drafts: {
    id: true,
    intake_id: true,
    seq: true,
    run_id: true,
    pfd: true,
    hash: true,
    replies: true,
    created_at: true,
  },
  intake_comments: {
    id: true,
    intake_id: true,
    draft_id: true,
    target_kind: true,
    target_id: true,
    body: true,
    run_id: true,
    created_at: true,
  },
  intake_approvals: { id: true, intake_id: true, draft_id: true, hash: true, approved_at: true },
  intake_processes: {
    intake_id: true,
    process_id: true,
    sub_issue_url: true,
    sub_issue_node_id: true,
    sub_issue_hash: true,
    sub_issue_closed: true,
    current_task_id: true,
    human_note: true,
    human_done_at: true,
    retired_at: true,
  },
  pr_observations: {
    task_id: true,
    pr_number: true,
    pr_url: true,
    state: true,
    base_ref: true,
    merged_at: true,
    merge_commit: true,
    observed_at: true,
  },
} satisfies { [T in keyof Database]: { [C in keyof Database[T]]: true } };

type ColumnInfo = {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
};

async function columnsOf(d: Db, table: string): Promise<ColumnInfo[]> {
  const { rows } = await sql<
    ColumnInfo
  >`SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(${table})`
    .execute(d);
  return rows.map((r) => ({
    name: r.name,
    type: r.type,
    notnull: r.notnull,
    dflt_value: r.dflt_value,
    pk: r.pk,
  }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function appliedMigrations(d: Db): Promise<string[]> {
  const { rows } = await sql<{ name: string }>`SELECT name FROM kysely_migration ORDER BY name`
    .execute(d);
  return rows.map((r) => r.name);
}

test("マイグレーションで14のテーブルができる", async () => {
  const d = await db();
  const { rows } = await sql<
    { name: string }
  >`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`
    .execute(d);
  const names = rows.map((r) => r.name);
  for (
    const t of [
      "intake_approvals",
      "intake_comments",
      "intake_drafts",
      "intake_processes",
      "intake_question_sets",
      "intake_runs",
      "intakes",
      "pr_observations",
      "projects",
      "rate_limit_samples",
      "step_outputs",
      "step_runs",
      "task_sessions",
      "tasks",
    ]
  ) {
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
    id: "t1",
    project_id: pid,
    title: "T",
    prompt: "P",
    workflow_name: "feature",
    branch: "doctrine/t1-t",
    priority: 2,
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
  await insertTask(d, {
    id: "t1",
    project_id: pid,
    title: "a",
    prompt: "p",
    workflow_name: "f",
    branch: "b1",
    priority: 2,
  });
  await insertTask(d, {
    id: "t2",
    project_id: pid,
    title: "b",
    prompt: "p",
    workflow_name: "f",
    branch: "b2",
    priority: 2,
  });
  await d.updateTable("tasks").set({ state: "running" }).where("id", "=", "t2").execute();
  assert.deepEqual((await listTasks(d, { state: "queued" })).map((t) => t.id), ["t1"]);
});

test("同じidのタスクは作れない", async () => {
  const d = await db();
  const pid = await seed(d);
  await insertTask(d, {
    id: "t1",
    project_id: pid,
    title: "a",
    prompt: "p",
    workflow_name: "f",
    branch: "b1",
    priority: 2,
  });
  await assert.rejects(() =>
    insertTask(d, {
      id: "t1",
      project_id: pid,
      title: "a",
      prompt: "p",
      workflow_name: "f",
      branch: "b1",
      priority: 2,
    })
  );
});

test("ファイルのDBは WAL で開き、外部キー制約が効いている", async () => {
  const d = await openDb(await tempDbPath());
  try {
    const { rows: [mode] } = await sql<{ journal_mode: string }>`PRAGMA journal_mode`.execute(d);
    assert.equal(mode.journal_mode, "wal");
    await assert.rejects(
      () =>
        insertTask(d, {
          id: "t1",
          project_id: 999,
          title: "a",
          prompt: "p",
          workflow_name: "f",
          branch: "b",
          priority: 2,
        }),
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
  assert.deepEqual(await appliedMigrations(first), [
    "0001_baseline",
    "0002_task_sessions",
    "0003_review_records",
    "0004_step_outputs_last_names",
    "0005_rate_limited",
    "0006_step_run_bounced",
    "0007_step_run_permission_denials",
    "0008_step_run_drop_degraded",
    "0009_intake",
    "0010_intake_revision",
    "0011_task_workflow_pin",
    "0012_intake_assumptions",
  ]);
  await first.destroy();

  const second = await openDb(path);
  try {
    assert.deepEqual(await appliedMigrations(second), [
      "0001_baseline",
      "0002_task_sessions",
      "0003_review_records",
      "0004_step_outputs_last_names",
      "0005_rate_limited",
      "0006_step_run_bounced",
      "0007_step_run_permission_denials",
      "0008_step_run_drop_degraded",
      "0009_intake",
      "0010_intake_revision",
      "0011_task_workflow_pin",
      "0012_intake_assumptions",
    ]);
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
    assert.deepEqual(await appliedMigrations(d), [
      "0001_baseline",
      "0002_task_sessions",
      "0003_review_records",
      "0004_step_outputs_last_names",
      "0005_rate_limited",
      "0006_step_run_bounced",
      "0007_step_run_permission_denials",
      "0008_step_run_drop_degraded",
      "0009_intake",
      "0010_intake_revision",
      "0011_task_workflow_pin",
      "0012_intake_assumptions",
    ]);
    const old = await getTask(d, "old");
    assert.equal(old?.state, "suspended", "既存の行は残る");
    assert.equal(old?.pending_feed, null, "列が足されていて、読める");
    await d.updateTable("tasks").set({ pending_feed: "feed" }).where("id", "=", "old").execute();
    assert.equal((await getTask(d, "old"))?.pending_feed, "feed", "書ける");
  } finally {
    await d.destroy();
  }
});

test('claude_session_id を持つ既存タスクは role "default" として task_sessions に移される', async () => {
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
    assert.deepEqual(
      rows.map((r) => ({ task_id: r.task_id, role: r.role, session_id: r.session_id })),
      [{ task_id: "old", role: "default", session_id: "sess-1" }],
    );
  } finally {
    await d.destroy();
  }
});

test("degraded だった既存の step_run は success になる", async () => {
  const path = await tempDbPath();
  const legacy = new DatabaseSync(path);
  legacy.exec(LEGACY_DDL);
  legacy.prepare("INSERT INTO projects (path, default_workflow) VALUES ('/repo', 'feature')").run();
  legacy.prepare(
    `INSERT INTO tasks (id, project_id, title, prompt, workflow_name, state, branch, created_at, updated_at)
     VALUES ('old', 1, 'T', 'P', 'feature', 'completed', 'b', 'x', 'x')`,
  ).run();
  legacy.prepare(
    `INSERT INTO step_runs (task_id, step_id, attempt, status, started_at, log_path)
     VALUES ('old', 'plan', 1, 'degraded', 'x', '')`,
  ).run();
  legacy.close();

  const d = await openDb(path);
  try {
    const rows = await d.selectFrom("step_runs").selectAll().where("task_id", "=", "old").execute();
    assert.deepEqual(rows.map((r) => r.status), ["success"]);
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
        assert.deepEqual(
          await columnsOf(migrated, table),
          await columnsOf(fresh, table),
          `${table} の形が違う`,
        );
      }
    } finally {
      await migrated.destroy();
      await fresh.destroy();
    }
  }
});

test("step_runs は awaiting と interrupted を受け付ける", async () => {
  const d = await db();
  const pid = await seed(d);
  await insertTask(d, {
    id: "t1",
    project_id: pid,
    title: "T",
    prompt: "P",
    workflow_name: "feature",
    branch: "b",
    priority: 2,
  });
  for (const status of ["awaiting", "interrupted"] as const) {
    await d.insertInto("step_runs").values({
      task_id: "t1",
      step_id: "review",
      attempt: 1,
      status,
      exit_code: null,
      started_at: "2026-09-18T00:00:00.000Z",
      ended_at: null,
      log_path: "",
      review_tree: null,
      goto_step_id: null,
    }).execute();
  }
  const rows = await d.selectFrom("step_runs").select("status").where("task_id", "=", "t1")
    .execute();
  assert.deepEqual(rows.map((r) => r.status).sort(), ["awaiting", "interrupted"]);
});

test("未知の status と、もう使わない degraded は CHECK 制約で落ちる", async () => {
  const d = await db();
  const pid = await seed(d);
  await insertTask(d, {
    id: "t1",
    project_id: pid,
    title: "T",
    prompt: "P",
    workflow_name: "feature",
    branch: "b",
    priority: 2,
  });
  for (const status of ["bogus", "degraded"]) {
    await assert.rejects(
      () =>
        d.insertInto("step_runs").values({
          task_id: "t1",
          step_id: "review",
          attempt: 1,
          // deno-lint-ignore no-explicit-any
          status: status as any,
          exit_code: null,
          started_at: "2026-09-18T00:00:00.000Z",
          ended_at: null,
          log_path: "",
          review_tree: null,
          goto_step_id: null,
        }).execute(),
      Error,
      status,
    );
  }
});

test("step_runs は bounced を受け付け、差し戻し先を goto_step_id に持つ", async () => {
  const d = await db();
  const pid = await seed(d);
  await insertTask(d, {
    id: "t1",
    project_id: pid,
    title: "T",
    prompt: "P",
    workflow_name: "feature",
    branch: "b",
    priority: 2,
  });
  await d.insertInto("step_runs").values({
    task_id: "t1",
    step_id: "plan-gate",
    attempt: 1,
    status: "bounced",
    exit_code: 1,
    started_at: "2026-09-19T00:00:00.000Z",
    ended_at: "2026-09-19T00:01:00.000Z",
    log_path: "",
    review_tree: null,
    goto_step_id: "plan",
  }).execute();
  const rows = await d.selectFrom("step_runs").selectAll().where("task_id", "=", "t1").execute();
  assert.equal(rows[0].status, "bounced");
  assert.equal(rows[0].goto_step_id, "plan");
});

test("bounced と goto_step_id の対応は CHECK 制約で固定されている", async () => {
  const d = await db();
  const pid = await seed(d);
  await insertTask(d, {
    id: "t1",
    project_id: pid,
    title: "T",
    prompt: "P",
    workflow_name: "feature",
    branch: "b",
    priority: 2,
  });
  const row = {
    task_id: "t1",
    step_id: "plan-gate",
    attempt: 1,
    exit_code: 1,
    started_at: "2026-09-19T00:00:00.000Z",
    ended_at: "2026-09-19T00:01:00.000Z",
    log_path: "",
    review_tree: null,
  };
  // 分岐先の無い差し戻し
  await assert.rejects(
    () =>
      d.insertInto("step_runs").values({ ...row, status: "bounced", goto_step_id: null })
        .execute(),
    /CHECK/,
  );
  // 分岐先のある失敗
  await assert.rejects(
    () =>
      d.insertInto("step_runs").values({ ...row, status: "failed", goto_step_id: "plan" })
        .execute(),
    /CHECK/,
  );
});

test("0005: step_outputs の行は step_runs の再構築を越えて残る", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(LEGACY_DDL);
  sqlite.exec(`
    INSERT INTO projects (path, default_workflow) VALUES ('/repo', 'f');
    INSERT INTO tasks (id, project_id, title, prompt, workflow_name, state, branch,
                       created_at, updated_at)
      VALUES ('t1', 1, 'T', 'P', 'f', 'running', 'b', '2026-09-19', '2026-09-19');
    INSERT INTO step_runs (id, task_id, step_id, attempt, status, started_at, log_path)
      VALUES (1, 't1', 'plan', 1, 'success', '2026-09-19', '');
    INSERT INTO step_outputs (task_id, step_id, stdout, stderr, exit_code)
      VALUES ('t1', 'plan', '計画', '', 0);
  `);
  const d = await openDbOn(sqlite);

  const rows = await d.selectFrom("step_outputs").selectAll().execute();
  assert.deepEqual(rows.map((r) => ({ ...r })), [
    { step_run_id: 1, last_stdout: "計画", last_stderr: "", exit_code: 0 },
  ]);
  const { rows: violations } = await sql<{ table: string }>`PRAGMA foreign_key_check`.execute(d);
  assert.deepEqual(violations, []);
});

test("既存の step_outputs は同じステップの最新の実行に割り当てられる", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(LEGACY_DDL);
  sqlite.exec(`
    INSERT INTO projects (path, default_workflow) VALUES ('/repo', 'f');
    INSERT INTO tasks (id, project_id, title, prompt, workflow_name, state, branch,
                       created_at, updated_at)
      VALUES ('t1', 1, 'T', 'P', 'f', 'running', 'b', '2026-09-18T00:00:00.000Z',
              '2026-09-18T00:00:00.000Z');
    INSERT INTO step_runs (id, task_id, step_id, attempt, status, started_at, log_path)
      VALUES (1, 't1', 'review', 1, 'failed', '2026-09-18T00:00:00.000Z', '');
    INSERT INTO step_runs (id, task_id, step_id, attempt, status, started_at, log_path)
      VALUES (2, 't1', 'review', 2, 'failed', '2026-09-18T00:01:00.000Z', '');
    INSERT INTO step_outputs (task_id, step_id, stdout, stderr, exit_code)
      VALUES ('t1', 'review', '2回目のコメント', '', 1);
    INSERT INTO step_outputs (task_id, step_id, stdout, stderr, exit_code)
      VALUES ('t1', 'gone', '対応する実行が無い', '', 0);
  `);
  const d = await openDbOn(sqlite);
  const rows = await d.selectFrom("step_outputs").selectAll().execute();
  // node:sqlite が返す行は prototype なしのオブジェクトなので、deepEqual の前に
  // 素のオブジェクトへ写す（他のテストの selectAll 結果比較と同じ理由）。
  assert.deepEqual(rows.map((r) => ({ ...r })), [
    { step_run_id: 2, last_stdout: "2回目のコメント", last_stderr: "", exit_code: 1 },
  ]);
});

test("移行時点で suspended のタスクには awaiting 行が立ち、attempt_counts が進む", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(LEGACY_DDL);
  sqlite.exec(`
    INSERT INTO projects (path, default_workflow) VALUES ('/repo', 'f');
    INSERT INTO tasks (id, project_id, title, prompt, workflow_name, state, current_step_id,
                       attempt_counts, branch, created_at, updated_at)
      VALUES ('t1', 1, 'T', 'P', 'f', 'suspended', 'review', '{"implement":1}', 'b',
              '2026-09-18T00:00:00.000Z', '2026-09-18T09:00:00.000Z');
  `);
  const d = await openDbOn(sqlite);
  const runs = await d.selectFrom("step_runs").selectAll().where("task_id", "=", "t1").execute();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "awaiting");
  assert.equal(runs[0].step_id, "review");
  assert.equal(runs[0].attempt, 1);
  assert.equal(runs[0].started_at, "2026-09-18T09:00:00.000Z");
  assert.equal(runs[0].ended_at, null);
  assert.equal(runs[0].review_tree, null);
  const t = (await getTask(d, "t1"))!;
  assert.equal(t.attempt_counts, JSON.stringify({ implement: 1, review: 1 }));
});

test("移行前に一度差し戻されている suspended タスクの awaiting 行は attempt 2 になる", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(LEGACY_DDL);
  // 1回目のレビューで差し戻され、implement をやり直して再び review で待っている DB。
  // 旧コードは決定時にしか attempt を進めないので、既存の step_run は1件だけある。
  sqlite.exec(`
    INSERT INTO projects (path, default_workflow) VALUES ('/repo', 'f');
    INSERT INTO tasks (id, project_id, title, prompt, workflow_name, state, current_step_id,
                       attempt_counts, branch, created_at, updated_at)
      VALUES ('t1', 1, 'T', 'P', 'f', 'suspended', 'review', '{"implement":2,"review":1}', 'b',
              '2026-09-18T00:00:00.000Z', '2026-09-18T09:00:00.000Z');
    INSERT INTO step_runs (id, task_id, step_id, attempt, status, started_at, ended_at, log_path)
      VALUES (1, 't1', 'review', 1, 'failed', '2026-09-18T01:00:00.000Z',
              '2026-09-18T02:00:00.000Z', '');
  `);
  const d = await openDbOn(sqlite);

  const runs = await d.selectFrom("step_runs").selectAll().where("task_id", "=", "t1")
    .orderBy("id").execute();
  assert.equal(runs.length, 2, "既存の行は残り、今待っている回のぶんが1行足される");
  assert.equal(runs[1].status, "awaiting");
  assert.equal(runs[1].attempt, 2, "既存の step_run 数 + 1");
  assert.equal(runs[1].started_at, "2026-09-18T09:00:00.000Z");
  const t = (await getTask(d, "t1"))!;
  assert.equal(
    t.attempt_counts,
    JSON.stringify({ implement: 2, review: 2 }),
    "attempt_counts は step_runs.attempt とちょうど一致する",
  );
});

/**
 * 0005 は tasks と step_runs を作り直す。tasks を DROP する時点で step_runs /
 * step_outputs / task_sessions が tasks.id を参照する行を持っているのが本番の姿なので、
 * フィクスチャには4テーブルすべてに行を入れる（行が無ければ defer_foreign_keys の
 * 効果を検証したことにならない）。
 */
function legacyWithChildren(): DatabaseSync {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(LEGACY_DDL);
  sqlite.exec(`
    INSERT INTO projects (path, default_workflow) VALUES ('/repo', 'f');
    INSERT INTO tasks (id, project_id, title, prompt, workflow_name, state, current_step_id,
                       attempt_counts, branch, claude_session_id, pending_feed,
                       created_at, updated_at)
      VALUES ('t1', 1, 'T', 'P', 'f', 'running', 'implement', '{"implement":1}', 'b',
              'sess-1', '直して', '2026-09-19T00:00:00.000Z', '2026-09-19T01:00:00.000Z');
    INSERT INTO step_runs (id, task_id, step_id, attempt, status, exit_code, started_at,
                           ended_at, log_path)
      VALUES (1, 't1', 'implement', 1, 'failed', 1, '2026-09-19T00:00:00.000Z',
              '2026-09-19T00:30:00.000Z', '/logs/implement.1.log');
    INSERT INTO step_outputs (task_id, step_id, stdout, stderr, exit_code)
      VALUES ('t1', 'implement', 'out', 'err', 1);
    INSERT INTO rate_limit_samples (observed_at, window, utilization, resets_at)
      VALUES ('2026-09-19T00:10:00.000Z', 'five_hour', 1, '2026-09-19T03:20:00.000Z');
  `);
  return sqlite;
}

test("0005: tasks と step_runs を作り直しても、全テーブルの行がそのまま残る", async () => {
  const d = await openDbOn(legacyWithChildren());

  const t = (await getTask(d, "t1"))!;
  assert.equal(t.state, "running");
  assert.equal(t.current_step_id, "implement");
  assert.equal(t.attempt_counts, '{"implement":1}');
  assert.equal(t.pending_feed, "直して");
  assert.equal(t.claude_session_id, "sess-1");
  assert.equal(t.rate_limited_until, null, "新しい列は NULL で足される");

  const runs = await d.selectFrom("step_runs").selectAll().execute();
  assert.deepEqual(runs.map((r) => [r.id, r.step_id, r.status, r.log_path]), [[
    1,
    "implement",
    "failed",
    "/logs/implement.1.log",
  ]], "id を含めて残る（step_outputs の参照先）");

  const outputs = await d.selectFrom("step_outputs").selectAll().execute();
  assert.deepEqual(outputs.map((o) => [o.step_run_id, o.last_stdout]), [[1, "out"]]);

  const sessions = await d.selectFrom("task_sessions").selectAll().execute();
  assert.deepEqual(sessions.map((s) => [s.task_id, s.role, s.session_id]), [[
    "t1",
    "default",
    "sess-1",
  ]]);

  const samples = await d.selectFrom("rate_limit_samples").selectAll().execute();
  assert.deepEqual(samples.map((s) => [s.window, s.utilization, s.resets_at]), [[
    "five_hour",
    1,
    "2026-09-19T03:20:00.000Z",
  ]], "rate_limit_samples には触っていない");

  const violations = await sql<{ table: string }>`PRAGMA foreign_key_check`.execute(d);
  assert.deepEqual(violations.rows, [], "外部キーが壊れていない");
});

test("0005: 再構築した tasks / step_runs の索引が残っている", async () => {
  const d = await openDbOn(legacyWithChildren());
  const { rows } = await sql<{ name: string }>`
    SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name
  `.execute(d);
  assert.deepEqual(rows.map((r) => r.name), [
    "idx_step_runs_task",
    "idx_tasks_project",
    "idx_tasks_state",
  ]);
});

test("0005: tasks.state は rate_limited を受け付け、未知の値は CHECK で落ちる", async () => {
  const d = await db();
  const pid = await seed(d);
  await insertTask(d, {
    id: "t1",
    project_id: pid,
    title: "T",
    prompt: "P",
    workflow_name: "feature",
    branch: "b",
    priority: 2,
  });
  await d.updateTable("tasks")
    .set({ state: "rate_limited", rate_limited_until: "2026-09-19T03:20:00.000Z" })
    .where("id", "=", "t1").execute();
  const t = (await getTask(d, "t1"))!;
  assert.equal(t.state, "rate_limited");
  assert.equal(t.rate_limited_until, "2026-09-19T03:20:00.000Z");

  await assert.rejects(() =>
    d.updateTable("tasks")
      // deno-lint-ignore no-explicit-any
      .set({ state: "bogus" as any }).where("id", "=", "t1").execute()
  );
});

test("0005: step_runs.status は rate_limited を受け付ける", async () => {
  const d = await db();
  const pid = await seed(d);
  await insertTask(d, {
    id: "t1",
    project_id: pid,
    title: "T",
    prompt: "P",
    workflow_name: "feature",
    branch: "b",
    priority: 2,
  });
  await d.insertInto("step_runs").values({
    task_id: "t1",
    step_id: "implement",
    attempt: 1,
    status: "rate_limited",
    exit_code: 1,
    started_at: "2026-09-19T00:00:00.000Z",
    ended_at: "2026-09-19T00:00:10.000Z",
    log_path: "",
    review_tree: null,
  }).execute();
  const rows = await d.selectFrom("step_runs").select("status").execute();
  assert.deepEqual(rows.map((r) => r.status), ["rate_limited"]);
});

test("0004: step_outputs の列が last_stdout / last_stderr に改名され、値は残る", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(LEGACY_DDL);
  sqlite.exec(`
    INSERT INTO projects (path, default_workflow) VALUES ('/repo', 'f');
    INSERT INTO tasks (id, project_id, title, prompt, workflow_name, state, branch,
                       created_at, updated_at)
      VALUES ('t1', 1, 'T', 'P', 'f', 'suspended', 'b', '2026-09-19', '2026-09-19');
    INSERT INTO step_runs (id, task_id, step_id, attempt, status, started_at, log_path)
      VALUES (1, 't1', 'review', 1, 'failed', '2026-09-19', '');
    INSERT INTO step_outputs (task_id, step_id, stdout, stderr, exit_code)
      VALUES ('t1', 'review', '直して', 'warn', 1);
  `);
  const d = await openDbOn(sqlite);

  const rows = await d.selectFrom("step_outputs").selectAll().execute();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].last_stdout, "直して");
  assert.equal(rows[0].last_stderr, "warn");
  assert.equal(rows[0].exit_code, 1);
});

function insertIntakeRow(
  d: Db,
  projectId: number,
  id: string,
  issueUrl: string,
  state: Database["intakes"]["state"] = "investigating",
) {
  return d.insertInto("intakes").values({
    id,
    project_id: projectId,
    issue_url: issueUrl,
    issue_node_id: `I_${id}`,
    issue_title: "T",
    state,
    created_at: "2026-09-21T00:00:00.000Z",
    updated_at: "2026-09-21T00:00:00.000Z",
  }).execute();
}

function newTask(id: string) {
  return {
    id,
    title: "T",
    prompt: "P",
    workflow_name: "feature",
    branch: `doctrine/${id}`,
    priority: 2,
  };
}

test("0009: tasks の intake_id と intake_process_id は両方 null か両方非 null でなければならない", async () => {
  const d = await db();
  const pid = await seed(d);
  await insertIntakeRow(d, pid, "i1", "https://github.com/o/r/issues/1");

  await assert.rejects(
    () => insertTask(d, { ...newTask("t1"), project_id: pid, intake_id: "i1" }),
    /CHECK/,
  );
  await assert.rejects(
    () => insertTask(d, { ...newTask("t2"), project_id: pid, intake_process_id: "p1" }),
    /CHECK/,
  );

  const linked = await insertTask(d, {
    ...newTask("t3"),
    project_id: pid,
    intake_id: "i1",
    intake_process_id: "p1",
    issue_url: "https://github.com/o/r/issues/2",
    parent_issue_url: "https://github.com/o/r/issues/1",
  });
  assert.equal(linked.intake_id, "i1");
  assert.equal(linked.intake_process_id, "p1");
  assert.equal(linked.issue_url, "https://github.com/o/r/issues/2");
  assert.equal(linked.parent_issue_url, "https://github.com/o/r/issues/1");

  const plain = await insertTask(d, { ...newTask("t4"), project_id: pid });
  assert.equal(plain.intake_id, null);
  assert.equal(plain.intake_process_id, null);
  assert.equal(plain.issue_url, null);
  assert.equal(plain.parent_issue_url, null);
});

test("0009: tasks.intake_id は存在しない Intake を指せない", async () => {
  const d = await db();
  const pid = await seed(d);
  await assert.rejects(
    () =>
      insertTask(d, {
        ...newTask("t1"),
        project_id: pid,
        intake_id: "nope",
        intake_process_id: "p1",
      }),
    /FOREIGN KEY/,
  );
});

test("0009: 移行前からあるタスクは紐づけ列が null のまま残る", async () => {
  const d = await openDbOn(legacyWithChildren());
  const t = (await getTask(d, "t1"))!;
  assert.equal(t.state, "running");
  assert.equal(t.current_step_id, "implement");
  assert.equal(t.intake_id, null);
  assert.equal(t.intake_process_id, null);
  assert.equal(t.issue_url, null);
  assert.equal(t.parent_issue_url, null);

  const violations = await sql<{ table: string }>`PRAGMA foreign_key_check`.execute(d);
  assert.deepEqual(violations.rows, [], "外部キーが壊れていない");
});

test("0009: 終わっていない Intake は同じ Issue に 1 つだけ", async () => {
  const d = await db();
  const pid = await seed(d);
  const url = "https://github.com/o/r/issues/1";
  await insertIntakeRow(d, pid, "i1", url);
  await assert.rejects(() => insertIntakeRow(d, pid, "i2", url), /UNIQUE/);

  await d.updateTable("intakes").set({ state: "canceled" }).where("id", "=", "i1").execute();
  await insertIntakeRow(d, pid, "i2", url);

  await d.updateTable("intakes").set({ state: "completed" }).where("id", "=", "i2").execute();
  await insertIntakeRow(d, pid, "i3", url);

  await insertIntakeRow(d, pid, "i4", "https://github.com/o/r/issues/2");
  const open = await d.selectFrom("intakes").select("id")
    .where("state", "not in", ["completed", "canceled"]).orderBy("id").execute();
  assert.deepEqual(open.map((r) => r.id), ["i3", "i4"]);
});

test("0009: intakes.state は 8 値だけを受け付ける", async () => {
  const d = await db();
  const pid = await seed(d);
  await insertIntakeRow(d, pid, "i1", "https://github.com/o/r/issues/1");
  for (
    const state of [
      "investigating",
      "answering",
      "decomposing",
      "reviewing",
      "active",
      "needs_attention",
      "completed",
      "canceled",
    ] as const
  ) {
    await d.updateTable("intakes").set({ state }).where("id", "=", "i1").execute();
    assert.equal(
      (await d.selectFrom("intakes").select("state").executeTakeFirstOrThrow()).state,
      state,
    );
  }
  await assert.rejects(
    () =>
      d.updateTable("intakes")
        // deno-lint-ignore no-explicit-any
        .set({ state: "bogus" as any }).where("id", "=", "i1").execute(),
    /CHECK/,
  );
});

test("0009: intake_runs の purpose と status は CHECK で固められている", async () => {
  const d = await db();
  const pid = await seed(d);
  await insertIntakeRow(d, pid, "i1", "https://github.com/o/r/issues/1");
  const run = { intake_id: "i1", attempt: 1, log_path: "" };
  await d.insertInto("intake_runs").values({ ...run, purpose: "investigate", status: "queued" })
    .execute();
  await assert.rejects(
    () =>
      d.insertInto("intake_runs")
        // deno-lint-ignore no-explicit-any
        .values({ ...run, purpose: "bogus" as any, status: "queued" }).execute(),
    /CHECK/,
  );
  await assert.rejects(
    () =>
      d.insertInto("intake_runs")
        // deno-lint-ignore no-explicit-any
        .values({ ...run, purpose: "decompose", status: "bogus" as any }).execute(),
    /CHECK/,
  );
});

test("0010: 改訂の範囲の列は null で足される", async () => {
  const d = await db();
  const pid = await seed(d);
  await insertIntakeRow(d, pid, "i1", "https://github.com/o/r/issues/1");
  const run = await d.insertInto("intake_runs")
    .values({ intake_id: "i1", attempt: 1, log_path: "", purpose: "decompose", status: "queued" })
    .executeTakeFirstOrThrow();
  const runId = Number(run.insertId);
  const draft = await d.insertInto("intake_drafts")
    .values({
      intake_id: "i1",
      seq: 1,
      run_id: runId,
      pfd: "{}",
      hash: "h",
      replies: "[]",
      created_at: "2026-09-21T00:00:00.000Z",
    })
    .executeTakeFirstOrThrow();
  await d.insertInto("intake_comments")
    .values({
      intake_id: "i1",
      draft_id: Number(draft.insertId),
      target_kind: "whole",
      target_id: null,
      body: "b",
      created_at: "2026-09-21T00:00:00.000Z",
    })
    .execute();

  const intake = await d.selectFrom("intakes").selectAll().executeTakeFirstOrThrow();
  assert.equal(intake.revision_run_id, null);
  const comment = await d.selectFrom("intake_comments").selectAll().executeTakeFirstOrThrow();
  assert.equal(comment.run_id, null);

  await d.updateTable("intakes").set({ revision_run_id: runId }).execute();
  await d.updateTable("intake_comments").set({ run_id: runId }).execute();
  assert.equal(
    (await d.selectFrom("intakes").select("revision_run_id").executeTakeFirstOrThrow())
      .revision_run_id,
    runId,
  );
  await assert.rejects(
    () => d.updateTable("intakes").set({ revision_run_id: 999 }).execute(),
    /FOREIGN KEY/,
  );
});

test("0011: 移行前からあるタスクは作成時の定義の列が NULL のまま残る", async () => {
  const d = await openDbOn(legacyWithChildren());
  const t = (await getTask(d, "t1"))!;
  assert.equal(t.workflow_yaml, null);
  assert.equal(t.workflow_setup, null);

  const violations = await sql<{ table: string }>`PRAGMA foreign_key_check`.execute(d);
  assert.deepEqual(violations.rows, [], "外部キーが壊れていない");
});

test("0011: insertTask は作成時の定義を書き戻せる", async () => {
  const d = await db();
  const pid = await seed(d);
  await insertTask(d, {
    ...newTask("t1"),
    project_id: pid,
    workflow_yaml: "name: x\n",
    workflow_setup: "echo hi",
  });
  const t1 = (await getTask(d, "t1"))!;
  assert.equal(t1.workflow_yaml, "name: x\n");
  assert.equal(t1.workflow_setup, "echo hi");

  await insertTask(d, { ...newTask("t2"), project_id: pid });
  const t2 = (await getTask(d, "t2"))!;
  assert.equal(t2.workflow_yaml, null);
  assert.equal(t2.workflow_setup, null);
});
