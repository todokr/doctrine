# PR のマージを待ち、conflict を都度直す 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** open-pr の後で PR のマージを待ち、develop と conflict したら同じ worktree で直して push し直す。マージされたらタスクを completed にする。

**Architecture:** 新しいステップ型 `poll` が、判定コマンドを一定間隔で実行する。「まだ」のときはタスクを新しい状態 `waiting` にし、`waiting_until` の時刻が来たら tick が `queued` に戻す（`rate_limited` と同じ、スケジューラ駆動の待ち）。conflict の解決は、`open-pr` の前に置いた `sync`（agent）で行い、`wait-merge` の失敗分岐は `goto sync` にする。`onFailure.onExhausted: suspend` を足して、上限に達したら failed ではなく人の承認待ちにする。

**Tech Stack:** Deno + Kysely + SQLite（core）、React + Vite + Vitest（app）、YAML ワークフロー、`gh` CLI

**Spec:** `docs/superpowers/specs/2026-09-22-merge-wait-design.md`

## Global Constraints

- 後方互換の仕掛けは作らない。型や名前を変えたら、参照を全部書き換えて終える
- コードコメントには、そのコード固有の事実だけを書く。一般原則は spec に書く
- コメント・エラーメッセージ・テスト名は日本語。周りのコードの書き方に合わせる
- poll の終了コード: `0` 済み / `75` まだ / `2` 諦める（canceled）/ それ以外は失敗
- `interval` の既定は `1m`、下限は `30s`。書式は `<整数><s|m|h>`
- `waiting` は全体枠を持たず、プロジェクト枠を持つ
- 待ちから再開した実行は attempt を進めず、新しい step_run の行も足さない（前の行を `running` に戻して使い直す）
- 取り込みは `git merge origin/develop`。rebase はしない
- 検証コマンド: core は `mise run core:check` と `mise run core:test`、app は `mise run app:test` と `mise run app:build`
- コミットメッセージは日本語の一行。末尾に `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`

## 並びと区切り

| Part | タスク | ここまでで成り立つこと |
| --- | --- | --- |
| A コア | 1〜5 | `poll` と `onExhausted` がエンジンで動く。既定ワークフローはまだ使っていない |
| B ワークフロー | 6 | doctrine 自身の既定ワークフローがマージ待ちをする |
| C アプリ | 7 | マージ待ちと、上限に達したときの承認がアプリで分かる |

アプリの型（`shared/protocol.ts` の union）は core と共有しているので、状態やステップ型を足したタスクで、アプリ側の網羅的な `Record` も同時に足す。そうしないと `app:build` が落ちる。見せ方（サイドバーの区分や説明文）は Task 7 にまとめる。

---

### Task 1: 状態 `waiting` とマイグレーション 0012

**Files:**
- Modify: `core/src/domain/states.ts`
- Modify: `core/src/db/schema.ts`（`TaskState`、`StepRunStatus`、`TasksTable.waiting_until`、`TaskRow` の `waiting_until`）
- Modify: `core/src/db/migrations.ts`（`0012_waiting` を末尾に足す）
- Modify: `core/src/db/boundary.ts`（`taskPatch` に `waiting_until`）
- Modify: `shared/protocol.ts`（`TaskState`、`StepRun.status`、`TaskSummary.waiting_until`）
- Modify: `app/src/types.ts`、`app/src/model.ts`（`TASK_STATES`、`RUN_PILL`）、`app/src/components/TaskView.tsx`（`STATE_PILL`）、`app/src/components/WorkflowRail.tsx`（`STATUS_CLASS`）
- Test: `core/test/domain/states.test.ts`、`core/test/db/migrate.test.ts`、`app/src/model.test.ts`、`app/src/worktrees.test.ts`

**Interfaces:**
- Produces: `TaskState` に `"waiting"`、`StepRunStatus` に `"waiting"`、`TaskRow.waiting_until: string | null`、`StepBoundary["taskPatch"]` の `waiting_until`

- [ ] **Step 1: 遷移のテストを書く**

`core/test/domain/states.test.ts` の rate_limited のテスト群の後ろに足す:

```ts
test("running から waiting へ入り、解放で queued に戻れる", () => {
  assert.ok(canTransition("running", "waiting"));
  assert.ok(canTransition("waiting", "queued"));
});

test("マージ待ちのタスクも人の操作と tick の失敗経路で外へ出られる", () => {
  for (const to of ["paused", "canceled", "failed"] as const) {
    assert.ok(canTransition("waiting", to), `waiting -> ${to}`);
  }
});

test("waiting から直接 running / suspended / completed へは行けない", () => {
  for (const to of ["running", "suspended", "completed"] as const) {
    assert.equal(canTransition("waiting", to), false, `waiting -> ${to}`);
  }
});
```

既存の「全体枠を握るのは running だけ」の配列に `"waiting"` を足す。「プロジェクト枠は suspended / paused / rate_limited でも保持される」は名前を「プロジェクト枠は suspended / paused / rate_limited / waiting でも保持される」に変え、1つ目の配列に `"waiting"` を足す。

- [ ] **Step 2: 失敗を確認する**

Run: `mise run core:test`
Expected: FAIL（`"waiting"` が `TaskState` に無いという型エラー）

- [ ] **Step 3: 状態と型を足す**

`core/src/db/schema.ts`: `TaskState` に `| "waiting"`、`StepRunStatus` に `| "waiting"` を足す。`rate_limited_until` の隣（`TasksTable` と `TaskRow` の両方）に次を足す:

```ts
  /** state が waiting の間だけ入る、次に確かめる時刻（ISO 8601）。 */
  waiting_until: string | null;
```

`core/src/domain/states.ts`:

```ts
  running: [
    "suspended",
    "paused",
    "completed",
    "failed",
    "canceled",
    "queued",
    "rate_limited",
    "waiting",
  ],
  ...
  /** poll ステップが「まだ」と答えた。解放（tick）と task.resume が queued へ戻す。 */
  waiting: ["queued", "paused", "canceled", "failed"],
```

`holdsProjectSlot` を次にする:

```ts
export function holdsProjectSlot(s: TaskState): boolean {
  return s === "running" || s === "suspended" || s === "paused" || s === "rate_limited" ||
    s === "waiting";
}
```

同じ関数の docstring の「suspended / paused / rate_limited のタスクは」を「suspended / paused / rate_limited / waiting のタスクは」にする。

`core/src/db/boundary.ts` の `taskPatch` の `Pick` に `| "waiting_until"` を足す。

- [ ] **Step 4: マイグレーションのテストを書く**

`core/test/db/migrate.test.ts` の、マイグレーション名を並べている2つの配列の末尾に `"0012_waiting"` を足す。ファイル末尾に足す:

```ts
test("0012: tasks.state と step_runs.status が waiting を受け付け、waiting_until が足される", async () => {
  const d = await openDb(":memory:");
  const pid = await insertProject(d, {
    path: "/repo",
    default_workflow: "f",
    max_concurrent: 1,
    base_branch: "main",
    setup: null,
  });
  await insertTask(d, {
    id: "t1",
    project_id: pid,
    title: "T",
    prompt: "P",
    workflow_name: "f",
    branch: "b",
    priority: 2,
  });
  await d.updateTable("tasks").set({ state: "waiting", waiting_until: "2026-09-22T00:01:00.000Z" })
    .where("id", "=", "t1").execute();
  await d.insertInto("step_runs").values({
    task_id: "t1",
    step_id: "wait-merge",
    attempt: 1,
    status: "waiting",
    exit_code: 75,
    started_at: "2026-09-22T00:00:00.000Z",
    ended_at: "2026-09-22T00:00:01.000Z",
    log_path: "",
  }).execute();
  const t = (await getTask(d, "t1"))!;
  assert.equal(t.state, "waiting");
  assert.equal(t.waiting_until, "2026-09-22T00:01:00.000Z");
});

test("0012: 作り直しても既存の行・索引・外部キーが残る", async () => {
  const d = await openDbOn(legacyWithChildren());
  const t = (await getTask(d, "t1"))!;
  assert.equal(t.waiting_until, null, "新しい列は NULL で足される");
  const outputs = await d.selectFrom("step_outputs").selectAll().execute();
  assert.deepEqual(outputs.map((o) => [o.step_run_id, o.last_stdout]), [[1, "out"]]);
  const { rows } = await sql<{ name: string }>`
    SELECT name FROM sqlite_master WHERE type='index' AND tbl_name IN ('tasks','step_runs')
      AND name LIKE 'idx_%' ORDER BY name
  `.execute(d);
  assert.ok(rows.some((r) => r.name === "idx_tasks_state"));
  assert.ok(rows.some((r) => r.name === "idx_step_runs_task"));
  const { rows: violations } = await sql`PRAGMA foreign_key_check`.execute(d);
  assert.deepEqual(violations, []);
});
```

（`legacyWithChildren` はこのファイルに既にある 0005 用の fixture。`insertProject` / `insertTask` / `getTask` / `sql` の import が無ければ足す。）

- [ ] **Step 5: 0012 を書く**

0005 のように列を書き写すと、0009 と 0011 で増えた tasks の列と CHECK を落としやすい。そこで `sqlite_master` にある今の CREATE 文から CHECK の値だけを差し替えて作り直す。`migrations.ts` の `migrations` の前にヘルパーを置く:

```ts
/**
 * 今の CREATE 文の CHECK の値の並びだけを差し替えて、表を作り直す。
 * 列の定義を書き写さないので、前のマイグレーションで ALTER が足した列や CHECK を落とさない。
 * 呼ぶ前に外部キーの検査を止めておくこと（0005 と同じ理由）。
 */
// deno-lint-ignore no-explicit-any
async function rebuildWithCheck(db: Kysely<any>, table: string, from: string, to: string) {
  const { rows } = await sql<{ sql: string }>`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ${table}
  `.execute(db);
  const ddl = rows[0]?.sql;
  if (!ddl || !ddl.includes(from)) {
    throw new Error(`${table} の CHECK が想定と違います: ${ddl}`);
  }
  const indexes = (await sql<{ sql: string }>`
    SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ${table} AND sql IS NOT NULL
  `.execute(db)).rows.map((r) => r.sql);

  const created = ddl.replace(from, to)
    .replace(/^CREATE TABLE\s+("?)\w+\1/, `CREATE TABLE "${table}_new"`);
  await sql.raw(created).execute(db);
  await sql.raw(`INSERT INTO "${table}_new" SELECT * FROM "${table}"`).execute(db);
  await sql.raw(`DROP TABLE "${table}"`).execute(db);
  await sql.raw(`ALTER TABLE "${table}_new" RENAME TO "${table}"`).execute(db);
  for (const index of indexes) await sql.raw(index).execute(db);
}
```

`migrations` の末尾（`0011_task_workflow_pin` の後）に足す:

```ts
  /**
   * マージ待ち（spec 2026-09-22-merge-wait-design.md 3 章）。tasks.state と step_runs.status に
   * 'waiting' を足し、次に確かめる時刻を tasks.waiting_until に持つ。
   * 外部キーの止め方と確かめ方は 0005 と同じ。
   */
  "0012_waiting": {
    // deno-lint-ignore no-explicit-any
    async up(db: Kysely<any>) {
      await sql`PRAGMA foreign_keys = OFF`.execute(db);
      await sql`PRAGMA defer_foreign_keys = ON`.execute(db);

      await rebuildWithCheck(db, "tasks", "'paused','rate_limited'", "'paused','rate_limited','waiting'");
      await rebuildWithCheck(
        db,
        "step_runs",
        "'rate_limited','bounced'",
        "'rate_limited','bounced','waiting'",
      );
      await db.schema.alterTable("tasks").addColumn("waiting_until", "text").execute();

      const violations = await sql<{ table: string }>`PRAGMA foreign_key_check`.execute(db);
      await sql`PRAGMA foreign_keys = ON`.execute(db);
      if (violations.rows.length > 0) {
        throw new Error(
          `外部キーが壊れています: ${violations.rows.map((r) => r.table).join(", ")}`,
        );
      }
    },
  },
```

- [ ] **Step 6: core のテストを通す**

Run: `mise run core:check && mise run core:test`
Expected: PASS。型エラーが出たら、`TaskState` や `StepRunStatus` を網羅している `Record` や `switch` に `waiting` を足す（`grep -rn "rate_limited" core/src` で当たる箇所のうち、状態の一覧を並べているところ）。

- [ ] **Step 7: 共有の型とアプリの網羅を足す**

`shared/protocol.ts`:
- `TaskState` に `| "waiting"`
- `StepRun.status` に `| "waiting"`。docstring を「bounced は差し戻し、rate_limited は利用上限で打ち切られ再開待ち、waiting は poll が『まだ』と答えた待ちの1周」にする
- `TaskSummary` の `rate_limited_until` の下に `/** state が waiting の間だけ入る、次に確かめる時刻（ISO 8601）。 */ waiting_until: string | null;`

`app/src/types.ts` の `TaskState` に `| "waiting"`。`app/src/model.ts` の `TASK_STATES` に `"waiting"` を足し、`RUN_PILL` に `waiting: ["マージ待ち", "p-muted"],` を足す。`app/src/components/TaskView.tsx` の `STATE_PILL` に `waiting: ["マージ待ち", "p-muted"],` を足す。`app/src/components/WorkflowRail.tsx` の `STATUS_CLASS` に `waiting: "wr-muted",` を足す。

`app/src/model.test.ts` と `app/src/worktrees.test.ts` で全状態を並べている配列（`model.test.ts` の 157 行付近と 514 行付近、`worktrees.test.ts` の 87 行付近）に `"waiting"` を足す。157 行付近は「一時停止を出さない状態」の一覧なので、Task 7 で `canPause` を変えるまでは `"waiting"` をここに置く。

`app/src/fixtures.ts` などで `TaskSummary` の値を組み立てている箇所があれば `waiting_until: null` を足す（`mise run app:build` の型エラーで場所が分かる）。

- [ ] **Step 8: app を通す**

Run: `mise run app:test && mise run app:build`
Expected: PASS

- [ ] **Step 9: コミット**

```bash
git add core/src core/test shared/protocol.ts app/src
git commit -m "タスクの状態に waiting を足す"
```

---

### Task 2: スケジューラと人の操作が waiting を扱う

**Files:**
- Modify: `core/src/domain/scheduler.ts`（`currentUsage` の状態一覧、`releaseDueWaiting` を足す）
- Modify: `core/src/daemon/handlers.ts`（`tickOnce` で解放、`task.resume` の許可状態）
- Test: `core/test/domain/scheduler.test.ts`

**Interfaces:**
- Consumes: Task 1 の `TaskState "waiting"`、`waiting_until`
- Produces: `releaseDueWaiting(db: Db, now?: Date): Promise<string[]>`

- [ ] **Step 1: テストを書く**

`core/test/domain/scheduler.test.ts` に、`addRateLimited` の隣に helper を足す:

```ts
async function addWaiting(d: Db, p: number, id: string, until = "2026-09-22T03:20:00.000Z") {
  await add(d, p, id, { state: "waiting" });
  await d.updateTable("tasks").set({ waiting_until: until }).where("id", "=", id).execute();
}

test("waiting は全体枠を数えず、プロジェクト枠は数える", async () => {
  const { d, p } = await fixture(2);
  await addWaiting(d, p, "w");
  const usage = await currentUsage(d);
  assert.equal(usage.global, 0);
  assert.equal(usage.byProject.get(p), 1, "PR を開いたままの worktree を握っている");
});

test("期限の来た waiting だけを queued に戻す", async () => {
  const { d, p } = await fixture(3);
  await addWaiting(d, p, "late", "2026-09-22T05:00:00.000Z");
  await addWaiting(d, p, "early", "2026-09-22T03:20:00.000Z");
  assert.deepEqual(await releaseDueWaiting(d, new Date("2026-09-22T04:00:00.000Z")), ["early"]);
  const t = (await getTask(d, "early"))!;
  assert.equal(t.state, "queued");
  assert.equal(t.waiting_until, null);
  assert.equal(t.resumed, 1, "進行中の仕事として行列の先頭に入る");
  assert.equal((await getTask(d, "late"))?.state, "waiting");
});
```

import に `releaseDueWaiting` を足す。

- [ ] **Step 2: 失敗を確認する**

Run: `mise run core:test`
Expected: FAIL（`releaseDueWaiting` が無い。枠のテストは `usage.byProject.get(p)` が `undefined`）

- [ ] **Step 3: 実装する**

`scheduler.ts` の `currentUsage` の `.where("state", "in", [...])` に `"waiting"` を足す。`releaseDueRateLimited` の後ろに足す:

```ts
/**
 * 期限の来たマージ待ちを queued に戻す。戻したタスクのidを返す（配るのは呼び出し側）。
 * 待ち方は releaseDueRateLimited と同じで、runTask の中では sleep しない。
 */
export async function releaseDueWaiting(db: Db, now: Date = new Date()): Promise<string[]> {
  const due = await db.selectFrom("tasks").select("id")
    .where("state", "=", "waiting")
    .where("waiting_until", "<=", now.toISOString())
    .orderBy("waiting_until", "asc")
    .execute();

  const released: string[] = [];
  for (const { id } of due) {
    try {
      await commitStepBoundary(db, {
        taskId: id,
        requireState: "waiting",
        taskPatch: { state: "queued", resumed: 1, waiting_until: null },
      });
      released.push(id);
    } catch (e) {
      if (!(e instanceof StateConflictError)) throw e;
    }
  }
  return released;
}
```

`handlers.ts` の `tickOnce` で、`releaseDueRateLimited` のループの直後に足す:

```ts
  for (const taskId of await releaseDueWaiting(ctx.db)) {
    ctx.broadcast({ event: "task.stateChanged", task_id: taskId, from: "waiting", to: "queued" });
  }
```

import に `releaseDueWaiting` を足す。`task.resume` の許可条件に `task.state !== "waiting"` を足し、`taskPatch` を `{ state: "queued", resumed: 1, rate_limited_until: null, waiting_until: null }` にする。その直前のコメントを「上限待ち・マージ待ちからの再開は、人が『待たずに今やれ』と言ったということ。期限を消さないと、次の tick が同じ行をもう一度解放しようとする。」にする。

`task.pause` と `task.cancel` は `assertTransition` を通すので、Task 1 の遷移表で `waiting` から出られる。変更は要らない。`recovery.ts` は `running` のタスクだけを見るので、`waiting` はデーモンを再起動しても残る。これも変更は要らない。

- [ ] **Step 4: 通す**

Run: `mise run core:check && mise run core:test`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add core/src/domain/scheduler.ts core/src/daemon/handlers.ts core/test/domain/scheduler.test.ts
git commit -m "期限の来たマージ待ちを tick で queued に戻す"
```

---

### Task 3: ワークフロー定義に `poll` と `onExhausted` を足す

**Files:**
- Modify: `core/src/workflow/schema.ts`
- Modify: `core/src/daemon/handlers.ts`（`toStepViews`）
- Modify: `shared/protocol.ts`（`StepView.type`）
- Test: `core/test/workflow/schema.test.ts`

**Interfaces:**
- Produces:
  - `type PollStep = { id: string; type: "poll"; run: string; interval: string; onFailure?: Branch }`（`interval` はパース後に既定値 `"1m"` で埋まる）
  - `type Branch = { goto: string; maxAttempts: number; feed?: string; onExhausted?: "fail" | "suspend" }`
  - `function intervalMs(interval: string): number`（書式違いと下限割れは投げる）
  - `export const DEFAULT_POLL_INTERVAL = "1m"`、`export const MIN_POLL_INTERVAL_MS = 30_000`
  - `Step` の union に `PollStep`

- [ ] **Step 1: テストを書く**

`core/test/workflow/schema.test.ts` に足す（import に `intervalMs`、`type PollStep` を足す）:

```ts
test("poll ステップは interval を省略すると 1m になる", () => {
  const { workflow } = parseWorkflow(`
name: f
steps:
  - id: wait
    type: poll
    run: "exit 0"
`);
  const step = workflow.steps[0] as PollStep;
  assert.equal(step.type, "poll");
  assert.equal(step.interval, "1m");
});

test("interval は 30 秒未満や読めない書式を弾く", () => {
  for (const bad of ["10s", "1d", "5", "m"]) {
    assert.throws(
      () =>
        parseWorkflow(`
name: f
steps:
  - id: wait
    type: poll
    run: "exit 0"
    interval: "${bad}"
`),
      WorkflowValidationError,
      bad,
    );
  }
});

test("intervalMs は s / m / h をミリ秒にする", () => {
  assert.equal(intervalMs("30s"), 30_000);
  assert.equal(intervalMs("5m"), 300_000);
  assert.equal(intervalMs("2h"), 7_200_000);
});

test("onExhausted は fail / suspend だけを受け付ける", () => {
  const yaml = (v: string) => `
name: f
steps:
  - id: a
    type: command
    run: "true"
  - id: b
    type: command
    run: "false"
    onFailure: { goto: a, maxAttempts: 2, onExhausted: ${v} }
`;
  assert.equal(branchOf(parseWorkflow(yaml("suspend")).workflow.steps[1])?.onExhausted, "suspend");
  assert.throws(() => parseWorkflow(yaml("retry")), WorkflowValidationError);
});

test("poll ステップの二重に効くコマンドにも警告を出し、gh pr comment も対象にする", () => {
  const { warnings } = parseWorkflow(`
name: f
steps:
  - id: a
    type: command
    run: "gh pr comment --body x"
  - id: wait
    type: poll
    run: "git push"
`);
  assert.equal(warnings.length, 2);
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `mise run core:test`
Expected: FAIL（`intervalMs` / `PollStep` が無い）

- [ ] **Step 3: 実装する**

`schema.ts`:

```ts
export type Branch = {
  goto: string;
  maxAttempts: number;
  feed?: string;
  /** maxAttempts を使い切ったとき。suspend なら failed にせず人の承認を待つ（省略時 fail）。 */
  onExhausted?: "fail" | "suspend";
};
/**
 * 判定コマンドを interval ごとに実行して待つステップ。終了コードの意味は
 * 0 済み / 75 まだ / 2 諦める（canceled）/ それ以外は失敗。
 */
export type PollStep = {
  id: string;
  type: "poll";
  run: string;
  interval: string;
  onFailure?: Branch;
};
export type Step = CommandStep | AgentStep | ApprovalStep | GuideStep | PollStep;

export const DEFAULT_POLL_INTERVAL = "1m";
export const MIN_POLL_INTERVAL_MS = 30_000;
const INTERVAL_UNITS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000 };

/** "30s" / "5m" / "2h" をミリ秒にする。書式が違うか下限を割れば投げる。 */
export function intervalMs(interval: string): number {
  const m = /^(\d+)([smh])$/.exec(interval);
  if (!m) throw new Error(`interval は 30s / 5m / 2h のように書いてください: ${interval}`);
  const ms = Number(m[1]) * INTERVAL_UNITS[m[2]];
  if (ms < MIN_POLL_INTERVAL_MS) throw new Error(`interval は 30s 以上にしてください: ${interval}`);
  return ms;
}
```

`branch` の zod に `onExhausted: z.enum(["fail", "suspend"]).optional(),` を足す。`stepSchema` の union に足す:

```ts
  z.object({
    id: stepId,
    type: z.literal("poll"),
    run: z.string().min(1),
    interval: z.string().default(DEFAULT_POLL_INTERVAL).refine((v) => {
      try {
        intervalMs(v);
        return true;
      } catch {
        return false;
      }
    }, "interval は 30s 以上で、30s / 5m / 2h のように書いてください"),
    onFailure: branch.optional(),
  }).strict(),
```

`NON_IDEMPOTENT` に `/\bgh\s+pr\s+comment\b/,` を足す。`parseWorkflow` の警告ループの `if (step.type !== "command") continue;` を `if (step.type !== "command" && step.type !== "poll") continue;` にし、メッセージの「command ステップは」を「command / poll ステップは」にする。

`shared/protocol.ts` の `StepView.type` に `| "poll"` を足す。`handlers.ts` の `toStepViews` は `branchOf` で分岐を拾うので変更は要らない（`step.type` をそのまま入れている）。

`branchOf` の docstring の「approval は onReject、それ以外（command / agent / guide）は onFailure」を「approval は onReject、それ以外（command / agent / guide / poll）は onFailure」にする。

- [ ] **Step 4: 通す**

Run: `mise run core:check && mise run core:test && mise run app:test && mise run app:build`
Expected: core の型エラーが出る（`engine.ts` の `step.type` の分岐が poll を知らない）。runTask の `else`（agent 扱い）に poll が落ちないよう、`engine.ts` の実行分岐の直前に一時的に次を置いて通す。Task 4 で置き換える:

```ts
    if (step.type === "poll") throw new Error("poll ステップはまだ実行できません");
```

app 側で `StepView["type"]` を網羅している箇所があれば `poll` を足す（`grep -rn "\"guide\"" app/src`）。

- [ ] **Step 5: コミット**

```bash
git add core/src shared/protocol.ts core/test/workflow/schema.test.ts app/src
git commit -m "ワークフロー定義に poll ステップと onExhausted を足す"
```

---

### Task 4: poll ステップを実行する

**Files:**
- Modify: `core/src/domain/stepRunner.ts`（`runCommandStep` の引数を `{ id: string; run: string }` にする）
- Create: `core/src/domain/poll.ts`
- Modify: `core/src/db/boundary.ts`（`stepRunReopen`）
- Modify: `core/src/domain/engine.ts`
- Test: `core/test/domain/poll.test.ts`、`core/test/domain/engine.test.ts`、`core/test/db/boundary.test.ts`

**Interfaces:**
- Consumes: Task 1〜3 の `waiting`、`waiting_until`、`PollStep`、`intervalMs`
- Produces:
  - `type PollVerdict = "done" | "wait" | "abandon" | "failed"`
  - `function pollVerdict(exitCode: number | null): PollVerdict`
  - `export const POLL_WAIT = 75`、`export const POLL_ABANDON = 2`
  - `StepBoundary.stepRunReopen?: { id: number }`（`status = 'running'`、`ended_at = NULL`、`exit_code = NULL` に戻す。返り値の stepRunId はこの id）

- [ ] **Step 1: 判定の純関数のテストを書く**

`core/test/domain/poll.test.ts`:

```ts
import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { pollVerdict } from "../../src/domain/poll.ts";

test("poll の終了コードを判定に写す", () => {
  assert.equal(pollVerdict(0), "done");
  assert.equal(pollVerdict(75), "wait");
  assert.equal(pollVerdict(2), "abandon");
  assert.equal(pollVerdict(1), "failed");
  assert.equal(pollVerdict(null), "failed", "起動できなかった・シグナルで落ちた");
});
```

- [ ] **Step 2: 実装する**

`core/src/domain/poll.ts`:

```ts
/** poll ステップの終了コードの意味（spec 2026-09-22-merge-wait-design.md 3 章）。 */
export const POLL_WAIT = 75;
export const POLL_ABANDON = 2;

export type PollVerdict = "done" | "wait" | "abandon" | "failed";

export function pollVerdict(exitCode: number | null): PollVerdict {
  if (exitCode === 0) return "done";
  if (exitCode === POLL_WAIT) return "wait";
  if (exitCode === POLL_ABANDON) return "abandon";
  return "failed";
}
```

Run: `mise run core:test` → poll.test.ts が PASS

- [ ] **Step 3: 行を使い直す口のテストを書く**

`core/test/db/boundary.test.ts` の既存 fixture を使って足す（fixture 名はファイル冒頭に合わせる）:

```ts
test("stepRunReopen は閉じた行を running に戻し、その id を返す", async () => {
  // fixture で t1 と、status waiting・ended_at あり・exit_code 75 の step_run を1行作る
  const id = await commitStepBoundary(db, {
    taskId: "t1",
    taskPatch: {},
    stepRunReopen: { id: runId },
  });
  assert.equal(id, runId);
  const row = (await getStepRun(db, runId))!;
  assert.equal(row.status, "running");
  assert.equal(row.ended_at, null);
  assert.equal(row.exit_code, null);
});
```

- [ ] **Step 4: 実装する**

`boundary.ts` の `StepBoundary` に足す:

```ts
  /**
   * poll の待ちから戻ったとき: 閉じた waiting の行を running に戻して使い直す。
   * 待ちの1周に1行にするため、新しい行は足さない。
   */
  stepRunReopen?: { id: number };
```

`commitStepBoundary` の `if (b.stepRunUpdate)` の前に足す:

```ts
    if (b.stepRunReopen) {
      await trx.updateTable("step_runs")
        .set({ status: "running", ended_at: null, exit_code: null })
        .where("id", "=", b.stepRunReopen.id)
        .execute();
      stepRunId = b.stepRunReopen.id;
    }
```

Run: `mise run core:test` → boundary.test.ts が PASS

- [ ] **Step 5: エンジンのテストを書く**

`core/test/domain/engine.test.ts` の上限待ちのテスト群の後ろに足す。判定コマンドは worktree のファイルで結果を切り替える（import に `releaseDueWaiting` を足す）:

```ts
const POLL_WF = `
name: f
steps:
  - id: wait
    type: poll
    run: "exit $(cat verdict)"
    interval: 30s
  - id: after
    type: command
    run: "true"
`;

test("poll が 75 なら waiting で待ち、期限で戻ると同じ行を使い直して attempt を進めない", async () => {
  const { db, root, workflow } = await taskFixture(POLL_WF);
  const deps = { db, adapter: createMockAdapter({ result: {} }), logRoot: join(root, "logs"), globalLimit: 4 };
  writeFileSync(join(root, "verdict"), "75");

  await runTask(db, "t1", workflow, deps);
  const waiting = (await getTask(db, "t1"))!;
  assert.equal(waiting.state, "waiting");
  assert.ok(Date.parse(waiting.waiting_until!) - Date.now() > 25_000, "interval ぶん先");

  // 2周目も「まだ」
  assert.deepEqual(await releaseDueWaiting(db, new Date(Date.parse(waiting.waiting_until!) + 1)), ["t1"]);
  await toRunning(db, "t1");
  await runTask(db, "t1", workflow, deps);
  assert.equal((await getTask(db, "t1"))?.state, "waiting");

  // 3周目でマージされた
  writeFileSync(join(root, "verdict"), "0");
  await releaseDueWaiting(db, new Date(Date.now() + 60_000));
  await toRunning(db, "t1");
  await runTask(db, "t1", workflow, deps);

  const t = (await getTask(db, "t1"))!;
  assert.equal(t.state, "completed");
  const runs = (await listStepRuns(db, "t1")).filter((r) => r.step_id === "wait");
  assert.deepEqual(runs.map((r) => [r.status, r.attempt]), [["success", 1]], "待ちの1周は1行");
  assert.equal(JSON.parse(t.attempt_counts).wait, 1);
});

test("poll が 2 なら分岐せずに canceled になり、行は interrupted で閉じる", async () => {
  const { db, root, workflow } = await taskFixture(POLL_WF);
  writeFileSync(join(root, "verdict"), "2");
  await runTask(db, "t1", workflow, {
    db,
    adapter: createMockAdapter({ result: {} }),
    logRoot: join(root, "logs"),
    globalLimit: 4,
  });
  assert.equal((await getTask(db, "t1"))?.state, "canceled");
  assert.deepEqual((await listStepRuns(db, "t1")).map((r) => r.status), ["interrupted"]);
});

test("poll がそれ以外で落ちたら onFailure へ差し戻す", async () => {
  const { db, root, workflow } = await taskFixture(`
name: f
steps:
  - id: fix
    type: command
    run: "echo 0 > verdict"
  - id: wait
    type: poll
    run: "exit $(cat verdict)"
    onFailure: { goto: fix, maxAttempts: 3 }
`);
  writeFileSync(join(root, "verdict"), "1");
  // wait から始め、1回目は落ちて fix へ戻る。fix が verdict を 0 にするので2回目は通る
  await db.updateTable("tasks").set({ current_step_id: "wait" }).where("id", "=", "t1").execute();
  await runTask(db, "t1", workflow, {
    db,
    adapter: createMockAdapter({ result: {} }),
    logRoot: join(root, "logs"),
    globalLimit: 4,
  });
  assert.equal((await getTask(db, "t1"))?.state, "completed");
  assert.deepEqual(
    (await listStepRuns(db, "t1")).map((r) => [r.step_id, r.status]),
    [["wait", "bounced"], ["fix", "success"], ["wait", "success"]],
  );
});
```

- [ ] **Step 6: 失敗を確認する**

Run: `mise run core:test`
Expected: FAIL（Task 3 で置いた「poll ステップはまだ実行できません」）

- [ ] **Step 7: 実装する**

`stepRunner.ts` の `runCommandStep` の第1引数を `step: Pick<CommandStep, "id" | "run">` にする（中身は `step.run` と `step.id` しか使っていない）。

`engine.ts`:

1. Task 3 で置いた `throw` を消す。
2. `resumingAfterRateLimit` を求めている箇所を、直前の行を1回だけ引く形にする:

```ts
    // 上限待ち・マージ待ちから戻ってきた実行は、ワークフロー上の新しい試行ではない。カウンタは
    // 持たず、直前の step_run の status から導く（デーモンの再起動をまたいでも同じ）。
    // 進めてしまうと onFailure / onReject の maxAttempts を待ちが食い潰す。
    const lastRun = await lastStepRunFor(db, taskId, step.id);
    const resumingAfterRateLimit = lastRun?.status === "rate_limited";
    // マージ待ちは待ちの1周を1行にする（spec 3 章）。閉じた waiting の行をそのまま使い直す。
    const reopenRunId = step.type === "poll" && lastRun?.status === "waiting" ? lastRun.id : null;
    const keepAttempt = resumingAfterRateLimit || reopenRunId !== null;
    const attempt = attemptCount(task, step.id) + (keepAttempt ? 0 : 1);
```

3. ステップ開始の `commitStepBoundary` で、`attempt_counts: keepAttempt ? task.attempt_counts : withAttempt(task, step.id)` にし、`stepRun` と `stepRunReopen` を出し分ける:

```ts
        ...(reopenRunId !== null
          ? { stepRunReopen: { id: reopenRunId } }
          : {
            stepRun: {
              step_id: step.id,
              attempt,
              status: "running",
              exit_code: null,
              started_at: new Date().toISOString(),
              ended_at: null,
              log_path: logPath,
            },
          }),
```

4. 実行の分岐の先頭で poll も `runCommandStep` に渡す:

```ts
    if (step.type === "command" || step.type === "poll") {
      outcome = await runCommandStep(step, ctx, { cwd: task.worktree_path!, taskId, attempt, deps: runnerDeps });
    } else if (step.type === "guide") {
```

5. `const verdict: RateLimitDecision = ...` の直後に、poll の「まだ」と「諦める」を扱う分岐を置く。`import { pollVerdict } from "./poll.ts";` と、schema.ts からの `intervalMs` の import を足す:

```ts
    const polled = step.type === "poll" ? pollVerdict(outcome.exitCode) : null;

    if (step.type === "poll" && polled === "wait") {
      assertTransition(task.state, "waiting");
      try {
        await commitStepBoundary(db, {
          taskId,
          requireState: "running",
          taskPatch: {
            state: "waiting",
            waiting_until: new Date(Date.now() + intervalMs(step.interval)).toISOString(),
            child_pid: null,
            child_started_at: null,
          },
          stepRunUpdate: {
            id: stepRunId,
            status: "waiting",
            exit_code: outcome.exitCode,
            ended_at: outcome.endedAt,
            duration_ms: outcome.durationMs,
          },
          outputs: { last_stdout: outcome.stdout, last_stderr: outcome.stderr, exit_code: outcome.exitCode },
        });
      } catch (e) {
        if (e instanceof StateConflictError) {
          await closeInterrupted(db, taskId, stepRunId, outcome);
          deps.onStepRunFinished?.(taskId, stepRunId, step.id, "interrupted", null, attempt);
          return;
        }
        throw e;
      }
      deps.onStateChanged?.(taskId, "running", "waiting");
      deps.onStepRunFinished?.(taskId, stepRunId, step.id, "waiting", null, attempt);
      return;
    }

    if (polled === "abandon") {
      // PR が閉じられた。外から閉じられた実行として interrupted で閉じ、分岐せずに終える。
      try {
        await commitStepBoundary(db, {
          taskId,
          requireState: "running",
          taskPatch: { child_pid: null, child_started_at: null },
          stepRunUpdate: {
            id: stepRunId,
            status: "interrupted",
            exit_code: outcome.exitCode,
            ended_at: outcome.endedAt,
            duration_ms: outcome.durationMs,
          },
          outputs: { last_stdout: outcome.stdout, last_stderr: outcome.stderr, exit_code: outcome.exitCode },
        });
      } catch (e) {
        if (e instanceof StateConflictError) {
          await closeInterrupted(db, taskId, stepRunId, outcome);
          deps.onStepRunFinished?.(taskId, stepRunId, step.id, "interrupted", null, attempt);
          return;
        }
        throw e;
      }
      deps.onStepRunFinished?.(taskId, stepRunId, step.id, "interrupted", null, attempt);
      await setState(db, (await getTask(db, taskId))!, "canceled", deps);
      return;
    }
```

`polled` が `"done"` のとき `outcome.status` は既に `success`、`"failed"` のときは `failed` なので、その後の `decide` の経路はそのまま使える。

- [ ] **Step 8: 通す**

Run: `mise run core:check && mise run core:test`
Expected: PASS

- [ ] **Step 9: コミット**

```bash
git add core/src core/test
git commit -m "poll ステップを実行し、まだなら waiting で待つ"
```

---

### Task 5: 上限に達したら人の承認を待つ（`onExhausted: suspend`）

**Files:**
- Modify: `core/src/domain/engine.ts`（`Decision` に `escalate`、`decide`、`runTask`、`applyApproval`）
- Modify: `core/src/db/tasks.ts`（`withoutAttempt`）
- Modify: `core/src/domain/taskContext.ts`、`shared/protocol.ts`（`TaskContext.escalation`）
- Test: `core/test/domain/engine.test.ts`、`core/test/domain/taskContext.test.ts`

**Interfaces:**
- Consumes: Task 3 の `Branch.onExhausted`
- Produces:
  - `Decision` に `{ kind: "escalate"; reason: string }`
  - `function withoutAttempt(task: TaskRow, stepId: string): string`
  - `TaskContext.escalation: { stepId: string; goto: string; maxAttempts: number } | null`

- [ ] **Step 1: テストを書く**

`engine.test.ts` の decide のテスト群に足す:

```ts
test("onExhausted: suspend なら maxAttempts を超えても failed にせず escalate", () => {
  const w = parseWorkflow(`
name: f
steps:
  - id: a
    type: command
    run: "true"
  - id: b
    type: command
    run: "false"
    onFailure: { goto: a, maxAttempts: 2, onExhausted: suspend }
`).workflow;
  assert.equal(decide({ workflow: w, currentStepId: "b", outcome: "failed", attempts: 2 }).kind, "escalate");
  assert.equal(decide({ workflow: w, currentStepId: "b", outcome: "failed", attempts: 1 }).kind, "goto");
});
```

runTask と applyApproval のテストを足す:

```ts
const ESCALATE_WF = `
name: f
steps:
  - id: fix
    type: command
    run: "true"
  - id: check
    type: command
    run: "exit $(cat verdict)"
    onFailure: { goto: fix, maxAttempts: 2, feed: "直して: {{ steps.check.last_stdout }}", onExhausted: suspend }
`;

test("上限に達すると、そのステップの awaiting の行を立てて suspended になる", async () => {
  const { db, root, workflow } = await taskFixture(ESCALATE_WF);
  writeFileSync(join(root, "verdict"), "1");
  await runTask(db, "t1", workflow, {
    db,
    adapter: createMockAdapter({ result: {} }),
    logRoot: join(root, "logs"),
    globalLimit: 4,
  });
  const t = (await getTask(db, "t1"))!;
  assert.equal(t.state, "suspended");
  assert.equal(t.current_step_id, "check");
  assert.deepEqual(
    (await listStepRuns(db, "t1")).map((r) => [r.step_id, r.status]),
    [["fix", "success"], ["check", "bounced"], ["fix", "success"], ["check", "failed"], ["check", "awaiting"]],
  );
});

test("上限到達の承認は回数を戻して goto 先から続け、feed を渡す", async () => {
  const { db, root, workflow } = await taskFixture(ESCALATE_WF);
  writeFileSync(join(root, "verdict"), "1");
  const deps = { db, adapter: createMockAdapter({ result: {} }), logRoot: join(root, "logs"), globalLimit: 4 };
  await runTask(db, "t1", workflow, deps);

  await applyApproval(db, "t1", { approved: true, comment: "" }, workflow);
  const t = (await getTask(db, "t1"))!;
  assert.equal(t.state, "queued");
  assert.equal(t.current_step_id, "fix");
  assert.equal(JSON.parse(t.attempt_counts).check, undefined, "check の回数を戻す");
  assert.match(t.pending_feed ?? "", /^直して: /);
  const last = (await listStepRuns(db, "t1")).at(-1)!;
  assert.deepEqual([last.step_id, last.status, last.goto_step_id], ["check", "bounced", "fix"]);

  writeFileSync(join(root, "verdict"), "0");
  await toRunning(db, "t1");
  await runTask(db, "t1", workflow, deps);
  assert.equal((await getTask(db, "t1"))?.state, "completed");
});

test("上限到達の却下は failed で終える", async () => {
  const { db, root, workflow } = await taskFixture(ESCALATE_WF);
  writeFileSync(join(root, "verdict"), "1");
  await runTask(db, "t1", workflow, {
    db,
    adapter: createMockAdapter({ result: {} }),
    logRoot: join(root, "logs"),
    globalLimit: 4,
  });
  await applyApproval(db, "t1", { approved: false, comment: "手で直す" }, workflow);
  assert.equal((await getTask(db, "t1"))?.state, "failed");
  assert.equal((await listStepRuns(db, "t1")).at(-1)?.status, "failed");
});
```

`taskContext.test.ts` に足す（既存の fixture の作り方に合わせる）:

```ts
test("approval 以外のステップで止まっていれば escalation を返す", async () => {
  // ESCALATE_WF と同じ定義のタスクを suspended・current_step_id = check にする
  const c = await buildTaskContext(db, task, workflow);
  assert.deepEqual(c.escalation, { stepId: "check", goto: "fix", maxAttempts: 2 });
});

test("approval で止まっていれば escalation は null", async () => {
  const c = await buildTaskContext(db, taskAtReview, workflow);
  assert.equal(c.escalation, null);
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `mise run core:test`
Expected: FAIL

- [ ] **Step 3: decide と attempt のヘルパーを実装する**

`tasks.ts`:

```ts
/** 上限到達を人が承認したとき、そのステップの回数を数え直すために消す。 */
export function withoutAttempt(task: TaskRow, stepId: string): string {
  const counts = JSON.parse(task.attempt_counts) as Record<string, number>;
  delete counts[stepId];
  return JSON.stringify(counts);
}
```

`engine.ts` の `Decision` に `| { kind: "escalate"; reason: string }` を足す。`decide` の maxAttempts の判定を次にする:

```ts
  if (o.attempts >= branch.maxAttempts) {
    const reason = `ステップ "${step.id}" が maxAttempts (${branch.maxAttempts}) を超えました`;
    return branch.onExhausted === "suspend" ? { kind: "escalate", reason } : { kind: "fail", reason };
  }
```

- [ ] **Step 4: runTask に escalate を実装する**

`runTask` の最後の `switch (decision.kind)` に足す:

```ts
      case "escalate":
        await escalate(db, task, step.id, attempt, deps);
        return;
```

`runTask` の前に関数を置く:

```ts
/**
 * maxAttempts を使い切ったステップで人の判断を待つ（onExhausted: suspend）。
 * suspended には「開いている awaiting の行がちょうど1件ある」という不変条件があるので、
 * 失敗した実行の行とは別に、そのステップの id で awaiting の行を立てる。
 */
async function escalate(
  db: Db,
  task: TaskRow,
  stepId: string,
  attempt: number,
  deps: EngineDeps,
): Promise<void> {
  assertTransition(task.state, "suspended");
  try {
    await commitStepBoundary(db, {
      taskId: task.id,
      requireState: "running",
      taskPatch: { state: "suspended", child_pid: null, child_started_at: null },
      stepRun: {
        step_id: stepId,
        attempt,
        status: "awaiting",
        exit_code: null,
        started_at: new Date().toISOString(),
        ended_at: null,
        log_path: "",
      },
    });
  } catch (e) {
    if (e instanceof StateConflictError) return;
    throw e;
  }
  deps.onStateChanged?.(task.id, task.state, "suspended");
}
```

- [ ] **Step 5: applyApproval に上限到達の解釈を足す**

`applyApproval` で `awaiting` を確かめた直後に足す:

```ts
  const step = workflow.steps[index];
  if (step.type !== "approval") {
    await applyEscalation(db, task, step, awaiting.id, verdict, now);
    return;
  }
```

関数を置く:

```ts
/**
 * 上限到達（escalate）で止まったステップへの人の判断。承認は回数を戻して goto 先から、
 * 却下は failed。approval の承認のように次のステップへは進めない（spec 6 章）。
 */
async function applyEscalation(
  db: Db,
  task: TaskRow,
  step: Step,
  awaitingId: number,
  verdict: { approved: boolean; comment: string },
  now: string,
): Promise<void> {
  const branch = branchOf(step);
  if (!branch) throw new Error(`ステップ "${step.id}" に onFailure がありません`);

  if (verdict.approved) {
    assertTransition(task.state, "queued");
    const ctx = await contextFor(db, task);
    await commitStepBoundary(db, {
      taskId: task.id,
      requireState: "suspended",
      taskPatch: {
        state: "queued",
        current_step_id: branch.goto,
        resumed: 1,
        attempt_counts: withoutAttempt(task, step.id),
        pending_feed: branch.feed ? expand(branch.feed, ctx) : null,
      },
      stepRunUpdate: {
        id: awaitingId,
        status: "bounced",
        exit_code: 0,
        ended_at: now,
        goto_step_id: branch.goto,
      },
    });
    return;
  }

  assertTransition(task.state, "failed");
  await commitStepBoundary(db, {
    taskId: task.id,
    requireState: "suspended",
    taskPatch: { state: "failed" },
    stepRunUpdate: { id: awaitingId, status: "failed", exit_code: 1, ended_at: now },
    outputs: { last_stdout: verdict.comment, last_stderr: "", exit_code: 1 },
  });
}
```

import に `type Step`（schema.ts）と `withoutAttempt`（tasks.ts）を足す。承認で `outputs` を書かないのは、feed が参照する `steps.<id>.last_stdout` を、失敗した実行の出力のまま残すため。

- [ ] **Step 6: task.context に escalation を足す**

`shared/protocol.ts` の `TaskContext` に足す:

```ts
  /** 上限到達（onExhausted: suspend）で止まっているときだけ入る。承認で goto 先からやり直す。 */
  escalation: { stepId: string; goto: string; maxAttempts: number } | null;
```

`taskContext.ts` の `TaskContext` 型（core 側）にも同じ項目を足し、`buildTaskContext` の返り値に `escalation: escalationOf(task, workflow),` を足す:

```ts
function escalationOf(task: TaskRow, workflow: Workflow | null): TaskContext["escalation"] {
  if (task.state !== "suspended" || !workflow) return null;
  const step = workflow.steps.find((s) => s.id === task.current_step_id);
  if (!step || step.type === "approval") return null;
  const b = branchOf(step);
  return b ? { stepId: step.id, goto: b.goto, maxAttempts: b.maxAttempts } : null;
}
```

- [ ] **Step 7: 通す**

Run: `mise run core:check && mise run core:test && mise run app:test && mise run app:build`
Expected: PASS。app で `TaskContext` を組み立てているテストの fixture が型エラーになったら `escalation: null` を足す。

- [ ] **Step 8: コミット**

```bash
git add core/src core/test shared/protocol.ts app/src
git commit -m "maxAttempts を使い切ったら人の承認を待てるようにする"
```

---

### Task 6: 既定ワークフローにマージ待ちを入れる

**Files:**
- Modify: `.doctrine/workflows/default.yaml`
- Test: `core/test/workflow/defaultWorkflow.test.ts`

**Interfaces:**
- Consumes: Task 3〜5 の `poll`、`interval`、`onExhausted`
- Produces: 既定ワークフローのステップ id `sync`、`verify-sync`、`wait-merge`

- [ ] **Step 1: wait-merge の判定をテストで固める**

`defaultWorkflow.test.ts` に、`openPrRun` と同じ形で `wait-merge` の `run` を取り出し、偽の `gh` で実行するテストを足す:

```ts
async function waitMergeRun(): Promise<string> {
  const yaml = await readFile(
    new URL("../../../.doctrine/workflows/default.yaml", import.meta.url),
    "utf8",
  );
  const step = parseWorkflow(yaml).workflow.steps.find((s) => s.id === "wait-merge");
  assert.ok(step && step.type === "poll", "wait-merge は poll ステップ");
  return (step as PollStep).run;
}

/** gh pr view の --jq の結果として `state mergeable` を返す偽の gh で wait-merge を実行する。 */
async function runWaitMerge(stateAndMergeable: string): Promise<{ code: number; stdout: string }> {
  const dir = await mkdtemp(join(tmpdir(), "doctrine-wait-merge-"));
  try {
    await mkdir(join(dir, "bin"));
    await writeFile(join(dir, "bin", "gh"), `#!/bin/sh\necho '${stateAndMergeable}'\n`);
    await chmod(join(dir, "bin", "gh"), 0o755);
    const ctx: TemplateContext = {
      task: { id: "t", title: "T", prompt: "P", branch: "b" },
      issue: { url: null, parent_url: null },
      worktree: { path: dir },
      project: { path: dir },
      steps: {},
    };
    try {
      const { stdout } = await exec("sh", ["-c", expand(await waitMergeRun(), ctx)], {
        cwd: dir,
        env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}` },
      });
      return { code: 0, stdout };
    } catch (e) {
      const err = e as { code: number; stdout: string };
      return { code: err.code, stdout: err.stdout };
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("wait-merge: マージされたら 0", async () => {
  assert.equal((await runWaitMerge("MERGED UNKNOWN")).code, 0);
});

test("wait-merge: conflict なら 1 で理由を出す", async () => {
  const r = await runWaitMerge("OPEN CONFLICTING");
  assert.equal(r.code, 1);
  assert.match(r.stdout, /conflict/);
});

test("wait-merge: 閉じられたら 2", async () => {
  assert.equal((await runWaitMerge("CLOSED MERGEABLE")).code, 2);
});

test("wait-merge: マージ可能・判定中はまだ（75）", async () => {
  assert.equal((await runWaitMerge("OPEN MERGEABLE")).code, 75);
  assert.equal((await runWaitMerge("OPEN UNKNOWN")).code, 75);
});
```

（`issue` の形は既存の `runOpenPr` の呼び出しに合わせる。`process` と `PollStep` の import を足す。）

open-pr のコメント投稿もテストする。既存の `runOpenPr` に `syncNotes?: string` の引数を足し、あれば `.doctrine-out/sync-notes.md` を書く。PR がある側の偽の `gh` は `pr comment` の引数を `$GH_ARGS` に書くようにする:

```ts
test("open-pr: sync の記録があれば PR にコメントし、ファイルを消す", async () => {
  const r = await runOpenPr({ url: null, parent_url: null }, true, "## develop を取り込んだ\n- a.ts\n");
  assert.equal(r.code, 0);
  assert.match(r.args.join(" "), /pr comment --body-file/);
  assert.equal(r.syncNotesLeft, false);
});

test("open-pr: sync の記録が無ければコメントしない", async () => {
  const r = await runOpenPr({ url: null, parent_url: null }, true);
  assert.equal(r.args.some((a) => a === "comment"), false);
});
```

（`Outcome` に `syncNotesLeft: boolean` を足し、実行後に `.doctrine-out/sync-notes.md` があるかを入れる。）

- [ ] **Step 2: 失敗を確認する**

Run: `mise run core:test`
Expected: FAIL（`wait-merge` が無い）

- [ ] **Step 3: default.yaml を書き換える**

冒頭のコメントの工程一覧を `（plan → plan-review → implement → verify → agent-review → guide → review → sync → verify-sync → open-pr → wait-merge）` にし、分岐の一覧に足す:

```yaml
#   verify-sync が落ちたら sync へ（最大3回。使い切ったら人の判断を待つ）
#   wait-merge  が conflict を見たら sync へ（最大10回。使い切ったら人の判断を待つ）
#
# review の後で develop を取り込み（sync）、テストを通してから PR を開き、マージされるまで待つ。
# マージを待っている間に develop と conflict したら、sync に戻って直し、open-pr で push し直す。
# 初回の sync は conflict が無ければ git merge だけで終わり、PR を develop に追従した状態で開く。
# 自動で解決した conflict は人に見直させず、sync が書いた記録を open-pr が PR にコメントする。
# PR がマージされずに閉じられたら、タスクは canceled で終わる。
```

`review` と `open-pr` の間に足す:

```yaml
  - id: sync
    type: agent
    session: implementer
    model: claude-sonnet-5
    permissionMode: acceptEdits
    allowedTools:
      - "Bash(git fetch:*)"
      - "Bash(git merge:*)"
      - "Bash(git status:*)"
      - "Bash(git diff:*)"
      - "Bash(git log:*)"
      - "Bash(git show:*)"
      - "Bash(git add:*)"
      - "Bash(git commit:*)"
      - "Bash(mise run core:test:*)"
      - "Bash(mise run core:check:*)"
      - "Bash(mise run app:test:*)"
      - "Bash(mise run app:build:*)"
      - "Bash(mise run pfd:test:*)"
      - "Bash(mise run pfd:check:*)"
      - "Bash(grep:*)"
      - "Bash(sed -n:*)"
      - "Bash(cat:*)"
      - "Bash(ls:*)"
    prompt: |
      develop の最新をこのブランチに取り込んでください。

      1. `git fetch origin develop` を実行し、続けて `git merge --no-edit origin/develop` を実行します。
      2. conflict が無ければ、それで終わりです。何も書かずに終えてください。
      3. conflict があれば、両側の意図を保つように解決し、触ったディレクトリの検証を通してから
         `git add` と `git commit --no-edit` でマージコミットを作ってください。rebase はしないでください。
         解決したら {{ worktree.path }}/.doctrine-out/sync-notes.md に次を書きます。
         - conflict したファイル
         - それぞれをどう解決したか（どちらの変更を残したか、両方を合わせたか）

      コマンドは1つずつ実行してください。`&&` や `cd` でつなぐと権限で拒否されます。

  - id: verify-sync
    type: command
    run: "mise run core:check && mise run core:test && mise run app:deps && mise run app:test && mise run app:build && mise run pfd:check && mise run pfd:test"
    onFailure:
      goto: sync
      maxAttempts: 3
      onExhausted: suspend
      feed: |
        develop を取り込んだ後の型検査かテストが失敗した:
        {{ steps.verify-sync.last_stdout }}
        {{ steps.verify-sync.last_stderr }}
```

`open-pr` の `run` を次にする（PR がある2周目以降は push と、記録があればコメントだけになる）:

```yaml
    run: "git push -u origin HEAD && { gh pr view --json url --jq .url || { cat .doctrine-out/implement-notes.md; if [ -n '{{ issue.closes }}' ]; then printf '\\n%s\\n' '{{ issue.closes }}'; fi; } | gh pr create --base develop --title \"{{ task.title }}\" --body-file -; } && if [ -f .doctrine-out/sync-notes.md ]; then gh pr comment --body-file .doctrine-out/sync-notes.md && rm .doctrine-out/sync-notes.md; fi"
```

末尾に足す:

```yaml
  # 「まだ」は 75、閉じられたら 2（spec 2026-09-22-merge-wait-design.md 3 章）。
  # push 直後の mergeable は UNKNOWN になるので、まだとして待つ。
  # BEHIND（conflict は無いが遅れている）は追わない。
  - id: wait-merge
    type: poll
    interval: 1m
    run: |
      gh pr view --json state,mergeable --jq '.state + " " + .mergeable' | {
        read s m
        case "$s $m" in
          "MERGED "*) exit 0 ;;
          "CLOSED "*) echo "PR がマージされずに閉じられました"; exit 2 ;;
          *" CONFLICTING") echo "develop と conflict しています"; exit 1 ;;
          *) exit 75 ;;
        esac
      }
    onFailure:
      goto: sync
      maxAttempts: 10
      onExhausted: suspend
      feed: |
        PR が develop と conflict した。develop を取り込み直して解決してください:
        {{ steps.wait-merge.last_stdout }}
```

- [ ] **Step 4: 通す**

Run: `mise run core:check && mise run core:test`
Expected: PASS。`parseWorkflow` の警告（open-pr の `gh pr comment`）は既存の `gh pr create` と同じく出てよい。

- [ ] **Step 5: コミット**

```bash
git add .doctrine/workflows/default.yaml core/test/workflow/defaultWorkflow.test.ts
git commit -m "既定ワークフローで PR のマージを待ち、conflict を直す"
```

---

### Task 7: アプリでマージ待ちと上限到達を見せる

**Files:**
- Modify: `app/src/model.ts`（`canPause`、`Group`、`groupOf`、グループの一覧、`toTask`）
- Modify: `app/src/types.ts`（`Task.checkAt`）
- Modify: `app/src/components/Sidebar.tsx`（グループのアイコン）
- Modify: `app/src/components/TaskView.tsx`（マージ待ちの説明）
- Modify: `app/src/components/ReviewView.tsx`（上限到達の説明）
- Test: `app/src/model.test.ts`

**Interfaces:**
- Consumes: Task 1 の `waiting` と `waiting_until`、Task 5 の `TaskContext.escalation`
- Produces: `Group` に `"waiting"`、`Task.checkAt: number | null`

- [ ] **Step 1: テストを書く**

`model.test.ts` に足す:

```ts
test("waiting はマージ待ちの区分に入り、要確認には入れない", () => {
  expect(groupOf(t({ state: "waiting" }))).toBe("waiting");
});

test("toTask は waiting_until を checkAt に写す", () => {
  expect(t1({ waiting_until: "2026-09-22T03:20:00.000Z" }).checkAt)
    .toBe(Date.parse("2026-09-22T03:20:00.000Z"));
  expect(t1({ waiting_until: null }).checkAt).toBeNull();
});

test("マージ待ちは一時停止できる", () => {
  expect(canPause("waiting")).toBe(true);
});
```

157 行付近の「一時停止を出さない状態」の配列から `"waiting"` を外し、146 行付近の「一時停止は queued・running・rate_limited のときだけ」を「… rate_limited・waiting のときだけ」にして配列に足す。

- [ ] **Step 2: 失敗を確認する**

Run: `mise run app:test`
Expected: FAIL

- [ ] **Step 3: 実装する**

`types.ts` の `Task` に、`resumeAt` の隣に `checkAt?: number | null;` を足す。

`model.ts`:

```ts
export const canPause = (s: TaskState) =>
  s === "queued" || s === "running" || s === "rate_limited" || s === "waiting";

export type Group = "review" | "check" | "running" | "limited" | "waiting" | "queued" | "paused" | "done";
```

`groupOf` の `rate_limited` の行の後に足す:

```ts
  // 要確認には入れない。人が何かする必要は無く、マージされるか conflict するまで自分で見に行く
  if (t.state === "waiting") return "waiting";
```

グループの一覧（106 行付近）の `limited` の後に足す:

```ts
  { key: "waiting", name: "マージ待ち", sort: (a, b) => (a.since ?? 0) - (b.since ?? 0) },
```

136 行付近の補助テキストに足す:

```ts
  if (g === "waiting") return t.checkAt ? `${hm(t.checkAt)} に確認` : "マージ待ち";
```

`toTask` の `resumeAt` の隣に `checkAt: parseTime(row.waiting_until),` を足す。

`Sidebar.tsx` の 74 行付近の `case "limited"` の後に `case "waiting": return <span className="hourglass" />;` を足す。

`TaskView.tsx` の `rate_limited` の説明ボックスの後に足す:

```tsx
      {t.state === "waiting" && (
        <section className="box quiet">
          <p>
            PR のマージを待っています。{t.checkAt ? `次は ${hm(t.checkAt)} に確認します。` : ""}
            develop と conflict したら、取り込み直して push し直します。
          </p>
        </section>
      )}
```

`ReviewView.tsx` の `<Context t={t} loaded={context} />` の直前に足す:

```tsx
        {c?.escalation && (
          <section className="box quiet">
            <p>
              ステップ「{c.escalation.stepId}」が {c.escalation.maxAttempts} 回やり直しても通りませんでした。
              承認すると回数を戻して「{c.escalation.goto}」からやり直します。却下するとタスクは失敗で終わります。
            </p>
          </section>
        )}
```

- [ ] **Step 4: 通す**

Run: `mise run app:test && mise run app:build`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add app/src
git commit -m "アプリでマージ待ちと上限到達を見せる"
```

---

## 実装者への注意

- Task 4 と Task 5 のテストのコマンドは、`taskFixture` が worktree に使う一時ディレクトリで動く。`verdict` ファイルはそこに書く。
- Task 4 Step 5 の3つ目のテストは、ワークフローの先頭が `fix` なので、`current_step_id` を `wait` にしてから始めている。`fix` が `verdict` を 0 に書くので、2周目の `wait` は通る。
- `escalate` と、失敗した実行の行を閉じるコミットは別のトランザクションになる。間でデーモンが落ちると、タスクは `running` のまま最後の行が `failed` になる。復帰すると同じステップを頭から実行する（command / poll は再実行しても安全）。
- `canceled` のタスクの worktree は、いまの `cleanupAfterRun` では消えない（消すのは completed だけ）。PR が閉じられたときに worktree が残るのは、今回は仕様どおり。
