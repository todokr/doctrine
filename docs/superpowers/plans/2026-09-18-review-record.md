# レビュー1回を1件の記録として残す 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** approval ステップの `step_runs` 1件＝レビュー1回になるよう記録を作り直し、待ち始めた時刻・すべての差し戻しコメント・その時点の worktree のツリーを DB から読めるようにする。

**Architecture:** `suspended` に入る時点で `status = "awaiting"` の `step_runs` 行を立て、承認・却下の時点で同じ行を閉じる。コメントは `step_outputs` を `step_run_id` 主キーにして全回残す。ツリーは一時インデックスで `git write-tree` し、`refs/doctrine/reviews/<task_id>/<step_run_id>` で `git gc` から守る。DB の形は1本のマイグレーション（`0003`）で変える。

**Tech Stack:** Deno / TypeScript、Kysely（SQLite: `node:sqlite`）、git CLI、`@std/testing/bdd` + `node:assert/strict`

## Global Constraints

- spec: `docs/superpowers/specs/2026-09-18-review-record-design.md`。issue: [#43](https://github.com/todokr/doctrine/issues/43)
- 読み出しの RPC（`task.diff` = #44、`task.context` / `review.files` = #45）は範囲外。**新しい RPC もイベントも足さない**
- 日本語でコメント・コミットメッセージ・テスト名を書く（既存コードの慣習）
- CI が `deno fmt --check` / `deno lint` / `deno check` / `deno test` を流す。**各タスクのコミット前に `deno fmt src test` を必ず走らせる**（`deno.json` の `lineWidth: 100`）
- マイグレーションの規則（`src/db/migrations.ts` 冒頭）: 一度コミットしたマイグレーションは書き換えない。マイグレーション内から `src/db/schema.ts` の型や `src/db/` のヘルパを参照しない。引数の db は `Kysely<any>` で受ける
- `PRAGMA foreign_keys` は `openDbOn` が `ON` にしており、マイグレーションのトランザクション内では切り替えられない
- 末尾 8KB（`OUTPUT_TAIL_BYTES`）の出力制限は変えない
- テンプレート変数 `{{ steps.<id>.stdout }}` の意味は変えない（そのステップの**最新の実行**）

---

## File Structure

| ファイル | 責務 | タスク |
| --- | --- | --- |
| `src/db/schema.ts` | `StepRunStatus` に `awaiting` / `interrupted`、`StepRunsTable.review_tree`、`StepOutputsTable` を新しい形に | 1 |
| `src/db/migrations.ts` | `0003_review_records`（2表の再構築＋`suspended` タスクの埋め戻し） | 1 |
| `src/db/boundary.ts` | `stepRun.review_tree` を受ける。`outputs` を `step_run_id` で書く | 1 |
| `src/db/stepRuns.ts` | `getStepOutputs` を JOIN で「最新の実行」に。`getAwaitingStepRun` を足す | 1, 3 |
| `src/core/reviewTree.ts` | **新規**。ツリーの作成・参照の保持・参照の削除（#44 も使う） | 2 |
| `src/core/engine.ts` | `suspended` 突入時に `awaiting` 行と `review_tree` を立て、`applyApproval` が閉じる | 3 |
| `src/core/recovery.ts` | 中断された行を `interrupted` で閉じる | 4 |
| `src/daemon/handlers.ts` | `onWarning` の配線（3）、worktree 削除時の参照の掃除（5） | 3, 5 |
| `README.md` | 「既知の制約」から `interrupted` を消す（4）、参照の掃除を書く（5） | 4, 5 |

---

## Task 1: DB の形を変える（マイグレーション `0003`）

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/db/migrations.ts`
- Modify: `src/db/boundary.ts`
- Modify: `src/db/stepRuns.ts`
- Test: `test/db/migrate.test.ts`

**Interfaces:**
- Consumes: なし（最初のタスク）
- Produces:
  - `StepRunStatus = "running" | "awaiting" | "success" | "failed" | "degraded" | "interrupted"`
  - `StepRunsTable.review_tree: string | null`
  - `StepOutputsTable = { step_run_id: number; stdout: string; stderr: string; exit_code: number | null }`
  - `StepBoundary.stepRun.review_tree?: string | null`
  - `StepBoundary.outputs?: { stdout: string; stderr: string; exit_code: number | null }`（`step_id` を落とす）
  - `getStepOutputs(db, taskId)` の戻り値の形は不変

このタスクだけで既存のテストが全部緑のままになる（形を変え、それに合わせて書き手と読み手を直す）。承認待ちの行を実際に立てるのは Task 3。

- [ ] **Step 1: 失敗するテストを書く（列集合と CHECK 制約）**

`test/db/migrate.test.ts` の `COLUMNS` を新しい形にする。

```ts
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
  },
  step_outputs: { step_run_id: true, stdout: true, stderr: true, exit_code: true },
```

同じファイルの末尾に足す。

```ts
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
    }).execute();
  }
  const rows = await d.selectFrom("step_runs").select("status").where("task_id", "=", "t1")
    .execute();
  assert.deepEqual(rows.map((r) => r.status).sort(), ["awaiting", "interrupted"]);
});

test("未知の status は CHECK 制約で落ちる", async () => {
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
  await assert.rejects(() =>
    d.insertInto("step_runs").values({
      task_id: "t1",
      step_id: "review",
      attempt: 1,
      // deno-lint-ignore no-explicit-any
      status: "bogus" as any,
      exit_code: null,
      started_at: "2026-09-18T00:00:00.000Z",
      ended_at: null,
      log_path: "",
      review_tree: null,
    }).execute()
  );
});
```

- [ ] **Step 2: テストを走らせて落ちることを確かめる**

Run: `deno test --allow-all test/db/migrate.test.ts`
Expected: FAIL（`review_tree` / `step_run_id` が実DBに無い、型エラー）

- [ ] **Step 3: `src/db/schema.ts` を新しい形にする**

```ts
export type StepRunStatus =
  | "running"
  | "awaiting"
  | "success"
  | "failed"
  | "degraded"
  | "interrupted";
```

`StepRunsTable` の末尾に足す。

```ts
  duration_ms: number | null;
  /** approval ステップで suspended に入った時点の worktree 全体のツリー（5章）。 */
  review_tree: string | null;
```

`StepOutputsTable` を差し替える。

```ts
export interface StepOutputsTable {
  step_run_id: number;
  stdout: string;
  stderr: string;
  exit_code: number | null;
}
```

- [ ] **Step 4: `0003_review_records` を書く**

`src/db/migrations.ts` の `migrations` オブジェクトに、`"0002_task_sessions"` の後へ足す。

```ts
  /**
   * レビュー1回を1件の記録にする（spec 2026-09-18-review-record-design.md）。
   *
   * SQLite は CHECK 制約を変えられないので step_runs を再構築する。step_outputs は
   * その step_runs を参照するので、順序は「step_runs を作り直す → step_outputs を
   * 作り直す」でなければならない。この順序なら PRAGMA foreign_keys を切る必要が
   * ない（切ろうにもマイグレーションはトランザクションの中なので切れない）。
   */
  "0003_review_records": {
    // deno-lint-ignore no-explicit-any
    async up(db: Kysely<any>) {
      // --- 1. step_runs の再構築（awaiting / interrupted と review_tree） ---
      await db.schema.createTable("step_runs_new")
        .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
        .addColumn("task_id", "text", (c) => c.notNull().references("tasks.id"))
        .addColumn("step_id", "text", (c) => c.notNull())
        .addColumn("attempt", "integer", (c) => c.notNull())
        .addColumn("status", "text", (c) =>
          c.notNull().check(
            sql`status IN ('running','awaiting','success','failed','degraded','interrupted')`,
          ))
        .addColumn("exit_code", "integer")
        .addColumn("started_at", "text", (c) => c.notNull())
        .addColumn("ended_at", "text")
        .addColumn("log_path", "text", (c) => c.notNull())
        .addColumn("cost_usd", "real")
        .addColumn("num_turns", "integer")
        .addColumn("duration_ms", "integer")
        .addColumn("review_tree", "text")
        .execute();
      // id を含めてコピーする。step_outputs の割り当てがこの id を使う。
      await sql`
        INSERT INTO step_runs_new
          (id, task_id, step_id, attempt, status, exit_code, started_at, ended_at,
           log_path, cost_usd, num_turns, duration_ms, review_tree)
        SELECT id, task_id, step_id, attempt, status, exit_code, started_at, ended_at,
               log_path, cost_usd, num_turns, duration_ms, NULL
        FROM step_runs
      `.execute(db);
      await db.schema.dropTable("step_runs").execute();
      await db.schema.alterTable("step_runs_new").renameTo("step_runs").execute();
      await db.schema.createIndex("idx_step_runs_task")
        .on("step_runs").columns(["task_id", "id"]).execute();

      // --- 2. step_outputs の再構築（主キーを step_run_id に） ---
      await db.schema.createTable("step_outputs_new")
        .addColumn("step_run_id", "integer", (c) => c.primaryKey().references("step_runs.id"))
        .addColumn("stdout", "text", (c) => c.notNull())
        .addColumn("stderr", "text", (c) => c.notNull())
        .addColumn("exit_code", "integer")
        .execute();
      // 既存の1行は、同じ (task_id, step_id) の最新の実行の出力だった。
      // 対応する step_run が無い行は、どの実行の出力か決められないので捨てる。
      await sql`
        INSERT INTO step_outputs_new (step_run_id, stdout, stderr, exit_code)
        SELECT (SELECT r.id FROM step_runs r
                 WHERE r.task_id = o.task_id AND r.step_id = o.step_id
                 ORDER BY r.id DESC LIMIT 1),
               o.stdout, o.stderr, o.exit_code
        FROM step_outputs o
        WHERE EXISTS (SELECT 1 FROM step_runs r
                       WHERE r.task_id = o.task_id AND r.step_id = o.step_id)
      `.execute(db);
      await db.schema.dropTable("step_outputs").execute();
      await db.schema.alterTable("step_outputs_new").renameTo("step_outputs").execute();

      // --- 3. 移行時点で suspended のタスクに awaiting 行を立てる ---
      // suspended は approval でしか起こらないので、current_step_id がそのまま
      // approval ステップの id である。待ち始めた時刻は updated_at（suspended へ
      // 遷移した時刻そのもの）。ツリーは過去に遡れないので NULL。
      const suspended = await sql<
        { id: string; current_step_id: string; attempt_counts: string; updated_at: string }
      >`
        SELECT id, current_step_id, attempt_counts, updated_at FROM tasks
         WHERE state = 'suspended' AND current_step_id IS NOT NULL
      `.execute(db);
      for (const t of suspended.rows) {
        const prior = await sql<{ n: number }>`
          SELECT COUNT(*) AS n FROM step_runs
           WHERE task_id = ${t.id} AND step_id = ${t.current_step_id}
        `.execute(db);
        await sql`
          INSERT INTO step_runs
            (task_id, step_id, attempt, status, exit_code, started_at, ended_at,
             log_path, cost_usd, num_turns, duration_ms, review_tree)
          VALUES (${t.id}, ${t.current_step_id}, ${prior.rows[0].n + 1}, 'awaiting', NULL,
                  ${t.updated_at}, NULL, '', NULL, NULL, NULL, NULL)
        `.execute(db);
        // attempt の確定を待ち始めた時点へ移したので（spec 3.4）、旧コードで
        // 進めていないぶんをここで進める。進めないと移行後の applyApproval が
        // 1つ小さい数を decide に渡し、差し戻しの上限が1回ぶん甘くなる。
        // withAttempt は呼ばない（マイグレーションは最新の形に依存しない）。
        const counts = JSON.parse(t.attempt_counts) as Record<string, number>;
        counts[t.current_step_id] = (counts[t.current_step_id] ?? 0) + 1;
        await sql`
          UPDATE tasks SET attempt_counts = ${JSON.stringify(counts)} WHERE id = ${t.id}
        `.execute(db);
      }

      // 再構築で外部キーが壊れていないことを確かめてから終える。
      const violations = await sql<{ table: string }>`PRAGMA foreign_key_check`.execute(db);
      if (violations.rows.length > 0) {
        throw new Error(
          `外部キーが壊れています: ${violations.rows.map((r) => r.table).join(", ")}`,
        );
      }
    },
  },
```

- [ ] **Step 5: `src/db/boundary.ts` を新しい形に合わせる**

`StepBoundary.stepRun` の末尾に足す。

```ts
    duration_ms?: number | null;
    /** approval ステップのみ。suspended に入った時点の worktree 全体のツリー。 */
    review_tree?: string | null;
```

`outputs` から `step_id` を落とす。

```ts
  /**
   * ステップの出力。この境界で立てた（または閉じた）step_run に紐づく。
   * step_run も stepRunUpdate も無いのに outputs だけ渡すのは呼び出し側のバグ。
   */
  outputs?: { stdout: string; stderr: string; exit_code: number | null };
```

`commitStepBoundary` の `stepRun` の `values` に `review_tree: s.review_tree ?? null,` を足し、`outputs` の節を差し替える。

```ts
    if (b.outputs) {
      if (stepRunId === null) {
        throw new Error(
          "outputs は step_run と一緒にしか書けません（どの実行の出力か決められません）",
        );
      }
      const o = b.outputs;
      await trx.insertInto("step_outputs")
        .values({
          step_run_id: stepRunId,
          stdout: tail(o.stdout),
          stderr: tail(o.stderr),
          exit_code: o.exit_code,
        })
        .onConflict((oc) =>
          oc.column("step_run_id").doUpdateSet((eb) => ({
            stdout: eb.ref("excluded.stdout"),
            stderr: eb.ref("excluded.stderr"),
            exit_code: eb.ref("excluded.exit_code"),
          }))
        )
        .execute();
    }
```

- [ ] **Step 6: `src/db/stepRuns.ts` の `getStepOutputs` を JOIN にする**

```ts
/**
 * 変数展開に渡す形（exitCode は文字列。テンプレートは文字列しか返さない）。
 *
 * step_outputs は実行1回ごとに1行あるので、ステップidごとに**最新の実行**
 * （= 最大の step_run_id）の行を選ぶ。{{ steps.<id>.stdout }} の意味は
 * 履歴が増えても変わらない。
 */
export async function getStepOutputs(
  db: Db,
  taskId: string,
): Promise<Record<string, { stdout: string; stderr: string; exitCode: string }>> {
  const rows = await db.selectFrom("step_outputs")
    .innerJoin("step_runs", "step_runs.id", "step_outputs.step_run_id")
    .select(["step_runs.step_id", "step_runs.id as step_run_id", "step_outputs.stdout", "step_outputs.stderr", "step_outputs.exit_code"])
    .where("step_runs.task_id", "=", taskId)
    .orderBy("step_runs.id")
    .execute();
  const out: Record<string, { stdout: string; stderr: string; exitCode: string }> = {};
  // id の昇順に上書きするので、最後に残るのが最新の実行。
  for (const r of rows) {
    out[r.step_id] = { stdout: r.stdout, stderr: r.stderr, exitCode: String(r.exit_code ?? "") };
  }
  return out;
}
```

- [ ] **Step 7: 型検査と全テストを走らせる**

Run: `deno task check && deno task test`
Expected: PASS。`outputs: { step_id: ... }` を渡している既存の呼び出し（`src/core/engine.ts` の3箇所）が型エラーになるので、`step_id` を消すだけの修正を入れる（振る舞いは変わらない。中身の書き換えは Task 3）

- [ ] **Step 8: 既存DBからの移行テストを足す**

`test/db/migrate.test.ts` の末尾に足す。`LEGACY_DDL` を流した素の接続に対して `openDbOn` することで、「古いDBファイルを開いた」状況を作る。

```ts
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
  assert.deepEqual(rows, [
    { step_run_id: 2, stdout: "2回目のコメント", stderr: "", exit_code: 1 },
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
```

- [ ] **Step 9: テストと整形を通す**

Run: `deno fmt src test && deno task check && deno task test`
Expected: PASS（126件 + 追加分）

- [ ] **Step 10: コミット**

```bash
git add src/db test/db
git commit -m "$(cat <<'EOF'
feat(db): step_runs に awaiting / interrupted / review_tree を足し、step_outputs を実行単位にする

レビュー1回を1件の記録にするための形の変更。SQLite は CHECK 制約を変えられない
ので step_runs を再構築し、step_outputs はその参照なので後から作り直す。

既存の step_outputs 行は同じ (task_id, step_id) の最新の実行に割り当てる。
移行時点で suspended のタスクには awaiting 行を立て、attempt の確定を待ち始めた
時点へ移すぶん attempt_counts も進めておく（進めないと移行後に差し戻しの上限が
1回ぶん甘くなる）。

承認待ちの行を実際に立てるのは次の変更。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `reviewTree.ts` — ツリーを作り、`git gc` から守る

**Files:**
- Create: `src/core/reviewTree.ts`
- Test: `test/core/reviewTree.test.ts`

**Interfaces:**
- Consumes: `runCommand` from `src/util/exec.ts`
- Produces:
  - `captureTree(worktreePath: string): Promise<string>` — ツリーの SHA
  - `retainTree(o: { worktreePath: string; taskId: string; stepRunId: number; tree: string }): Promise<void>`
  - `releaseTrees(repoPath: string, taskId: string): Promise<void>`
  - `reviewRefName(taskId: string, stepRunId: number): string`

git の参照はリンクされた worktree とリポジトリ本体で共有されるので、書くときは worktree のパスから、消すときはリポジトリのパスから同じ参照に届く。

- [ ] **Step 1: 失敗するテストを書く**

`test/core/reviewTree.test.ts` を作る。

```ts
import { afterEach, test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureTree, releaseTrees, retainTree, reviewRefName } from "../../src/core/reviewTree.ts";
import { runCommand } from "../../src/util/exec.ts";
import { makeRepo } from "../helpers/repo.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function repo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "doctrine-tree-"));
  roots.push(root);
  return await makeRepo(root, { "a.txt": "1\n" });
}

test("ツリーには未コミットの変更と未追跡のファイルが入る", async () => {
  const r = await repo();
  await writeFile(join(r, "a.txt"), "2\n"); // 追跡済みの変更（未コミット）
  await writeFile(join(r, "new.txt"), "新規\n"); // 未追跡

  const tree = await captureTree(r);

  const { stdout } = await runCommand("git", ["-C", r, "ls-tree", "-r", "--name-only", tree]);
  assert.deepEqual(stdout.trim().split("\n").sort(), ["a.txt", "new.txt"]);
  const { stdout: content } = await runCommand("git", ["-C", r, "show", `${tree}:a.txt`]);
  assert.equal(content, "2\n");
});

test("worktree の index は汚さない", async () => {
  const r = await repo();
  await writeFile(join(r, "new.txt"), "新規\n");

  await captureTree(r);

  // git add していないのだから、未追跡のままでなければならない。
  const { stdout } = await runCommand("git", ["-C", r, "status", "--porcelain"]);
  assert.match(stdout, /\?\? new\.txt/);
});

test("参照を張ったツリーは git gc で消えない", async () => {
  const r = await repo();
  await writeFile(join(r, "new.txt"), "新規\n");
  const tree = await captureTree(r);

  await retainTree({ worktreePath: r, taskId: "t1", stepRunId: 7, tree });
  await runCommand("git", ["-C", r, "gc", "--prune=now", "--aggressive"]);

  const { stdout } = await runCommand("git", ["-C", r, "ls-tree", "-r", "--name-only", tree]);
  assert.ok(stdout.includes("new.txt"));
  const { stdout: refs } = await runCommand("git", [
    "-C",
    r,
    "for-each-ref",
    "--format=%(refname)",
    "refs/doctrine/reviews/t1",
  ]);
  assert.equal(refs.trim(), reviewRefName("t1", 7));
});

test("参照が指すコミットから前回のツリーを引ける", async () => {
  const r = await repo();
  await writeFile(join(r, "new.txt"), "新規\n");
  const tree = await captureTree(r);
  await retainTree({ worktreePath: r, taskId: "t1", stepRunId: 7, tree });

  const { stdout } = await runCommand("git", [
    "-C",
    r,
    "rev-parse",
    `${reviewRefName("t1", 7)}^{tree}`,
  ]);
  assert.equal(stdout.trim(), tree);
});

test("releaseTrees はそのタスクの参照だけを消す", async () => {
  const r = await repo();
  const tree = await captureTree(r);
  await retainTree({ worktreePath: r, taskId: "t1", stepRunId: 1, tree });
  await retainTree({ worktreePath: r, taskId: "t1", stepRunId: 2, tree });
  await retainTree({ worktreePath: r, taskId: "t2", stepRunId: 3, tree });

  await releaseTrees(r, "t1");

  const { stdout } = await runCommand("git", [
    "-C",
    r,
    "for-each-ref",
    "--format=%(refname)",
    "refs/doctrine/reviews",
  ]);
  assert.deepEqual(stdout.trim().split("\n"), [reviewRefName("t2", 3)]);
});

test("参照が1つも無いタスクの releaseTrees は落ちない", async () => {
  const r = await repo();
  await releaseTrees(r, "t-none");
});

test("git リポジトリでなければ captureTree は失敗する", async () => {
  const root = await mkdtemp(join(tmpdir(), "doctrine-tree-"));
  roots.push(root);
  await assert.rejects(() => captureTree(root));
});
```

- [ ] **Step 2: テストを走らせて落ちることを確かめる**

Run: `deno test --allow-all test/core/reviewTree.test.ts`
Expected: FAIL（`src/core/reviewTree.ts` が無い）

- [ ] **Step 3: `src/core/reviewTree.ts` を書く**

```ts
import { join } from "@std/path";
import { runCommand } from "../util/exec.ts";

/**
 * レビュー1回のツリーを指す参照の名前。step_runs.id を名前に持つので、
 * 「レビュー1件 = 参照1つ」の対応がそのまま名前に出る。
 */
export function reviewRefName(taskId: string, stepRunId: number): string {
  return `refs/doctrine/reviews/${taskId}/${stepRunId}`;
}

/**
 * コミットの作者・コミッタを doctrine で固定する。git は user.email が未設定の
 * リポジトリでは commit-tree を拒否するので、人の設定に依存させない
 * （ここで失敗すると、人が待っているレビューの基準点だけが理由もなく欠ける）。
 */
const IDENTITY = {
  GIT_AUTHOR_NAME: "doctrine",
  GIT_AUTHOR_EMAIL: "doctrine@localhost",
  GIT_COMMITTER_NAME: "doctrine",
  GIT_COMMITTER_EMAIL: "doctrine@localhost",
};

/**
 * worktree の「今あるもの全部」をツリーにする。未コミットの変更も未追跡の
 * ファイルも入る — 人が承認するのは worktree に実際にあるものであって、
 * コミットされたものではない。
 *
 * 一時インデックスを使うので worktree の .git/index には触らない（エージェントが
 * 作業中のステージング状態を doctrine が書き換えてはいけない）。
 * `.doctrine-out/` は .git/info/exclude によって最初から入らない。
 */
export async function captureTree(worktreePath: string): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "doctrine-index-" });
  try {
    const env = { ...Deno.env.toObject(), GIT_INDEX_FILE: join(dir, "index") };
    await runCommand("git", ["-C", worktreePath, "add", "-A"], { env });
    const { stdout } = await runCommand("git", ["-C", worktreePath, "write-tree"], { env });
    return stdout.trim();
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

/**
 * ツリーを指すコミットを作り、参照を張って `git gc` から守る。参照が無いツリーは
 * 到達不能なオブジェクトとして刈られる。
 *
 * コミットを1つ挟むのは、参照がコミットを指していれば `git diff <ref>` が
 * そのまま使えるため（task.diff がツリーの特別扱いを持たずに済む）。親は持たせない
 * — 比較に要らず、持たせると worktree の履歴に依存した意味が生まれる。
 *
 * 参照は worktree とリポジトリ本体で共有されるので、worktree のパスから書いてよい。
 */
export async function retainTree(o: {
  worktreePath: string;
  taskId: string;
  stepRunId: number;
  tree: string;
}): Promise<void> {
  const { stdout } = await runCommand(
    "git",
    ["-C", o.worktreePath, "commit-tree", o.tree, "-m", `doctrine review ${o.taskId}#${o.stepRunId}`],
    { env: { ...Deno.env.toObject(), ...IDENTITY } },
  );
  await runCommand("git", [
    "-C",
    o.worktreePath,
    "update-ref",
    reviewRefName(o.taskId, o.stepRunId),
    stdout.trim(),
  ]);
}

/**
 * そのタスクのレビュー参照をすべて消す。worktree を消すときに呼ぶ
 * （worktree が無くなればレビューの基準点を使う相手もいなくなる）。
 *
 * 参照が1つも無くても失敗しない（ツリーを1度も記録できなかったタスクがある）。
 */
export async function releaseTrees(repoPath: string, taskId: string): Promise<void> {
  const { stdout } = await runCommand("git", [
    "-C",
    repoPath,
    "for-each-ref",
    "--format=%(refname)",
    `refs/doctrine/reviews/${taskId}`,
  ]);
  for (const ref of stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0)) {
    await runCommand("git", ["-C", repoPath, "update-ref", "-d", ref]);
  }
}
```

- [ ] **Step 4: テストを走らせて通ることを確かめる**

Run: `deno test --allow-all test/core/reviewTree.test.ts`
Expected: PASS（7件）

- [ ] **Step 5: 整形と型検査**

Run: `deno fmt src test && deno lint && deno task check`
Expected: 差分なし・エラーなし

- [ ] **Step 6: コミット**

```bash
git add src/core/reviewTree.ts test/core/reviewTree.test.ts
git commit -m "$(cat <<'EOF'
feat(core): レビュー時点の worktree をツリーとして記録する reviewTree を足す

一時インデックスで worktree 全体（未コミット・未追跡を含む）をツリーにし、
refs/doctrine/reviews/<task_id>/<step_run_id> を張って git gc から守る。
worktree の .git/index には触らない。

まだ誰も呼んでいない。engine から使うのは次の変更。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `suspended` に入る時点で行を立て、決定時に閉じる

**Files:**
- Modify: `src/core/engine.ts`
- Modify: `src/db/stepRuns.ts`
- Modify: `src/daemon/handlers.ts:478-512`（`EngineDeps` を組み立てている箇所に `onWarning` を足す）
- Test: `test/core/engine.test.ts`

**Interfaces:**
- Consumes: Task 1 の `StepBoundary.stepRun.review_tree` / `outputs`、Task 2 の `captureTree` / `retainTree`
- Produces:
  - `getAwaitingStepRun(db, taskId, stepId): Promise<StepRunRow | undefined>`（`src/db/stepRuns.ts`）
  - `EngineDeps.onWarning?(taskId: string, message: string): void`

- [ ] **Step 1: 失敗するテストを書く**

`test/core/engine.test.ts` の末尾に足す。`taskFixture` の `worktree_path` は git リポジトリではないので、ツリーの記録は失敗する（＝ 5.3 の経路をそのまま踏む）。ツリーが取れる経路は Task 6 の統合テストで確かめる。

```ts
test("suspended に入った時点で awaiting の行が立ち、待ち始めた時刻が残る", async () => {
  const { db, root, workflow } = await taskFixture(`
name: f
steps:
  - id: review
    type: approval
    title: "見て"
`);
  await runTask(db, "t1", workflow, {
    db,
    adapter: createMockAdapter({ result: {} }),
    logRoot: join(root, "logs"),
    globalLimit: 4,
  });

  const runs = await listStepRuns(db, "t1");
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "awaiting");
  assert.equal(runs[0].step_id, "review");
  assert.equal(runs[0].attempt, 1);
  assert.equal(runs[0].ended_at, null);
  assert.ok(Date.parse(runs[0].started_at) > 0);
  // attempt の確定は待ち始めた時点へ移った。
  assert.equal((await getTask(db, "t1"))!.attempt_counts, JSON.stringify({ review: 1 }));
});

test("承認は awaiting の行を閉じる（新しい行を足さない）", async () => {
  const { db, root, workflow } = await taskFixture(`
name: f
steps:
  - id: review
    type: approval
    title: "見て"
  - id: after
    type: command
    run: "true"
`);
  await runTask(db, "t1", workflow, {
    db,
    adapter: createMockAdapter({ result: {} }),
    logRoot: join(root, "logs"),
    globalLimit: 4,
  });
  const started = (await listStepRuns(db, "t1"))[0];

  await applyApproval(db, "t1", { approved: true, comment: "" }, workflow);

  const runs = await listStepRuns(db, "t1");
  assert.equal(runs.length, 1);
  assert.equal(runs[0].id, started.id);
  assert.equal(runs[0].status, "success");
  assert.equal(runs[0].exit_code, 0);
  assert.equal(runs[0].started_at, started.started_at);
  assert.ok(runs[0].ended_at !== null);
});

test("2回差し戻すと、両方のコメントと待ち時間が残る", async () => {
  const { db, root, workflow } = await taskFixture(`
name: f
steps:
  - id: implement
    type: command
    run: "true"
  - id: review
    type: approval
    title: "見て"
    onReject:
      goto: implement
      maxAttempts: 5
`);
  const deps = {
    db,
    adapter: createMockAdapter({ result: {} }),
    logRoot: join(root, "logs"),
    globalLimit: 4,
  };

  await runTask(db, "t1", workflow, deps);
  await applyApproval(db, "t1", { approved: false, comment: "1回目の指摘" }, workflow);
  await toRunning(db, "t1");
  await runTask(db, "t1", workflow, deps);
  await applyApproval(db, "t1", { approved: false, comment: "2回目の指摘" }, workflow);

  const reviews = (await listStepRuns(db, "t1")).filter((r) => r.step_id === "review");
  assert.equal(reviews.length, 2);
  assert.deepEqual(reviews.map((r) => r.attempt), [1, 2]);
  assert.deepEqual(reviews.map((r) => r.status), ["failed", "failed"]);
  // それぞれの待ち時間が引ける（started_at と ended_at が両方ある）。
  for (const r of reviews) {
    assert.ok(r.ended_at !== null);
    assert.ok(Date.parse(r.ended_at!) >= Date.parse(r.started_at));
  }
  // 1回目の待ちは2回目より先に始まっている。
  assert.ok(Date.parse(reviews[0].started_at) <= Date.parse(reviews[1].started_at));

  const outputs = await db.selectFrom("step_outputs").selectAll()
    .orderBy("step_run_id").execute();
  assert.deepEqual(
    outputs.filter((o) => reviews.some((r) => r.id === o.step_run_id)).map((o) => o.stdout),
    ["1回目の指摘", "2回目の指摘"],
  );
  // テンプレート変数は今までどおり最新の実行を指す。
  assert.equal((await getStepOutputs(db, "t1")).review.stdout, "2回目の指摘");
});

test("ツリーを記録できなくても suspended に入り、警告が出る", async () => {
  const { db, root, workflow } = await taskFixture(`
name: f
steps:
  - id: review
    type: approval
    title: "見て"
`);
  const warnings: string[] = [];
  await runTask(db, "t1", workflow, {
    db,
    adapter: createMockAdapter({ result: {} }),
    logRoot: join(root, "logs"),
    globalLimit: 4,
    onWarning: (_id, message) => warnings.push(message),
  });

  assert.equal((await getTask(db, "t1"))!.state, "suspended");
  assert.equal((await listStepRuns(db, "t1"))[0].review_tree, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /ツリー/);
});

test("awaiting の行が無ければ承認は失敗する", async () => {
  const { db, root, workflow } = await taskFixture(`
name: f
steps:
  - id: review
    type: approval
    title: "見て"
`);
  await runTask(db, "t1", workflow, {
    db,
    adapter: createMockAdapter({ result: {} }),
    logRoot: join(root, "logs"),
    globalLimit: 4,
  });
  await db.deleteFrom("step_runs").where("task_id", "=", "t1").execute();

  await assert.rejects(
    () => applyApproval(db, "t1", { approved: true, comment: "" }, workflow),
    /承認待ちのステップ実行がありません/,
  );
});
```

`toRunning(db, taskId)` は既にこのファイルにあるヘルパ（`applyApproval` が `queued` にしたタスクを、スケジューラが拾って `running` にしたのと同じ状態にする）。新しく足さない。

- [ ] **Step 2: テストを走らせて落ちることを確かめる**

Run: `deno test --allow-all test/core/engine.test.ts`
Expected: FAIL（`awaiting` の行が立たない、`onWarning` が型に無い）

- [ ] **Step 3: `getAwaitingStepRun` を足す**

`src/db/stepRuns.ts` に足す。

```ts
/**
 * 承認待ちのステップ実行（approval が suspended に入った時点で立てた行）。
 * タスクが suspended なら、この行がちょうど1件ある。
 */
export function getAwaitingStepRun(
  db: Db,
  taskId: string,
  stepId: string,
): Promise<StepRunRow | undefined> {
  return db.selectFrom("step_runs").selectAll()
    .where("task_id", "=", taskId)
    .where("step_id", "=", stepId)
    .where("status", "=", "awaiting")
    .orderBy("id desc")
    .executeTakeFirst();
}
```

- [ ] **Step 4: `EngineDeps` に `onWarning` を足す**

`src/core/engine.ts` の `EngineDeps` に足す。

```ts
  /**
   * ワークフローは止めないが人に見せるべきこと（レビュー時点のツリーを記録できな
   * かった等）。デーモンは ctx.warnings に積む。
   */
  onWarning?(taskId: string, message: string): void;
```

- [ ] **Step 5: approval の分岐を書き直す**

`src/core/engine.ts` の import に足す。

```ts
import { captureTree, retainTree } from "./reviewTree.ts";
import { getAwaitingStepRun, getStepOutputs, type StepRunStatus } from "../db/stepRuns.ts";
```

`runTask` の `if (step.type === "approval") { ... }` を差し替える。

```ts
    if (step.type === "approval") {
      // ここから「レビュー1回」が始まる。待ち始めた時刻・そのときのツリーを
      // 決定時ではなく今の時点で記録する（決定時に作る行は待ち時間を常に0にする）。
      //
      // ツリーは判断材料であって承認そのものではないので、取れなくても止めない
      // （spec 5.3）。欠けるのは次の差し戻しで「前回レビュー以降」が引けないことだけ。
      let reviewTree: string | null = null;
      if (task.worktree_path) {
        try {
          reviewTree = await captureTree(task.worktree_path);
        } catch (e) {
          deps.onWarning?.(
            taskId,
            `レビュー時点のツリーを記録できませんでした: ${(e as Error).message}`,
          );
        }
      }

      assertTransition(task.state, "suspended");
      let stepRunId: number | null;
      try {
        stepRunId = await commitStepBoundary(db, {
          taskId,
          requireState: "running",
          taskPatch: {
            state: "suspended",
            current_step_id: step.id,
            // approval も他のステップと同じく「開始時」に attempt を進める。
            // applyApproval はこの数をそのまま decide へ渡す。
            attempt_counts: withAttempt(task, step.id),
            child_pid: null,
            child_started_at: null,
          },
          stepRun: {
            step_id: step.id,
            attempt: attemptCount(task, step.id) + 1,
            status: "awaiting",
            exit_code: null,
            started_at: new Date().toISOString(),
            ended_at: null,
            // 人の判断にログファイルは無い。
            log_path: "",
            review_tree: reviewTree,
          },
        });
      } catch (e) {
        if (e instanceof StateConflictError) return;
        throw e;
      }
      deps.onStateChanged?.(taskId, task.state, "suspended");

      // 参照は step_run の id を名前に持つので、行を書いた後でしか張れない。
      // この隙間で落ちるとツリーが gc に刈られ得るが、そのとき欠けるのは基準点
      // だけで、レビューそのものは回る（spec 5.2）。
      if (reviewTree !== null && stepRunId !== null) {
        try {
          await retainTree({
            worktreePath: task.worktree_path!,
            taskId,
            stepRunId,
            tree: reviewTree,
          });
        } catch (e) {
          deps.onWarning?.(
            taskId,
            `レビュー時点のツリーの参照を張れませんでした: ${(e as Error).message}`,
          );
        }
      }
      return;
    }
```

- [ ] **Step 6: `applyApproval` が行を閉じるようにする**

`src/core/engine.ts` の `applyApproval` の `const now = ...` の直後に足す。

```ts
  // 「suspended なら awaiting の行がちょうど1件ある」は runTask と 0003 の
  // マイグレーションが保つ不変条件。無ければ記録が壊れている。ここで started_at =
  // now の行を作って取り繕うと、待ち時間0という嘘を記録に残すことになる。
  const awaiting = await getAwaitingStepRun(db, taskId, stepId);
  if (!awaiting) {
    throw new Error(`承認待ちのステップ実行がありません: ${taskId} / ${stepId}`);
  }
```

承認の枝の `commitStepBoundary` を差し替える。

```ts
    await commitStepBoundary(db, {
      taskId,
      requireState: "suspended",
      taskPatch: next
        ? { state: "queued", current_step_id: next.id, resumed: 1 }
        : { state: "completed" },
      stepRunUpdate: { id: awaiting.id, status: "success", exit_code: 0, ended_at: now },
      outputs: { stdout: "", stderr: "", exit_code: 0 },
    });
```

却下の枝は、attempt を進める処理が `runTask` へ移ったぶんを削る。

```ts
  // 却下は onFailure と同じ「失敗して分岐する」ケースであり、goto/maxAttempts の
  // 判断はここで作り直さず decide に委ねる。attempt は suspended に入った時点で
  // 既に進んでいるので、attemptCount がそのまま maxAttempts と比較される数であり、
  // かつ awaiting の行に記録されている attempt と一致する。
  const decision = decide({
    workflow,
    currentStepId: stepId,
    outcome: "failed",
    attempts: attemptCount(task, stepId),
  });
```

`goto` の枝と `fail` の枝の `commitStepBoundary` を差し替える（`attempt_counts` の更新と `stepRun` の挿入が消え、`stepRunUpdate` になる）。

```ts
  if (decision.kind === "goto") {
    const to: TaskState = "queued";
    assertTransition(task.state, to);
    await commitStepBoundary(db, {
      taskId,
      requireState: "suspended",
      taskPatch: {
        state: "queued",
        current_step_id: decision.stepId,
        resumed: 1,
        pending_feed: decision.feed ? expand(decision.feed, ctx) : null,
      },
      stepRunUpdate: { id: awaiting.id, status: "failed", exit_code: 1, ended_at: now },
      outputs: { stdout: verdict.comment, stderr: "", exit_code: 1 },
    });
    return;
  }

  // decision.kind === "fail"（onReject が無い、または maxAttempts を使い切った）
  const to: TaskState = "failed";
  assertTransition(task.state, to);
  await commitStepBoundary(db, {
    taskId,
    requireState: "suspended",
    taskPatch: { state: "failed" },
    stepRunUpdate: { id: awaiting.id, status: "failed", exit_code: 1, ended_at: now },
    outputs: { stdout: verdict.comment, stderr: "", exit_code: 1 },
  });
```

`withAttempt` が `applyApproval` から消えるが `runTask` では使うので、import はそのまま。

- [ ] **Step 7: `onWarning` をデーモンに配線する**

`src/daemon/handlers.ts` の `void runTask(ctx.db, task.id, workflow, { ... })` に足す（`onStateChanged` の隣）。

```ts
        onWarning: (id, message) => ctx.warnings.push(`タスク ${id}: ${message}`),
```

- [ ] **Step 8: テストを走らせて通ることを確かめる**

Run: `deno task test`
Expected: PASS。既存の approval 関連テストのうち、行数を数えているもの（「承認待ちの間に YAML から消えたステップ」など）が新しい行数に合わなければ、**期待値だけ**を直す（振る舞いは仕様どおりに変わっている）

- [ ] **Step 9: 整形・lint・型検査**

Run: `deno fmt src test && deno lint && deno task check`
Expected: 差分なし・エラーなし

- [ ] **Step 10: コミット**

```bash
git add src/core/engine.ts src/db/stepRuns.ts src/daemon/handlers.ts test/core/engine.test.ts
git commit -m "$(cat <<'EOF'
feat(core): レビュー1回を suspended 突入時から決定時までの1行として記録する

approval が suspended に入る時点で status=awaiting の step_runs 行を立て、
その時点の worktree のツリーを review_tree に記録して参照を張る。承認・却下は
新しい行を足さず、その行を閉じる。差し戻しコメントは行ごとに残るので、2回目が
1回目を上書きしない。

attempt の確定を決定時から待ち始めた時点へ移した。他のステップが開始コミットで
進めるのと同じ形になり、applyApproval は attemptCount をそのまま decide へ渡す。
maxAttempts と比較される数は変わらない。

ツリーを記録できなくても suspended は止めず、review_tree を null にして警告を
出す（EngineDeps.onWarning）。人が待っているレビューを、基準点が取れなかった
という理由で失わせない。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: 中断された実行を `interrupted` で閉じる

**Files:**
- Modify: `src/core/recovery.ts:161-189`
- Modify: `README.md`（「既知の制約」の1項目を消す）
- Test: `test/core/recovery.test.ts`

**Interfaces:**
- Consumes: Task 1 の `StepRunStatus` に足した `interrupted` / `awaiting`
- Produces: なし（振る舞いの変更のみ）

- [ ] **Step 1: 失敗するテストを書く**

`test/core/recovery.test.ts` の末尾に足す。このファイルには `fixture()`（プロジェクトとタスクを作って `Db` を返す）、`probe({})`（どの pid も存在しないプローブ）、`lookupWF`（`implement` を agent ステップとして返す `WorkflowLookup`）が既にあるので、そのまま使う。

既存の2件（「復帰に成功したら…」「復帰に失敗しても…」）は `assert.notEqual(runs[0].status, "running")` としか書いておらず、閉じる値を固定していない。**その2件の `notEqual` を `assert.equal(runs[0].status, "interrupted")` に書き換える**（値を決めた以上、テストも値を名指しする）。さらに、承認待ちが閉じられないことを確かめる1件を足す。

```ts
test("承認待ちの行は復帰処理で閉じない", async () => {
  const db = await fixture();
  // approval が suspended に入った時点の行。人を待っている最中であり、
  // デーモンが再起動しただけで閉じてはならない（待ち始めた時刻が失われる）。
  await commitStepBoundary(db, {
    taskId: "t1",
    taskPatch: { state: "suspended", current_step_id: "review" },
    stepRun: {
      step_id: "review",
      attempt: 1,
      status: "awaiting",
      exit_code: null,
      started_at: "2026-09-18T09:00:00.000Z",
      ended_at: null,
      log_path: "",
      review_tree: null,
    },
  });

  await recoverOnStartup(db, probe({}), lookupWF);

  const runs = await listStepRuns(db, "t1");
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "awaiting");
  assert.equal(runs[0].ended_at, null);
  assert.equal((await getTask(db, "t1"))!.state, "suspended");
});

test("running の行と awaiting の行が混ざっていても、閉じるのは running の行だけ", async () => {
  const db = await fixture();
  await commitStepBoundary(db, {
    taskId: "t1",
    taskPatch: { current_step_id: "review" },
    stepRun: {
      step_id: "review",
      attempt: 1,
      status: "awaiting",
      exit_code: null,
      started_at: "2026-09-18T09:00:00.000Z",
      ended_at: null,
      log_path: "",
      review_tree: null,
    },
  });
  await commitStepBoundary(db, {
    taskId: "t1",
    taskPatch: { state: "running", current_step_id: "implement" },
    stepRun: {
      step_id: "implement",
      attempt: 1,
      status: "running",
      exit_code: null,
      started_at: "2026-09-18T10:00:00.000Z",
      ended_at: null,
      log_path: "/l",
    },
  });

  await recoverOnStartup(db, probe({}), lookupWF);

  const runs = await listStepRuns(db, "t1");
  assert.equal(runs[0].status, "awaiting");
  assert.equal(runs[0].ended_at, null);
  assert.equal(runs[1].status, "interrupted");
  assert.ok(runs[1].ended_at !== null);
});
```

2件目は現実には起きない組み合わせ（`suspended` と `running` は同時に成り立たない）だが、`closeDanglingStepRun` の探索条件が `awaiting` を拾わないことを、タスクの状態に頼らず行の側だけで固定する。

- [ ] **Step 2: テストを走らせて落ちることを確かめる**

Run: `deno test --allow-all test/core/recovery.test.ts`
Expected: FAIL（`interrupted` ではなく `failed` で閉じられる）

- [ ] **Step 3: `closeDanglingStepRun` を直す**

`src/core/recovery.ts` の該当関数を差し替える（doc コメントごと）。

```ts
/**
 * 中断された時点で running のまま残っている step_runs 行を閉じる
 * （taskId につき「最後の running 行」を1つだけ、あれば）。
 *
 * 承認待ちの行は status が awaiting であり running ではないので、ここには
 * 掛からない。人を待っている最中のレビューを、デーモンの再起動だけで閉じては
 * ならない（待ち始めた時刻が失われる）。
 *
 * running の行が無ければ何もしない（呼び出し側はこれをエラー扱いしない）。
 */
async function closeDanglingStepRun(
  db: Db,
  taskId: string,
): Promise<Pick<StepBoundary, "stepRunUpdate">> {
  const runs = await listStepRuns(db, taskId);
  const dangling = [...runs].reverse().find((r) => r.status === "running");
  if (!dangling) return {};
  return {
    stepRunUpdate: {
      id: dangling.id,
      status: "interrupted",
      exit_code: null,
      ended_at: new Date().toISOString(),
    },
  };
}
```

- [ ] **Step 4: README の「既知の制約」から該当項目を消す**

`README.md` の次の項目を丸ごと削除する。

```
- **中断されたステップ実行は `failed` として閉じられる。** デーモンのクラッシュで
  `running` のまま残ったステップ実行は、復帰時に本来より正直でない `failed` になる
  （本来欲しい値は `interrupted`）。マイグレーション機構（`src/db/migrations.ts`）は
  入ったので値を足すことはできるが、SQLite で `step_runs.status` の `CHECK` 制約を
  変えるにはテーブル再構築が要るため、別の変更として残している。
```

あわせて README「5. `degraded` の意味」の後ろ、`dctl get` で状態を見る話の近くに、status の一覧を足す。

```markdown
### ステップ実行の状態

`dctl get <task-id>` の `.stepRuns[].status` が取る値。

- `running` — 実行中
- `awaiting` — `approval` ステップが人の承認・却下を待っている（1行＝レビュー1回）
- `success` / `failed` — 終わった
- `degraded` — 成功扱いだが権限拒否があった（5章）
- `interrupted` — デーモンのクラッシュで中断され、復帰時に閉じられた
```

- [ ] **Step 5: テストを走らせて通ることを確かめる**

Run: `deno test --allow-all test/core/recovery.test.ts && deno task test`
Expected: PASS

- [ ] **Step 6: 整形・型検査**

Run: `deno fmt src test && deno lint && deno task check`
Expected: 差分なし・エラーなし

- [ ] **Step 7: コミット**

```bash
git add src/core/recovery.ts test/core/recovery.test.ts README.md
git commit -m "$(cat <<'EOF'
fix(core): 中断されたステップ実行を interrupted で閉じる

デーモンのクラッシュで running のまま残った行を failed で閉じていた。値が
足せるようになったので、正直な値にする。探索条件は変えない — 承認待ちの行は
awaiting であり running ではないので、ここには掛からない。

README の「既知の制約」から該当項目を消し、ステップ実行の状態の一覧を足す。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: worktree を消すときにレビュー参照も消す

**Files:**
- Modify: `src/daemon/handlers.ts`（`worktree.remove` ハンドラ、`cleanupAfterRun`）
- Modify: `README.md`（4章に一文足す）
- Test: `test/daemon/handlers.test.ts`

**Interfaces:**
- Consumes: Task 2 の `releaseTrees(repoPath, taskId)`
- Produces: なし

- [ ] **Step 1: 失敗するテストを書く**

`test/daemon/handlers.test.ts` の末尾に足す。このファイルの `context()` / `createHandler` / `tick` / `until` / `NOOP_CONN` と、`beforeEach` が作る既定の `feature` ワークフロー（approval 1つだけ）をそのまま使う。tick を回せば本物の git worktree ができて `suspended` に入るので、参照は Task 3 の経路が実際に張ったものを見る（手で作らない）。

import に足すもの:

```ts
import { listStepRuns } from "../../src/db/stepRuns.ts";
import { reviewRefName } from "../../src/core/reviewTree.ts";
```

```ts
test("worktree を消すとそのタスクのレビュー参照も消える", async () => {
  const ctx = await context();
  const h = createHandler(ctx);
  await h("project.add", { path: repo }, NOOP_CONN);
  const t = await h("task.create", { project: repo, title: "T", prompt: "p" }, NOOP_CONN) as {
    id: string;
  };
  await tick(ctx);
  await until(async () => (await getTask(ctx.db, t.id))?.state === "suspended");
  await until(() => ctx.running.size === 0);

  const review = (await listStepRuns(ctx.db, t.id)).find((r) => r.status === "awaiting")!;
  const ref = reviewRefName(t.id, review.id);
  const before = await run("git", ["-C", repo, "for-each-ref", "--format=%(refname)", ref]);
  assert.equal(before.stdout.trim(), ref, "suspended に入った時点で参照が張られている");

  await h("worktree.remove", { task_id: t.id, force: true }, NOOP_CONN);

  const after = await run("git", [
    "-C",
    repo,
    "for-each-ref",
    "--format=%(refname)",
    "refs/doctrine/reviews",
  ]);
  assert.equal(after.stdout.trim(), "", "worktree と一緒に参照も消える");
  assert.equal((await getTask(ctx.db, t.id))?.worktree_path, null);
});

test("削除を拒否されたら参照は残す", async () => {
  const ctx = await context();
  const h = createHandler(ctx);
  await h("project.add", { path: repo }, NOOP_CONN);
  const t = await h("task.create", { project: repo, title: "T", prompt: "p" }, NOOP_CONN) as {
    id: string;
  };
  await tick(ctx);
  await until(async () => (await getTask(ctx.db, t.id))?.state === "suspended");
  await until(() => ctx.running.size === 0);
  const worktree = (await getTask(ctx.db, t.id))!.worktree_path!;
  await writeFile(join(worktree, "dirty.txt"), "未コミット\n");

  // force を付けなければ、未コミットの変更を理由に削除は拒否される。
  await assert.rejects(() => h("worktree.remove", { task_id: t.id }, NOOP_CONN));

  const after = await run("git", [
    "-C",
    repo,
    "for-each-ref",
    "--format=%(refname)",
    "refs/doctrine/reviews",
  ]);
  assert.notEqual(after.stdout.trim(), "", "worktree が残るなら基準点も残す");
});
```

- [ ] **Step 2: テストを走らせて落ちることを確かめる**

Run: `deno test --allow-all test/daemon/handlers.test.ts`
Expected: FAIL（参照が残っている）

- [ ] **Step 3: `worktree.remove` ハンドラで参照を消す**

`src/daemon/handlers.ts` の import に足す。

```ts
import { releaseTrees } from "../core/reviewTree.ts";
```

`case "worktree.remove"` の `removeWorktree(...)` の後、`commitStepBoundary(...)` の前に足す。

```ts
        // worktree が無くなればレビューの基準点を使う相手もいなくなる。
        // 参照を残すと、指しているツリーが永久に gc されない。
        await releaseTrees(project.path, taskId).catch((e: Error) => {
          ctx.warnings.push(`タスク ${taskId}: レビュー参照を消せませんでした: ${e.message}`);
        });
```

- [ ] **Step 4: `cleanupAfterRun` でも参照を消す**

`removeWorktree(...)` の直後、`commitStepBoundary(...)` の前に同じものを足す。

```ts
    await releaseTrees(project.path, taskId).catch((e: Error) => {
      ctx.warnings.push(`タスク ${taskId}: レビュー参照を消せませんでした: ${e.message}`);
    });
```

削除が拒否された（未コミットの変更が残っている）場合は `removeWorktree` が投げるので、ここには来ない。worktree が残るなら基準点も残すのが正しい。

- [ ] **Step 5: README に一文足す**

`README.md` の「4. worktree は失敗・中止時に残る」の `dctl gc` の説明の後に足す。

```markdown
worktree を消すと、そのタスクのレビュー参照（`refs/doctrine/reviews/<task-id>/`）も
一緒に消える。この参照は「レビュー時点の worktree の中身」を `git gc` から守るために
doctrine が張っているもので、worktree が無くなれば使う相手もいない。
```

- [ ] **Step 6: テストを走らせて通ることを確かめる**

Run: `deno task test`
Expected: PASS

- [ ] **Step 7: 整形・lint・型検査**

Run: `deno fmt src test && deno lint && deno task check`
Expected: 差分なし・エラーなし

- [ ] **Step 8: コミット**

```bash
git add src/daemon/handlers.ts test/daemon/handlers.test.ts README.md
git commit -m "$(cat <<'EOF'
feat(daemon): worktree を消すときにレビュー参照も消す

refs/doctrine/reviews/<task_id>/ は、レビュー時点の worktree の中身を git gc から
守るための参照。worktree が無くなれば使う相手もいないので、一緒に消す。残すと
そのツリーが永久に刈られない。

削除が拒否された場合はここに来ない（worktree が残るなら基準点も残す）。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: 完了条件を統合テストで確かめる

**Files:**
- Create: `test/integration/reviewRecord.test.ts`

**Interfaces:**
- Consumes: Task 1〜5 のすべて
- Produces: なし

issue の完了条件を、本物の git worktree の上で確かめる。Task 3 のテストは `worktree_path` が git リポジトリでないためツリーの経路を踏めていない。ここで踏む。

- [ ] **Step 1: 統合テストを書く**

```ts
import { afterEach, test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyApproval, runTask } from "../../src/core/engine.ts";
import { parseWorkflow } from "../../src/workflow/schema.ts";
import { openDb } from "../../src/db/migrate.ts";
import { getTask, insertProject, insertTask } from "../../src/db/tasks.ts";
import { listStepRuns } from "../../src/db/stepRuns.ts";
import { createWorktree } from "../../src/core/worktree.ts";
import { reviewRefName } from "../../src/core/reviewTree.ts";
import { createMockAdapter } from "../../src/adapter/mock.ts";
import { runCommand } from "../../src/util/exec.ts";
import { makeRepo } from "../helpers/repo.ts";
import type { Db } from "../../src/db/schema.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

const WORKFLOW = parseWorkflow(`
name: f
steps:
  - id: implement
    type: command
    run: "true"
  - id: review
    type: approval
    title: "見て"
    onReject:
      goto: implement
      maxAttempts: 5
`).workflow;

/** 本物の git worktree を持つ running のタスクを1件作る。 */
async function fixture(): Promise<{ db: Db; repo: string; worktree: string; logRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), "doctrine-review-"));
  roots.push(root);
  const repo = await makeRepo(root, { "a.txt": "1\n" });
  const worktree = await createWorktree({
    repoPath: repo,
    worktreePath: join(root, "wt"),
    branch: "doctrine/t1",
    baseBranch: "main",
  });
  const db = await openDb(":memory:");
  const pid = await insertProject(db, {
    path: repo,
    default_workflow: "f",
    max_concurrent: 1,
    base_branch: "main",
    setup: null,
  });
  await insertTask(db, {
    id: "t1",
    project_id: pid,
    title: "T",
    prompt: "P",
    workflow_name: "f",
    branch: "doctrine/t1",
    priority: 2,
  });
  await db.updateTable("tasks").set({ state: "running", worktree_path: worktree })
    .where("id", "=", "t1").execute();
  return { db, repo, worktree, logRoot: join(root, "logs") };
}

function deps(db: Db, logRoot: string) {
  return { db, adapter: createMockAdapter({ result: {} }), logRoot, globalLimit: 4 };
}

function resume(db: Db) {
  return db.updateTable("tasks").set({ state: "running" }).where("id", "=", "t1").execute();
}

test("2回差し戻した後、両方のコメントと時刻とそれぞれの待ち時間が DB から読める", async () => {
  const { db, logRoot } = await fixture();

  await runTask(db, "t1", WORKFLOW, deps(db, logRoot));
  await applyApproval(db, "t1", { approved: false, comment: "1回目: 命名が雑" }, WORKFLOW);
  await resume(db);
  await runTask(db, "t1", WORKFLOW, deps(db, logRoot));
  await applyApproval(db, "t1", { approved: false, comment: "2回目: テストが無い" }, WORKFLOW);

  const rows = await db.selectFrom("step_runs")
    .innerJoin("step_outputs", "step_outputs.step_run_id", "step_runs.id")
    .select([
      "step_runs.attempt",
      "step_runs.started_at",
      "step_runs.ended_at",
      "step_outputs.stdout",
    ])
    .where("step_runs.task_id", "=", "t1")
    .where("step_runs.step_id", "=", "review")
    .orderBy("step_runs.id")
    .execute();

  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.stdout), ["1回目: 命名が雑", "2回目: テストが無い"]);
  assert.deepEqual(rows.map((r) => r.attempt), [1, 2]);
  for (const r of rows) {
    assert.ok(r.ended_at !== null, "決まった時刻が残っていない");
    // 待ち時間 = ended_at - started_at。行ごとに引ける。
    assert.ok(Date.parse(r.ended_at!) - Date.parse(r.started_at) >= 0);
  }
});

test("差し戻し後の再レビューで、前回レビュー時点のツリーを引ける", async () => {
  const { db, repo, worktree, logRoot } = await fixture();

  // 1回目のレビュー時点の worktree（未追跡のファイルを含む）
  await writeFile(join(worktree, "first.txt"), "1回目\n");
  await runTask(db, "t1", WORKFLOW, deps(db, logRoot));
  const first = (await listStepRuns(db, "t1")).find((r) => r.step_id === "review")!;
  assert.ok(first.review_tree !== null, "1回目のツリーが記録されていない");

  await applyApproval(db, "t1", { approved: false, comment: "直して" }, WORKFLOW);
  await resume(db);

  // 差し戻し後に作業が進み、2回目のレビューへ
  await writeFile(join(worktree, "second.txt"), "2回目\n");
  await runTask(db, "t1", WORKFLOW, deps(db, logRoot));

  // 到達不能なオブジェクトが刈られても、参照があるので前回のツリーは生きている。
  await runCommand("git", ["-C", repo, "gc", "--prune=now"]);

  const { stdout } = await runCommand("git", [
    "-C",
    repo,
    "ls-tree",
    "-r",
    "--name-only",
    reviewRefName("t1", first.id),
  ]);
  const files = stdout.trim().split("\n").sort();
  assert.ok(files.includes("first.txt"), "前回レビュー時点のファイルが引けない");
  assert.ok(!files.includes("second.txt"), "前回レビュー時点に無かったファイルが混ざっている");
});

test("レビュー時点のツリーには未コミットの変更が入る", async () => {
  const { db, repo, worktree, logRoot } = await fixture();
  await writeFile(join(worktree, "a.txt"), "書き換えた\n"); // 追跡済み・未コミット

  await runTask(db, "t1", WORKFLOW, deps(db, logRoot));

  const run = (await listStepRuns(db, "t1")).find((r) => r.step_id === "review")!;
  const { stdout } = await runCommand("git", ["-C", repo, "show", `${run.review_tree}:a.txt`]);
  assert.equal(stdout, "書き換えた\n");
});

test("承認されたタスクも、そのレビュー時点のツリーを持つ", async () => {
  const { db, logRoot } = await fixture();
  await runTask(db, "t1", WORKFLOW, deps(db, logRoot));

  await applyApproval(db, "t1", { approved: true, comment: "" }, WORKFLOW);

  const run = (await listStepRuns(db, "t1")).find((r) => r.step_id === "review")!;
  assert.equal(run.status, "success");
  assert.ok(run.review_tree !== null);
  assert.equal((await getTask(db, "t1"))!.state, "completed");
});
```

- [ ] **Step 2: テストを走らせる**

Run: `deno test --allow-all test/integration/reviewRecord.test.ts`
Expected: PASS（4件）

落ちた場合は、Task 1〜5 のどこが足りないかを特定してから直す。**テストの期待値を先に緩めない** — これは issue の完了条件そのもの。

- [ ] **Step 3: 全体を通す**

Run: `deno fmt src test && deno lint && deno task check && deno task test`
Expected: すべて PASS

- [ ] **Step 4: コミット**

```bash
git add test/integration/reviewRecord.test.ts
git commit -m "$(cat <<'EOF'
test: issue #43 の完了条件を本物の worktree で確かめる

- 2回差し戻した後、両方のコメントと時刻、それぞれの待ち時間が DB から読める
- 差し戻し後の再レビューで、前回レビュー時点のツリーを引ける（git gc の後も）

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## 仕上げ

- [ ] **`dctl` で手を動かして確かめる**

```bash
deno task install
dctld &
# 適当なリポジトリで approval を含むワークフローを作り、タスクを1件流す
dctl add --project /path/to/repo --title "試す" --prompt "..."
# suspended になったら
dctl get <task-id>   # .stepRuns に status "awaiting" の行があり、ended_at が null
dctl reject <task-id> --comment "1回目"
# 再び suspended になったら
dctl reject <task-id> --comment "2回目"
dctl get <task-id>   # review の行が2つ、attempt 1 と 2、両方 ended_at を持つ
git -C /path/to/repo for-each-ref refs/doctrine/reviews/<task-id>
```

- [ ] **PR を作る**

```bash
git push -u origin todokr/1-1
gh pr create --base develop --title "レビュー1回を1件の記録として残す" --body "$(cat <<'EOF'
## 何を

approval ステップの step_run 1件 = レビュー1回になるよう記録を作り直した。
待ち始めた時刻・すべての差し戻しコメント・その時点の worktree のツリーが DB から読める。

closes #43

## どう

- `step_runs.status` に `awaiting`（承認待ち）を足し、`suspended` に入る時点で行を立てて決定時に閉じる
- `step_outputs` の主キーを `step_run_id` に変え、すべての回のコメントを残す。`{{ steps.<id>.stdout }}` は今までどおり最新の実行を指す
- `step_runs.review_tree` に `suspended` 突入時の worktree 全体（未コミット・未追跡を含む）のツリーを記録し、`refs/doctrine/reviews/<task_id>/<step_run_id>` で `git gc` から守る。worktree を消すときに参照も消す
- CHECK 制約の再構築が要るので、README「既知の制約」の `interrupted` も同じマイグレーション（`0003`）に乗せた

設計は [`docs/superpowers/specs/2026-09-18-review-record-design.md`](docs/superpowers/specs/2026-09-18-review-record-design.md)。

## 範囲外

読み出しの RPC は #44（`task.diff`）と #45（`task.context`）。

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
