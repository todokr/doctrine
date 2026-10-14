# Intake と Execution 段階 1: デーモンの direct Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Issue を PFD で分解せずにタスク 1 本で流す direct の Intake をデーモンに足し、`intake.get` の各プロセスにいまのタスクのステップの帯（`rail`）を載せる。

**Architecture:** `intakes.mode`（`plan` / `direct`）を足す。direct で開始すると、Intake の行（`active`）・プロセス `main` の行・タスク 1 本を 1 トランザクションで作る。PFD・承認・sub-issue は持たない。
プロセスの状態は PFD を使わずタスクと PR だけから求め、見張りは PR の観測と完了の判定だけを行う。帯の組み立て（`buildRail`）はアプリから `shared/rail.ts` へ移し、デーモンの `view.ts` も使う。

**Tech Stack:** Node 26（型ストリップ）+ pnpm workspace（core、shared）、Kysely + SQLite、React + Vite（app）、`node:test` と `node:assert/strict`（core）、vitest（app）

**Spec:** `docs/superpowers/specs/2026-10-14-intake-execution-design.md`（5 章、7.1、7.3、10 章、11 章）

## 前提

- 作業ディレクトリはリポジトリの根（`/Users/shunsuke.tadokoro/orca/workspaces/doctrine/app_ux`）。シェルの `cd` が置き換えられている環境があるので、ディレクトリを移るときは `builtin cd <絶対パス>` と書く。
  core のテスト 1 ファイルは `builtin cd /Users/shunsuke.tadokoro/orca/workspaces/doctrine/app_ux/core && node --test <file>`（複数ファイルも並べて渡せる。権限フラグは無い）、全体は `mise run core:test`、型検査は `mise run core:check`。
  app は `builtin cd /Users/shunsuke.tadokoro/orca/workspaces/doctrine/app_ux/app && pnpm exec vitest run <file>`、型検査は `builtin cd /Users/shunsuke.tadokoro/orca/workspaces/doctrine/app_ux/app && pnpm exec tsc`、全体は `mise run app:test`。
- 各 Task の終わりで `mise run core:check && mise run core:test && mise run app:test && (builtin cd /Users/shunsuke.tadokoro/orca/workspaces/doctrine/app_ux/app && pnpm exec tsc) && pnpm check:style` が通ること。
  protocol の形を変えた Task は、app の型検査が通るところまで追従させる。
- 書式はリポジトリの根で `pnpm exec biome format --write <file...>`（core と shared。app は対象外）。検査は `pnpm check:style`（lint を含む。ファイル指定は `pnpm exec biome check <file...>`）。幅 100、trailing comma all。
- core の TypeScript は Node の型ストリップで動くので、`enum`・`namespace`・パラメータプロパティは使えない（`erasableSyntaxOnly`）。型だけの import は `import type`（`verbatimModuleSyntax`）。相対 import は `.ts` 拡張子つき、Node 標準は `node:` 接頭辞。
- テストは `import { test } from "node:test";` と `import assert from "node:assert/strict";` で、`describe` を使わずトップレベルの `test("…", async () => {…})` を並べる。

## Global Constraints

- 段階をまたぐ固定のインターフェース（段階 2・3 の計画もこれを使う。名前と型を変えない）:
  - `shared/protocol.ts` が `IntakeMode`（`"plan" | "direct"`）を export する。`IntakeSummary.mode: IntakeMode`。`"intake.start"` の params は `{ workspace: string; issue_url: string; mode: IntakeMode }`（mode は必須）
  - `shared/intake/processStatus.ts` が `export const DIRECT_PROCESS_ID = "main";`
  - `shared/rail.ts` が `RailStatus` / `RailNode` / `buildRail` を export する（名前と意味はいまの `app/src/rail.ts` のまま）
  - `IntakeProcessView` に `rail: RailNode[] | null`（プロセスのいまのタスクの帯。タスクが無いプロセスは null）
  - アプリの `useIntakeRpc().start(workspacePath: string, issueUrl: string, mode: IntakeMode)`
- `workspace.setup` と初回ウィザードには触らない（段階 2）。`task.create` には触らない（別の作業）。
- 後方互換の仕掛けを作らない。
- コードのコメントにはそのコード固有の事実だけを書き、一般論は spec に書く。既存のコメントの密度に合わせる。
- direct の Intake は sub-issue を作らず、`intake_processes.sub_issue_url` は常に NULL。タスクの `issue_url` は親 Issue そのもの、`parent_issue_url` は NULL。
- direct のタスクのワークフローはプロジェクトの既定（`project.default_workflow`）。

## Review Focus

1. **ワークフローが読めないプロジェクトで direct を開始する** — 開始は失敗し、Intake・プロセス・タスクのどれも残らない（Task 4 の `startIntake` のテスト）。
2. **direct のタスクが failed / canceled で止まる、PR が閉じられる、PR 無しで completed になる** — プロセスは `needs_attention`（理由はそれぞれ `task_stopped` / `pr_closed` / `no_pr`）になり、再投入できる（Task 3 と Task 6 のテスト）。
3. **direct の PR が base_branch 以外へマージされる** — `merged` にならず完了しない（Task 3 の `directProcessStatus` のテスト）。
4. **pin された YAML から外れた step_id の step_run がある** — 帯は末尾にそのノードを生やし、`intake.get` を失敗させない。ワークフローが読めないタスクの帯は null（Task 2 のテスト）。
5. **direct に plan 専用の操作を送る**（改訂・自動投入の一時停止・人の完了）— 状態を変えずに拒む（Task 6 のテスト）。

---

## ファイルの地図

| ファイル | 変えること |
| --- | --- |
| `shared/intake/state.ts` | `IntakeMode` を足す |
| `shared/intake/processStatus.ts` | `DIRECT_PROCESS_ID` を足す |
| `shared/protocol.ts` | `IntakeMode` の export、`IntakeSummary.mode`、`intake.start` の `mode`、`IntakeProcessView.rail` |
| `shared/rail.ts`（新規） | `app/src/rail.ts` から `RailStatus` / `RailNode` / `buildRail` を移す |
| `core/src/db/migrations.ts` / `schema.ts` / `intakes.ts` | `0017_intake_mode`、`IntakesTable.mode`、`insertIntake` の `mode` |
| `core/src/domain/intakeStates.ts` | `initialIntakeState`（作ったときの状態） |
| `core/src/workflow/load.ts` | `toStepViews` を `daemon/handlers.ts` から移す |
| `core/src/intake/pfd/status.ts` | `agentState` の切り出しと `directProcessStatus` |
| `core/src/intake/processProject.ts` | `directBaseBranch` |
| `core/src/intake/view.ts` | `mode`、`directStatusOf`、direct の状態、`rail` |
| `core/src/intake/dispatch.ts` | `directTask` / `directTaskPrompt` / `insertDirectIntake`、direct の再投入 |
| `core/src/intake/commands.ts` | `startIntake` の direct、改訂と一時停止の拒否 |
| `core/src/intake/watch.ts` | direct の完了の判定 |
| `core/src/daemon/handlers.ts` | `intake.start` の `mode`、`toIntakeDetail` に `loadWorkflow` を渡す |
| `app/src/rail.ts` / `tone.ts` / `components/WorkflowRail.tsx` / `rail.test.ts` | `shared/rail.ts` からの import |
| `app/src/store.tsx` / `components/IssuePicker.tsx` / `IssuePicker.test.tsx` | `start` の `mode` |
| `app/src/fixtures.ts` / `intake.ts` / `worktrees.test.ts` | `mode` と `rail` の追従 |
| `core/test/intake/direct.test.ts`（新規）、`core/test/intake/watchFixture.ts` | direct のテストと種 |
| `docs/developer-guide/06-intake.md` / `07-app.md` | direct と帯の移動 |

---

### Task 1: `mode` 列と開始のときの状態

**Files:**
- Modify: `shared/intake/state.ts`、`shared/intake/processStatus.ts`、`shared/protocol.ts:14,487-502,658-661`
- Modify: `core/src/db/schema.ts:1-6,161-185`、`core/src/db/migrations.ts`（`0016_intake_workspace` の後）、`core/src/db/intakes.ts:42-56`
- Modify: `core/src/domain/intakeStates.ts`、`core/src/intake/view.ts:94-120`（`summaryOf`）
- Modify: `app/src/fixtures.ts:400-416`、`app/src/intake.ts:540-556`、`app/src/worktrees.test.ts:28-42`
- Test: `core/test/db/migrate.test.ts`、`core/test/db/intakes.test.ts`、`core/test/domain/intakeStates.test.ts`

**Interfaces:**
- Produces: `IntakeMode`（`shared/intake/state.ts`、`shared/protocol.ts` から再 export）、`DIRECT_PROCESS_ID`、`IntakesTable.mode: Generated<IntakeMode>`、
  `NewIntake.mode?: IntakeMode`（省くと plan）、`initialIntakeState(mode: IntakeMode): "investigating" | "active"`、`IntakeSummary.mode`

- [ ] **Step 1: 失敗するテストを書く**

`core/test/domain/intakeStates.test.ts` の import に `initialIntakeState` を足し、末尾に:

```ts
test("作ったときの状態: plan は investigating、direct は active", () => {
  assert.equal(initialIntakeState("plan"), "investigating");
  assert.equal(initialIntakeState("direct"), "active");
});
```

`core/test/db/intakes.test.ts` の末尾に（同ファイルの既存のテストが使う DB と workspace の用意に合わせる。下は `openDb` と `seedProject` を使う形）:

```ts
test("insertIntake: mode を省くと plan・investigating、direct なら active で作る", async () => {
  const db = await openDb(":memory:");
  const p = await seedProject(db, { path: "/repo" });
  const base = { workspace_id: p.workspace_id, issue_node_id: "I", issue_title: "T" };
  const plan = await insertIntake(db, {
    ...base,
    id: "a",
    issue_url: "https://github.com/o/r/issues/1",
  });
  assert.equal(plan.mode, "plan");
  assert.equal(plan.state, "investigating");
  const direct = await insertIntake(db, {
    ...base,
    id: "b",
    issue_url: "https://github.com/o/r/issues/2",
    mode: "direct",
  });
  assert.equal(direct.mode, "direct");
  assert.equal(direct.state, "active");
});
```

`core/test/db/migrate.test.ts`:
- `COLUMNS.intakes`（247 行目付近）に `mode: true,` を足す
- `appliedMigrations` を比べる 3 か所の配列の末尾に `"0017_intake_mode",` を足す
- `0016` のテストの後に:

```ts
test("0017: 既存の Intake は plan になり、mode には plan と direct しか入らない", async () => {
  const sqlite = new DatabaseSync(":memory:");
  const d = await openDbOn(sqlite, "0016_intake_workspace");
  sqlite.exec(`
    INSERT INTO workspaces (id, path, name) VALUES (1, '/w/a', 'a');
    INSERT INTO intakes (id, workspace_id, issue_url, issue_node_id, issue_title, state,
                         created_at, updated_at)
      VALUES ('i1', 1, 'https://github.com/o/r/issues/1', 'I_1', 'T', 'active',
              '2026-10-14', '2026-10-14');
  `);
  await migrateToLatest(d);
  const i1 = await d
    .selectFrom("intakes")
    .select("mode")
    .where("id", "=", "i1")
    .executeTakeFirstOrThrow();
  assert.equal(i1.mode, "plan");
  assert.throws(() => sqlite.exec(`UPDATE intakes SET mode = 'other' WHERE id = 'i1'`), /CHECK/);
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `builtin cd /Users/shunsuke.tadokoro/orca/workspaces/doctrine/app_ux/core && node --test test/domain/intakeStates.test.ts test/db/intakes.test.ts test/db/migrate.test.ts`
Expected: FAIL（`initialIntakeState` が無い、`mode` 列が無い）

- [ ] **Step 3: 実装する**

`shared/intake/state.ts` の末尾:

```ts
/** 取り込みの種類（spec 2026-10-14-intake-execution-design.md 4.2）。direct は PFD を作らずタスクを 1 本流す。 */
export type IntakeMode = "plan" | "direct";
```

`shared/intake/processStatus.ts` の末尾:

```ts
/** direct の Intake がただ 1 つ持つプロセスの id。 */
export const DIRECT_PROCESS_ID = "main";
```

`shared/protocol.ts`: 14 行目の import に `IntakeMode` を足し、その下に `export type { IntakeMode };` を置く。`IntakeSummary` の `issue_title` の後に:

```ts
  mode: IntakeMode;
```

`"intake.start"` の params を `{ workspace: string; issue_url: string; mode: IntakeMode }` にする。

`core/src/db/schema.ts`: 3-6 行目の import に `IntakeMode` を足し、`IntakesTable` の `issue_title` の後に:

```ts
  /** 0017 で足した。既定は plan。 */
  mode: Generated<IntakeMode>;
```

`core/src/db/migrations.ts` の `"0016_intake_workspace"` の後:

```ts
  /** Intake の取り込みの種類（spec 2026-10-14-intake-execution-design.md 5.1）。既存の行は plan。 */
  "0017_intake_mode": {
    // biome-ignore lint/suspicious/noExplicitAny: マイグレーションは今の schema.ts ではなく当時のスキーマを相手にする
    async up(db: Kysely<any>) {
      await db.schema
        .alterTable("intakes")
        .addColumn("mode", "text", (c) =>
          c.notNull().defaultTo("plan").check(sql`mode IN ('plan', 'direct')`),
        )
        .execute();
    },
  },
```

`core/src/domain/intakeStates.ts`（import に `IntakeMode` を `../../../shared/intake/state.ts` から足す）の `isIntakeTerminal` の前:

```ts
/**
 * 作ったときの状態（spec 5.2 の [*] からの辺）。direct は調査・分解・承認を持たず、
 * 作るのと同じトランザクションでタスクを持つので active から始まる。
 */
export function initialIntakeState(mode: IntakeMode): "investigating" | "active" {
  return mode === "direct" ? "active" : "investigating";
}
```

`core/src/db/intakes.ts`: `NewIntake` に `mode?: IntakeMode;`（`schema.ts:43` の `export type { IntakeRunPurpose, IntakeRunStatus, IntakeState };` に `IntakeMode` を足し、`intakes.ts` は `./schema.ts` から import する）を足し、`insertIntake` を:

```ts
/**
 * mode を省くと plan。状態は initialIntakeState で決める（plan は investigating、direct は active）。
 * 同じ Issue の終わっていない Intake があれば例外。
 */
export async function insertIntake(db: Db, i: NewIntake): Promise<IntakeRow> {
  const now = new Date().toISOString();
  const mode = i.mode ?? "plan";
  await db
    .insertInto("intakes")
    .values({ ...i, mode, state: initialIntakeState(mode), created_at: now, updated_at: now })
    .execute();
  return (await getIntake(db, i.id))!;
}
```

（`import { initialIntakeState } from "../domain/intakeStates.ts";` を足す。`intakeStates.ts` からこのファイルへの import は型だけなので循環は型だけになる）

`core/src/intake/view.ts` の `summaryOf` の `issue_title` の後に `mode: row.mode,`。

app の追従:
- `app/src/fixtures.ts` の `intake()` の `issue_title` の後に `mode: "plan",`
- `app/src/worktrees.test.ts` の `intake` の `issue_title` の後に `mode: "plan",`
- `app/src/intake.ts` の `summaryOf` の `issue_title` の後に `mode: d.mode,`

- [ ] **Step 4: 通ることを確かめる**

Run: `(builtin cd /Users/shunsuke.tadokoro/orca/workspaces/doctrine/app_ux/core && node --test test/domain/intakeStates.test.ts test/db/intakes.test.ts test/db/migrate.test.ts) && mise run core:check && (builtin cd /Users/shunsuke.tadokoro/orca/workspaces/doctrine/app_ux/app && pnpm exec tsc)`
Expected: PASS。`intake.start` の params の型が変わったので、app の `store.tsx` の `rpc("intake.start", …)` が型エラーになる。Task 1 では `store.tsx:477` を `rpc("intake.start", { workspace: workspacePath, issue_url: issueUrl, mode: "plan" })` にしておき、Task 4 で引数にする。

- [ ] **Step 5: コミット**

```bash
git add shared core app
git commit -m "Intake に取り込みの種類 mode を足す"
```

---

### Task 2: 帯を `shared/rail.ts` に移し、`intake.get` のプロセスに載せる

**Files:**
- Create: `shared/rail.ts`
- Modify: `app/src/rail.ts:1-78`、`app/src/tone.ts:7`、`app/src/components/WorkflowRail.tsx:2-16`、`app/src/rail.test.ts:4`
- Modify: `shared/protocol.ts:541-544`、`app/src/fixtures.ts:634-646`
- Modify: `core/src/workflow/load.ts`、`core/src/daemon/handlers.ts:145-152,315-320,870-874`、`core/src/intake/view.ts:139-200`
- Modify: `core/test/intake/view.test.ts:84,118`、`core/test/intake/watch.test.ts:415`（`toIntakeDetail` の引数）
- Test: `core/test/intake/view.test.ts`

**Interfaces:**
- Consumes: なし
- Produces: `shared/rail.ts` の `RailStatus`、`RailNode`、
  `buildRail(steps: StepView[] | null, stepRuns: readonly Pick<StepRun, "step_id" | "status">[], task: Pick<TaskSummary, "current_step_id">): RailNode[] | null`、
  `core/src/workflow/load.ts` の `toStepViews(workflow: Workflow): StepView[]`、
  `toIntakeDetail(db: Db, row: IntakeRow, watch: WatchHealth, loadWorkflow: WorkflowLoader): Promise<IntakeDetail>`、
  `IntakeProcessView.rail: RailNode[] | null`

- [ ] **Step 1: 失敗するテストを書く**

`core/test/intake/view.test.ts` の import に `loadWorkflowFromDisk` と `fakeWorkflowLoader`（`../helpers/watcher.ts`）を足す。既存の 2 か所の `toIntakeDetail(db, …, INITIAL_WATCH_HEALTH)` に第 4 引数 `loadWorkflowFromDisk` を足す（`core/test/intake/watch.test.ts:415` も同じ）。末尾に:

```ts
const RAIL_YAML =
  'name: feature\nsteps:\n  - id: a\n    type: command\n    run: "true"\n  - id: review\n    type: approval\n    title: 見て\n';

test("プロセスのいまのタスクの帯を、pin されたワークフローと step_runs から組む", async () => {
  const { db, projectId } = await seedActive();
  await insertTask(db, {
    ...newTaskFor("t1", projectId, "1"),
    workflow_yaml: RAIL_YAML,
    workflow_setup: null,
  });
  await replaceCurrentTask(db, "i1", "1", null, "t1");
  await db.updateTable("tasks").set({ current_step_id: "review" }).where("id", "=", "t1").execute();
  for (const step_id of ["a", "gone"]) {
    await db
      .insertInto("step_runs")
      .values({
        task_id: "t1",
        step_id,
        attempt: 1,
        status: "success",
        exit_code: 0,
        started_at: "2026-10-14T00:00:00.000Z",
        ended_at: "2026-10-14T00:01:00.000Z",
        log_path: "",
        review_tree: null,
        goto_step_id: null,
      })
      .execute();
  }

  const detail = await toIntakeDetail(
    db,
    (await getIntake(db, "i1"))!,
    INITIAL_WATCH_HEALTH,
    fakeWorkflowLoader(RAIL_YAML),
  );
  const rail = detail.processes.find((p) => p.id === "1")!.rail!;
  assert.deepEqual(
    rail.map((n) => [n.id, n.status, n.current, n.unknown]),
    [
      ["a", "success", false, false],
      ["review", "pending", true, false],
      ["gone", "success", false, true],
    ],
  );
  assert.equal(detail.processes.find((p) => p.id === "2")!.rail, null);
});

test("ワークフローを読めないタスクの帯は null で、intake.get は失敗しない", async () => {
  const { db, projectId } = await seedActive();
  await insertTask(db, newTaskFor("t1", projectId, "1"));
  await replaceCurrentTask(db, "i1", "1", null, "t1");
  const detail = await toIntakeDetail(db, (await getIntake(db, "i1"))!, INITIAL_WATCH_HEALTH, () =>
    Promise.reject(new Error("読めない")),
  );
  assert.equal(detail.processes.find((p) => p.id === "1")!.rail, null);
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `builtin cd /Users/shunsuke.tadokoro/orca/workspaces/doctrine/app_ux/core && node --test test/intake/view.test.ts`
Expected: FAIL（`toIntakeDetail` が 4 引数を取らない、`rail` が無い）

- [ ] **Step 3: 実装する**

`shared/rail.ts` を作る。中身は `app/src/rail.ts` の `RailStatus` / `RailNode` / `buildRail`（22-78 行目）をそのまま移し、`stepRuns` の型だけ広げる:

```ts
// task.get の steps / stepRuns / current_step_id を、ワークフローの帯が描くノードの列にする。
// アプリのタスク画面とデーモンの intake.get（IntakeProcessView.rail）が使う。副作用を持たない（テストは app/src/rail.test.ts）
import type { StepRun, StepView, TaskSummary } from "./protocol.ts";

/** 「まだ実行していない」は step_runs に対応する値が無いので、ここで足す。 */
export type RailStatus = StepRun["status"] | "pending";

export type RailNode = {
  id: string;
  /** steps に無く末尾に生やしたノードは種別が分からないので null。 */
  type: StepView["type"] | null;
  /** approval だけが持つ。ツールチップに出す。 */
  title?: string;
  status: RailStatus;
  /** current_step_id と一致するステップ。 */
  current: boolean;
  /** steps に無い step_id / current_step_id を末尾に生やしたノード。 */
  unknown: boolean;
};

/**
 * steps が null（ワークフロー YAML が読めない）なら null。帯は描かない。
 *
 * steps に無い step_id（YAML が編集されて列がずれた）は、stepRuns にあるものも
 * current_step_id も末尾に生やす。黙って落とすと、いま止まっているステップが帯から消える。
 */
export function buildRail(
  steps: StepView[] | null,
  stepRuns: readonly Pick<StepRun, "step_id" | "status">[],
  task: Pick<TaskSummary, "current_step_id">,
): RailNode[] | null {
  if (steps === null) return null;

  const known = new Set(steps.map((s) => s.id));
  const extra: string[] = [];
  for (const id of [...stepRuns.map((r) => r.step_id), task.current_step_id]) {
    if (id !== null && !known.has(id)) {
      known.add(id);
      extra.push(id);
    }
  }

  // stepRuns は id の昇順で届くので、step_id ごとに後から上書きしたものが最後の run。
  const lastOf = new Map<string, Pick<StepRun, "status">>();
  for (const r of stepRuns) lastOf.set(r.step_id, r);

  return [
    ...steps.map((s) => ({
      id: s.id,
      type: s.type,
      title: s.title,
      unknown: false,
    })),
    ...extra.map((id) => ({ id, type: null, title: undefined, unknown: true })),
  ].map(({ title, ...n }) => ({
    ...n,
    ...(title !== undefined && { title }),
    status: lastOf.get(n.id)?.status ?? "pending",
    current: n.id === task.current_step_id,
  }));
}
```

`app/src/rail.ts`: 22-78 行目（`RailStatus` から `buildRail` の終わりまで）を消す。先頭の 2 行を
`// 設定画面の「ワークフローの定義の図」の寸法と組み立て。副作用を持たない（テストは rail.test.ts）` にし、
import を `import type { WorkflowStepDetail } from "../../shared/protocol.ts";` だけにする。
10-11 行目のコメントの「タスク画面の帯（buildRail）」を「タスク画面の帯（shared/rail.ts の buildRail）」にする。

app の import の書き換え:
- `app/src/tone.ts:7` を `import type { RailStatus } from "../../shared/rail.ts";`
- `app/src/components/WorkflowRail.tsx` の `../rail` からの import から `buildRail` と `type RailNode` を外し、
  `import { buildRail, type RailNode } from "../../../shared/rail.ts";` を足す
- `app/src/rail.test.ts:4` を `import { buildDefinitionRail, GAP, NODE_W } from "./rail";` と `import { buildRail } from "../../shared/rail.ts";` の 2 行にする

`shared/protocol.ts` に `import type { RailNode } from "./rail.ts";` を足し、`IntakeProcessView` を:

```ts
export type IntakeProcessView = { id: string } & ProcessStatus & {
    sub_issue_url: string | null;
    task_ids: string[];
    rail: RailNode[] | null;
  };
```

`app/src/fixtures.ts` の `INTAKE_ACTIVE.processes` の map に `rail: null,` を足す。

`core/src/workflow/load.ts`: `daemon/handlers.ts:145-152` の `toStepViews` を export 付きで移す（`StepView` を `../../../shared/protocol.ts` から import）。`handlers.ts` は `../workflow/load.ts` から import する。

```ts
/** 帯が描く分だけを残す。title は approval だけが持つ。 */
export function toStepViews(workflow: Workflow): StepView[] {
  return workflow.steps.map((step) => {
    const view: StepView = { id: step.id, type: step.type };
    if (step.type === "approval") view.title = step.title;
    return view;
  });
}
```

`core/src/intake/view.ts`: import に `getProject`（`../db/tasks.ts`）、`listStepRuns`（`../db/stepRuns.ts`）、`taskWorkflow` / `toStepViews` / `type WorkflowLoader`（`../workflow/load.ts`）、`buildRail` / `type RailNode`（`../../../shared/rail.ts`）を足し、`toIntakeDetail` の前に:

```ts
/** プロセス id → いまのタスクの帯。タスクが無いプロセスは入らない。 */
async function railsOf(
  db: Db,
  intakeId: string,
  loadWorkflow: WorkflowLoader,
): Promise<Map<string, RailNode[] | null>> {
  const rails = new Map<string, RailNode[] | null>();
  for (const p of await listProcesses(db, intakeId)) {
    if (p.retired_at !== null || p.current_task_id === null) continue;
    const task = (await getTask(db, p.current_task_id))!;
    const project = (await getProject(db, task.project_id))!;
    // task.get と同じく、ワークフローが読めないことで intake.get を失敗させない
    const workflow = await taskWorkflow(task, project, loadWorkflow).catch(() => null);
    rails.set(
      p.process_id,
      buildRail(workflow && toStepViews(workflow), await listStepRuns(db, task.id), task),
    );
  }
  return rails;
}
```

`toIntakeDetail` に第 4 引数 `loadWorkflow: WorkflowLoader` を足し、本体の先頭で `const rails = await railsOf(db, row.id, loadWorkflow);`、`processes` の map に `rail: rails.get(f.id) ?? null,` を足す。

`core/src/daemon/handlers.ts` の `intakeDetailOf`（319 行目）と `case "intake.get"`（873 行目）の `toIntakeDetail` に `ctx.loadWorkflow` を渡す。

- [ ] **Step 4: 通ることを確かめる**

Run: `(builtin cd /Users/shunsuke.tadokoro/orca/workspaces/doctrine/app_ux/core && node --test test/intake/view.test.ts test/intake/watch.test.ts) && mise run core:check && (builtin cd /Users/shunsuke.tadokoro/orca/workspaces/doctrine/app_ux/app && pnpm exec tsc && pnpm exec vitest run src/rail.test.ts src/WorkflowRail.test.tsx)`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add shared core app
git commit -m "ワークフローの帯を shared に移し、intake.get のプロセスに載せる"
```

---

### Task 3: direct のプロセスの状態

**Files:**
- Modify: `core/src/intake/pfd/status.ts`（`settledState` の周り）
- Modify: `core/src/intake/processProject.ts`
- Modify: `core/src/intake/view.ts`（`processStatusesOf`）
- Modify: `core/src/intake/dispatch.ts`（`directTask` / `directTaskPrompt` / `insertDirectIntake` を足す）
- Modify: `core/test/intake/watchFixture.ts`（`seedDirect` を足す）
- Test: `core/test/intake/pfd/status.test.ts`、`core/test/intake/direct.test.ts`（新規）

**Interfaces:**
- Consumes: Task 1 の `DIRECT_PROCESS_ID`、`NewIntake.mode`。Task 2 の `toIntakeDetail(db, row, watch, loadWorkflow)`
- Produces:
  - `directProcessStatus(progress: ProcessProgress, baseBranch: string): ProcessStatusEntry`（`pfd/status.ts`）
  - `directBaseBranch(db: Db, intakeId: string): Promise<string>`（`processProject.ts`）
  - `directStatusOf(db: Db, intakeId: string): Promise<ProcessStatusEntry>`（`view.ts`）
  - `directTaskPrompt(issue: Pick<IssueDetail, "url" | "title" | "body">): string`、
    `directTask(o: { intakeId: string; issueUrl: string; project: ProjectRow; title: string; prompt: string; pin: WorkflowPin }): NewTask`、
    `insertDirectIntake(db: Db, o: { intake: Omit<NewIntake, "mode">; project: ProjectRow; issue: Pick<IssueDetail, "url" | "title" | "body">; pin: WorkflowPin }): Promise<IntakeRow>`（`dispatch.ts`）
  - テストの種 `seedDirect(): Promise<{ db: Db; projectId: number; workspaceId: number; taskId: string }>`（Intake の id は `d1`、親 Issue は `PARENT_URL`）と `DIRECT_WORKFLOW`（`watchFixture.ts`）

- [ ] **Step 1: 失敗するテストを書く**

`core/test/intake/pfd/status.test.ts` の import に `directProcessStatus` を足し、末尾に:

```ts
const directProgress = (o: Partial<ProcessProgress> = {}): ProcessProgress => ({
  task: { id: "t1", state: "running" },
  pr: null,
  subIssueUrl: null,
  humanDone: null,
  ...o,
});

test("direct: タスクと PR だけから running / pr_open / merged / needs_attention を求める", () => {
  const state = (o: Partial<ProcessProgress>) =>
    directProcessStatus(directProgress(o), "main").state;
  assert.equal(state({}), "running");
  assert.equal(state({ pr: pr("OPEN") }), "pr_open");
  assert.equal(state({ pr: pr("MERGED") }), "merged");
  assert.equal(state({ pr: pr("MERGED", "release") }), "needs_attention");
  assert.equal(state({ pr: pr("CLOSED") }), "needs_attention");
  assert.equal(state({ task: { id: "t1", state: "completed" } }), "needs_attention");
  assert.equal(state({ task: { id: "t1", state: "failed" } }), "needs_attention");
  assert.equal(directProcessStatus(directProgress(), "main").id, "main");
});

test("direct: タスクが無ければ投げる", () => {
  assert.throws(
    () => directProcessStatus(directProgress({ task: null }), "main"),
    /タスクがありません/,
  );
});
```

`core/test/intake/watchFixture.ts` に（import に `insertDirectIntake`（`../../src/intake/dispatch.ts`）、`listProcesses`（`../../src/db/intakes.ts`）、`pinOf`（`../../src/workflow/load.ts`）、`fakeWorkflowLoader`（`../helpers/watcher.ts`）を足す）:

```ts
export const DIRECT_WORKFLOW =
  'name: feature\nsteps:\n  - id: a\n    type: command\n    run: "true"\n  - id: review\n    type: approval\n    title: 見て\n';

/** direct で開始した Intake（id は d1、親 Issue は PARENT_URL）を 1 つ持つ DB。 */
export async function seedDirect(): Promise<{
  db: Db;
  projectId: number;
  workspaceId: number;
  taskId: string;
}> {
  const db = await openDb(":memory:");
  const project = await seedProject(db, { path: "/repo", default_workflow: "feature" });
  const loaded = await fakeWorkflowLoader(DIRECT_WORKFLOW)("/repo", "feature");
  await insertDirectIntake(db, {
    intake: {
      id: "d1",
      workspace_id: project.workspace_id,
      issue_url: PARENT_URL,
      issue_node_id: "I_1",
      issue_title: "直す",
    },
    project,
    issue: { url: PARENT_URL, title: "直す", body: "本文" },
    pin: pinOf(loaded, project),
  });
  const taskId = (await listProcesses(db, "d1"))[0].current_task_id!;
  return { db, projectId: project.id, workspaceId: project.workspace_id, taskId };
}
```

`core/test/intake/direct.test.ts` を作る:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { getIntake, listProcesses, upsertPrObservation } from "../../src/db/intakes.ts";
import { getTask } from "../../src/db/tasks.ts";
import { insertDirectIntake } from "../../src/intake/dispatch.ts";
import { toIntakeDetail } from "../../src/intake/view.ts";
import { INITIAL_WATCH_HEALTH } from "../../src/intake/watch.ts";
import { fakeWorkflowLoader } from "../helpers/watcher.ts";
import { DIRECT_WORKFLOW, PARENT_URL, seedDirect } from "./watchFixture.ts";

test("direct: Intake は active で、プロセス main とタスク 1 本を持つ", async () => {
  const { db, projectId, taskId } = await seedDirect();
  const intake = (await getIntake(db, "d1"))!;
  assert.equal(intake.mode, "direct");
  assert.equal(intake.state, "active");
  const rows = await listProcesses(db, "d1");
  assert.deepEqual(
    rows.map((r) => [r.process_id, r.sub_issue_url]),
    [["main", null]],
  );
  const task = (await getTask(db, taskId))!;
  assert.equal(task.project_id, projectId);
  assert.equal(task.title, "直す");
  assert.equal(task.prompt, `# 直す\n\n${PARENT_URL}\n\n本文`);
  assert.equal(task.workflow_name, "feature");
  assert.equal(task.workflow_yaml, DIRECT_WORKFLOW);
  assert.equal(task.issue_url, PARENT_URL);
  assert.equal(task.parent_issue_url, null);
  assert.equal(task.intake_id, "d1");
  assert.equal(task.intake_process_id, "main");
});

test("direct: タスクを入れられなければ、Intake もプロセスも残らない", async () => {
  const { db } = await seedDirect();
  const project = {
    ...(await db.selectFrom("projects").selectAll().executeTakeFirstOrThrow()),
    id: 9999,
  };
  const loaded = await fakeWorkflowLoader(DIRECT_WORKFLOW)("/repo", "feature");
  await assert.rejects(() =>
    insertDirectIntake(db, {
      intake: {
        id: "d2",
        workspace_id: project.workspace_id,
        issue_url: "https://github.com/o/r/issues/2",
        issue_node_id: "I_2",
        issue_title: "別",
      },
      project,
      issue: { url: "https://github.com/o/r/issues/2", title: "別", body: "" },
      pin: { workflow_yaml: loaded.text, workflow_setup: null },
    }),
  );
  assert.equal(await getIntake(db, "d2"), undefined);
  assert.deepEqual(await listProcesses(db, "d2"), []);
});

test("direct: intake.get はプロセス main 1 つと帯を返し、PR のマージで merged になる", async () => {
  const { db, taskId } = await seedDirect();
  const loader = fakeWorkflowLoader(DIRECT_WORKFLOW);
  const before = await toIntakeDetail(
    db,
    (await getIntake(db, "d1"))!,
    INITIAL_WATCH_HEALTH,
    loader,
  );
  assert.equal(before.mode, "direct");
  assert.equal(before.approval, null);
  assert.deepEqual(before.progress, { done: 0, total: 1 });
  assert.equal(before.needs_human, false);
  const main = before.processes[0];
  assert.equal(before.processes.length, 1);
  assert.equal(main.id, "main");
  assert.equal(main.state, "running");
  assert.equal(main.sub_issue_url, null);
  assert.deepEqual(main.task_ids, [taskId]);
  assert.deepEqual(
    main.rail!.map((n) => n.id),
    ["a", "review"],
  );

  await upsertPrObservation(db, {
    task_id: taskId,
    pr_number: 7,
    pr_url: "https://github.com/o/r/pull/7",
    state: "MERGED",
    base_ref: "main",
    merged_at: "2026-10-14T00:00:00.000Z",
    merge_commit: "c7",
  });
  const after = await toIntakeDetail(
    db,
    (await getIntake(db, "d1"))!,
    INITIAL_WATCH_HEALTH,
    loader,
  );
  assert.equal(after.processes[0].state, "merged");
  assert.deepEqual(after.progress, { done: 1, total: 1 });
});

test("direct: タスクが止まると要確認になり、needs_human が立つ", async () => {
  const { db, taskId } = await seedDirect();
  await db.updateTable("tasks").set({ state: "failed" }).where("id", "=", taskId).execute();
  const detail = await toIntakeDetail(
    db,
    (await getIntake(db, "d1"))!,
    INITIAL_WATCH_HEALTH,
    fakeWorkflowLoader(DIRECT_WORKFLOW),
  );
  const main = detail.processes[0];
  assert.equal(main.state, "needs_attention");
  assert.equal("reason" in main && main.reason, "task_stopped");
  assert.equal(detail.needs_human, true);
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `builtin cd /Users/shunsuke.tadokoro/orca/workspaces/doctrine/app_ux/core && node --test test/intake/pfd/status.test.ts test/intake/direct.test.ts`
Expected: FAIL（`directProcessStatus` / `insertDirectIntake` が無い）

- [ ] **Step 3: 実装する**

`core/src/intake/pfd/status.ts`: `settledState` のエージェントの部分を切り出す（import に `DIRECT_PROCESS_ID` を足す）:

```ts
// エージェントのプロセスの、タスクと PR だけで決まる状態。タスクが無ければ null
function agentState(
  id: string,
  progress: ProcessProgress,
  baseBranch: string | undefined,
): ProcessStatusEntry | null {
  const { task, pr } = progress;
  if (!task) return null;
  const taskId = task.id;
  if (pr) {
    if (pr.state === "MERGED" && pr.baseRef === baseBranch) {
      return { id, state: "merged", taskId, pr };
    }
    if (pr.state === "OPEN") return { id, state: "pr_open", taskId, pr };
    return { id, state: "needs_attention", taskId, reason: "pr_closed" };
  }
  if (task.state === "completed") {
    return { id, state: "needs_attention", taskId, reason: "no_pr" };
  }
  if (task.state === "failed" || task.state === "canceled") {
    return { id, state: "needs_attention", taskId, reason: "task_stopped" };
  }
  return { id, state: "running", taskId };
}

// 入力の成果物を見ずに決まる状態。決まらなければ null
function settledState(
  process: Process,
  progress: ProcessProgress,
  baseBranch: string | undefined,
): ProcessStatusEntry | null {
  if (process.actor === "human") {
    return progress.humanDone ? { id: process.id, state: "done", ...progress.humanDone } : null;
  }
  return agentState(process.id, progress, baseBranch);
}

/**
 * direct の Intake のプロセス main の状態。タスクは開始と同じトランザクションで作るので、
 * running / pr_open / merged / needs_attention のどれかになる。
 */
export function directProcessStatus(
  progress: ProcessProgress,
  baseBranch: string,
): ProcessStatusEntry {
  const entry = agentState(DIRECT_PROCESS_ID, progress, baseBranch);
  if (!entry) throw new Error("direct の Intake にタスクがありません");
  return entry;
}
```

`core/src/intake/processProject.ts`（import に `DIRECT_PROCESS_ID` を足す）:

```ts
/** direct の Intake の、いまのタスクのプロジェクトの base_branch。 */
export async function directBaseBranch(db: Db, intakeId: string): Promise<string> {
  const row = await db
    .selectFrom("intake_processes as p")
    .innerJoin("tasks as t", "t.id", "p.current_task_id")
    .innerJoin("projects as pr", "pr.id", "t.project_id")
    .select("pr.base_branch as base_branch")
    .where("p.intake_id", "=", intakeId)
    .where("p.process_id", "=", DIRECT_PROCESS_ID)
    .executeTakeFirst();
  if (!row) throw new Error(`direct の Intake ${intakeId} にタスクがありません`);
  return row.base_branch;
}
```

`core/src/intake/view.ts`（import に `DIRECT_PROCESS_ID`、`directProcessStatus`、`directBaseBranch`、`ProcessStatusEntry` を足す）:

```ts
/** direct の Intake のプロセス main の状態（spec 5.3）。 */
export async function directStatusOf(db: Db, intakeId: string): Promise<ProcessStatusEntry> {
  const progress = (await processProgressOf(db, intakeId)).get(DIRECT_PROCESS_ID);
  if (!progress) throw new Error(`direct の Intake ${intakeId} にプロセスがありません`);
  return directProcessStatus(progress, await directBaseBranch(db, intakeId));
}
```

`processStatusesOf` の先頭に:

```ts
  if (row.mode === "direct") {
    const status = await directStatusOf(db, row.id);
    return [{ id: status.id, status, subIssueUrl: null }];
  }
```

（`processStatusesOf` の doc を「plan は承認の前は空配列。承認後は、承認された案と DB の進み具合から組む。direct はプロセス main の 1 つ。」にする）

`core/src/intake/dispatch.ts`（import に `DIRECT_PROCESS_ID`、`IssueDetail`（`../../../shared/intake/tracker.ts`）、`insertIntake` / `insertProcesses` / `type NewIntake`（`../db/intakes.ts`）を足す）:

```ts
/** direct のタスクの prompt。Issue の本文の前に、題と URL を置く。 */
export function directTaskPrompt(issue: Pick<IssueDetail, "url" | "title" | "body">): string {
  return `# ${issue.title}\n\n${issue.url}\n\n${issue.body}`;
}

/** direct の Intake のタスク。issue_url は親 Issue そのもので、sub-issue は無い。 */
export function directTask(o: {
  intakeId: string;
  issueUrl: string;
  project: ProjectRow;
  title: string;
  prompt: string;
  pin: WorkflowPin;
}): NewTask {
  const id = crypto.randomUUID();
  return {
    id,
    project_id: o.project.id,
    title: o.title,
    prompt: o.prompt,
    workflow_name: o.project.default_workflow,
    branch: branchNameFor(id, o.title),
    priority: 2,
    intake_id: o.intakeId,
    intake_process_id: DIRECT_PROCESS_ID,
    issue_url: o.issueUrl,
    parent_issue_url: null,
    ...o.pin,
  };
}

/**
 * direct の Intake を、プロセス main とそのタスクごと 1 トランザクションで入れる（spec 5.1）。
 * 調査・分解・承認・sub-issue の同期・投入はどれも通らない。
 */
export async function insertDirectIntake(
  db: Db,
  o: {
    intake: Omit<NewIntake, "mode">;
    project: ProjectRow;
    issue: Pick<IssueDetail, "url" | "title" | "body">;
    pin: WorkflowPin;
  },
): Promise<IntakeRow> {
  return await db.transaction().execute(async (trx) => {
    const row = await insertIntake(trx, { ...o.intake, mode: "direct" });
    await insertProcesses(trx, row.id, [DIRECT_PROCESS_ID]);
    const task = directTask({
      intakeId: row.id,
      issueUrl: row.issue_url,
      project: o.project,
      title: o.issue.title,
      prompt: directTaskPrompt(o.issue),
      pin: o.pin,
    });
    await insertTask(trx, task);
    if (!(await replaceCurrentTask(trx, row.id, DIRECT_PROCESS_ID, null, task.id))) {
      throw new Error("direct のタスクを紐づけられませんでした");
    }
    return row;
  });
}
```

- [ ] **Step 4: 通ることを確かめる**

Run: `(builtin cd /Users/shunsuke.tadokoro/orca/workspaces/doctrine/app_ux/core && node --test test/intake/pfd/status.test.ts test/intake/direct.test.ts test/intake/view.test.ts) && mise run core:check`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add core
git commit -m "direct の Intake のプロセスの状態を、PFD を使わずに求める"
```

---

### Task 4: `intake.start` で direct を開始する

**Files:**
- Modify: `core/src/intake/commands.ts`（import と `startIntake`）
- Modify: `core/src/daemon/handlers.ts`（`case "intake.start"`）
- Modify: `core/test/daemon/intakeHandlers.test.ts`（既存の `intake.start` の呼び出しすべてに `mode: "plan"`）
- Modify: `app/src/store.tsx`（`start`）、`app/src/components/IssuePicker.tsx`（`startIntake` と呼び出し）、`app/src/IssuePicker.test.tsx`（`describe("startIntake")` の `deps.start` と 2 つの呼び出し）
- Test: `core/test/intake/direct.test.ts`、`core/test/daemon/intakeHandlers.test.ts`

**Interfaces:**
- Consumes: Task 3 の `insertDirectIntake`
- Produces: `startIntake(db, wt, o: { workspaceId: number; issueUrl: string; logRoot: string; mode: IntakeMode }, deps: { loadWorkflow: WorkflowLoader })`、
  アプリの `useIntakeRpc().start(workspacePath, issueUrl, mode)`、
  `startIntake(root: string, issueUrl: string, mode: IntakeMode, deps)`（`IssuePicker.tsx`。段階 2 が選択の UI から mode を渡す）

- [ ] **Step 1: 失敗するテストを書く**

`core/test/intake/direct.test.ts` に（import に `startIntake`（`../../src/intake/commands.ts`）、`openDb`、`seedProject`（`../helpers/project.ts`）、`fakeTracker`（`../helpers/tracker.ts`）を足す）:

```ts
async function startDirect(loadWorkflow = fakeWorkflowLoader(DIRECT_WORKFLOW)) {
  const db = await openDb(":memory:");
  const project = await seedProject(db, { path: "/repo", default_workflow: "feature" });
  const wt = {
    tracker: fakeTracker({ title: "直す", body: "本文" }),
    projectPathFor: () => Promise.resolve("/repo"),
  };
  const started = () =>
    startIntake(
      db,
      wt,
      {
        workspaceId: project.workspace_id,
        issueUrl: PARENT_URL,
        logRoot: "/tmp/doctrine-test-logs",
        mode: "direct",
      },
      { loadWorkflow },
    );
  return { db, started };
}

test("startIntake: direct は調査を立てず、Intake・プロセス・タスクを作る", async () => {
  const { db, started } = await startDirect();
  const { intake, alreadyActive } = await started();
  assert.equal(alreadyActive, false);
  assert.equal(intake.state, "active");
  assert.equal(intake.mode, "direct");
  assert.deepEqual(await db.selectFrom("intake_runs").selectAll().execute(), []);
  const [main] = await listProcesses(db, intake.id);
  assert.equal((await getTask(db, main.current_task_id!))!.title, "直す");
});

test("startIntake: ワークフローを読めなければ direct の開始は失敗し、何も作らない", async () => {
  const { db, started } = await startDirect(() => Promise.reject(new Error("YAML が壊れている")));
  await assert.rejects(started, /YAML が壊れている/);
  assert.deepEqual(await db.selectFrom("intakes").selectAll().execute(), []);
  assert.deepEqual(await db.selectFrom("tasks").selectAll().execute(), []);
});

test("startIntake: 同じ Issue の direct がまだ終わっていなければ、それを返す", async () => {
  const { started } = await startDirect();
  const first = await started();
  const second = await started();
  assert.equal(second.alreadyActive, true);
  assert.equal(second.intake.id, first.intake.id);
});
```

`core/test/daemon/intakeHandlers.test.ts`: 既存の `"intake.start"` の呼び出しすべてに `mode: "plan"` を足す:

```bash
perl -0pi -e 's/("intake\.start",\s*\{)/$1 mode: "plan",/g' core/test/daemon/intakeHandlers.test.ts
pnpm exec biome format --write core/test/daemon/intakeHandlers.test.ts
```

（import に `listProcesses` は既にある。`getTask` も既にある）その後、末尾近くに:

```ts
test("direct で開始すると、調査を立てずに active になり、プロセス main とタスクが 1 つずつできる", async () => {
  const { ctx, call } = await setup();
  const started = await call<IntakeSummary & { alreadyActive: boolean }>("intake.start", {
    workspace: repo,
    issue_url: ISSUE,
    mode: "direct",
  });
  assert.equal(started.state, "active");
  assert.equal(started.mode, "direct");
  assert.deepEqual(started.progress, { done: 0, total: 1 });
  assert.deepEqual(await listIntakeRuns(ctx.db, started.id), []);
  const rows = await listProcesses(ctx.db, started.id);
  assert.deepEqual(
    rows.map((r) => [r.process_id, r.sub_issue_url]),
    [["main", null]],
  );
  const task = (await getTask(ctx.db, rows[0].current_task_id!))!;
  assert.equal(task.workflow_name, "feature");
  assert.equal(task.issue_url, ISSUE);
  assert.equal(task.parent_issue_url, null);
  const detail = await call<IntakeDetail>("intake.get", { intake_id: started.id });
  assert.deepEqual(
    detail.processes[0].rail!.map((n) => n.id),
    ["review"],
  );
});

test("mode が plan でも direct でもない intake.start は拒まれる", async () => {
  const { call } = await setup();
  await assert.rejects(
    () => call("intake.start", { workspace: repo, issue_url: ISSUE }),
    /mode は plan か direct です/,
  );
  assert.deepEqual(await call<IntakeSummary[]>("intake.list"), []);
});
```

`app/src/IssuePicker.test.tsx`: 37 行目を
`start: (w: string, u: string, m: IntakeMode) => rpc("intake.start", { workspace: w, issue_url: u, mode: m }),`
（`IntakeMode` を `../../shared/protocol.ts` から type import）、48 行目と 59 行目の `startIntake(…, "https://github.com/o/r/issues/8", deps)` を
`startIntake(…, "https://github.com/o/r/issues/8", "direct", deps)` にし、51 行目の期待値を
`params: { workspace: "~/work/shop-api", issue_url: "https://github.com/o/r/issues/8", mode: "direct" },` にする。

- [ ] **Step 2: 失敗を確かめる**

Run: `(builtin cd /Users/shunsuke.tadokoro/orca/workspaces/doctrine/app_ux/core && node --test test/intake/direct.test.ts test/daemon/intakeHandlers.test.ts); (builtin cd /Users/shunsuke.tadokoro/orca/workspaces/doctrine/app_ux/app && pnpm exec vitest run src/IssuePicker.test.tsx)`
Expected: FAIL（`startIntake` が mode を見ない、`mode` の検査が無い、`startIntake` の引数が違う）

- [ ] **Step 3: 実装する**

`core/src/intake/commands.ts` の `startIntake`（import に `getProjectByPath`（`../db/tasks.ts`）、`insertDirectIntake`（`./dispatch.ts` の既存の import に足す）、`pinOf` / `type WorkflowLoader`（`../workflow/load.ts`）、`IntakeMode`（`../../../shared/intake/state.ts`）を足す）:

```ts
/**
 * 同じ Issue の終わっていない Intake があれば、作らずにそれを返す。
 * 失敗応答は文字列しか運べず既存の id を返せないので、失敗にはしない（spec 13 章）。
 * direct は調査を立てず、プロセス main とタスクを同じトランザクションで作る。ワークフローが読めなければ何も作らない。
 */
export async function startIntake(
  db: Db,
  wt: Pick<WorkspaceTracker, "tracker" | "projectPathFor">,
  o: { workspaceId: number; issueUrl: string; logRoot: string; mode: IntakeMode },
  deps: { loadWorkflow: WorkflowLoader },
): Promise<{ intake: IntakeRow; alreadyActive: boolean; problems: string[] }> {
  // gh が使えなくても、進行中の Intake は開けるように、gh を呼ぶ前にも引く。
  const opened = await findOpenIntakeByIssue(db, o.issueUrl);
  if (opened) return { intake: opened, alreadyActive: true, problems: [] };

  const projectPath = await wt.projectPathFor(o.issueUrl);
  if (projectPath === null) {
    throw new Error(`この Issue は workspace のどのリポジトリにもありません: ${o.issueUrl}`);
  }
  const tracker = wt.tracker;
  const issue = await tracker.readIssue(projectPath, o.issueUrl);
  const canonical = await findOpenIntakeByIssue(db, issue.url);
  if (canonical) return { intake: canonical, alreadyActive: true, problems: [] };

  const problems: string[] = [];
  const fields = {
    id: crypto.randomUUID(),
    workspace_id: o.workspaceId,
    issue_url: issue.url,
    issue_node_id: issue.nodeId,
    issue_title: issue.title,
  };
  try {
    let intake: IntakeRow;
    if (o.mode === "direct") {
      const project = await getProjectByPath(db, projectPath);
      if (!project) throw new Error(`未登録のプロジェクトです: ${projectPath}`);
      const loaded = await deps.loadWorkflow(project.path, project.default_workflow);
      for (const w of loaded.warnings) problems.push(`作成時の検証: ${w}`);
      intake = await insertDirectIntake(db, {
        intake: fields,
        project,
        issue,
        pin: pinOf(loaded, project),
      });
    } else {
      intake = await db.transaction().execute(async (trx) => {
        const row = await insertIntake(trx, fields);
        await enqueueIntakeRun(trx, row.id, "investigate", { logRoot: o.logRoot, resume: false });
        return row;
      });
    }
    // 失敗しても開始は成功させる。承認の後の見張りの周が issue_phase を見てやり直す
    try {
      await advanceParentIssue(db, tracker, { projectPath, intake });
    } catch (e) {
      problems.push(
        `親 Issue の Linear の状態を進められませんでした: ${e instanceof Error ? e.message : e}`,
      );
    }
    return { intake, alreadyActive: false, problems };
  } catch (e) {
    // 競合で同じ Issue の Intake が先に入った。部分 unique index が最後の砦になる。
    if (!(e as Error).message.includes("UNIQUE constraint failed")) throw e;
    const winner = await findOpenIntakeByIssue(db, issue.url);
    if (!winner) throw e;
    return { intake: winner, alreadyActive: true, problems: [] };
  }
}
```

`core/src/daemon/handlers.ts` の `case "intake.start"`:

```ts
      case "intake.start": {
        const mode = params.mode;
        if (mode !== "plan" && mode !== "direct") throw new Error("mode は plan か direct です");
        const ws = await reqWorkspace(ctx, params);
        const wt = await ctx.trackerOf(await workspaceRefOf(ctx.db, ws.id));
        const { intake, alreadyActive, problems } = await startIntake(ctx.db, wt, {
          workspaceId: ws.id,
          issueUrl: req(params, "issue_url"),
          logRoot: ctx.logRoot,
          mode,
        }, { loadWorkflow: ctx.loadWorkflow });
        // direct の作成時の検証の警告は、task.create と同じくタスクに紐づけずに積む
        for (const message of problems) ctx.warnings.push(message);
        const summary = await toIntakeSummary(
          ctx.db,
          intake,
          ctx.intakeWatcher.health(intake.workspace_id),
        );
        return { ...summary, alreadyActive };
      }
```

`app/src/store.tsx`: `../../shared/protocol.ts` からの type import（26 行目）に `IntakeMode` を足し、`start` を:

```ts
    start: (
      workspacePath: string,
      issueUrl: string,
      mode: IntakeMode,
    ): Promise<IntakeSummary & { alreadyActive: boolean }> =>
      rpc("intake.start", { workspace: workspacePath, issue_url: issueUrl, mode }),
```

`app/src/components/IssuePicker.tsx`: `startIntake` に `mode: IntakeMode` を第 3 引数で足し、`deps.start(root, issueUrl, mode)` を呼ぶ。
390 行目の呼び出しは `startIntake(workspace.path, picked.url, "plan", { start: api.start, dispatch })` にする（選択の UI は段階 2 が足す）。

- [ ] **Step 4: 通ることを確かめる**

Run: `(builtin cd /Users/shunsuke.tadokoro/orca/workspaces/doctrine/app_ux/core && node --test test/intake/direct.test.ts test/daemon/intakeHandlers.test.ts) && mise run core:check && (builtin cd /Users/shunsuke.tadokoro/orca/workspaces/doctrine/app_ux/app && pnpm exec tsc && pnpm exec vitest run src/IssuePicker.test.tsx)`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add core app
git commit -m "intake.start で direct を開始できるようにする"
```

---

### Task 5: 見張りが direct の Intake をマージで完了にする

**Files:**
- Modify: `core/src/intake/watch.ts`（`watchWorkspace` の最後の、完了の判定の周）
- Test: `core/test/intake/direct.test.ts`

**Interfaces:**
- Consumes: Task 3 の `directStatusOf`、`seedDirect`
- Produces: なし

- [ ] **Step 1: 失敗するテストを書く**

`core/test/intake/direct.test.ts` に（import に `createIntakeWatcher`（`../../src/intake/watch.ts` の既存の import に足す）、`fakeTracker as statefulTracker`（`../helpers/fakeTracker.ts`）、`constTrackerOf`（`../helpers/tracker.ts`）、`fakePrWatcher`（`../helpers/prWatcher.ts`）、`fakeBaseSync`（`../helpers/watcher.ts` の既存の import に足す）、`type IntakeTransition`（`../../src/intake/commands.ts`）を足す）:

```ts
async function watchDirect() {
  const seeded = await seedDirect();
  const ft = statefulTracker();
  const pw = fakePrWatcher();
  const transitions: IntakeTransition[] = [];
  const watcher = createIntakeWatcher({
    db: seeded.db,
    trackerOf: constTrackerOf(ft.tracker),
    prWatcher: pw.prWatcher,
    baseSync: fakeBaseSync().baseSync,
    loadWorkflow: fakeWorkflowLoader(DIRECT_WORKFLOW),
    onStateChanged: (t) => transitions.push(t),
    onUpdated: () => {},
  });
  return { ...seeded, ft, pw, watcher, transitions };
}

const merged = (baseRef: string) => ({
  number: 7,
  url: "https://github.com/o/r/pull/7",
  state: "MERGED" as const,
  baseRef,
  mergedAt: "2026-10-14T00:00:00.000Z",
  mergeCommit: "c7",
});

test("見張り: direct は sub-issue を作らず、PR のマージで completed にする", async () => {
  const s = await watchDirect();
  await s.watcher.request(s.workspaceId);
  assert.equal((await getIntake(s.db, "d1"))!.state, "active");
  assert.equal(s.ft.calls.filter((c) => c.op === "createSubIssue").length, 0);

  const task = (await getTask(s.db, s.taskId))!;
  s.pw.prs.set(task.branch, [merged("main")]);
  await s.watcher.request(s.workspaceId);
  const row = (await getIntake(s.db, "d1"))!;
  assert.equal(row.state, "completed");
  assert.notEqual(row.ended_at, null);
  assert.deepEqual(
    s.transitions.map((t) => [t.from, t.to]),
    [["active", "completed"]],
  );
  assert.equal((await listTasks(s.db)).length, 1);
});

test("見張り: direct の PR が base_branch 以外へマージされても完了にしない", async () => {
  const s = await watchDirect();
  const task = (await getTask(s.db, s.taskId))!;
  s.pw.prs.set(task.branch, [merged("release")]);
  await s.watcher.request(s.workspaceId);
  assert.equal((await getIntake(s.db, "d1"))!.state, "active");
  assert.deepEqual(s.transitions, []);
});
```

（import の `getTask` の並びに `listTasks`（`../../src/db/tasks.ts`）を足す）

- [ ] **Step 2: 失敗を確かめる**

Run: `builtin cd /Users/shunsuke.tadokoro/orca/workspaces/doctrine/app_ux/core && node --test test/intake/direct.test.ts`
Expected: FAIL（マージしても `active` のまま）

- [ ] **Step 3: 実装する**

`core/src/intake/watch.ts`（import に `directStatusOf`（`./view.ts` の既存の import に足す）を足す）。
完了の判定の周（`for (const intake of intakes) { … goalReached … }`）を次で置き換え、その上に関数を足す:

```ts
/** plan は goal の成果物が揃ったか、direct はプロセス main がマージされたか。plan で承認が無ければ false。 */
async function reachedGoal(db: Db, intake: IntakeRow): Promise<boolean> {
  if (intake.mode === "direct") return (await directStatusOf(db, intake.id)).state === "merged";
  const plan = await approvedPlanOf(db, intake);
  if (!plan) return false;
  const statuses = computeProcessStatuses({
    pfd: plan.pfd,
    baseBranches: plan.baseBranches,
    revising: false,
    dispatchPaused: false,
    progress: await processProgressOf(db, intake.id),
  });
  return goalReached(plan.pfd, statuses);
}
```

```ts
    for (const intake of intakes) {
      try {
        if (!(await reachedGoal(db, intake))) continue;
        const transition = await completeIntake(db, intake.id);
        if (transition) report.transitions.push(transition);
      } catch (e) {
        report.errors.push(`${intake.issue_url} の完了の判定: ${describe(e)}`);
      }
    }
```

direct の Intake は承認を持たないので、sub-issue の同期（`loadApprovedPlan` が null）・投入（`dispatchIntake` が承認の無い Intake には空の報告で戻る）・マージでの sub-issue の閉じ（`approvedPlanOf` が null）は何もしない。PR の観測（`observePullRequests`）はプロセス main のタスクを他と同じく拾う。
この 3 か所の `continue` / 早い return が direct を通すことを、`watchWorkspace` の冒頭のコメント（「改訂中の Intake は PR の観測だけ続ける」の段落）に 1 文で書き足す:
`direct の Intake は承認を持たないので、PR の観測と完了の判定だけが働く。`

- [ ] **Step 4: 通ることを確かめる**

Run: `(builtin cd /Users/shunsuke.tadokoro/orca/workspaces/doctrine/app_ux/core && node --test test/intake/direct.test.ts test/intake/watch.test.ts) && mise run core:check`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add core
git commit -m "見張りが direct の Intake をマージで完了にする"
```

---

### Task 6: direct への操作（再投入・改訂と一時停止の拒否）

**Files:**
- Modify: `core/src/intake/dispatch.ts`（`redispatchProcess`）
- Modify: `core/src/intake/commands.ts`（`reviseIntake`、`setDispatchPaused`）
- Test: `core/test/intake/direct.test.ts`

**Interfaces:**
- Consumes: Task 3 の `directStatusOf`、`directTask`、`seedDirect`
- Produces: なし（`redispatchProcess` の形は変えない）

- [ ] **Step 1: 失敗するテストを書く**

`core/test/intake/direct.test.ts` に（import に `redispatchProcess`（`../../src/intake/dispatch.ts` の既存の import に足す）、`reviseIntake` / `setDispatchPaused` / `completeHumanProcess`（`../../src/intake/commands.ts` の既存の import に足す）を足す）:

```ts
const DEPS = { loadWorkflow: fakeWorkflowLoader(DIRECT_WORKFLOW) };

test("direct: 止まったタスクを再投入すると、同じプロセス main に新しいタスクができ、古いタスクは残る", async () => {
  const { db, taskId } = await seedDirect();
  await db.updateTable("tasks").set({ state: "failed" }).where("id", "=", taskId).execute();
  const { taskId: next, replacedTaskId } = await redispatchProcess(
    db,
    { intakeId: "d1", processId: "main" },
    DEPS,
  );
  assert.equal(replacedTaskId, taskId);
  assert.notEqual(next, taskId);
  const task = (await getTask(db, next))!;
  assert.equal(task.title, "直す");
  assert.equal(task.prompt, `# 直す\n\n${PARENT_URL}\n\n本文`);
  assert.equal(task.issue_url, PARENT_URL);
  assert.equal(task.parent_issue_url, null);
  assert.equal(task.intake_process_id, "main");
  assert.equal((await listProcesses(db, "d1"))[0].current_task_id, next);
  assert.equal((await getTask(db, taskId))!.intake_process_id, "main");
});

test("direct: 走っているタスクは再投入できない", async () => {
  const { db } = await seedDirect();
  await assert.rejects(
    () => redispatchProcess(db, { intakeId: "d1", processId: "main" }, DEPS),
    /要確認のプロセスだけを再投入できます: main（running）/,
  );
});

test("direct: 改訂・自動投入の一時停止・人の完了は拒まれ、状態は変わらない", async () => {
  const { db } = await seedDirect();
  await assert.rejects(
    () => reviseIntake(db, { intakeId: "d1", comments: [], logRoot: "/tmp/x" }),
    /direct の Intake は改訂できません/,
  );
  await assert.rejects(
    () => setDispatchPaused(db, { intakeId: "d1", paused: true }),
    /direct の Intake には自動投入がありません/,
  );
  await assert.rejects(
    () => completeHumanProcess(db, { intakeId: "d1", processId: "main", note: "x" }),
    /人のプロセスではありません/,
  );
  const row = (await getIntake(db, "d1"))!;
  assert.equal(row.state, "active");
  assert.equal(row.revising, 0);
  assert.equal(row.dispatch_paused, 0);
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `builtin cd /Users/shunsuke.tadokoro/orca/workspaces/doctrine/app_ux/core && node --test test/intake/direct.test.ts`
Expected: FAIL（再投入が「承認された計画がありません」で落ちる、改訂・一時停止の文言が違う）

- [ ] **Step 3: 実装する**

`core/src/intake/dispatch.ts`（import に `getProject` / `getTask`（`../db/tasks.ts`）、`directStatusOf`（`./view.ts` の既存の import に足す）を足す）。`redispatchProcess` の `if (intake.state !== "active") …` の直後に:

```ts
  if (intake.mode === "direct") return await redispatchDirect(db, intake, o.processId, deps);
```

その前に:

```ts
/**
 * direct の再投入。sub-issue は無く、題と prompt は置き換えるタスクから写す（Issue を読み直さない）。
 * プロジェクトも置き換えるタスクのもの。
 */
async function redispatchDirect(
  db: Db,
  intake: IntakeRow,
  processId: string,
  deps: DispatchDeps,
): Promise<{ taskId: string; replacedTaskId: string | null }> {
  const status = await directStatusOf(db, intake.id);
  if (processId !== DIRECT_PROCESS_ID || status.state !== "needs_attention") {
    const state = processId === DIRECT_PROCESS_ID ? status.state : "案に無い";
    throw new Error(`要確認のプロセスだけを再投入できます: ${processId}（${state}）`);
  }
  const previous = (await getTask(db, status.taskId))!;
  const project = (await getProject(db, previous.project_id))!;
  const pin = pinOf(await deps.loadWorkflow(project.path, project.default_workflow), project);
  const task = directTask({
    intakeId: intake.id,
    issueUrl: intake.issue_url,
    project,
    title: previous.title,
    prompt: previous.prompt,
    pin,
  });
  const committed = await commitDispatch(db, {
    intakeId: intake.id,
    processId: DIRECT_PROCESS_ID,
    expectedTaskId: previous.id,
    task,
  });
  if (!committed) throw new Error("ほかの操作が先にタスクを置き換えました");
  return { taskId: task.id, replacedTaskId: previous.id };
}
```

`core/src/intake/commands.ts` の `reviseIntake` の `const intake = await requireIntake(…)` の直後に:

```ts
  if (intake.mode === "direct") throw new Error("direct の Intake は改訂できません");
```

`setDispatchPaused` の `const intake = await requireIntake(…)` の直後に:

```ts
  if (intake.mode === "direct") throw new Error("direct の Intake には自動投入がありません");
```

`completeHumanProcess` は direct では承認が無く `plan` が null になり、既存の「人のプロセスではありません」で拒む。変えない。

- [ ] **Step 4: 通ることを確かめる**

Run: `(builtin cd /Users/shunsuke.tadokoro/orca/workspaces/doctrine/app_ux/core && node --test test/intake/direct.test.ts test/intake/dispatch.test.ts) && mise run core:check && mise run core:test`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add core
git commit -m "direct の Intake の再投入を足し、改訂と自動投入の一時停止を拒む"
```

---

### Task 7: 開発者ガイドを直す

**Files:**
- Modify: `docs/developer-guide/06-intake.md`（6.1、6.3、6.7 の投入と見張り）
- Modify: `docs/developer-guide/07-app.md`（7.5 の `rail.ts` の行）

- [ ] **Step 1: 06-intake.md を直す**

6.1 の番号付きの流れの前に段落を足す:

```markdown
取り込みには 2 種類ある（`intakes.mode`）。**plan** は下の流れで PFD に分解する。**direct** は分解しない。
`intake.start`（`mode: "direct"`）が Intake（`active`）、プロセス `main`（`shared/intake/processStatus.ts:DIRECT_PROCESS_ID`）の行、
タスク 1 本を 1 トランザクションで作る（`dispatch.ts:insertDirectIntake`）。調査・分解・承認・sub-issue・投入は無く、
タスクの `issue_url` は親 Issue そのもの、ワークフローはプロジェクトの既定である。
```

6.3 の表の `active` の行の意味を「承認済み（plan）か、direct で開始した。PR の観測と完了の判定が動き、plan では sub-issue と投入も動く」にする。
mermaid の図に `[*] --> active: intake.start（direct）` の行を `[*] --> investigating` の次に足す。図の後の箇条書きに足す:

```markdown
- 作ったときの状態は `domain/intakeStates.ts:initialIntakeState` が mode から決める
- direct の Intake には `intake.revise` と `intake.setDispatchPaused` を拒む。プロセス `main` の状態は
  `pfd/status.ts:directProcessStatus` がタスクと PR だけから求める（`running` / `pr_open` / `merged` / `needs_attention`）
```

6.7 の「投入」の箇条書きに足す:

```markdown
- direct の `intake.redispatch` は sub-issue を見ず、置き換えるタスクの題・prompt・プロジェクトを写した新しいタスクを作る（`dispatch.ts:redispatchDirect`）
```

6.7 の「見張り」の 7 の後に足す:

```markdown
direct の Intake は承認を持たないので、2・6 の sub-issue の処理と投入は何もしない。3 の観測は同じく行い、
プロセス `main` が `merged` になれば `completed` にする（`watch.ts:reachedGoal`）。
```

`IntakeDetail.processes` を説明している箇所（6.6 の「プロセスの状態」）の末尾に:

```markdown
`intake.get` の各プロセスは、いまのタスクのステップの帯 `rail` も持つ（`shared/rail.ts:buildRail`。タスクが pin したワークフローで組み、読めなければ null）。
```

- [ ] **Step 2: 07-app.md を直す**

7.5 の表の `rail.ts` の行（いまは「ワークフローの帯（タスク画面の実行状態付きと、設定画面の定義図）」）を
`| `rail.ts` | 設定画面のワークフローの定義図。タスク画面の帯の組み立て（`buildRail`）は `shared/rail.ts` にあり、デーモンの `intake.get` も使う |` にする。

- [ ] **Step 3: コミット**

```bash
git add docs/developer-guide
git commit -m "開発者ガイドに direct の Intake と帯の置き場所を書く"
```
