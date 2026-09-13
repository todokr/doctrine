# ステップ間の成果物受け渡し Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 役割単位のセッション（`agent` ステップの `session: <role>`）と、worktree 内ファイル
（`.doctrine-out/`）によるステップ間の成果物受け渡しを実装する。

**Architecture:** `tasks.claude_session_id`（単一列）を `task_sessions(task_id, role, session_id)`
テーブルに置き換え、`agent` ステップに `session?: string`（省略時は暗黙の既定ロール）を追加する。
`createWorktree` は `.git/info/exclude` へ `.doctrine-out/` を自動で追記し、この規約に沿った
中間成果物を git の視界（`git status` / `task.diff` の write-tree）から外す。

**Tech Stack:** Deno、TypeScript、Kysely（SQLite / `node:sqlite`）、Zod、`deno test`（`@std/testing/bdd`）

**Spec:** [docs/superpowers/specs/2026-09-13-step-artifacts-design.md](../specs/2026-09-13-step-artifacts-design.md)

## Global Constraints

- 一度コミットしたマイグレーションは書き換えない。変更は新しい番号（`0002_task_sessions`）で足す
- `tasks.claude_session_id` 列は残す（削除しない）。コードから参照しなくなるだけ
- `.doctrine-out/` はプロジェクトの `.gitignore` を書き換えて除外しない。`.git/info/exclude`
  （リポジトリのローカル設定、共有 `.git` ディレクトリ内、コミットされない）に追記する
- `session` を省略した既存のワークフロー（`project-add` の scaffold 含む）は無変更で動く
  （暗黙の既定ロール1つを共有する、今までと同じ挙動）
- `step_runs.status` に `interrupted` を足す既知の制約はこの変更に含めない

---

## Task 1: `task_sessions` テーブルを追加するマイグレーション

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/db/migrations.ts`
- Modify: `test/db/migrate.test.ts`

**Interfaces:**
- Produces: `Database["task_sessions"]`（型 `TaskSessionsTable = { task_id: string; role: string; session_id: string }`）。
  Task 2・Task 4 がこの型に対してクエリを書く

- [ ] **Step 1: 失敗するテストを書く**

`test/db/migrate.test.ts` の既存の「マイグレーションで5つのテーブルができる」テストを
6つに直し、`COLUMNS` に `task_sessions` を足し、バックフィルの新しいテストを追加する。

`const names = rows.map((r) => r.name);` を含むテストを次に置き換える:

```ts
test("マイグレーションで6つのテーブルができる", async () => {
  const d = await db();
  const { rows } = await sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`
    .execute(d);
  const names = rows.map((r) => r.name);
  for (const t of ["projects", "rate_limit_samples", "step_outputs", "step_runs", "task_sessions", "tasks"]) {
    assert.ok(names.includes(t), `${t} が無い: ${names.join(",")}`);
  }
});
```

`COLUMNS` の `step_outputs` の行の直後に足す:

```ts
  task_sessions: { task_id: true, role: true, session_id: true },
```

`test("pending_feed を足す前に作られたDBファイルは...")` テストの直後（同じファイル内、
`test("手書き DDL 時代のDBを移行した形は...")` テストより前）に新しいテストを足す:

```ts
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
    assert.deepEqual(rows, [{ task_id: "old", role: "default", session_id: "sess-1" }]);
  } finally {
    await d.destroy();
  }
});
```

- [ ] **Step 2: schema.ts に型を足す（テストのコンパイルを通すため）**

`src/db/schema.ts` の `TasksTable` の直後（`StepRunsTable` の手前）に足す:

```ts
export interface TaskSessionsTable {
  task_id: string;
  role: string;
  session_id: string;
}
```

`Database` インターフェースの `step_outputs` の行の直後に足す:

```ts
  task_sessions: TaskSessionsTable;
```

- [ ] **Step 3: テストを実行して失敗を確認する**

Run: `deno test --allow-all test/db/migrate.test.ts`
Expected: FAIL（`task_sessions` テーブルが無い、`SqliteError: no such table: task_sessions`）

- [ ] **Step 4: マイグレーションを実装する**

`src/db/migrations.ts` の `migrations` オブジェクトに、`"0001_baseline"` の直後（オブジェクトの
最後）に新しいキーを足す:

```ts
  "0002_task_sessions": {
    // deno-lint-ignore no-explicit-any
    async up(db: Kysely<any>) {
      await db.schema.createTable("task_sessions").ifNotExists()
        .addColumn("task_id", "text", (c) => c.notNull().references("tasks.id"))
        .addColumn("role", "text", (c) => c.notNull())
        .addColumn("session_id", "text", (c) => c.notNull())
        .addPrimaryKeyConstraint("task_sessions_pk", ["task_id", "role"])
        .execute();

      // 既存の tasks.claude_session_id を role "default" として移す。
      // 列自体はここでは消さない（コードから参照しなくなるだけ、spec 5章）。
      await sql`
        INSERT INTO task_sessions (task_id, role, session_id)
        SELECT id, 'default', claude_session_id FROM tasks WHERE claude_session_id IS NOT NULL
      `.execute(db);
    },
  },
```

- [ ] **Step 5: テストを実行して成功を確認する**

Run: `deno test --allow-all test/db/migrate.test.ts`
Expected: PASS（全テスト）

- [ ] **Step 6: コミット**

```bash
git add src/db/schema.ts src/db/migrations.ts test/db/migrate.test.ts
git commit -m "feat: task_sessions テーブルを追加し claude_session_id を役割 default へ移す"
```

---

## Task 2: `task_sessions` の読み書き（`getSessionId` と `sessionUpsert`）

**Files:**
- Create: `src/db/sessions.ts`
- Modify: `src/db/boundary.ts`
- Create: `test/db/sessions.test.ts`

**Interfaces:**
- Consumes: `Database["task_sessions"]`（Task 1）、`commitStepBoundary(db, StepBoundary)`（既存、
  `src/db/boundary.ts`）
- Produces:
  - `getSessionId(db: Db, taskId: string, role: string): Promise<string | undefined>`
  - `StepBoundary.sessionUpsert?: { role: string; session_id: string }`
    — Task 4（`engine.ts`）がこれを使ってステップ開始時にセッションを記録する

- [ ] **Step 1: 失敗するテストを書く**

`test/db/sessions.test.ts` を新規作成する:

```ts
import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { openDb } from "../../src/db/migrate.ts";
import { insertProject, insertTask } from "../../src/db/tasks.ts";
import { commitStepBoundary } from "../../src/db/boundary.ts";
import { getSessionId } from "../../src/db/sessions.ts";
import type { Db } from "../../src/db/schema.ts";

async function fixture(): Promise<Db> {
  const d = await openDb(":memory:");
  const pid = await insertProject(d, {
    path: "/repo", default_workflow: "f", max_concurrent: 1, base_branch: "main", setup: null,
  });
  await insertTask(d, { id: "t1", project_id: pid, title: "T", prompt: "P", workflow_name: "f", branch: "b", priority: 2 });
  return d;
}

test("セッションが無いロールは undefined", async () => {
  const d = await fixture();
  assert.equal(await getSessionId(d, "t1", "planner"), undefined);
});

test("commitStepBoundary の sessionUpsert で書いたセッションが引ける", async () => {
  const d = await fixture();
  await commitStepBoundary(d, { taskId: "t1", taskPatch: {}, sessionUpsert: { role: "planner", session_id: "s1" } });
  assert.equal(await getSessionId(d, "t1", "planner"), "s1");
});

test("同じロールへの2度目の sessionUpsert は上書きする", async () => {
  const d = await fixture();
  await commitStepBoundary(d, { taskId: "t1", taskPatch: {}, sessionUpsert: { role: "planner", session_id: "s1" } });
  await commitStepBoundary(d, { taskId: "t1", taskPatch: {}, sessionUpsert: { role: "planner", session_id: "s2" } });
  assert.equal(await getSessionId(d, "t1", "planner"), "s2");
});

test("ロールが違えば別のセッションとして残る", async () => {
  const d = await fixture();
  await commitStepBoundary(d, { taskId: "t1", taskPatch: {}, sessionUpsert: { role: "planner", session_id: "s1" } });
  await commitStepBoundary(d, { taskId: "t1", taskPatch: {}, sessionUpsert: { role: "implementer", session_id: "s2" } });
  assert.equal(await getSessionId(d, "t1", "planner"), "s1");
  assert.equal(await getSessionId(d, "t1", "implementer"), "s2");
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `deno test --allow-all test/db/sessions.test.ts`
Expected: FAIL（`src/db/sessions.ts` が無い、`sessionUpsert` が `StepBoundary` に無いため型検査で落ちる）

- [ ] **Step 3: `boundary.ts` に `sessionUpsert` を実装する**

`src/db/boundary.ts` の `StepBoundary` 型に、`outputs` フィールドの直前（`stepRunUpdate` の
直後）にフィールドを足す:

```ts
  /** ステップ開始時（agent ステップのみ）: そのロールのセッションを記録する。 */
  sessionUpsert?: { role: string; session_id: string };
```

`commitStepBoundary` 内、`if (b.stepRunUpdate) { ... }` ブロックの直後・`if (b.outputs)` の
直前に足す:

```ts
    if (b.sessionUpsert) {
      const s = b.sessionUpsert;
      await trx.insertInto("task_sessions")
        .values({ task_id: b.taskId, role: s.role, session_id: s.session_id })
        .onConflict((oc) => oc.columns(["task_id", "role"]).doUpdateSet((eb) => ({
          session_id: eb.ref("excluded.session_id"),
        })))
        .execute();
    }
```

- [ ] **Step 4: `src/db/sessions.ts` を実装する**

```ts
import type { Db } from "./schema.ts";

/**
 * タスクのロール別セッションIDを引く。無ければ undefined
 * （そのロールではまだ agent ステップが start していない）。
 */
export async function getSessionId(db: Db, taskId: string, role: string): Promise<string | undefined> {
  const row = await db.selectFrom("task_sessions").select("session_id")
    .where("task_id", "=", taskId).where("role", "=", role)
    .executeTakeFirst();
  return row?.session_id;
}
```

- [ ] **Step 5: テストを実行して成功を確認する**

Run: `deno test --allow-all test/db/sessions.test.ts test/db/boundary.test.ts`
Expected: PASS（全テスト。`boundary.test.ts` は既存のテストが壊れていないことの確認）

- [ ] **Step 6: コミット**

```bash
git add src/db/sessions.ts src/db/boundary.ts test/db/sessions.test.ts
git commit -m "feat: task_sessions の読み書き（getSessionId / sessionUpsert）を足す"
```

---

## Task 3: ワークフロースキーマに `agent` ステップの `session` を追加

**Files:**
- Modify: `src/workflow/schema.ts`
- Modify: `test/workflow/schema.test.ts`

**Interfaces:**
- Produces: `AgentStep.session?: string`（Task 4 が `step.session ?? "default"` として読む）

- [ ] **Step 1: 失敗するテストを書く**

`test/workflow/schema.test.ts` の先頭 import に `AgentStep` を足す:

```ts
import { parseWorkflow, WorkflowValidationError, type CommandStep, type AgentStep } from "../../src/workflow/schema.ts";
```

ファイル末尾に足す:

```ts
test("agent ステップの session を読める", () => {
  const yaml = `
name: roles
steps:
  - id: plan
    type: agent
    session: planner
    prompt: "計画してください"
  - id: review
    type: approval
    title: "確認してください"
`;
  const { workflow } = parseWorkflow(yaml);
  assert.equal((workflow.steps[0] as AgentStep).session, "planner");
});

test("session を省略した agent ステップは undefined のまま", () => {
  const { workflow } = parseWorkflow(VALID);
  assert.equal((workflow.steps[0] as AgentStep).session, undefined);
});

test("session に使えない文字は日本語で案内する", () => {
  const yaml = `
name: bad
steps:
  - id: plan
    type: agent
    session: "plan ner"
    prompt: "x"
`;
  assert.throws(() => parseWorkflow(yaml), (e: unknown) => {
    assert.ok(e instanceof WorkflowValidationError);
    assert.match(e.issues.join("\n"), /session/);
    return true;
  });
});

test("command ステップに session を書くと弾かれる", () => {
  const yaml = `
name: bad
steps:
  - id: a
    type: command
    run: "true"
    session: x
`;
  assert.throws(() => parseWorkflow(yaml), WorkflowValidationError);
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `deno test --allow-all test/workflow/schema.test.ts`
Expected: FAIL（`session` が undefined のまま読めない・`AgentStep` に `session` プロパティが無く
型検査で落ちる）

- [ ] **Step 3: `src/workflow/schema.ts` を実装する**

`AgentStep` 型を変更する:

```ts
export type AgentStep = {
  id: string; type: "agent"; prompt: string; session?: string;
  permissionMode?: string; model?: string; onFailure?: Branch;
};
```

`stepSchema` の discriminated union の `agent` 分岐を変更する:

```ts
  z.object({
    id: stepId, type: z.literal("agent"), prompt: z.string().min(1),
    session: z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/, "sessionは英数字・ハイフン・アンダースコアのみ").optional(),
    permissionMode: z.string().optional(), model: z.string().optional(), onFailure: branch.optional(),
  }).strict(),
```

- [ ] **Step 4: テストを実行して成功を確認する**

Run: `deno test --allow-all test/workflow/schema.test.ts`
Expected: PASS（全テスト）

- [ ] **Step 5: コミット**

```bash
git add src/workflow/schema.ts test/workflow/schema.test.ts
git commit -m "feat: agent ステップに session（役割）を追加する"
```

---

## Task 4: エンジンをロール単位のセッション解決に切り替える

**Files:**
- Modify: `src/core/engine.ts`
- Modify: `test/core/engine.test.ts`

**Interfaces:**
- Consumes: `getSessionId(db, taskId, role)`（Task 2）、`StepBoundary.sessionUpsert`（Task 2）、
  `AgentStep.session`（Task 3）
- Produces: `runTask` の resume/start 判定がロール単位になる（`decide` のシグネチャは変えない）

- [ ] **Step 1: 失敗するテストを書く**

`test/core/engine.test.ts` の、`test("2つ目の agent ステップは同じ session id で resume される", ...)`
テストの直後に2つ足す:

```ts
test("異なる session を持つ agent ステップは独立した会話になる", async () => {
  const { db, root, workflow } = await taskFixture(`
name: f
steps:
  - id: plan
    type: agent
    session: planner
    prompt: "計画して"
  - id: implement
    type: agent
    session: implementer
    prompt: "実装して"
`);
  const adapter = createMockAdapter({ result: { ok: true, text: "done" } });
  await runTask(db, "t1", workflow, { db, adapter, logRoot: join(root, "logs"), globalLimit: 4 });

  assert.equal(adapter.calls.length, 2);
  assert.equal(adapter.calls[0].kind, "start");
  assert.equal(adapter.calls[1].kind, "start", "role が違うので implementer は自分の会話を持たない");
  assert.notEqual(adapter.calls[1].sessionId, adapter.calls[0].sessionId, "ロールごとに別の session id");
});

test("session ごとに独立した会話が保たれる（別ロールを挟んでも取り違えない）", async () => {
  const { db, root, workflow } = await taskFixture(`
name: f
steps:
  - id: implement
    type: agent
    session: implementer
    prompt: "実装して"
  - id: review
    type: agent
    session: reviewer
    prompt: "レビューして"
  - id: test
    type: command
    run: "false"
    onFailure:
      goto: implement
      maxAttempts: 2
      feed: "指摘があった"
`);
  const adapter = createMockAdapter({ result: { ok: true, text: "done" } });
  await runTask(db, "t1", workflow, { db, adapter, logRoot: join(root, "logs"), globalLimit: 4 });

  // implement(start) -> review(start) -> test(失敗) -> implement(resume) -> review(resume)
  // -> test(失敗、maxAttempts=2 を使い切って failed)
  assert.equal(adapter.calls.length, 4);
  assert.equal(adapter.calls[0].kind, "start");
  assert.equal(adapter.calls[1].kind, "start");
  assert.equal(adapter.calls[2].kind, "resume");
  assert.equal(adapter.calls[3].kind, "resume");
  assert.equal(adapter.calls[2].sessionId, adapter.calls[0].sessionId, "implementer の会話が続く");
  assert.equal(adapter.calls[3].sessionId, adapter.calls[1].sessionId, "reviewer の会話が続く");
  assert.notEqual(adapter.calls[0].sessionId, adapter.calls[1].sessionId, "ロールごとに別の session id");
  assert.equal((await getTask(db, "t1"))?.state, "failed", "maxAttempts を使い切って failed");
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `deno test --allow-all test/core/engine.test.ts`
Expected: FAIL（`session` を無視して単一の `claude_session_id` を共有するため、2つの新しい
テストで `adapter.calls[1].kind` が `"resume"` になってしまう）

- [ ] **Step 3: `src/core/engine.ts` を実装する**

先頭の import に `getSessionId` を足す:

```ts
import { getSessionId } from "../db/sessions.ts";
```

`decide` 関数の直前あたりに定数を足す（`export type Decision` の直前でよい）:

```ts
/** session を省略した agent ステップが共有する暗黙のロール名。 */
export const DEFAULT_SESSION_ROLE = "default";
```

`runTask` 内の、次のブロック（現在のコード、`src/core/engine.ts:126-131` 相当）:

```ts
    // session id はタスク全体で1つ。「このステップを始める時点で既に会話が
    // あったか」だけが resume すべきかを決める（ステップ内の再試行かどうかでは
    // ない）。agent ステップが2つ並ぶワークフローで2度 start すると、同じ
    // --session-id を使い回すことになり、CLI が拒否するか会話が継続しない。
    const hadSession = task.claude_session_id !== null;
    const sessionId = task.claude_session_id ?? crypto.randomUUID();
```

を次に置き換える:

```ts
    // セッションはロール単位（agent ステップの session、省略時は既定ロール）。
    // 「このロールで会話が既にあったか」だけが resume すべきかを決める
    // （ステップ内の再試行かどうかではない）。session を省略すると全 agent ステップが
    // 同じ既定ロールを共有するので、今までどおり「タスクに会話は1本」になる。
    const role = step.type === "agent" ? (step.session ?? DEFAULT_SESSION_ROLE) : null;
    const existingSessionId = role ? await getSessionId(db, taskId, role) : undefined;
    const hadSession = existingSessionId !== undefined;
    const sessionId = existingSessionId ?? crypto.randomUUID();
```

続く `commitStepBoundary` 呼び出し全体（`let stepRunId: number; try { stepRunId = (await
commitStepBoundary(db, { ... }))!; } catch ...` の `commitStepBoundary` の引数オブジェクト）を、
現在の:

```ts
      stepRunId = (await commitStepBoundary(db, {
        taskId,
        // 状態の確認と書き込みを同じトランザクションで行う。running でなくなって
        // いれば（上の読み取りの後に cancel / pause が書いた）何も書かずに降りる。
        requireState: "running",
        taskPatch: {
          current_step_id: step.id, attempt_counts: withAttempt(task, step.id),
          // 会話を始めるのは agent ステップだけ。command ステップでも書くと、
          // 一度も start していない id が「会話がある」ことにされ、次の agent が
          // その id で resume してしまう（project.setup は全ワークフローの
          // 先頭に command ステップとして入るので、これは常道の形で必ず踏む）。
          // 既存の非null値を消さないよう、キーごと省く（null を書かない）。
          ...(step.type === "agent" ? { claude_session_id: sessionId } : {}),
          pending_feed: null,
        },
        stepRun: {
          step_id: step.id, attempt, status: "running", exit_code: null,
          started_at: new Date().toISOString(), ended_at: null, log_path: logPath,
        },
      }))!;
```

から次に置き換える:

```ts
      stepRunId = (await commitStepBoundary(db, {
        taskId,
        // 状態の確認と書き込みを同じトランザクションで行う。running でなくなって
        // いれば（上の読み取りの後に cancel / pause が書いた）何も書かずに降りる。
        requireState: "running",
        taskPatch: {
          current_step_id: step.id, attempt_counts: withAttempt(task, step.id),
          pending_feed: null,
        },
        // 会話を始めるのは agent ステップだけ。command ステップでは書かない —
        // 一度も start していないロールが「会話がある」ことにされ、次の agent が
        // そのロールで resume してしまうのを防ぐ（project.setup は全ワークフローの
        // 先頭に command ステップとして入るので、これは常道の形で必ず踏む）。
        sessionUpsert: role ? { role, session_id: sessionId } : undefined,
        stepRun: {
          step_id: step.id, attempt, status: "running", exit_code: null,
          started_at: new Date().toISOString(), ended_at: null, log_path: logPath,
        },
      }))!;
```

- [ ] **Step 4: テストを実行して成功を確認する**

Run: `deno test --allow-all test/core/engine.test.ts`
Expected: PASS（新しい2テストに加え、既存の全テスト。特に「2つ目の agent ステップは同じ
session id で resume される」「先行する command ステップは session を消費しない」
「差し戻しでは resume が使われる」が引き続き通ること — これが `session` 省略時の互換性）

- [ ] **Step 5: `deno check` を通す**

Run: `deno check src test`
Expected: エラーなし（`task.claude_session_id` を読まなくなったことで型エラーが出ないこと、
`StepBoundary.taskPatch` から `claude_session_id` を渡さなくなった箇所が問題なくコンパイル
できることを確認する）

- [ ] **Step 6: コミット**

```bash
git add src/core/engine.ts test/core/engine.test.ts
git commit -m "feat: agent ステップの resume 判定をロール単位のセッションに切り替える"
```

---

## Task 5: worktree 作成時に `.doctrine-out/` を `.git/info/exclude` へ追記する

**Files:**
- Modify: `src/core/worktree.ts`
- Modify: `test/core/worktree.test.ts`

**Interfaces:**
- Produces: `ensureDoctrineOutExcluded(repoPath: string): Promise<void>`（`createWorktree` から
  呼ぶ。単体でもテストできるようエクスポートする）

- [ ] **Step 1: 失敗するテストを書く**

`test/core/worktree.test.ts` の先頭 import に `mkdir`, `readFile` を足す
（既存の `import { mkdtemp, rm, writeFile, stat, realpath } from "node:fs/promises";` を
次に変更する）:

```ts
import { mkdtemp, rm, writeFile, stat, realpath, mkdir, readFile } from "node:fs/promises";
```

`test("baseBranch から worktree とブランチを生やす", ...)` テストの直後に3つ足す:

```ts
test("worktree作成時に .doctrine-out/ を .git/info/exclude に追記する", async () => {
  const wt = join(root, "wt", "t1");
  await createWorktree({ repoPath: repo, worktreePath: wt, branch: "doctrine/t1-x", baseBranch: "main" });
  const content = await readFile(join(repo, ".git", "info", "exclude"), "utf8");
  assert.match(content, /^\.doctrine-out\/$/m);
});

test(".doctrine-out/ 配下の変更は hasUncommittedChanges で無視される", async () => {
  const wt = join(root, "wt", "t2");
  await createWorktree({ repoPath: repo, worktreePath: wt, branch: "doctrine/t2-x", baseBranch: "main" });
  await mkdir(join(wt, ".doctrine-out"), { recursive: true });
  await writeFile(join(wt, ".doctrine-out", "plan.md"), "plan\n");
  assert.equal(await hasUncommittedChanges(wt), false);
});

test("2回 createWorktree しても info/exclude の行は重複しない", async () => {
  const wt1 = join(root, "wt", "a");
  const wt2 = join(root, "wt", "b");
  await createWorktree({ repoPath: repo, worktreePath: wt1, branch: "doctrine/a", baseBranch: "main" });
  await createWorktree({ repoPath: repo, worktreePath: wt2, branch: "doctrine/b", baseBranch: "main" });
  const content = await readFile(join(repo, ".git", "info", "exclude"), "utf8");
  const matches = content.match(/^\.doctrine-out\/$/gm) ?? [];
  assert.equal(matches.length, 1);
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `deno test --allow-all test/core/worktree.test.ts`
Expected: FAIL（`.git/info/exclude` に `.doctrine-out/` が追記されない）

- [ ] **Step 3: `src/core/worktree.ts` を実装する**

先頭の import を変更する（`isAbsolute` を足す）:

```ts
import { basename, isAbsolute, join, resolve } from "@std/path";
```

`branchNameFor` 関数の直後・`createWorktree` 関数の直前に定数と関数を足す:

```ts
/**
 * 前段のエージェントが worktree 内に書く中間成果物の置き場所。doctrine 自身は
 * この名前を強制しない（ワークフローの書き手がプロンプトで決める自由な文字列）が、
 * git に見せないための exclude 設定だけはこの規約に合わせて自動で行う
 * （step-artifacts spec 4章）。
 */
const DOCTRINE_OUT_EXCLUDE_LINE = ".doctrine-out/";

/**
 * `.doctrine-out/` を `.git/info/exclude` に追記し、git status / task.diff の
 * write-tree の両方から見えなくする。プロジェクトの `.gitignore` は書き換えない
 * （project-add が「既存のファイルを上書きしない」原則を持つのと同じ理由）。
 *
 * `git rev-parse --git-path` は、リポジトリのルートから呼ぶと相対パスを、
 * リンクされた worktree から呼ぶと絶対パスを返す（common dir を指すため）。
 * どちらでも動くよう、絶対パスでなければ repoPath からの相対として解決する。
 *
 * 既に同じ行があれば何もしない（複数タスクが同じリポジトリに何度も worktree を
 * 作るので冪等にする）。
 */
export async function ensureDoctrineOutExcluded(repoPath: string): Promise<void> {
  const { stdout } = await runCommand("git", ["-C", repoPath, "rev-parse", "--git-path", "info/exclude"]);
  const raw = stdout.trim();
  const excludePath = isAbsolute(raw) ? raw : join(repoPath, raw);

  let content = "";
  try {
    content = await Deno.readTextFile(excludePath);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  if (content.split("\n").some((l) => l.trim() === DOCTRINE_OUT_EXCLUDE_LINE)) return;

  const withTrailingNewline = content.length > 0 && !content.endsWith("\n") ? content + "\n" : content;
  await Deno.writeTextFile(excludePath, withTrailingNewline + DOCTRINE_OUT_EXCLUDE_LINE + "\n");
}
```

`createWorktree` 関数の本体に1行足す:

```ts
export async function createWorktree(o: {
  repoPath: string; worktreePath: string; branch: string; baseBranch: string;
}): Promise<void> {
  await runCommand("git", ["-C", o.repoPath, "worktree", "add", "-b", o.branch, o.worktreePath, o.baseBranch]);
  await ensureDoctrineOutExcluded(o.repoPath);
}
```

- [ ] **Step 4: テストを実行して成功を確認する**

Run: `deno test --allow-all test/core/worktree.test.ts`
Expected: PASS（全テスト）

- [ ] **Step 5: コミット**

```bash
git add src/core/worktree.ts test/core/worktree.test.ts
git commit -m "feat: worktree作成時に .doctrine-out/ を git の視界から外す"
```

---

## Task 6: README を更新する

**Files:**
- Modify: `README.md`

- [ ] **Step 1: `agent` ステップの説明を role 対応に直す**

`### ステップは3種類だけ` セクション（`README.md:118`）の該当行:

```markdown
- **`agent`** — Claude Code を headless 実行する。`claude_session_id` を記録し再開可能。
```

を次に置き換える:

```markdown
- **`agent`** — Claude Code を headless 実行する。会話を role 単位（`session: <role>`）で
  記録し再開可能。
```

同じセクションの次の段落:

```markdown
失敗時の分岐は `onFailure`（`command` / `agent`）と `onReject`（`approval`）のみで、
どちらも同じ形（`goto` / `maxAttempts` / `feed`）を持つ。分岐先へ戻った `agent` は
`claude_session_id` で `--resume` されるので、会話は継続する（やり直しではない）。
```

を次に置き換える:

```markdown
失敗時の分岐は `onFailure`（`command` / `agent`）と `onReject`（`approval`）のみで、
どちらも同じ形（`goto` / `maxAttempts` / `feed`）を持つ。分岐先へ戻った `agent` は
同じ role のセッションIDで `--resume` されるので、会話は継続する（やり直しではない）。

### role ごとの会話（`session`）

`agent` ステップに `session: <role>` を書くと、同じ role を持つステップ同士が1本の会話を
共有する。差し戻しで同じ role の `agent` ステップへ戻ると、その会話が `--resume` される。

```yaml
  - id: plan
    type: agent
    session: planner
    prompt: "計画を .doctrine-out/plan.md に書いてください"

  - id: implement
    type: agent
    session: implementer
    prompt: "{{ worktree.path }}/.doctrine-out/plan.md を実装してください"
```

`session` を省略すると、すべての `agent` ステップが暗黙の既定ロールを共有する
（今までどおり「タスクに会話は1本」）。役割を分けたときの詳しい設計は
[`docs/superpowers/specs/2026-09-13-step-artifacts-design.md`](docs/superpowers/specs/2026-09-13-step-artifacts-design.md) を参照。
```

- [ ] **Step 2: ステップ間の成果物の受け渡し（`.doctrine-out/`）を追記する**

`## 5. \`degraded\` の意味` セクションの終わり（`## 既知の制約` の直前、`README.md:225` 付近）
に新しいセクションを足す:

```markdown
## 6. ステップ間で成果物を渡す

前段の `agent` ステップが後段へ計画やレビュー結果を渡したいときは、worktree 内の
ファイルに書かせ、後段は `{{ worktree.path }}` でパスを組み立てて読ませる。

```yaml
  - id: plan
    type: agent
    session: planner
    prompt: "計画を .doctrine-out/plan.md に書いてください"

  - id: plan-review
    type: approval
    title: "計画を確認してください"
    review:
      files: [".doctrine-out/plan.md"]
```

`.doctrine-out/` という名前は規約であり、doctrine が強制するものではない
（プロンプトで指示する自由な文字列）。ただし doctrine は worktree 作成時に、
この名前を `.git/info/exclude` へ自動で追記する。これにより:

- `completed` の後始末（4章）が、この中間ファイルを「未コミットの変更」として
  誤って削除拒否しない
- レビュー画面の diff にも混ざらない

対象を別の名前にしたい場合でも、この自動追記の対象は `.doctrine-out/` に固定されている
点に注意する（変えたい場合は自分で `.git/info/exclude` に追記する）。
```

- [ ] **Step 3: 「既知の制約」からセッションの制約を削除する**

`## 既知の制約` セクション内の次のブロックを削除する:

```markdown
- **1タスクにつきエージェントの会話は1本だけ。** ワークフロー内のすべての
  `agent` ステップは同一の `claude_session_id` を共有する。計画担当と
  レビュー担当を別々のエージェントとして持つような構成は、このサブプロジェクトの
  スコープ外（`docs/overview.md` 4章参照）。
```

（この制約は解決済みであり、代わりの説明は Step 1 で足した「role ごとの会話」節にある）

- [ ] **Step 4: コミット**

```bash
git add README.md
git commit -m "docs: README を role ごとのセッションと .doctrine-out/ の説明に更新する"
```

---

## Task 7: 全体テストと型検査を通す

**Files:** なし（確認のみ）

- [ ] **Step 1: 全テストを実行する**

Run: `deno task test`
Expected: PASS（全ファイル。特に `test/integration/fullCycle.test.ts` が影響を受けていないこと
— このテストは `session` を書かないワークフローを使うはずなので、Task 4 の互換性が保たれて
いれば無変更で通る）

- [ ] **Step 2: 型検査を通す**

Run: `deno task check`
Expected: エラーなし

- [ ] **Step 3: `deno.json` の `test` / `check` タスクの対象に変更が無いことを確認する**

Run: `cat deno.json`
Expected: `tasks.test` / `tasks.check` の定義は変更不要（既に `test/` と `src test` を
対象にしている）。変更が必要なら気づいた時点でこのタスクを止めて相談する。

- [ ] **Step 4: 最終コミット（必要なら）**

Step 1-3 で何もファイルを変更していなければコミット不要。何か直した場合はここでコミットする。
