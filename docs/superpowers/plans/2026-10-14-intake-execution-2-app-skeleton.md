# Intake と Execution 段階 2: 画面の骨格 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rail を Intake / Execution / 設定の 3 つにし、承認後の Intake を Execution の一覧と図で扱えるようにする。Composer・タスクの一覧・worktree と警告の画面・setup のタスクを消す。

**Architecture:** 一覧の並びと「人の番」の判定は純関数（`app/src/execution.ts`、`app/src/intake.ts`）に置き、`model.ts` の reducer が view と選択（`execSel` / `execClosed`）を持つ。Execution の本体（`components/ExecutionView.tsx`）は今の Intake の進行中の面（`IntakeProgress`）の中身を移したもので、図の下の `exec-panel-slot` に選んだ要素の欄と開いたタスクの画面を出す。段階 3 はこのスロットを下のパネルに置き換える。

**Tech Stack:** React 19 / TypeScript 6 / vitest 5（app）、Node 26 + pnpm workspace / kysely / `node:test`（core）

**Spec:** `docs/superpowers/specs/2026-10-14-intake-execution-design.md`（3 章・4 章・6.1・6.4・8.1・8.2・10・11 章のうち画面の部分）

## Global Constraints

- 段階 1（デーモンの direct）がマージ済みであること。使うもの: `shared/protocol.ts` の `IntakeMode = "plan" | "direct"`、`IntakeSummary.mode`、`intake.start` の params の `mode: IntakeMode`（必須）、`shared/intake/` の `DIRECT_PROCESS_ID = "main"`、`IntakeProcessView.rail`。段階 1 の時点で `builtin cd /Users/shunsuke.tadokoro/orca/workspaces/doctrine/app_ux/app && pnpm exec tsc` が通っている（`fixtures.ts` の `intake()` と `INTAKE_*` に `mode` / `rail` が入っている）ことを着手前に確かめる
- `view` は `"intake" | "execution" | "settings"` の 3 つだけ。`"tasks"` / `"done"` / `"worktrees"` は参照ごと消す。互換の仕掛けは作らない
- 取り込みの種類の文言: plan は「計画して進める」・補足「複数の PR に分ける」、direct は「すぐ実行する」・補足「1 本の PR で済ませる」。既定の選択は置かない
- 人の番 = タスクの承認待ち（`suspended`）・プロセスの要確認（`needs_attention`）・人のプロセスの番（`your_turn`）。PR のマージ待ち（`pr_open`）は入れない
- `task.create` の RPC と `shared/protocol.ts` のその定義には触らない（別の作業で消す。dctl はすでに無く、アプリからの呼び出しもこの段階で無くなる）
- コードのコメントは、そのコード固有の事実だけを書く。一般論は書かない。既存のコメントの密度に合わせる
- コマンド: app のテスト `builtin cd /Users/shunsuke.tadokoro/orca/workspaces/doctrine/app_ux/app && pnpm test`、型 `builtin cd /Users/shunsuke.tadokoro/orca/workspaces/doctrine/app_ux/app && pnpm exec tsc`、core のテスト `mise run core:test`（1 ファイルは `builtin cd /Users/shunsuke.tadokoro/orca/workspaces/doctrine/app_ux/core && node --test <file>`）、core の型 `mise run core:check`、書式と lint は `pnpm check:style`（リポジトリの根。整形は `pnpm exec biome format --write <file...>`。対象は core と shared で、app は対象外）。core の変更は Node の型ストリップで動くので、`enum`・`namespace`・パラメータプロパティは使えず、型だけの import は `import type`

## Review Focus

1. **Execution で選んでいる Intake が完了・中止して「進行中」から外れたとき**、選択と取ってある詳細は消えず、図はそのまま見える → Task 6 の `intakes.sync` のテスト
2. **「改訂を始める…」を押した直後の Intake**（`state: "active"`・`revising: false` のまま改訂に入るモード）は Intake の一覧に出て、「やめる」で Execution に戻る → Task 1 の `intakeOrder` と Task 6 の `intake.revise.enter` / `leave` のテスト
3. **direct で開始した直後**は Execution に移ってその Issue を選び、Intake の一覧には出ない → Task 1 の `inIntakeList` と Task 6 の `intake.started` のテスト
4. **Intake に属さないタスク（`intake: null`）を `task.open` したとき**、落ちずにトーストで知らせ、選択を動かさない → Task 6 の `task.open` のテスト
5. **承認・差し戻しの後の「次のレビュー待ち」**は同じ Intake の中からだけ選び、別の Intake や Intake の無いタスクに飛ばない → Task 6 の `approve` / `reject.confirm` のテスト

---

## ファイルの構成

| ファイル | 役割 | Task |
| --- | --- | --- |
| `app/src/execution.ts`（新規） | Execution の一覧に並ぶか・区切り・人の番・並び | 1 |
| `app/src/intake.ts` | Intake の一覧の絞り込み（承認前と改訂）、Rail の点、`MODE_WORD`、`progressOps` の direct | 1 |
| `app/src/tone.ts` | `IntakeSection` の縮小、`executionTone` | 1 |
| `app/src/composer.ts` ほか | 削除 | 2 |
| `app/src/components/RemoveWorktree.tsx`（新規） | worktree の削除の確認とボタン（`WorktreeView.tsx` から移す。task_id で消す） | 3 |
| `app/src/components/WorktreeView.tsx`、`app/src/worktrees.ts` | 削除 | 3 |
| `core/src/workflow/setupWorkflow.ts` ほか | setup のタスクの削除 | 4 |
| `app/src/wizard.ts`、`components/SetupWizard.tsx` | ウィザードを workspace の登録だけにする | 4 |
| `app/src/components/ExecutionSidebar.tsx`（新規） | Execution の一覧と行 | 5, 6 |
| `app/src/components/ExecutionView.tsx`（新規） | Execution の本体（見出し・操作・図・スロット・direct の欄） | 5, 6 |
| `app/src/components/ReviseFace.tsx`（新規） | Intake 側の改訂に入る面（`IntakeProgress` の改訂のモードを移す） | 6 |
| `app/src/components/IntakeProgress.tsx` | 面の本体を消し、部品と `useApprovedPfd` だけを持つ | 6 |
| `app/src/model.ts`、`app/src/store.tsx`、`app/src/App.tsx`、`components/Sidebar.tsx`、`components/IntakeView.tsx` | view・選択・取り直し・振り分け | 6 |
| `components/IssuePicker.tsx` | plan / direct の選択 | 7 |
| ドキュメント | 07-app.md、overview.md、PRD 7.1、Quick Start（site と spec） | 8 |

---

### Task 1: 一覧と人の番の純関数

**Files:**
- Create: `app/src/execution.ts`
- Create: `app/src/execution.test.ts`
- Modify: `app/src/intake.ts`（`IntakeSection` / `INTAKE_SECTIONS` / `countIntakeAttention` / `intakeSection` / `intakeOrder` / `progressOps` / `summaryOf`、`MODE_WORD` と `inIntakeList` を足す）
- Modify: `app/src/tone.ts:77-84`
- Test: `app/src/intake.test.ts`、`app/src/tone.test.ts`、`app/src/IntakeProgress.test.tsx`

**Interfaces:**
- Consumes: `IntakeSummary.mode: IntakeMode`（段階 1）
- Produces:
  - `execution.ts`: `type ExecutionSection = "active" | "closed"`、`inExecution(i: IntakeSummary): boolean`、`executionSection(i: IntakeSummary): ExecutionSection`、`isExecutionAttention(i: IntakeSummary, tasks: readonly Task[]): boolean`、`countExecutionAttention(intakes: readonly IntakeSummary[], tasks: readonly Task[]): number`、`executionOrder(intakes: IntakeSummary[], tasks: readonly Task[], workspace: WorkspaceFilter, closed: boolean): IntakeSummary[]`
  - `intake.ts`: `type IntakeSection = "attention" | "working"`、`inIntakeList(i: IntakeSummary, reviseId: string | null): boolean`、`intakeOrder(intakes: IntakeSummary[], workspace: WorkspaceFilter, reviseId: string | null): IntakeSummary[]`、`countIntakeAttention(intakes: IntakeSummary[]): number`、`MODE_WORD: Record<IntakeMode, { name: string; hint: string; mark: string }>`、`progressOps(detail: Pick<IntakeSummary, "state" | "revising" | "mode">): ProgressOps`
  - `tone.ts`: `executionTone(i: IntakeSummary, attention: boolean): Tone`

- [ ] **Step 1: execution.ts の失敗するテストを書く**

`app/src/execution.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import type { IntakeSummary } from "../../shared/protocol.ts";
import {
  countExecutionAttention,
  executionOrder,
  executionSection,
  inExecution,
  isExecutionAttention,
} from "./execution";
import { INTAKES, seedTasks } from "./fixtures";
import type { Task, TaskState } from "./types";

const row = (id: string): IntakeSummary => INTAKES.find((i) => i.id === id)!;
const ids = (rows: IntakeSummary[]) => rows.map((i) => i.id);
const task = (id: string, state: TaskState, intakeId: string | null): Task => ({
  ...seedTasks()[0],
  id,
  state,
  intake: intakeId === null ? null : { id: intakeId, processId: "p1", issueUrl: null, parentIssueUrl: null },
});

describe("inExecution / executionSection", () => {
  test("承認後・改訂中・終端だけが並ぶ。承認前は並ばない", () => {
    expect(INTAKES.filter(inExecution).map((i) => i.id).sort()).toEqual(["i2", "i5", "i6", "i7"]);
  });

  test("改訂中は承認前の状態でも進行中に並ぶ", () => {
    const revising = { ...row("i4"), revising: true };
    expect(inExecution(revising)).toBe(true);
    expect(executionSection(revising)).toBe("active");
  });

  test("完了と中止は終了", () => {
    expect(executionSection(row("i6"))).toBe("closed");
    expect(executionSection(row("i7"))).toBe("closed");
    expect(executionSection(row("i2"))).toBe("active");
  });
});

describe("isExecutionAttention", () => {
  test("active で needs_human なら人の番", () => {
    expect(isExecutionAttention(row("i2"), [])).toBe(true);
  });

  test("承認前の needs_human（レビュー待ち）は Execution の人の番に入れない", () => {
    expect(isExecutionAttention(row("i1"), [])).toBe(false);
  });

  test("その Intake のタスクが承認待ちなら、needs_human が偽でも人の番", () => {
    const quiet = { ...row("i2"), needs_human: false };
    expect(isExecutionAttention(quiet, [])).toBe(false);
    expect(isExecutionAttention(quiet, [task("t1", "suspended", "i2")])).toBe(true);
  });

  test("別の Intake や Intake の無いタスクの承認待ちは数えない", () => {
    const quiet = { ...row("i2"), needs_human: false };
    expect(isExecutionAttention(quiet, [task("t1", "suspended", "i5"), task("t2", "suspended", null)])).toBe(false);
  });

  test("改訂中でも走っているタスクの承認待ちは人の番", () => {
    expect(isExecutionAttention(row("i5"), [task("t1", "suspended", "i5")])).toBe(true);
  });

  test("終了した Intake は人の番にしない", () => {
    expect(isExecutionAttention({ ...row("i7"), needs_human: true }, [task("t1", "suspended", "i7")])).toBe(false);
  });

  test("countExecutionAttention は人の番のある Intake の数", () => {
    expect(countExecutionAttention(INTAKES, [])).toBe(1);
    expect(countExecutionAttention(INTAKES, [task("t1", "suspended", "i5")])).toBe(2);
  });
});

describe("executionOrder", () => {
  test("進行中は人の番を上に、その中は更新の新しい順", () => {
    expect(ids(executionOrder(INTAKES, [], "all", false))).toEqual(["i2", "i5"]);
    const quiet = INTAKES.map((i) => (i.id === "i2" ? { ...i, needs_human: false } : i));
    expect(ids(executionOrder(quiet, [task("t1", "suspended", "i5")], "all", false))).toEqual(["i5", "i2"]);
  });

  test("終了は完了と中止を更新の新しい順に並べる", () => {
    expect(ids(executionOrder(INTAKES, [], "all", true))).toEqual(["i6", "i7"]);
  });

  test("workspace で絞り込む", () => {
    expect(ids(executionOrder(INTAKES, [], 2, false))).toEqual(["i2"]);
    expect(ids(executionOrder(INTAKES, [], 99, true))).toEqual([]);
  });

  test("渡した配列を並べ替えない", () => {
    const before = ids(INTAKES);
    executionOrder(INTAKES, [], "all", false);
    expect(ids(INTAKES)).toEqual(before);
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `builtin cd /Users/shunsuke.tadokoro/orca/workspaces/doctrine/app_ux/app && pnpm test execution.test.ts`
Expected: FAIL（`./execution` が無い）

- [ ] **Step 3: execution.ts を書く**

`app/src/execution.ts`:

```ts
// Execution のビューの導出。副作用を持たない（テストは execution.test.ts）
import type { IntakeSummary } from "../../shared/protocol.ts";
import { isClosedIntake, visibleIntakes } from "./intake";
import type { Task, WorkspaceFilter } from "./types";

export type ExecutionSection = "active" | "closed";

/** Execution の一覧に並ぶか。承認後と改訂中と終端。承認前に中止したものも終端に入る */
export function inExecution(i: IntakeSummary): boolean {
  return i.state === "active" || i.revising || isClosedIntake(i.state);
}

export function executionSection(i: IntakeSummary): ExecutionSection {
  return isClosedIntake(i.state) ? "closed" : "active";
}

/**
 * 人の番があるか。needs_human は承認前の判断も含むので active のときだけ見る。
 * タスクの承認待ちは needs_human に入らないので、タスクの一覧から足す
 */
export function isExecutionAttention(i: IntakeSummary, tasks: readonly Task[]): boolean {
  if (!inExecution(i) || executionSection(i) === "closed") return false;
  return (i.state === "active" && i.needs_human) ||
    tasks.some((t) => t.intake?.id === i.id && t.state === "suspended");
}

/** Rail の点。絞り込みに関係なく全 workspace を数える */
export function countExecutionAttention(intakes: readonly IntakeSummary[], tasks: readonly Task[]): number {
  return intakes.filter((i) => isExecutionAttention(i, tasks)).length;
}

/** サイドバーの描画も j/k もこの順を使う */
export function executionOrder(
  intakes: IntakeSummary[],
  tasks: readonly Task[],
  workspace: WorkspaceFilter,
  closed: boolean,
): IntakeSummary[] {
  const rows = visibleIntakes(intakes, workspace)
    .filter((i) => inExecution(i) && (executionSection(i) === "closed") === closed);
  const recent = (a: IntakeSummary, b: IntakeSummary) => Date.parse(b.updated_at) - Date.parse(a.updated_at);
  if (closed) return rows.sort(recent);
  const rank = (i: IntakeSummary) => (isExecutionAttention(i, tasks) ? 0 : 1);
  return rows.sort((a, b) => rank(a) - rank(b) || recent(a, b));
}
```

- [ ] **Step 4: 通ることを確かめる**

Run: `builtin cd /Users/shunsuke.tadokoro/orca/workspaces/doctrine/app_ux/app && pnpm test execution.test.ts`
Expected: PASS

- [ ] **Step 5: intake.ts と tone.ts のテストを書き換える**

`app/src/intake.test.ts` の `describe("countIntakeAttention", ...)`（212 行あたり）を次に置き換える:

```ts
describe("countIntakeAttention", () => {
  test("回答待ち・レビュー待ち・要確認の数。承認後の your_turn は数えない", () => {
    expect(countIntakeAttention(INTAKES)).toBe(1);
    expect(countIntakeAttention([])).toBe(0);
    const answering = { ...INTAKES[0], id: "x", state: "answering" as const };
    const failed = { ...INTAKES[0], id: "y", state: "needs_attention" as const };
    expect(countIntakeAttention([answering, failed])).toBe(2);
  });

  test("区分は人の判断を待つ状態なら attention、それ以外は working", () => {
    expect(intakeSection({ ...INTAKES[0], state: "reviewing" })).toBe("attention");
    expect(intakeSection({ ...INTAKES[0], state: "decomposing" })).toBe("working");
    expect(intakeSection({ ...INTAKES[0], state: "active", needs_human: true })).toBe("working");
  });
});
```

`describe("intakeOrder", ...)`（354 行あたり）を次に置き換える:

```ts
describe("intakeOrder", () => {
  const ids = (rows: typeof INTAKES) => rows.map((i) => i.id);

  test("承認前と改訂中だけを並べ、対応が要るものを上に、残りは更新の新しい順", () => {
    expect(ids(intakeOrder(INTAKES, "all", null))).toEqual(["i1", "i3", "i4", "i5"]);
  });

  test("改訂に入るモードの active の Intake は、改訂中になる前から並ぶ", () => {
    expect(ids(intakeOrder(INTAKES, "all", "i2"))).toEqual(["i1", "i3", "i2", "i4", "i5"]);
  });

  test("workspace で絞り込む", () => {
    expect(ids(intakeOrder(INTAKES, 2, null))).toEqual(["i4"]);
    expect(intakeOrder(INTAKES, 99, null)).toEqual([]);
  });

  test("inIntakeList は direct で開始した active を含めない", () => {
    expect(inIntakeList({ ...INTAKES[0], state: "active", mode: "direct" }, null)).toBe(false);
  });
});
```

（import に `inIntakeList` を足し、使わなくなった `sections` ヘルパー（209 行）を消す）

`describe("progressOps", ...)`（303 行あたり）に次のテストを足す:

```ts
  test("direct の進行中は確認だけ。一時停止と改訂は出さない", () => {
    expect(progressOps({ state: "active", revising: false, mode: "direct" }))
      .toEqual({ refresh: true, pause: false, revise: false, closeIssue: false });
  });

  test("direct の完了は Issue を閉じる", () => {
    expect(progressOps({ state: "completed", revising: false, mode: "direct" }).closeIssue).toBe(true);
  });
```

`app/src/tone.test.ts` の 65〜67 行（`"active"` / `"closed"` の `sectionTone`）を消し、次を足す:

```ts
  test("executionTone は完了 ok・中止 idle・人の番 human・それ以外 run", () => {
    expect(executionTone(i({ state: "completed" }), false)).toBe("ok");
    expect(executionTone(i({ state: "canceled" }), false)).toBe("idle");
    expect(executionTone(i({ state: "active" }), true)).toBe("human");
    expect(executionTone(i({ state: "active" }), false)).toBe("run");
  });
```

（import に `executionTone` を足す）

`app/src/IntakeProgress.test.tsx` の `describe("ProgressActions", ...)` の「進行中は確認・一時停止・改訂」の期待値 `"改訂に入る…"` を `"改訂を始める…"` に、「完了は Issue を閉じるだけ」の `"改訂に入る"` を `"改訂を始める"` に直す。

- [ ] **Step 6: 失敗を確かめる**

Run: `builtin cd /Users/shunsuke.tadokoro/orca/workspaces/doctrine/app_ux/app && pnpm test intake.test.ts tone.test.ts IntakeProgress.test.tsx`
Expected: FAIL（`inIntakeList` / `executionTone` が無い、`intakeOrder` の並びが違う、文言が違う）

- [ ] **Step 7: intake.ts と tone.ts と IntakeProgress.tsx の文言を直す**

`app/src/intake.ts` の `IntakeSection` から `countIntakeAttention` / `intakeSection` / `intakeOrder` までを次に置き換える:

```ts
export type IntakeSection = "attention" | "working";

export const INTAKE_SECTIONS: { key: IntakeSection; name: string }[] = [
  { key: "attention", name: "対応が要る" },
  { key: "working", name: "調査・分解・改訂" },
];
```

```ts
/** 人の判断を待っている状態。Intake の Rail の点と「対応が要る」の区分はこれで決まる */
const AWAITING_HUMAN: ReadonlySet<IntakeState> = new Set(["answering", "reviewing", "needs_attention"]);

export function countIntakeAttention(intakes: IntakeSummary[]): number {
  return intakes.filter((i) => AWAITING_HUMAN.has(i.state)).length;
}

export function intakeSection(i: IntakeSummary): IntakeSection {
  return AWAITING_HUMAN.has(i.state) ? "attention" : "working";
}

/** Intake の一覧に並ぶか。承認前（改訂中もここを通る）と、改訂に入るモードの active の Intake */
export function inIntakeList(i: IntakeSummary, reviseId: string | null): boolean {
  return i.id === reviseId || i.revising || (i.state !== "active" && !isClosedIntake(i.state));
}
```

```ts
/** サイドバーの描画も j/k もこの順を使う */
export function intakeOrder(
  intakes: IntakeSummary[],
  workspace: WorkspaceFilter,
  reviseId: string | null,
): IntakeSummary[] {
  const rows = visibleIntakes(intakes, workspace).filter((i) => inIntakeList(i, reviseId));
  return INTAKE_SECTIONS.flatMap((s) => {
    const inSection = rows.filter((i) => intakeSection(i) === s.key);
    const sign = s.key === "attention" ? 1 : -1;
    return inSection.sort((a, b) => sign * (Date.parse(a.updated_at) - Date.parse(b.updated_at)));
  });
}
```

`INTAKE_WORD` の下に足す（import に `IntakeMode` を `../../shared/protocol.ts` から足す）:

```ts
/** 取り込みの種類の語。mark は一覧と見出しの印 */
export const MODE_WORD: Record<IntakeMode, { name: string; hint: string; mark: string }> = {
  plan: { name: "計画して進める", hint: "複数の PR に分ける", mark: "Plan" },
  direct: { name: "すぐ実行する", hint: "1 本の PR で済ませる", mark: "Direct" },
};
```

`progressOps` を次に置き換える:

```ts
export function progressOps(detail: Pick<IntakeSummary, "state" | "revising" | "mode">): ProgressOps {
  const none = { refresh: false, pause: false, revise: false, closeIssue: false };
  if (detail.state === "completed") return { ...none, closeIssue: true };
  if (detail.state !== "active" || detail.revising) return none;
  // direct は投入も、改訂する計画も持たない
  return detail.mode === "direct" ? { ...none, refresh: true } : { ...none, refresh: true, pause: true, revise: true };
}
```

`summaryOf` に `mode: d.mode,` が無ければ `issue_title` の次に足す。

`app/src/tone.ts:77-84` を次に置き換える:

```ts
export function sectionTone(s: IntakeSection, i: IntakeSummary): Tone {
  switch (s) {
    case "attention": return i.state === "needs_attention" ? "danger" : "human";
    case "working": return "run";
  }
}

/** Execution の一覧の行の色 */
export function executionTone(i: IntakeSummary, attention: boolean): Tone {
  if (i.state === "completed") return "ok";
  if (i.state === "canceled") return "idle";
  return attention ? "human" : "run";
}
```

`app/src/components/IntakeProgress.tsx` の `ProgressActions` のボタン `改訂に入る…` を `改訂を始める…` にする。

この時点で `model.ts` と `Sidebar.tsx` の `intakeOrder(..., s.showClosedIntakes)` は型が合わなくなる。Task 6 で書き換えるまでの間、`model.ts:886` と `Sidebar.tsx:179` の第 3 引数を `s.intakeRevise` にする（`Sidebar.tsx:154` の `sectionTone(intakeSection(i), i)` はそのまま型が通る）。`model.test.ts:1788` の `intakeOrder(INTAKES, "all", false)` も `intakeOrder(INTAKES, "all", null)` にする。

- [ ] **Step 8: 通ることを確かめる**

Run: `builtin cd /Users/shunsuke.tadokoro/orca/workspaces/doctrine/app_ux/app && pnpm test && pnpm exec tsc`
Expected: PASS。`model.test.ts` の「Intake のビュー」の j/k のテストが並びの変化で落ちたら、期待値を Step 5 の `intakeOrder` の並び（`["i1", "i3", "i4", "i5"]`）に合わせて直す

- [ ] **Step 9: コミット**

```bash
git add app/src/execution.ts app/src/execution.test.ts app/src/intake.ts app/src/intake.test.ts app/src/tone.ts app/src/tone.test.ts app/src/components/IntakeProgress.tsx app/src/IntakeProgress.test.tsx app/src/model.ts app/src/model.test.ts app/src/components/Sidebar.tsx
git commit -m "Execution の一覧と人の番、Intake の一覧の絞り込みを純関数にする

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Composer とやり直しのボタンを消す

**Files:**
- Delete: `app/src/composer.ts`、`app/src/composer.test.ts`、`app/src/components/Composer.tsx`、`app/src/Composer.test.tsx`
- Modify: `app/src/model.ts`（`ComposerInit` / `Composer` / `composer` の状態と `composer.*` の action）、`app/src/store.tsx`（`composer: null`、`ComposerRpc` / `useComposerRpc`）、`app/src/App.tsx`、`app/src/components/Sidebar.tsx`（タスクの一覧の「＋」）、`app/src/components/TaskView.tsx`
- Test: `app/src/model.test.ts`、`app/src/TaskView.test.tsx`

**Interfaces:**
- Consumes: なし
- Produces: `State` から `composer` が消える。`TaskView.tsx` から `RetryButton` が消える

- [ ] **Step 1: テストを書き換える**

`app/src/model.test.ts`:
- `describe("コンポーザ", ...)`（120〜175 行）を丸ごと消す
- `base()` の `composer: null,`（111 行）を消す
- `describe("初回ウィザード", ...)` の `expect(s.composer).toBeNull();`（215 行）を消す

`app/src/TaskView.test.tsx`:
- `describe("RetryButton", ...)`（70 行〜）を丸ごと消す
- import から `RetryButton` と `import { retryInit } from "./composer";` を消す

- [ ] **Step 2: 失敗を確かめる**

Run: `builtin cd /Users/shunsuke.tadokoro/orca/workspaces/doctrine/app_ux/app && pnpm exec tsc`
Expected: FAIL はまだ出ない（テストを消しただけ）。`pnpm test` は PASS のまま。ここでは削除の前の基準を取る

- [ ] **Step 3: 消す**

```bash
git rm app/src/composer.ts app/src/composer.test.ts app/src/components/Composer.tsx app/src/Composer.test.tsx
```

`app/src/model.ts`:
- `export type ComposerInit = ...`（435 行）と `export type Composer = ...`（438 行）を消す
- `State` の `composer: Composer | null;` とその説明を消す
- `Action` の `composer.open` / `composer.close` / `composer.created` を消す
- `reduce` の `case "composer.open"` / `"composer.close"` / `"composer.created"` を消す
- `reduce` の中の `composer: null` を全部消す（`view` / `select` / `wizard.done` の分岐）。`case "move"` の先頭の `if (s.composer !== null) return s;` を消す

`app/src/store.tsx`:
- `initialState` の `composer: null,` を消す
- `ComposerRpc` と `useComposerRpc` を消す。使わなくなった import（`ParamsOf` / `ResultOf` / `WorkflowListEntry` のうち他で使っていないもの）を `pnpm exec tsc` の指摘どおり消す

`app/src/App.tsx`:
- `import { Composer } from "./components/Composer";` を消す
- `main` の `) : s.composer ? (<Composer key={s.composer.opened} init={s.composer.init} />` の分岐を消す
- スクロールの effect の依存 `s.composer?.opened` を消す

`app/src/components/Sidebar.tsx`: タスクの一覧の `side-head` にある「新しいタスク」の `<button className="plus" ...>＋</button>` を消す。

`app/src/components/TaskView.tsx`:
- `import { canRetry, retryInit } from "../composer";` と `ComposerInit` の import を消す
- `RetryButton` を消す
- `const openComposer = ...` を消す
- failed の欄（245〜272 行あたり）を次にする:

```tsx
              {t.worktree
                ? (
                  <p className="hint">worktree は証拠として残しています。中を確認してから削除してください。</p>
                )
                : (
                  <p className="hint">worktree は残っていないので、中を見ることはできません。記録だけが残っています。</p>
                )}
              {t.intake && <IntakeRetryHint intakeId={t.intake.id} onOpenIntake={openIntake} />}
              <SetupRetryHint t={t} />
              {t.worktree && (
                <div className="actions">
                  <RemoveWorktreeButton path={removePath!} dirty={removeDirty} />
                </div>
              )}
```

（今の `p` 要素の構造を変えずに、`canRetry(t) ? ... : ...` の三項を後ろの文に寄せる。囲みの要素とクラス名は今のものを残す）
- canceled の欄（292〜299 行あたり）の `{canRetry(t) && (<div className="actions"><RetryButton .../></div>)}` を消す

- [ ] **Step 4: 通ることを確かめる**

Run: `builtin cd /Users/shunsuke.tadokoro/orca/workspaces/doctrine/app_ux/app && pnpm exec tsc && pnpm test`
Expected: PASS。`rg -n "composer|Composer|RetryButton|canRetry|retryInit" app/src` が何も出さない（`firstProjectIn` は設定画面が使うので残る）

- [ ] **Step 5: コミット**

```bash
git add -A app/src
git commit -m "Composer とやり直しのボタンを消す

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: worktree と警告の画面を消し、worktree の削除をタスクの画面に残す

**Files:**
- Create: `app/src/components/RemoveWorktree.tsx`
- Create: `app/src/RemoveWorktree.test.tsx`
- Delete: `app/src/components/WorktreeView.tsx`、`app/src/WorktreeView.test.tsx`、`app/src/worktrees.ts`、`app/src/worktrees.test.ts`
- Modify: `app/src/model.ts`（`View` から `"worktrees"`、`worktrees` / `warnings` / `removing` / `staleDaysOf`、`worktrees.sync` / `remove.ask`、`daemon.warning`）、`app/src/store.tsx`（`worktree.list` / `daemon.warnings` の取り直し、`removeWorktree`）、`app/src/App.tsx`、`app/src/components/Sidebar.tsx`、`app/src/components/TaskView.tsx`
- Test: `app/src/model.test.ts`

**Interfaces:**
- Consumes: `"worktree.remove"` の params `{ task_id: string; force?: boolean }`（既存）
- Produces:
  - `State.removing: { taskId: string; path: string; dirty: boolean | null } | null`
  - `Action` `{ type: "remove.ask"; taskId: string; path: string; dirty: boolean | null }`
  - `useDecide().removeWorktree(taskId: string)`
  - `RemoveWorktree.tsx`: `removeConfirmText(dirty: boolean | null): string`、`RemoveConfirm`、`RemoveWorktreeModal`、`RemoveWorktreeButton(p: { taskId: string; path: string; dirty: boolean | null })`

- [ ] **Step 1: 失敗するテストを書く**

`app/src/RemoveWorktree.test.tsx`（`WorktreeView.test.tsx` の `RemoveConfirm` のテストと `worktrees.test.ts` の `removeConfirmText` のテストをここへ移す）:

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { RemoveConfirm, removeConfirmText } from "./components/RemoveWorktree";

const noop = () => {};

describe("removeConfirmText", () => {
  test("dirty が true・null なら失われることを書き、false なら変更が無いと書く", () => {
    expect(removeConfirmText(true)).toBe("未コミットの変更があります。削除すると失われます。");
    expect(removeConfirmText(null)).toBe("未コミットの変更があれば、削除すると失われます。");
    expect(removeConfirmText(false)).toBe("未コミットの変更はありません。");
  });
});

describe("RemoveConfirm", () => {
  test("パスと確認の文言と削除のボタンを出す", () => {
    const html = renderToStaticMarkup(
      <RemoveConfirm path="/w/t-1" dirty={true} pending={false} onConfirm={noop} onCancel={noop} />,
    );
    expect(html).toContain("/w/t-1");
    expect(html).toContain("未コミットの変更があります。削除すると失われます。");
    expect(html).toContain("削除する");
  });
});
```

`app/src/model.test.ts`:
- `describe("worktree と警告", ...)`（1032〜1069 行）を次に置き換える:

```ts
describe("worktree の削除", () => {
  test("remove.ask と remove.close で確認の対象を出し入れする", () => {
    let s = reduce(base(), { type: "remove.ask", taskId: "t-e812", path: "/w/t-e812", dirty: null });
    expect(s.removing).toEqual({ taskId: "t-e812", path: "/w/t-e812", dirty: null });
    s = reduce(s, { type: "remove.close" });
    expect(s.removing).toBeNull();
  });
});
```

- `test("daemon.warning はトーストで知らせ、警告の一覧の先頭に足す", ...)`（1011 行）を消す（1002 行の「トーストで知らせる」は残す）
- `base()` の `worktrees: [],` と `warnings: [],` を消す

- [ ] **Step 2: 失敗を確かめる**

Run: `builtin cd /Users/shunsuke.tadokoro/orca/workspaces/doctrine/app_ux/app && pnpm test RemoveWorktree.test.tsx model.test.ts`
Expected: FAIL（`./components/RemoveWorktree` が無い、`remove.ask` の形が違う）

- [ ] **Step 3: RemoveWorktree.tsx を作り、画面と状態を消す**

`app/src/components/RemoveWorktree.tsx`:

```tsx
import { useState, type ReactNode } from "react";
import { sendDecision } from "../decision";
import { useDecide, useRefresh, useStore } from "../store";

/** 削除確認の文言。true・null は「失われ」を含める（未コミットの変更があるか分からない） */
export function removeConfirmText(dirty: boolean | null): string {
  if (dirty === true) return "未コミットの変更があります。削除すると失われます。";
  if (dirty === null) return "未コミットの変更があれば、削除すると失われます。";
  return "未コミットの変更はありません。";
}

export function RemoveConfirm(p: {
  path: string;
  dirty: boolean | null;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): ReactNode {
  return (
    <>
      <div className="scrim" onClick={p.onCancel} />
      <div className="modal" role="dialog" aria-modal="true">
        <h2>worktree を削除しますか</h2>
        <p className="mono hint">{p.path}</p>
        <p>{removeConfirmText(p.dirty)}</p>
        <div className="actions">
          <button className="btn danger" disabled={p.pending} onClick={p.onConfirm}>削除する</button>
          <button className="btn" onClick={p.onCancel}>戻る</button>
        </div>
      </div>
    </>
  );
}

export function RemoveWorktreeModal(): ReactNode {
  const { s, dispatch } = useStore();
  const decide = useDecide();
  const refresh = useRefresh();
  const [pending, setPending] = useState(false);
  if (!s.removing) return null;
  const { taskId, path, dirty } = s.removing;
  return (
    <RemoveConfirm
      path={path}
      dirty={dirty}
      pending={pending}
      onCancel={() => dispatch({ type: "remove.close" })}
      onConfirm={async () => {
        setPending(true);
        try {
          const r = await sendDecision(decide.removeWorktree(taskId), "worktree を削除できませんでした");
          dispatch({ type: "remove.close" });
          if (r.ok) {
            dispatch({ type: "toast", message: "worktree を削除しました" });
            void refresh();
          } else {
            dispatch({ type: "toast", message: r.message });
          }
        } finally {
          setPending(false);
        }
      }}
    />
  );
}

export function RemoveWorktreeButton(p: { taskId: string; path: string; dirty: boolean | null }): ReactNode {
  const { dispatch } = useStore();
  return (
    <button
      className="btn sm danger"
      onClick={() => dispatch({ type: "remove.ask", taskId: p.taskId, path: p.path, dirty: p.dirty })}
    >
      worktree を削除
    </button>
  );
}
```

```bash
git rm app/src/components/WorktreeView.tsx app/src/WorktreeView.test.tsx app/src/worktrees.ts app/src/worktrees.test.ts
```

`app/src/model.ts`:
- `View` を `"tasks" | "done" | "intake" | "settings"` にする（Task 6 で最終の形にする）
- `import { addWarning, sortWarnings } from "./worktrees";` と、`Warning` / `WorktreeEntry` の import を消す
- `State` の `worktrees` / `warnings` を消し、`removing` を `{ taskId: string; path: string; dirty: boolean | null } | null` にする
- `staleDaysOf` を消す
- `Action` の `worktrees.sync` を消し、`remove.ask` を `{ type: "remove.ask"; taskId: string; path: string; dirty: boolean | null }` にする
- `reduce`: `case "view"` の `a.view === "worktrees"` の条件を消す（`if (a.view === "intake")` にする）。`case "move"` の `s.view === "worktrees" ||` を消す。`case "worktrees.sync"` を消す。`case "remove.ask"` を `return { ...s, removing: { taskId: a.taskId, path: a.path, dirty: a.dirty } };` にする
- `daemon.warning` の分岐を次にする（警告の一覧を持たない。トーストだけ）:

```ts
      if (ev.event === "daemon.warning") {
        return { ...s, toast: ev.message };
      }
```

`app/src/store.tsx`:
- `initialState` の `worktrees: [],` / `warnings: [],` を消す
- `refresh` の後半の `worktree.list` / `daemon.warnings` の `Promise.all` とその dispatch（「worktree.list は worktree ごとに git status を回す」のコメントから `worktrees.sync` の dispatch まで）を消す
- `useDecide` の `removeWorktree` を次にする:

```ts
    // 確認ダイアログを経た後しか呼ばないので、常に force を付ける
    removeWorktree: (taskId: string) => rpc("worktree.remove", { task_id: taskId, force: true }),
```

- 使わなくなった `Warning` / `WorktreeEntry` の import を消す

`app/src/App.tsx`:
- `import { RemoveWorktreeModal, WorktreeView } from "./components/WorktreeView";` を `import { RemoveWorktreeModal } from "./components/RemoveWorktree";` にする
- `main` の `s.view === "worktrees" ? (<WorktreeView />) :` の分岐を消す

`app/src/components/Sidebar.tsx`:
- `icons.worktree` と、Rail の「worktree と警告」のボタンを消す
- `WorktreeSidebar` と `if (s.view === "worktrees") return <WorktreeSidebar />;` を消す
- `staleDaysOf` と `../worktrees` の import を消す

`app/src/components/TaskView.tsx`:
- `import { RemoveWorktreeButton } from "./WorktreeView";` を `import { RemoveWorktreeButton } from "./RemoveWorktree";` にする
- `worktreeEntry` / `removePath` / `removeDirty` の 4 行とそのコメントを次にする:

```tsx
  // 削除拒否は「完了時に未コミットの変更が残っていた」ので true。それ以外は分からない
  const removeDirty = t.refused ? true : null;
```

- `<RemoveWorktreeButton path={removePath!} dirty={removeDirty} />` を `<RemoveWorktreeButton taskId={t.id} path={t.worktree} dirty={removeDirty} />` にする（`t.worktree &&` の内側なので非 null）

- [ ] **Step 4: 通ることを確かめる**

Run: `builtin cd /Users/shunsuke.tadokoro/orca/workspaces/doctrine/app_ux/app && pnpm exec tsc && pnpm test`
Expected: PASS。`rg -n "worktrees\"|WorktreeView|staleDaysOf|warnings" app/src` が `settings.ts` / `SettingsView` の `staleDays` 以外を出さない

- [ ] **Step 5: コミット**

```bash
git add -A app/src
git commit -m "worktree と警告の画面を消し、worktree の削除をタスクの画面に残す

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: setup のタスクを消し、ウィザードを workspace の登録だけにする

**Files:**
- Delete: `core/src/workflow/setupWorkflow.ts`、`core/test/workflow/setupWorkflow.test.ts`、`core/test/daemon/workspaceSetup.test.ts`、`core/test/integration/setupTask.test.ts`
- Modify: `core/src/daemon/handlers.ts`（`setupWorkflow.ts` の import、type import の `SetupPolicy`、`case "workspace.setup"`、それだけが使っていた import）、`shared/protocol.ts`（`SetupPolicy`、`"workspace.setup"`）
- Modify: `app/src/wizard.ts`、`app/src/components/SetupWizard.tsx`、`app/src/model.ts`（`wizard.done`）、`app/src/components/TaskView.tsx`（`SetupDoneNotice` / `SetupRetryHint`）
- Test: `app/src/wizard.test.ts`、`app/src/SetupWizard.test.tsx`、`app/src/model.test.ts`、`app/src/TaskView.test.tsx`

**Interfaces:**
- Consumes: なし
- Produces:
  - `WizardStep = "welcome" | "directory" | "projects" | "tracker" | "confirm"`、`WizardState` から `policy` が消える
  - `submitWizard(s: WizardState): Promise<void>`（`workspace.add` だけ）
  - `Action` `{ type: "wizard.done"; toast: string }`。Task 6 でこの action の行き先を Intake の Issue の選択にする

- [ ] **Step 1: テストを書き換える**

`app/src/wizard.test.ts`:
- 「workspace.yaml があれば tracker を飛ばして policy へ進む」（54 行）の名前を「workspace.yaml があれば tracker を飛ばして confirm へ進む」にし、`expect(next(s)).toBe("policy")` を `expect(next(s)).toBe("confirm")` にする
- 「PR を開かない方針なら sync は false になり、追従の問を出さない」（99 行）を消す
- `describe("setupTargets", ...)` を消す
- `describe("submitWizard", ...)` の先頭のテストを次に置き換え、「setup の対象が無ければ workspace.setup を呼ばない」「workspace.setup が失敗したら、登録済みであることが分かる形で投げる」を消し、「workspace.add が失敗したら投げ、workspace.setup を呼ばない」を「workspace.add が失敗したら投げる」にして中の `workspace.setup` の期待を消す。残りのテストの `daemon({...})` から `"workspace.setup"` の行を消す:

```ts
  test("submitWizard は workspace.add だけを呼ぶ", async () => {
    const calls = daemon({ "workspace.add": () => Promise.resolve(ADDED_WORKSPACE) });
    const s = detected("/Users/me/work", DETECT_PARENT, {
      step: "confirm",
      tracker: { kind: "linear", team: "ENG" },
    });
    await submitWizard(s);
    expect(calls).toEqual([
      [
        "workspace.add",
        {
          path: "/Users/me/work",
          projects: { "shop-api": "Shop_API", web: "web" },
          tracker: { kind: "linear", team: "ENG" },
        },
      ],
    ]);
  });
```

- import から `DEFAULT_POLICY` / `setupTargets` / `WorkspaceSetupError` を消す

`app/src/SetupWizard.test.tsx`:
- 「policy の画面に 7 問が既定値つきで出る」「PR を開かない方針なら追従の問を出さない」を消す
- 「確認の画面に setup の対象の決め方と、確定のボタンが出る」を次に置き換える:

```tsx
  test("確認の画面にディレクトリ・プロジェクト・トラッカーと、確定のボタンが出る", () => {
    const html = screen(detected("/Users/me/work", DETECT_PARENT, { step: "confirm" }));
    expect(html).toContain("/Users/me/work");
    expect(html).toContain("shop-api");
    expect(html).toContain("GitHub Issues");
    expect(html).toContain("登録する");
    expect(html).not.toContain("setup");
  });
```

（`screen` / `detected` はこのファイルの既存のヘルパーの名前に合わせる）
- `describe("SetupFailedScreen", ...)` を消す

`app/src/model.test.ts` の `describe("初回ウィザード", ...)` の「wizard.done は閉じてタスク一覧に移り、作った setup のタスクを選ぶ」と「setup のタスクが無ければ選ぶものは変えず、トーストを出す」を次の 1 つに置き換える:

```ts
  test("wizard.done は閉じてトーストを出す", () => {
    const s = reduce(base({ wizard: { closable: true } }), { type: "wizard.done", toast: "workspace を登録しました" });
    expect(s.wizard).toBeNull();
    expect(s.toast).toBe("workspace を登録しました");
  });
```

`app/src/TaskView.test.tsx`: `SetupDoneNotice` と `SetupRetryHint` の describe を消し、import から外す。

- [ ] **Step 2: 失敗を確かめる**

Run: `builtin cd /Users/shunsuke.tadokoro/orca/workspaces/doctrine/app_ux/app && pnpm test wizard.test.ts SetupWizard.test.tsx model.test.ts`
Expected: FAIL（`next` が `"policy"` を返す、`wizard.done` の形が違う、確認の画面に setup の文言がある）

- [ ] **Step 3: core と protocol から setup のタスクを消す**

```bash
git rm core/src/workflow/setupWorkflow.ts core/test/workflow/setupWorkflow.test.ts core/test/daemon/workspaceSetup.test.ts core/test/integration/setupTask.test.ts
```

`core/src/daemon/handlers.ts`:
- `import { SETUP_WORKFLOW_NAME, setupPrompt, setupWorkflowYaml } from "../workflow/setupWorkflow.ts";` を消す
- type import の `SetupPolicy,` を消す
- `case "workspace.setup": { ... }` を丸ごと消す
- `listProjectsOf`（`../db/workspaces.ts` からの import）はこの case だけが使っていたので、import から外す（`pnpm exec biome check core/src/daemon/handlers.ts` が未使用の import を教える）
- `createTaskRow` の呼び出しが `task.create` だけになるので、`createTaskRow` 自体は残す（`task.create` は触らない）

`shared/protocol.ts`:
- `export type SetupPolicy = { ... };`（直前の doc コメントごと）を消す
- `Methods` の `"workspace.setup": { ... };`（直前の doc コメントごと）を消す

Run: `mise run core:check && mise run core:test`
Expected: PASS。落ちたら `rg -n "workspace.setup|SetupPolicy|setupWorkflow" core shared` で残りを消す。続けて `pnpm check:style` が通ること

- [ ] **Step 4: ウィザードを縮める**

`app/src/wizard.ts`:
- import から `SetupPolicy` / `TaskSummary` を消す
- `WizardStep` を `"welcome" | "directory" | "projects" | "tracker" | "confirm"` にする
- `WizardState` の `policy` と、`DEFAULT_POLICY`、`initialWizard` の `policy: DEFAULT_POLICY,` を消す
- `blocker` の `case "policy": { ... }` を消す
- `ORDER` を `["welcome", "directory", "projects", "tracker", "confirm"]` にする
- `Choice` / `PolicyQuestion` / `policyQuestions` / `MODEL_ROLES` / `setupTargets` / `WorkspaceSetupError` / `errorMessage` を消す
- `submitWizard` を次にする:

```ts
/** 確認画面の確定。workspace.add を呼ぶ */
export async function submitWizard(s: WizardState): Promise<void> {
  if (s.path === null || s.detection === null) throw new Error("ディレクトリが選ばれていません");
  // workspace.yaml があれば、中身はそちらが決める
  const init = s.detection.existing ? {} : {
    projects: Object.fromEntries(s.projects.filter((p) => p.selected).map((p) => [p.name, p.dir])),
    tracker: s.tracker.kind === "linear" ? { ...s.tracker, team: s.tracker.team.trim() } : s.tracker,
  };
  await rpc("workspace.add", { path: s.path, ...init });
}
```

`app/src/components/SetupWizard.tsx`:
- `Welcome` の本文を次にする:

```tsx
function Welcome() {
  return (
    <>
      <p>doctrine で作業するディレクトリを workspace として登録します。</p>
      <p className="hint">
        まだ <span className="mono">.doctrine/</span> が無いプロジェクトには、ワークフローの雛形
        （<span className="mono">.doctrine/workflows/default.yaml</span>）を置きます。リポジトリに合わせて直してから使ってください。
      </p>
    </>
  );
}
```

- `Tracker` の「setup のタスクはトラッカーを使わないので、後から設定しても構いません。」（140 行）を「後から設定しても構いません。」にする
- `Policy` と、`STEP_WORD` の `policy` の項を消す。`WizardScreen` の `{s.step === "policy" && <Policy .../>}` を消す
- `Confirm` から `answers` と、`answers.map(...)` の行と、setup のタスクの説明の `<p className="hint">` を消す
- `SetupFailedScreen` を消す
- `SetupWizard` の `setupFailed` の state と、その早期 return を消す。`submit` を次にする:

```tsx
  async function submit() {
    setPending(true);
    try {
      await submitWizard(s);
      await refresh();
      dispatch({ type: "wizard.done", toast: "workspace を登録しました" });
    } catch (e) {
      setS((x) => ({ ...x, error: `登録できませんでした: ${errorMessage(e)}` }));
    } finally {
      setPending(false);
    }
  }
```

- 使わなくなった import（`SetupPolicy`、`WorkspaceSetupError`、`policyQuestions`、`MODEL_ROLES`）を消す

`app/src/model.ts`:
- `Action` の `wizard.done` を `{ type: "wizard.done"; toast: string }` にし、説明を「登録を終えた後の後片付け」にする
- `case "wizard.done"` を次にする（Task 6 で行き先を足す）:

```ts
    case "wizard.done":
      return { ...s, wizard: null, editing: null, toast: a.toast };
```

`app/src/components/TaskView.tsx`: `SetupDoneNotice` と `SetupRetryHint` と、その 3 箇所の呼び出しを消す。

- [ ] **Step 5: 通ることを確かめる**

Run: `builtin cd /Users/shunsuke.tadokoro/orca/workspaces/doctrine/app_ux/app && pnpm exec tsc && pnpm test`
Expected: PASS。`rg -n "setup のタスク|workspace\.setup|SetupPolicy|policy" app/src` がプロジェクトの `setup` コマンド（`project.yaml` の `setup`）以外を出さない

- [ ] **Step 6: コミット**

```bash
git add -A core shared app/src
git commit -m "setup のタスクを消し、ウィザードを workspace の登録だけにする

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Execution の部品（props だけで描くもの）

**Files:**
- Create: `app/src/components/ExecutionSidebar.tsx`（この Task では `ExecutionRow` だけ）
- Create: `app/src/components/ExecutionView.tsx`（この Task では `DirectProcess` だけ）
- Create: `app/src/ExecutionView.test.tsx`
- Modify: `app/src/components/Sidebar.tsx`（`IntakeRow` に `tone` / `extra`）、`app/src/components/IntakeView.tsx`（`IntakeHeading` に `label` と種類の印、`MovedToExecution`）、`app/src/components/IntakeProgress.tsx`（`ProcessTrail` の `showSubIssue`、`CancelDialog` の `scope`）、`app/src/styles.css`
- Test: `app/src/Sidebar.test.tsx`、`app/src/IntakeView.test.tsx`、`app/src/IntakeProgress.test.tsx`

**Interfaces:**
- Consumes: Task 1 の `MODE_WORD` / `executionTone` / `intakeSection` / `sectionTone`
- Produces:
  - `IntakeRow(p: { intake: IntakeSummary; workspace: Workspace | undefined; tone: Tone; selected: boolean; now: number; onSelect: () => void; extra?: ReactNode })`
  - `ExecutionRow(p: { intake: IntakeSummary; workspace: Workspace | undefined; attention: boolean; selected: boolean; now: number; onSelect: () => void })`
  - `IntakeHeading({ intake, workspace, label?, onCancel? })`。`label` は `"Intake" | "Execution"`、既定 `"Intake"`
  - `MovedToExecution({ onOpen }: { onOpen: () => void })`
  - `DirectProcess(p: { title: string; view: IntakeProcessView | undefined; pending: boolean; onRedispatch: () => void; onOpenTask: (taskId: string) => void })`
  - `ProcessTrail({ view, onOpenTask, showSubIssue? })`。`showSubIssue` の既定は true
  - `CancelDialog(p: { scope: "none" | "plan" | "direct"; pending; onSend; onClose })`

- [ ] **Step 1: 失敗するテストを書く**

`app/src/ExecutionView.test.tsx`:

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { IntakeProcessView } from "../../shared/protocol.ts";
import { ExecutionRow } from "./components/ExecutionSidebar";
import { DirectProcess } from "./components/ExecutionView";
import { INTAKES, NOW, WORKSPACES } from "./fixtures";

const noop = () => {};
const active = INTAKES.find((i) => i.id === "i2")!;

const row = (o: Partial<Parameters<typeof ExecutionRow>[0]> = {}) =>
  renderToStaticMarkup(
    <ExecutionRow intake={active} workspace={WORKSPACES[1]} attention={false} selected={false} now={NOW} onSelect={noop} {...o} />,
  );

describe("ExecutionRow", () => {
  test("種類の印を出す", () => {
    expect(row()).toContain(">Plan<");
    expect(row({ intake: { ...active, mode: "direct" } })).toContain(">Direct<");
  });

  test("人の番なら点を出し、行を human の色にする", () => {
    const html = row({ attention: true });
    expect(html).toContain('aria-label="あなたの番"');
    expect(html).toContain("tone-human");
    expect(row()).not.toContain('aria-label="あなたの番"');
  });

  test("完了は ok の色", () => {
    expect(row({ intake: { ...active, state: "completed" } })).toContain("tone-ok");
  });
});

const direct = (o: Partial<IntakeProcessView>): IntakeProcessView => ({
  id: "main",
  state: "running",
  taskId: "t1",
  sub_issue_url: null,
  task_ids: ["t1"],
  rail: null,
  ...o,
} as IntakeProcessView);

describe("DirectProcess", () => {
  test("Issue のタイトルと状態とタスクを出し、sub-issue の欄は出さない", () => {
    const html = renderToStaticMarkup(
      <DirectProcess title="ログインを直す" view={direct({})} pending={false} onRedispatch={noop} onOpenTask={noop} />,
    );
    expect(html).toContain("ログインを直す");
    expect(html).toContain("t1");
    expect(html).not.toContain("sub-issue");
    expect(html).not.toContain("再投入する");
  });

  test("要確認なら再投入のボタンを出す", () => {
    const html = renderToStaticMarkup(
      <DirectProcess
        title="ログインを直す"
        view={direct({ state: "needs_attention", taskId: "t1", reason: "task_stopped" } as Partial<IntakeProcessView>)}
        pending={false}
        onRedispatch={noop}
        onOpenTask={noop}
      />,
    );
    expect(html).toContain("再投入する");
  });

  test("プロセスがまだ届いていなければ読み込み中", () => {
    const html = renderToStaticMarkup(
      <DirectProcess title="x" view={undefined} pending={false} onRedispatch={noop} onOpenTask={noop} />,
    );
    expect(html).toContain("読み込み中");
  });
});
```

`app/src/Sidebar.test.tsx` の `row()` ヘルパーに `tone="run"` を足す（`IntakeRow` に `tone` が必須になるため）:

```tsx
    <IntakeRow intake={INTAKES[0]} workspace={WORKSPACES[1]} tone="run" selected={false} now={NOW} onSelect={noop} {...o} />,
```

`app/src/IntakeView.test.tsx` の `describe("IntakeView の部品", ...)` に足す（import に `MovedToExecution` を足す）:

```tsx
  test("見出しのパンくずは label、見出しに種類の印を出す", () => {
    const html = renderToStaticMarkup(
      <IntakeHeading intake={{ ...reviewing, mode: "direct" }} workspace={WORKSPACES[0]} label="Execution" />,
    );
    expect(html).toContain('<span class="lbl">Execution</span>');
    expect(html).toContain(">Direct<");
  });

  test("Execution へ移った Intake は案内と開くボタンを出す", () => {
    const html = renderToStaticMarkup(<MovedToExecution onOpen={noop} />);
    expect(html).toContain("Execution で開く");
  });
```

`app/src/IntakeProgress.test.tsx` の `describe("CancelDialog", ...)` を次に置き換える:

```tsx
describe("CancelDialog", () => {
  const dialog = (scope: "none" | "plan" | "direct") =>
    renderToStaticMarkup(<CancelDialog scope={scope} pending={false} onSend={noop} onClose={noop} />);

  test("plan の承認後はタスクと sub-issue の扱いを選ばせる", () => {
    const html = dialog("plan");
    expect(html).toContain("そのままにする");
    expect(html).toContain("タスクを止め、sub-issue を取りやめとして閉じる");
  });

  test("direct はタスクを止めるかを選ばせ、sub-issue には触れない", () => {
    const html = dialog("direct");
    expect(html).toContain("そのままにする");
    expect(html).toContain("タスクを止める");
    expect(html).not.toContain("sub-issue");
  });

  test("承認前は選択肢を出さない", () => {
    const html = dialog("none");
    expect(html).not.toContain("そのままにする");
    expect(html).toContain("中止する");
  });
});
```

`describe("ProcessTrail", ...)` に足す:

```tsx
  test("showSubIssue が false なら sub-issue の欄を出さない", () => {
    const view = INTAKE_ACTIVE.processes[0];
    const html = renderToStaticMarkup(<ProcessTrail view={view} onOpenTask={noop} showSubIssue={false} />);
    expect(html).not.toContain("sub-issue");
  });
```

- [ ] **Step 2: 失敗を確かめる**

Run: `builtin cd /Users/shunsuke.tadokoro/orca/workspaces/doctrine/app_ux/app && pnpm test ExecutionView.test.tsx Sidebar.test.tsx IntakeView.test.tsx IntakeProgress.test.tsx`
Expected: FAIL（`ExecutionSidebar` / `ExecutionView` が無い、`label` / `scope` / `showSubIssue` が無い）

- [ ] **Step 3: 部品を書く**

`app/src/components/Sidebar.tsx` の `IntakeRow` を次にする（import に `type Tone` を `../tone` から、`type ReactNode` を `react` から足す）:

```tsx
export function IntakeRow(p: {
  intake: IntakeSummary;
  workspace: Workspace | undefined;
  tone: Tone;
  selected: boolean;
  now: number;
  onSelect: () => void;
  /** 行のメタの末尾に足す印 */
  extra?: ReactNode;
}) {
  const i = p.intake;
  const num = issueNumber(i.issue_url);
  const progress = intakeProgress(i);
  return (
    <button className={`it ${toneClass(p.tone)}`} aria-current={p.selected} onClick={p.onSelect}>
      <span className="t">
        {num !== null && <span className="num">{`#${num}`}</span>}
        {i.issue_title}
      </span>
      <span className="m">
        <span className="pj">
          <span className="pjdot" style={{ background: p.workspace?.color ?? "#666" }} />
          {p.workspace?.name ?? ""}
        </span>
        <span>{INTAKE_WORD[i.state]}</span>
        {progress && <span className="prog">{progress}</span>}
        {i.revising && <span className="tag rev">改訂中</span>}
        {i.rate_limited_until && <span>{`${hm(Date.parse(i.rate_limited_until))} 再開`}</span>}
        {p.extra}
        <span className="tm">{ago(Date.parse(i.updated_at), p.now)}</span>
      </span>
    </button>
  );
}
```

`IntakeItem` の `<IntakeRow ...>` に `tone={sectionTone(intakeSection(i), i)}` を足す。

`app/src/components/ExecutionSidebar.tsx`:

```tsx
import type { IntakeSummary } from "../../../shared/protocol.ts";
import { MODE_WORD } from "../intake";
import { executionTone } from "../tone";
import type { Workspace } from "../types";
import { IntakeRow } from "./Sidebar";

export function ExecutionRow(p: {
  intake: IntakeSummary;
  workspace: Workspace | undefined;
  attention: boolean;
  selected: boolean;
  now: number;
  onSelect: () => void;
}) {
  return (
    <IntakeRow
      intake={p.intake}
      workspace={p.workspace}
      tone={executionTone(p.intake, p.attention)}
      selected={p.selected}
      now={p.now}
      onSelect={p.onSelect}
      extra={
        <>
          <span className="tag">{MODE_WORD[p.intake.mode].mark}</span>
          {p.attention && <span className="row-pip" aria-label="あなたの番" />}
        </>
      }
    />
  );
}
```

`app/src/components/IntakeProgress.tsx`:
- `ProcessTrail` に `showSubIssue = true` を足し、`<Sec title="sub-issue">...</Sec>` を `{showSubIssue && (...)}` で囲む:

```tsx
export function ProcessTrail(
  { view, onOpenTask, showSubIssue = true }: {
    view: IntakeProcessView;
    onOpenTask: (taskId: string) => void;
    /** direct は sub-issue を持たない */
    showSubIssue?: boolean;
  },
) {
```

- `CancelDialog` を次にする:

```tsx
/** 中止の確認（8.6）。承認前（none）は選択肢を出さない。direct は sub-issue を持たない */
export function CancelDialog(p: {
  scope: "none" | "plan" | "direct";
  pending: boolean;
  onSend: (mode: "leave" | "stop") => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<"leave" | "stop">("leave");
  const choose = p.scope !== "none";
  return (
    <>
      <div className="scrim" onClick={p.onClose} />
      <div className="modal" role="dialog" aria-modal="true">
        <h2>Intake を中止する</h2>
        {choose && (
          <>
            <label>
              <input type="radio" name="cancel-mode" checked={mode === "leave"} onChange={() => setMode("leave")} />
              そのままにする
            </label>
            <label>
              <input type="radio" name="cancel-mode" checked={mode === "stop"} onChange={() => setMode("stop")} />
              {p.scope === "plan" ? "タスクを止め、sub-issue を取りやめとして閉じる" : "タスクを止める"}
            </label>
          </>
        )}
        <div className="actions">
          <button className="btn danger" disabled={p.pending} onClick={() => p.onSend(choose ? mode : "leave")}>
            中止する
          </button>
          <button className="btn" onClick={p.onClose}>戻る</button>
        </div>
      </div>
    </>
  );
}
```

- `IntakeView.tsx` の `CancelDialog` の呼び出し（`approved={detail.value.approval !== null}`）は `scope={detail.value.approval !== null ? "plan" : "none"}` にする（Intake 側は承認前と改訂中しか開かない）

`app/src/components/ExecutionView.tsx`（この Task では `DirectProcess` だけ。Task 6 で本体を足す）:

```tsx
import type { IntakeProcessView } from "../../../shared/protocol.ts";
import { statusText } from "../intake";
import { PROCESS_TONE } from "../tone";
import { ProcessTrail } from "./IntakeProgress";
import { StatusDot } from "./StatusDot";

/** direct の Issue の欄。図の組み立ては段階 3 なので、ここではプロセス 1 つを箱で出す */
export function DirectProcess(p: {
  title: string;
  view: IntakeProcessView | undefined;
  pending: boolean;
  onRedispatch: () => void;
  onOpenTask: (taskId: string) => void;
}) {
  if (!p.view) return <p className="hint">タスクを読み込み中</p>;
  return (
    <section className="box">
      <div className="headrow">
        <b>{p.title}</b>
        <StatusDot tone={PROCESS_TONE[p.view.state].tone} word={statusText(p.view)} />
      </div>
      <ProcessTrail view={p.view} onOpenTask={p.onOpenTask} showSubIssue={false} />
      {p.view.state === "needs_attention" && (
        <div className="actions">
          <button className="btn" disabled={p.pending} onClick={p.onRedispatch}>再投入する</button>
        </div>
      )}
    </section>
  );
}
```

（`PROCESS_TONE` が `tone.ts` ではなく `pfd.ts` 側にあれば、そちらから import する。`rg -n "export const PROCESS_TONE" app/src` で場所を確かめる）

`app/src/components/IntakeView.tsx`:
- `IntakeHeading` を次にする（import に `MODE_WORD` を足す）:

```tsx
export function IntakeHeading(
  { intake, workspace, label = "Intake", onCancel }: {
    intake: IntakeSummary;
    workspace: Workspace | undefined;
    label?: "Intake" | "Execution";
    onCancel?: () => void;
  },
) {
  const num = issueNumber(intake.issue_url);
  return (
    <>
      <div className="crumbs">
        <span className="lbl">{label}</span>
        <span>/</span>
        <span className="pjdot" style={{ background: workspace?.color ?? "#666" }} />
        <span>{workspace?.name ?? ""}</span>
      </div>
      <div className="headrow">
        <h1>
          {num !== null && <span className="num">{`#${num}`}</span>}
          {intake.issue_title}
        </h1>
        <StatusDot tone={INTAKE_TONE[intake.state]} word={INTAKE_WORD[intake.state]} />
        <span className="tag">{MODE_WORD[intake.mode].mark}</span>
        <span className="mono hint">{intake.issue_url}</span>
        {onCancel && !isClosedIntake(intake.state) && <button className="btn sm danger" onClick={onCancel}>中止…</button>}
      </div>
    </>
  );
}
```

- `IntakeFacePlaceholder` の下に足す:

```tsx
/** Intake の一覧から外れた（承認済み・終了した）Intake を Intake のビューで開いたとき */
export function MovedToExecution({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="box quiet">
      <p>この Issue は Execution で扱っています。</p>
      <div className="actions">
        <button className="btn" onClick={onOpen}>Execution で開く</button>
      </div>
    </div>
  );
}
```

`app/src/styles.css` の `.ib .pip{...}` の次の行に足す:

```css
.it .row-pip{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--accent)}
.exec-panel-slot{display:flex;flex-direction:column;gap:16px;margin-top:16px}
```

- [ ] **Step 4: 通ることを確かめる**

Run: `builtin cd /Users/shunsuke.tadokoro/orca/workspaces/doctrine/app_ux/app && pnpm exec tsc && pnpm test`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add app/src/components/ExecutionSidebar.tsx app/src/components/ExecutionView.tsx app/src/ExecutionView.test.tsx app/src/components/Sidebar.tsx app/src/components/IntakeView.tsx app/src/components/IntakeProgress.tsx app/src/styles.css app/src/Sidebar.test.tsx app/src/IntakeView.test.tsx app/src/IntakeProgress.test.tsx
git commit -m "Execution の行・direct の欄・見出しの部品を足す

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: view を Intake / Execution / 設定にして、Execution の本体を繋ぐ

**Files:**
- Modify: `app/src/model.ts`、`app/src/store.tsx`、`app/src/App.tsx`
- Modify: `app/src/components/Sidebar.tsx`（Rail、タスクの一覧を消す、`IntakeSidebar`）
- Modify: `app/src/components/ExecutionSidebar.tsx`（`ExecutionSidebar`）
- Modify: `app/src/components/ExecutionView.tsx`（`ExecutionView` / `PlanBody` / `DirectBody` / `OpenedTask`）
- Create: `app/src/components/ReviseFace.tsx`
- Modify: `app/src/components/IntakeProgress.tsx`（`IntakeProgress` を消し、`useApprovedPfd` を足す）
- Modify: `app/src/components/IntakeView.tsx`（面の振り分け）
- Modify: `app/src/components/TaskView.tsx`（`IntakeRetryHint`）
- Test: `app/src/model.test.ts`、`app/src/TaskView.test.tsx`

**Interfaces:**
- Consumes: Task 1〜5 のすべて
- Produces（段階 3 が使う）:
  - `View = "intake" | "execution" | "settings"`
  - `State.execSel: string | null`（Execution で選んでいる Intake の id）、`State.execClosed: boolean`（「終了」を見ているか）
  - `Action` `{ type: "execution.select"; id: string }`、`{ type: "execution.closed"; closed: boolean }`
  - `intakeRowOf(s: State, id: string): IntakeSummary | null`（一覧の行、無ければ取ってある詳細）
  - `ExecutionView` は選んだ要素のキーを `useState<string | null>` の `selected` で持ち、図の下に `<div className="exec-panel-slot">` を置く。スロットには `PfdElementPanel` + `ProcessTrail` と `OpenedTask`（`s.sel` のタスクがこの Intake のものなら `ReviewView` / `TaskView`）を出す
  - `useApprovedPfd(detail: IntakeDetail): { pfd: Pfd | null; error: string | null }`（`IntakeProgress.tsx`）

- [ ] **Step 1: reducer の失敗するテストを書く**

`app/src/model.test.ts`:
- `base()` の `view: "tasks",` を `view: "execution",` に、`showClosedIntakes: false,` を `execSel: null,` と `execClosed: false,` にする
- 次の describe を消す（対象の機能が無くなる）: `describe("sidebarOrder", ...)`、`describe("workspace の絞り込み", ...)` のうち「絞り込み中の j/k はその workspace のタスクだけを動く」「sync は新しい projects で絞って先頭を選ぶ」、`describe("上限待ち", ...)` の「サイドバーでは実行中と待ちの間に、再開の早い順で並ぶ」と `timeLabel` の 2 つ、`describe("reduce", ...)` の「j / k の移動はサイドバーの端で止まる」「終了ビューに切り替えると終了したタスクを選ぶ」、`describe("sync", ...)` の「選択中のタスクが消えたら先頭を選び直す」、`describe("進行中の面", ...)` の「task.open は終了したタスクなら終了ビューで開く」「intake.open はタスクの選択を残して Intake を開く」「taskViewFor」、`describe("設定のビュー", ...)` の「設定ビューでタスクを選ぶとタスクのビューに戻る」、`describe("Intake の一覧の取り直し", ...)` の「intake.select と intake.showClosed は値を書く」
- `describe("reduce", ...)` の「承認は…次のレビュー待ちを選び toast を出す」「差し戻しも…次のレビュー待ちを選び toast を出す」の `expect(s.sel).toBe("b-204")` を `expect(s.sel).toBe("t-2b91")` にする（fixture のタスクは Intake を持たないので、選んだまま）
- `describe("初回ウィザード", ...)` の「wizard.done は閉じてトーストを出す」に `expect(s.view).toBe("intake"); expect(s.intakeSel).toBe("new");` を足す
- 次の describe を足す:

```ts
describe("Execution のビュー", () => {
  const withIntake = (id: string, state: TaskState, intakeId: string | null): Task => ({
    ...seedTasks()[0],
    id,
    state,
    intake: intakeId === null ? null : { id: intakeId, processId: "p1", issueUrl: null, parentIssueUrl: null },
  });

  test("view を移っても選択は消えない", () => {
    const s = reduce(base({ execSel: "i2", sel: "t-2b91" }), { type: "view", view: "intake" });
    expect(s.view).toBe("intake");
    expect(s.execSel).toBe("i2");
    expect(s.sel).toBe("t-2b91");
  });

  test("execution.select と execution.closed は値を書く", () => {
    expect(reduce(base(), { type: "execution.select", id: "i2" }).execSel).toBe("i2");
    expect(reduce(base(), { type: "execution.closed", closed: true }).execClosed).toBe(true);
  });

  test("execution ビューで j/k は Execution の一覧を動く", () => {
    let s = base({ intakes: INTAKES, execSel: null });
    s = reduce(s, { type: "move", delta: 1 });
    expect(s.execSel).toBe("i2");
    s = reduce(s, { type: "move", delta: 1 });
    expect(s.execSel).toBe("i5");
    s = reduce(s, { type: "move", delta: 1 });
    expect(s.execSel).toBe("i5");
  });

  test("intake.started は plan なら Intake で選び、direct なら Execution に移って選ぶ", () => {
    const plan = reduce(base({ view: "intake" }), { type: "intake.started", intake: { ...INTAKES[6], id: "n1", mode: "plan" } });
    expect(plan.view).toBe("intake");
    expect(plan.intakeSel).toBe("n1");
    const direct = reduce(base({ view: "intake", execClosed: true }), {
      type: "intake.started",
      intake: { ...INTAKES[6], id: "n2", state: "active", mode: "direct" },
    });
    expect(direct.view).toBe("execution");
    expect(direct.execSel).toBe("n2");
    expect(direct.execClosed).toBe(false);
  });

  test("承認の後片付けは Execution に移ってその Intake を選ぶ", () => {
    const s = reduce(base({ view: "intake", intakes: INTAKES }), { type: "intake.sent", id: "i1", what: "approve" });
    expect(s.view).toBe("execution");
    expect(s.execSel).toBe("i1");
  });

  test("改訂に入ると Intake に移ってその Intake を選び、やめると Execution に戻る", () => {
    let s = reduce(base({ intakes: INTAKES, execSel: "i2" }), { type: "intake.revise.enter", id: "i2" });
    expect(s.view).toBe("intake");
    expect(s.intakeSel).toBe("i2");
    expect(s.intakeRevise).toBe("i2");
    s = reduce(s, { type: "intake.revise.leave" });
    expect(s.view).toBe("execution");
    expect(s.execSel).toBe("i2");
    expect(s.intakeRevise).toBeNull();
  });

  test("task.open はタスクの Intake を Execution で選び、タスクを選ぶ。終了した Intake なら終了を見る", () => {
    const tasks = [withIntake("t9", "suspended", "i7")];
    const s = reduce(base({ view: "intake", tasks, intakes: INTAKES }), { type: "task.open", id: "t9" });
    expect(s.view).toBe("execution");
    expect(s.execSel).toBe("i7");
    expect(s.execClosed).toBe(true);
    expect(s.sel).toBe("t9");
  });

  test("Intake に属さないタスクの task.open はトーストだけ", () => {
    const tasks = [withIntake("t9", "failed", null)];
    const before = base({ tasks, sel: null, execSel: "i2" });
    const s = reduce(before, { type: "task.open", id: "t9" });
    expect(s.sel).toBeNull();
    expect(s.execSel).toBe("i2");
    expect(s.toast).toBe("Intake に属さないタスクです");
  });

  test("intake.open は Execution でその Intake を選ぶ", () => {
    const s = reduce(base({ view: "intake" }), { type: "intake.open", id: "i2" });
    expect(s.view).toBe("execution");
    expect(s.execSel).toBe("i2");
  });

  test("承認・差し戻しの後は同じ Intake の次の承認待ちを選び、別の Intake には飛ばない", () => {
    const tasks = [
      withIntake("a1", "suspended", "i2"),
      withIntake("b1", "suspended", "i5"),
      withIntake("a2", "suspended", "i2"),
    ];
    const approved = reduce(base({ tasks, sel: "a1" }), { type: "approve" });
    expect(approved.sel).toBe("a2");
    const rejected = reduce(base({ tasks: tasks.filter((t) => t.id !== "a2"), sel: "a1" }), { type: "reject.confirm" });
    expect(rejected.sel).toBe("a1");
  });

  test("選んでいるタスクが消えたら選択を外す", () => {
    const s = reduce(base({ sel: "gone" }), { type: "sync", tasks: seedTasks(), projects: PROJECTS, now: NOW });
    expect(s.sel).toBeNull();
  });

  test("intakes.sync は Execution で選んでいる Intake の詳細を、一覧から消えても残す", () => {
    const s = reduce(
      base({ intakes: INTAKES, execSel: "i7", intakeDetails: { i7: { kind: "ok", value: { ...INTAKE_ACTIVE, id: "i7" } } } }),
      { type: "intakes.sync", intakes: INTAKES.filter((i) => i.id !== "i7") },
    );
    expect(s.intakeDetails.i7).toBeDefined();
    expect(s.execSel).toBe("i7");
  });
});
```

（import に `INTAKE_ACTIVE`、`type TaskState`、`type Task` が無ければ足す）

`app/src/TaskView.test.tsx` の `describe("IntakeRetryHint", ...)` を次に置き換える:

```tsx
describe("IntakeRetryHint", () => {
  test("Execution の再投入を案内する", () => {
    const h = renderToStaticMarkup(<IntakeRetryHint />);
    expect(h).toContain("再投入する");
    expect(h).not.toContain("Intake を開く");
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `builtin cd /Users/shunsuke.tadokoro/orca/workspaces/doctrine/app_ux/app && pnpm test model.test.ts TaskView.test.tsx`
Expected: FAIL（`execSel` / `execution.select` / `execution.closed` が無い、`intake.started` が direct を見ない、など）

- [ ] **Step 3: model.ts を書き換える**

import に `import { executionOrder } from "./execution";` を足し、`./intake` の import に `isClosedIntake` を足す。

`View` と、タスクの一覧の関数を書き換える:

```ts
export type View = "intake" | "execution" | "settings";
```

`taskViewFor` / `visibleTasks` / `sidebarOrder` / `countReview` / `timeLabel` / `GROUPS` を消す（`groupOf` と `Group` は `tone.ts:groupTone` と `TaskView` が使うので残す）。消した後 `pnpm exec tsc` が他の参照を指摘したら、その参照も消す。

`State`:
- `showClosedIntakes: boolean;` を消し、`intakeSel` の下に足す:

```ts
  /** Execution で選んでいる Intake の id */
  execSel: string | null;
  /** Execution の一覧で「終了」を見ているか */
  execClosed: boolean;
```

`selectedIntake` を次に置き換える:

```ts
/** 一覧の行。一覧から消えていれば、取ってある詳細を代わりに返す */
export function intakeRowOf(s: State, id: string): IntakeSummary | null {
  const row = s.intakes.find((i) => i.id === id);
  if (row) return row;
  const d = intakeDetailOf(s, id);
  return d?.kind === "ok" ? d.value : null;
}

export function selectedIntake(s: State): IntakeSummary | null {
  return s.intakeSel === null || s.intakeSel === "new" ? null : intakeRowOf(s, s.intakeSel);
}
```

`Action`:
- `{ type: "select"; id: string }` と `{ type: "intake.showClosed"; show: boolean }` を消す
- 足す:

```ts
  | { type: "execution.select"; id: string }
  | { type: "execution.closed"; closed: boolean }
```

- `task.open` の説明を「タスクを、その Intake の Execution で開く」に、`intake.open` の説明を「Intake を Execution で開く」にする

`selectNextReview` を次に置き換える:

```ts
/** 判断の後は、同じ Intake の次のレビュー待ちを選ぶ。無ければ選んだまま */
function selectNextReview(s: State, done: Task): string | null {
  const intakeId = done.intake?.id;
  if (intakeId === undefined) return s.sel;
  const next = s.tasks.find((x) => x.state === "suspended" && x.id !== done.id && x.intake?.id === intakeId);
  return next ? next.id : s.sel;
}
```

（`case "approve"` と `case "reject.confirm"` の呼び出しを `selectNextReview(next, t)` にする）

`reduce` の各 case:

```ts
    case "view":
      return { ...s, view: a.view, editing: null };
```

`case "select"` を消す。

```ts
    case "wizard.done":
      return { ...s, wizard: null, view: "intake", intakeSel: "new", editing: null, toast: a.toast };
```

```ts
    case "move": {
      if (s.view === "settings") return s;
      if (s.view === "intake") {
        const rows = intakeOrder(s.intakes, s.workspace, s.intakeRevise);
        if (!rows.length) return s;
        const i = rows.findIndex((x) => x.id === s.intakeSel);
        const n = i < 0 ? rows[0] : rows[Math.max(0, Math.min(rows.length - 1, i + a.delta))];
        return { ...s, intakeSel: n.id };
      }
      const rows = executionOrder(s.intakes, s.tasks, s.workspace, s.execClosed);
      if (!rows.length) return s;
      const i = rows.findIndex((x) => x.id === s.execSel);
      const n = i < 0 ? rows[0] : rows[Math.max(0, Math.min(rows.length - 1, i + a.delta))];
      return { ...s, execSel: n.id };
    }
```

`case "intake.sent"` の return に、承認のときだけ Execution へ移すことを足す:

```ts
      return {
        ...s,
        intakeDrafts: setIntakeDraft(s, a.id, patch),
        intakeRevise: a.what === "revise" ? null : s.intakeRevise,
        modal: null,
        ...invalidateIntake(s, a.id),
        toast: SENT_TOAST[a.what],
        // 承認した Intake は Intake の一覧から外れるので、Execution で開き直す
        ...(a.what === "approve" ? { view: "execution" as const, execSel: a.id, execClosed: false } : {}),
      };
```

```ts
    case "intake.revise.enter":
      return { ...s, intakeRevise: a.id, view: "intake", intakeSel: a.id, editing: null };
    case "intake.revise.leave":
      return { ...s, intakeRevise: null, view: "execution", execSel: s.intakeRevise ?? s.execSel };
    case "task.open": {
      const target = s.tasks.find((x) => x.id === a.id);
      if (!target) return { ...s, toast: "タスクが一覧にありません" };
      if (!target.intake) return { ...s, toast: "Intake に属さないタスクです" };
      const row = s.intakes.find((i) => i.id === target.intake!.id);
      return {
        ...s,
        view: "execution",
        execSel: target.intake.id,
        execClosed: row ? isClosedIntake(row.state) : s.execClosed,
        sel: a.id,
        editing: null,
      };
    }
    case "intake.open":
      return { ...s, view: "execution", execSel: a.id, editing: null };
```

`case "intake.showClosed"` を消し、足す:

```ts
    case "execution.select":
      return { ...s, execSel: a.id };
    case "execution.closed":
      return { ...s, execClosed: a.closed };
```

`case "intakes.sync"` の `keep` と `intakeRevise` の条件に `execSel` を足す:

```ts
      const kept = (id: string) => ids.has(id) || id === s.intakeSel || id === s.execSel;
      const keep = <T,>(r: Record<string, T>) => Object.fromEntries(Object.entries(r).filter(([id]) => kept(id)));
      return {
        ...s,
        intakes: a.intakes,
        intakeRevise: s.intakeRevise !== null && kept(s.intakeRevise) ? s.intakeRevise : null,
        intakeDetails: keep(s.intakeDetails),
        intakeLogs: keep(s.intakeLogs),
        intakeGen: keep(s.intakeGen),
        intakeDrafts: keep(s.intakeDrafts),
      };
```

`case "intake.started"`:

```ts
    case "intake.started": {
      const has = s.intakes.some((i) => i.id === a.intake.id);
      const intakes = has
        ? s.intakes.map((i) => (i.id === a.intake.id ? a.intake : i))
        : [a.intake, ...s.intakes];
      // direct は開始と同時に active になり、Intake の一覧には並ばない
      return a.intake.mode === "direct"
        ? { ...s, intakes, view: "execution", execSel: a.intake.id, execClosed: false }
        : { ...s, intakes, intakeSel: a.intake.id };
    }
```

`case "sync"` の末尾の 2 行（`const first = sidebarOrder(...)` から）を次にする:

```ts
      if (s.sel !== null && ids.has(s.sel)) return next;
      return { ...next, sel: null, editing: null };
```

（`if (s.sel !== null && ids.has(s.sel)) return next;` は既にあるので、その後ろだけを書き換える）

- [ ] **Step 4: store.tsx を書き換える**

`initialState`:
- `view: "tasks",` を `view: "execution",` にする
- `showClosedIntakes: false,` を `execSel: null,` と `execClosed: false,` にする

`refresh` の `intake.list`:

```ts
          // 「終了」で出した分を取り直しで消さないよう、今の切り替えを渡す。
          // （以下、既存のコメントはそのまま）
          rpc("intake.list", { include_closed: latest.current.execClosed }).catch(
```

「すべて」の切り替えの effect を次にする:

```ts
  // 「終了」の切り替えは、次の 15 秒を待たずに取り直す
  useEffect(() => {
    void refreshRef.current?.();
  }, [s.execClosed]);
```

開いている Intake の詳細の対象を次にする:

```ts
  // 開いている Intake の詳細。選ばれていて、まだ取っていないものだけ
  const intakeId = s.view === "intake"
    ? (s.intakeSel === "new" ? null : s.intakeSel)
    : s.view === "execution"
    ? s.execSel
    : null;
```

`useIntakeRpc` は変えない（`start` の mode は Task 7）。

- [ ] **Step 5: IntakeProgress.tsx を部品だけにし、ReviseFace を作る**

`app/src/components/IntakeProgress.tsx`:
- `export function IntakeProgress(...)` を丸ごと消す
- 次を足す（import の `useEffect` / `useState` / `PfdDraft` / `type Loaded` / `useIntakeRpc` はこれが使う。使わなくなった import は `pnpm exec tsc` の指摘どおり消す）:

```tsx
/** 承認された案の PFD。最新の案が承認された案と違うときは取りに行く。承認前は null */
export function useApprovedPfd(detail: IntakeDetail): { pfd: Pfd | null; error: string | null } {
  const api = useIntakeRpc();
  const [fetched, setFetched] = useState<Loaded<PfdDraft> | null>(null);
  const { approval } = detail;
  const inLatest = approval !== null && detail.latest_draft?.id === approval.draft_id;
  const approvedId = approval?.draft_id ?? null;
  useEffect(() => {
    if (approvedId === null || inLatest) return;
    let alive = true;
    setFetched({ kind: "loading" });
    api.draft(detail.id, approvedId).then(
      (value) => alive && setFetched({ kind: "ok", value }),
      (e) => alive && setFetched({ kind: "error", message: errorMessage(e) }),
    );
    return () => {
      alive = false;
    };
  }, [detail.id, approvedId, inLatest]);
  const pfd = inLatest ? detail.latest_draft!.pfd : fetched?.kind === "ok" ? fetched.value.pfd : null;
  return { pfd, error: fetched?.kind === "error" ? fetched.message : null };
}
```

`app/src/components/ReviseFace.tsx`:

```tsx
import { useMemo, useState, type ReactNode } from "react";
import type { IntakeDetail } from "../../../shared/protocol.ts";
import { sendDecision } from "../decision";
import { canRejectIntake, commentCounts, commentsOn, processStatuses, wholeComment } from "../intake";
import { intakeDraftOf } from "../model";
import { buildPfdView, frozenIds, pfdElement } from "../pfd";
import { useIntakeRpc, useStore } from "../store";
import { ReviseDecide, useApprovedPfd } from "./IntakeProgress";
import { PfdDiagram } from "./PfdDiagram";
import { PfdElementPanel } from "./PfdElementPanel";
import { StatusCounts } from "./StatusCounts";

/** 改訂に入るモードの面。承認された案の図の、固定でない要素にコメントを付けて改訂を始める */
export function ReviseFace({ detail, heading }: { detail: IntakeDetail; heading: ReactNode }) {
  const { s, dispatch } = useStore();
  const api = useIntakeRpc();
  const [selected, setSelected] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const { pfd, error } = useApprovedPfd(detail);
  const local = intakeDraftOf(s, detail.id);
  const frozen = useMemo(() => (pfd ? frozenIds(pfd, detail.processes) : new Set<string>()), [pfd, detail.processes]);
  const view = useMemo(
    () =>
      pfd
        ? buildPfdView(pfd, { statuses: processStatuses(detail.processes), comments: commentCounts(local.comments), frozen })
        : null,
    [pfd, detail.processes, local.comments, frozen],
  );
  if (!view || !pfd) {
    return <div className="pad">{heading}<p className="hint">{error ?? "承認された案を読み込み中"}</p></div>;
  }

  const info = selected === null ? null : pfdElement(pfd, selected, detail.question_sets);
  const isFrozen = selected !== null && frozen.has(selected);
  const commentKey = isFrozen ? null : selected;
  const start = async () => {
    setPending(true);
    try {
      const r = await sendDecision(api.revise(detail.id, local.comments), "改訂を始められませんでした");
      if (r.ok) dispatch({ type: "intake.sent", id: detail.id, what: "revise" });
      else dispatch({ type: "toast", message: r.message });
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <div className="pad">
        {heading}
        <StatusCounts view={view} />
        <div className="plan-body">
          <PfdDiagram view={view} selected={selected} onSelect={setSelected} />
          <PfdElementPanel
            pfd={pfd}
            info={info}
            onSelect={setSelected}
            frozen={isFrozen}
            prompt={undefined}
            onOpenPrompt={null}
            comments={commentKey === null ? [] : commentsOn(local.comments, commentKey)}
            previous={[]}
            onAddComment={commentKey === null
              ? null
              : (body) => dispatch({ type: "intake.comment.add", id: detail.id, key: commentKey, body })}
            onDeleteComment={commentKey === null
              ? null
              : (index) => dispatch({ type: "intake.comment.delete", id: detail.id, index })}
          />
        </div>
      </div>
      <ReviseDecide
        count={local.comments.length}
        whole={wholeComment(local.comments)}
        canStart={canRejectIntake(local)}
        pending={pending}
        onWhole={(body) => dispatch({ type: "intake.whole", id: detail.id, body })}
        onStart={() => void start()}
        onLeave={() => dispatch({ type: "intake.revise.leave" })}
      />
    </>
  );
}
```

- [ ] **Step 6: ExecutionView の本体を書く**

`app/src/components/ExecutionView.tsx` に、Task 5 の `DirectProcess` に加えて次を書く（import は下のコードが使うものを足す: `useMemo` / `useState` / `type ReactNode`、`IntakeDetail` / `IntakeSummary`、`DIRECT_PROCESS_ID`（`shared/intake/` の段階 1 の置き場所から）、`sendDecision`、`actionNeeded` / `processStatuses` / `progressOps` / `workspaceOfIntake`、`intakeDetailOf` / `intakeDraftOf` / `intakeRowOf` / `selectedTask` / `type Loaded`、`buildPfdView` / `pfdElement`、`useIntakeRpc` / `useStore`、`ActionNeeded` / `CancelDialog` / `ProgressActions` / `useApprovedPfd` / `WatchAlert`、`IntakeHistory`、`IntakeHeading`、`PfdDiagram`、`PfdElementPanel`、`ReviewView`、`StatusCounts`、`TaskView`）:

```tsx
const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** スロットの下に、選んでいるタスク（s.sel）がこの Intake のものなら、その画面を出す */
function OpenedTask({ intakeId }: { intakeId: string }) {
  const { s } = useStore();
  const t = selectedTask(s);
  if (!t || t.intake?.id !== intakeId) return null;
  return t.state === "suspended" ? <ReviewView key={t.id} t={t} /> : <TaskView key={t.id} t={t} />;
}

/** RPC を送り、成功したときだけ後片付けをする。失敗はトースト */
function useCall() {
  const { dispatch } = useStore();
  const [pending, setPending] = useState<string | null>(null);
  const call = async <T,>(key: string, send: Promise<T>, failed: string, onOk: (value: T) => void) => {
    setPending(key);
    try {
      let value!: T;
      const r = await sendDecision(send.then((v) => {
        value = v;
      }), failed);
      if (r.ok) onOk(value);
      else dispatch({ type: "toast", message: r.message });
    } finally {
      setPending(null);
    }
  };
  return { pending, call };
}

/** Issue 単位の操作。plan と direct の両方が使う */
function Ops({ detail, pending, call }: { detail: IntakeDetail; pending: boolean; call: ReturnType<typeof useCall>["call"] }) {
  const { dispatch } = useStore();
  const api = useIntakeRpc();
  return (
    <ProgressActions
      ops={progressOps(detail)}
      paused={detail.dispatch_paused}
      pending={pending}
      onRefresh={() =>
        void call("*", api.refresh(detail.id), "確認できませんでした", (d) =>
          dispatch({ type: "intake.fresh", id: detail.id, detail: d }))}
      onTogglePause={() => {
        const paused = !detail.dispatch_paused;
        void call("*", api.setDispatchPaused(detail.id, paused), "自動投入を切り替えられませんでした", (intake) =>
          dispatch({ type: "intake.done", intake, toast: paused ? "自動投入を止めました" : "自動投入を再開しました" }));
      }}
      onRevise={() => dispatch({ type: "intake.revise.enter", id: detail.id })}
      onCloseIssue={() =>
        void call("*", api.closeIssue(detail.id), "Issue を閉じられませんでした", (intake) =>
          dispatch({ type: "intake.done", intake, toast: "Issue を閉じました" }))}
    />
  );
}

function PlanBody({ detail, heading }: { detail: IntakeDetail; heading: ReactNode }) {
  const { s, dispatch } = useStore();
  const api = useIntakeRpc();
  const { pending, call } = useCall();
  const [selected, setSelected] = useState<string | null>(null);
  const [prompts, setPrompts] = useState<Record<string, Loaded<string>>>({});
  const { pfd, error } = useApprovedPfd(detail);
  const local = intakeDraftOf(s, detail.id);
  const view = useMemo(
    () => (pfd ? buildPfdView(pfd, { statuses: processStatuses(detail.processes) }) : null),
    [pfd, detail.processes],
  );

  const title = detail.state === "completed" ? <h2 className="plan-title">完了しました</h2> : null;
  if (detail.approval === null) {
    // 承認の前に中止した。図は無いので経緯だけ読み返せる
    return <div className="pad">{heading}{title}<IntakeHistory detail={detail} /></div>;
  }
  if (!view || !pfd) {
    return <div className="pad">{heading}{title}<p className="hint">{error ?? "承認された案を読み込み中"}</p></div>;
  }

  const approval = detail.approval;
  const info = selected === null ? null : pfdElement(pfd, selected, detail.question_sets);
  const processId = info?.kind === "process" ? info.process.id : null;
  const processView = processId === null ? undefined : detail.processes.find((p) => p.id === processId);
  const openTask = (id: string) => dispatch({ type: "task.open", id });
  const openPrompt = () => {
    if (processId === null || prompts[processId]) return;
    setPrompts((m) => ({ ...m, [processId]: { kind: "loading" } }));
    api.processPrompt(detail.id, approval.draft_id, processId).then(
      (value) => setPrompts((m) => ({ ...m, [processId]: { kind: "ok", value } })),
      (e) => setPrompts((m) => ({ ...m, [processId]: { kind: "error", message: errorMessage(e) } })),
    );
  };
  const complete = (id: string) => {
    // 送る値は、後片付けの dispatch が下書きを消す前に読んでおく
    const note = local.notes[id] ?? "";
    void call(id, api.completeHumanProcess(detail.id, id, note), "完了を記録できませんでした", (d) => {
      dispatch({ type: "intake.sent", id: detail.id, what: "complete", processId: id });
      dispatch({ type: "intake.fresh", id: detail.id, detail: d });
    });
  };
  const redispatch = (id: string) =>
    void call(id, api.redispatch(detail.id, id), "再投入できませんでした", (d) => {
      dispatch({ type: "intake.fresh", id: detail.id, detail: d });
      dispatch({ type: "toast", message: "再投入しました" });
    });

  return (
    <div className="pad">
      {heading}
      {title}
      <WatchAlert watch={detail.watch} now={s.now} />
      {detail.state !== "canceled" && (
        <ActionNeeded
          pfd={pfd}
          items={actionNeeded(detail, pfd)}
          notes={local.notes}
          pending={pending}
          onNote={(id, text) => dispatch({ type: "intake.note", id: detail.id, processId: id, text })}
          onComplete={complete}
          onRedispatch={redispatch}
          onOpenTask={openTask}
        />
      )}
      <Ops detail={detail} pending={pending !== null} call={call} />
      <StatusCounts view={view} />
      <PfdDiagram view={view} selected={selected} onSelect={setSelected} />
      <div className="exec-panel-slot">
        <PfdElementPanel
          pfd={pfd}
          info={info}
          onSelect={setSelected}
          extra={processView && <ProcessTrail view={processView} onOpenTask={openTask} />}
          prompt={processId === null ? undefined : prompts[processId]}
          onOpenPrompt={openPrompt}
          comments={[]}
          previous={[]}
          onAddComment={null}
          onDeleteComment={null}
        />
        <OpenedTask intakeId={detail.id} />
      </div>
      <IntakeHistory detail={detail} />
    </div>
  );
}

function DirectBody({ detail, heading }: { detail: IntakeDetail; heading: ReactNode }) {
  const { s, dispatch } = useStore();
  const api = useIntakeRpc();
  const { pending, call } = useCall();
  const view = detail.processes.find((p) => p.id === DIRECT_PROCESS_ID);
  const redispatch = () =>
    void call(DIRECT_PROCESS_ID, api.redispatch(detail.id, DIRECT_PROCESS_ID), "再投入できませんでした", (d) => {
      dispatch({ type: "intake.fresh", id: detail.id, detail: d });
      dispatch({ type: "toast", message: "再投入しました" });
    });
  return (
    <div className="pad">
      {heading}
      {detail.state === "completed" && <h2 className="plan-title">完了しました</h2>}
      <WatchAlert watch={detail.watch} now={s.now} />
      <Ops detail={detail} pending={pending !== null} call={call} />
      <div className="exec-panel-slot">
        <DirectProcess
          title={detail.issue_title}
          view={view}
          pending={pending !== null}
          onRedispatch={redispatch}
          onOpenTask={(id) => dispatch({ type: "task.open", id })}
        />
        <OpenedTask intakeId={detail.id} />
      </div>
    </div>
  );
}

export function ExecutionView() {
  const { s, dispatch } = useStore();
  const api = useIntakeRpc();
  const [canceling, setCanceling] = useState(false);
  if (s.execSel === null) {
    return <div className="pad"><p className="hint">左から Issue を選んでください</p></div>;
  }
  const intake: IntakeSummary | null = intakeRowOf(s, s.execSel);
  const detail = intakeDetailOf(s, s.execSel);
  if (!intake) {
    return <div className="pad"><p className="hint">{detail?.kind === "error" ? detail.message : "読み込み中"}</p></div>;
  }
  const workspace = workspaceOfIntake(intake, s.workspaces);
  if (detail?.kind !== "ok") {
    return (
      <div className="pad">
        <IntakeHeading intake={intake} workspace={workspace} label="Execution" />
        <p className="hint">{detail?.kind === "error" ? detail.message : "読み込み中"}</p>
      </div>
    );
  }
  const d = detail.value;
  const heading = (
    <IntakeHeading
      intake={intake}
      workspace={workspace}
      label="Execution"
      onCancel={() => dispatch({ type: "intake.preview", modal: "intake-cancel" })}
    />
  );
  const cancel = async (mode: "leave" | "stop") => {
    setCanceling(true);
    try {
      let next: IntakeSummary | undefined;
      const r = await sendDecision(api.cancel(intake.id, mode).then((v) => {
        next = v;
      }), "中止できませんでした");
      if (r.ok && next) dispatch({ type: "intake.done", intake: next, toast: "中止しました" });
      else if (!r.ok) dispatch({ type: "toast", message: r.message });
    } finally {
      setCanceling(false);
    }
  };
  return (
    <>
      {d.mode === "direct"
        ? <DirectBody detail={d} heading={heading} />
        : <PlanBody key={d.approval?.draft_id} detail={d} heading={heading} />}
      {s.modal === "intake-cancel" && (
        <CancelDialog
          scope={d.mode === "direct" ? "direct" : d.approval !== null ? "plan" : "none"}
          pending={canceling}
          onSend={cancel}
          onClose={() => dispatch({ type: "modal.close" })}
        />
      )}
    </>
  );
}
```

`app/src/components/ExecutionSidebar.tsx` に足す（import に `countExecutionAttention` は不要。`executionOrder` / `isExecutionAttention`、`workspaceOfIntake`、`useStore`、`RateLimit`、`WorkspaceFilterSelect` を足す）:

```tsx
export function ExecutionSidebar() {
  const { s, dispatch } = useStore();
  const rows = executionOrder(s.intakes, s.tasks, s.workspace, s.execClosed);
  return (
    <aside className="side">
      <div className="side-head">
        <WorkspaceFilterSelect
          workspaces={s.workspaces}
          value={s.workspace}
          allLabel="すべての workspace"
          onChange={(workspace) => dispatch({ type: "workspace", workspace })}
        />
        <span className="count">{rows.length}</span>
      </div>
      <div className="side-head">
        <div className="seg">
          <button aria-pressed={!s.execClosed} onClick={() => dispatch({ type: "execution.closed", closed: false })}>進行中</button>
          <button aria-pressed={s.execClosed} onClick={() => dispatch({ type: "execution.closed", closed: true })}>終了</button>
        </div>
      </div>
      <div className="side-scroll">
        {rows.map((i) => (
          <ExecutionRow
            key={i.id}
            intake={i}
            workspace={workspaceOfIntake(i, s.workspaces)}
            attention={isExecutionAttention(i, s.tasks)}
            selected={s.execSel === i.id}
            now={s.now}
            onSelect={() => dispatch({ type: "execution.select", id: i.id })}
          />
        ))}
        {rows.length === 0 && <p className="hint" style={{ padding: 8 }}>ありません</p>}
      </div>
      <RateLimit />
    </aside>
  );
}
```

- [ ] **Step 7: Sidebar・IntakeView・App・TaskView を繋ぐ**

`app/src/components/Sidebar.tsx`:
- `icons.inbox` / `icons.done` を消し、`icons.execution` を足す:

```tsx
  execution: (
    <svg viewBox="0 0 24 24"><circle cx="6" cy="12" r="3" /><circle cx="18" cy="6" r="3" /><circle cx="18" cy="18" r="3" /><path d="M9 12h3l3-4.5M12 12l3 4.5" /></svg>
  ),
```

- `Rail` の Intake の次の 2 つのボタン（タスク・終了したタスク）を次の 1 つにする（import に `countExecutionAttention` を `../execution` から足す）:

```tsx
      <button
        className="ib"
        title={execAttention > 0 ? `Execution（あなたの番 ${execAttention} 件）` : "Execution"}
        aria-pressed={s.view === "execution"}
        onClick={() => dispatch({ type: "view", view: "execution" })}
      >
        {icons.execution}
        {execAttention > 0 && <span className="pip" />}
      </button>
```

（`Rail` の先頭に `const execAttention = countExecutionAttention(s.intakes, s.tasks);` を足す。Intake のボタンの title の「対応が要るもの」はそのまま）
- `IntakeSidebar` の `rows` を `intakeOrder(s.intakes, s.workspace, s.intakeRevise)` にし、「進行中 / すべて」の `side-head`（`seg`）を消す
- `Item` と、`Sidebar` の末尾のタスクの一覧（`const ts = visibleTasks(...)` から最後の `</aside>` まで）を消し、`Sidebar` を次にする:

```tsx
export function Sidebar() {
  const { s } = useStore();
  if (s.view === "settings") return <SettingsSidebar />;
  if (s.view === "execution") return <ExecutionSidebar />;
  return <IntakeSidebar />;
}
```

（`ExecutionSidebar` は `./ExecutionSidebar` から import する。`ExecutionSidebar.tsx` は `IntakeRow` / `WorkspaceFilterSelect` を `./Sidebar` から import するので循環になるが、どちらも描画のときにしか参照しない関数宣言なので問題ない。`pnpm test` で `Sidebar.test.tsx` と `ExecutionView.test.tsx` が通ることで確かめる）
- 使わなくなった import（`GROUPS` / `countReview` / `groupOf` / `sidebarOrder` / `timeLabel` / `visibleTasks` / `taskIntakeMark` / `groupTone` / `Task`）を消す

`app/src/components/IntakeView.tsx` の `IntakeView`:
- `import { IntakeProgress, CancelDialog } from "./IntakeProgress";` を `import { CancelDialog } from "./IntakeProgress";` にし、`import { ReviseFace } from "./ReviseFace";` と `inIntakeList` / `intakeOrder` の import を足す
- 先頭の `if (s.intakeSel === "new") return <IssuePicker />;` を次にする（spec 4.1: 一覧が空なら Issue の選択を空の状態として出す）:

```tsx
  const empty = intakeOrder(s.intakes, s.workspace, s.intakeRevise).length === 0;
  if (s.intakeSel === "new" || (s.intakeSel === null && empty)) return <IssuePicker />;
```
- `const face = intakeFace(detail.value.state);` の直前に次を足す:

```tsx
  if (s.intakeRevise === intake.id && detail.value.state === "active" && !detail.value.revising) {
    return (
      <>
        <ReviseFace key={detail.value.approval?.draft_id} detail={detail.value} heading={heading} />
        {dialog}
      </>
    );
  }
  if (!inIntakeList(intake, s.intakeRevise)) {
    return (
      <div className="pad">
        {heading}
        <MovedToExecution onOpen={() => dispatch({ type: "intake.open", id: intake.id })} />
      </div>
    );
  }
```

- `if (face === "progress") { ... }` の分岐を消す（上の 2 つで active と終端は先に返る）

`app/src/App.tsx`:
- `import { TaskView } ...` / `import { ReviewView } ...` を消し、`import { ExecutionView } from "./components/ExecutionView";` を足す
- `main` の中身を次にする:

```tsx
          {s.view === "settings" ? <SettingsView /> : s.view === "intake" ? <IntakeView /> : <ExecutionView />}
```

- `const t = selectedTask(s);`（`App` の中）が使われなくなるので消す
- スクロールの effect の依存を `[s.view, s.intakeSel, s.execSel]` にする（スロットでタスクを開いたときに図の位置から飛ばさない）
- `useKeys` の `const t = selectedTask(s);` の前に足す:

```tsx
      if (s.view !== "execution") return;
```

`app/src/components/TaskView.tsx`:
- `IntakeRetryHint` を次にし、2 箇所の呼び出しを `{t.intake && <IntakeRetryHint />}` にする。`openIntake` を消す:

```tsx
/** Intake 由来のタスクのやり直し方の案内 */
export function IntakeRetryHint() {
  return (
    <p className="hint">
      Intake から投入したタスクです。やり直すには、Execution の「操作が必要」かプロセスの欄から「再投入する」を押してください。
    </p>
  );
}
```

`app/src/components/ReviewView.tsx:64` の `intake.open` のリンクはそのまま残す（Execution で同じ Intake を選び直すだけ）。

- [ ] **Step 8: 通ることを確かめる**

Run: `builtin cd /Users/shunsuke.tadokoro/orca/workspaces/doctrine/app_ux/app && pnpm exec tsc && pnpm test`
Expected: PASS。`rg -n '"tasks"|"done"|"worktrees"|showClosedIntakes|intake.showClosed|IntakeProgress\b' app/src` が `IntakeProgress.tsx` / `IntakeProgress.test.tsx` のファイル名以外を出さない（`TaskState` の `"done"` ではなく view の値を探す。`groupOf` の `"done"` は残ってよい）

- [ ] **Step 9: 画面を目で確かめる**

Run: `mise run app:tauri`（dctld が要る）。次を確かめる:
- Rail に Intake と Execution と設定だけがある
- Execution の一覧で「進行中」「終了」を切り替えられ、plan の Intake を選ぶと図が出て、プロセスを選ぶとスロットに欄が出て、タスクを開くとスロットにタスクの画面かレビューの画面が出る
- 「改訂を始める…」で Intake に移り、「やめる」で Execution に戻る

dctld を動かせない環境なら、この Step を飛ばしたことを報告に書く。

- [ ] **Step 10: コミット**

```bash
git add -A app/src
git commit -m "view を Intake / Execution / 設定にし、承認後の Intake を Execution で扱う

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Issue の選択で plan と direct を選ぶ

**Files:**
- Modify: `app/src/store.tsx`（`useIntakeRpc().start`）
- Modify: `app/src/components/IssuePicker.tsx`（`startIntake`、`IssuePreview`、`onOpen`）
- Test: `app/src/IssuePicker.test.tsx`、`app/src/IntakeView.test.tsx`

**Interfaces:**
- Consumes: `"intake.start"` の params の `mode: IntakeMode`（段階 1）、Task 1 の `MODE_WORD` / `inIntakeList`
- Produces: `useIntakeRpc().start(workspacePath: string, issueUrl: string, mode: IntakeMode)`、`startIntake(root: string, issueUrl: string, mode: IntakeMode, deps)`、`IssuePreview` の `onStart: (mode: IntakeMode) => void`

- [ ] **Step 1: 失敗するテストを書く**

`app/src/IssuePicker.test.tsx` の `describe("startIntake", ...)`:
- `setup()` の `start` を `(w: string, u: string, m: IntakeMode) => rpc("intake.start", { workspace: w, issue_url: u, mode: m })` にする（import に `type IntakeMode` を `../../shared/protocol.ts` から足す）
- 先頭のテストを次にする:

```ts
  test("選んだ workspace の root と種類で intake.start を呼ぶ", async () => {
    invoke.mockResolvedValue({ ...INTAKES[0], alreadyActive: false });
    const { actions, deps } = setup();
    await startIntake(pickerWorkspace(WORKSPACES, 2)!.path, "https://github.com/o/r/issues/8", "direct", deps);
    expect(invoke).toHaveBeenCalledWith("rpc", {
      method: "intake.start",
      params: { workspace: "~/work/shop-api", issue_url: "https://github.com/o/r/issues/8", mode: "direct" },
    });
    expect(actions).toEqual([{ type: "intake.started", intake: INTAKES[0] }]);
  });
```

- 残りの `startIntake(...)` の呼び出しに第 3 引数 `"plan"` を足す

`app/src/IntakeView.test.tsx` の `describe("IssuePreview", ...)` の「Intake の無い Issue は開始ボタンを出す」を次にする:

```tsx
  test("Intake の無い Issue は、計画して進めるとすぐ実行するの 2 つのボタンを出し、どちらも主ボタンにしない", () => {
    const html = preview({ target: { kind: "start", url: "https://github.com/o/r/issues/8" } });
    expect(html).toContain("計画して進める");
    expect(html).toContain("複数の PR に分ける");
    expect(html).toContain("すぐ実行する");
    expect(html).toContain("1 本の PR で済ませる");
    expect(html).not.toContain("btn primary");
    expect(html).not.toContain("Intake を開始");
  });
```

（`preview` はこの describe の既存のヘルパーの名前に合わせる。無ければ `renderToStaticMarkup(<IssuePreview ... />)` を直接書く）

- [ ] **Step 2: 失敗を確かめる**

Run: `builtin cd /Users/shunsuke.tadokoro/orca/workspaces/doctrine/app_ux/app && pnpm test IssuePicker.test.tsx IntakeView.test.tsx`
Expected: FAIL（`mode` を送っていない、ボタンが「Intake を開始」のまま）

- [ ] **Step 3: 書く**

`app/src/store.tsx` の `useIntakeRpc().start`:

```ts
    start: (
      workspacePath: string,
      issueUrl: string,
      mode: IntakeMode,
    ): Promise<IntakeSummary & { alreadyActive: boolean }> =>
      rpc("intake.start", { workspace: workspacePath, issue_url: issueUrl, mode }),
```

（段階 1 が既に `mode` を足していれば、その形に合わせて引数だけ確かめる）

`app/src/components/IssuePicker.tsx`:

```ts
/** intake.start を root で呼び、始まった Intake を置く。失敗はトーストに出す */
export async function startIntake(
  root: string,
  issueUrl: string,
  mode: IntakeMode,
  deps: { start: ReturnType<typeof useIntakeRpc>["start"]; dispatch: Dispatch<Action> },
): Promise<void> {
  try {
    const { alreadyActive: _, ...intake } = await deps.start(root, issueUrl, mode);
    deps.dispatch({ type: "intake.started", intake });
  } catch (e) {
    deps.dispatch({ type: "toast", message: `Intake を始められませんでした（${errorMessage(e)}）` });
  }
}
```

`IssuePreview` の props の `onStart: () => void;` を `onStart: (mode: IntakeMode) => void;` にし、`actions` を次にする:

```tsx
      <div className="actions">
        {target.kind === "open"
          ? <button className="btn" onClick={() => onOpen(target.intakeId)}>進行中の Intake を開く</button>
          : (["plan", "direct"] as const).map((mode) => (
            <button key={mode} className="btn" disabled={pending} onClick={() => onStart(mode)}>
              {MODE_WORD[mode].name}
              <span className="hint">（{MODE_WORD[mode].hint}）</span>
            </button>
          ))}
      </div>
```

`IssuePicker` の `<IssuePreview>` の呼び出し:

```tsx
            onOpen={(id) => {
              // 承認済みの Intake は Intake の一覧に無いので、Execution で開く
              const row = s.intakes.find((i) => i.id === id);
              dispatch(row && !inIntakeList(row, s.intakeRevise) ? { type: "intake.open", id } : { type: "intake.select", id });
            }}
            onStart={async (mode) => {
              setPending(true);
              try {
                await startIntake(workspace.path, picked.url, mode, { start: api.start, dispatch });
              } finally {
                setPending(false);
              }
            }}
```

（import に `type IntakeMode`、`MODE_WORD`、`inIntakeList` を足す）

- [ ] **Step 4: 通ることを確かめる**

Run: `builtin cd /Users/shunsuke.tadokoro/orca/workspaces/doctrine/app_ux/app && pnpm exec tsc && pnpm test`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add app/src/store.tsx app/src/components/IssuePicker.tsx app/src/IssuePicker.test.tsx app/src/IntakeView.test.tsx
git commit -m "Issue を取り込むときに計画して進めるかすぐ実行するかを選ぶ

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: ドキュメント

**Files:**
- Modify: `docs/developer-guide/07-app.md`（7.4 の表、7.5 の表）
- Modify: `docs/overview.md:307`
- Modify: `docs/prd/intake.md`（7.1 の表）
- Modify: `site/src/content/docs/ja/quick-start/index.md`（5〜7 章、うまくいかなかったとき）
- Modify: `docs/superpowers/specs/2026-09-27-quick-start-design.md`（冒頭）

- [ ] **Step 1: 07-app.md を直す**

7.4 の冒頭の「本体は `view` と選んでいるタスクの状態で振り分け、`suspended` なら `ReviewView`、それ以外なら `TaskView` を出す。」を次にする:

```markdown
本体は `view`（`intake` / `execution` / `settings`）で振り分ける。Execution の本体（`ExecutionView`）は選んだ Intake の図を出し、
図の下のスロットに、選んだ要素の欄と、開いたタスクの画面（`suspended` なら `ReviewView`、それ以外なら `TaskView`）を出す。
```

表の行を書き換える:
- 「サイドバー（タスク・Intake・worktree・設定）」→「サイドバー（Intake・Execution・設定）」、ファイルに `components/ExecutionSidebar.tsx` を足す
- 「進行中の Intake」の行を「Execution」にし、ファイルを `components/ExecutionView.tsx`、`IntakeProgress.tsx`（部品）、`StatusCounts.tsx` にする。RPC は今のまま
- 「改訂に入る」の行を足す: ファイル `components/ReviseFace.tsx`、RPC `intake.revise`
- 「worktree と警告」の行を消す
- タスク画面の行のファイルに `RemoveWorktree.tsx` を足し、RPC に `worktree.remove` を足す
- 表の下の「`task.create` を除いてどこかの画面が使っている（コンポーザは後続）」を「`task.create` を除いてどこかの画面が使っている（`task.create` はどの画面も使わない）」にする

7.5 の表:
- `intake.ts` の役割の「サイドバーの区分」を「Intake の一覧の絞り込みと区分」にする
- 行を足す: `execution.ts` — Execution の一覧に並ぶか・区切り・人の番・並び
- `worktrees.ts` の行を消す

- [ ] **Step 2: overview.md と PRD を直す**

`docs/overview.md:307` のフロントアプリの説明を次にする:

```markdown
| フロントアプリ  | Intake ビュー（Issue の選択と取り込みの種類・質問と仮定・PFD のレビュー・改訂）、Execution ビュー（Issue の一覧・進み具合の付いた PFD・タスク画面・レビュー画面（diff・経緯の表示・ガイドの表示とガイドに沿った読み方の提示・行コメント・承認／差し戻し））、設定画面（プロジェクト・実行枠・ワークフロー） |
```

`docs/prd/intake.md` の 7.1 の表の V-1・V-3・V-5・V-6・V-7 を次にする（V-2・V-4 はそのまま）:

```markdown
| V-1 | 左端のレールに Intake と Execution の 2 つの入口を持つ。Intake は承認までを、Execution は承認の後を扱う | M |
| V-3 | 人の対応が要るものの有無を、レールの入口ごとに示す。Intake は回答待ち・レビュー待ち・要確認、Execution はタスクの承認待ち・あなたの番・要確認 | M |
| V-5 | Execution は承認済みの PFD をプロセスの状態で塗り分ける（7.7 の状態）。プロセスを選ぶと、その定義、sub-issue、タスク、PR へ辿れ、タスクを選べば同じ画面の中でタスク画面・レビュー画面を開く | M |
| V-6 | タスクの一覧は持たない。タスクは Execution の Intake の中で開く | M |
| V-7 | 完了・中止した Intake は Execution の「終了」に切り替えて見られる | S |
```

- [ ] **Step 3: Quick Start を直す**

`site/src/content/docs/ja/quick-start/index.md`:
- 5 章の手順 3 の「ワークフローを作るタスクはトラッカーを使わないので、後回しで構いません。」を「後回しで構いません。」にする
- 手順 4（ワークフローの方針）を消し、手順 5 を 4 にして「**確認** — 「登録する」を押すと workspace を登録します。」にする
- 手順の後の段落（setup のタスクを作る対象の説明）を次にする:

```markdown
まだ `.doctrine/` が無いプロジェクトには、ワークフローの雛形（`.doctrine/workflows/default.yaml`）を置きます。既に `.doctrine/` があるプロジェクトには触りません。
```

- 6 章「setup のタスクを承認する」と 7 章「承認してコミットする」を次の 6 章に置き換える:

```markdown
## 6. ワークフローを直してコミットする

ウィザードが置いた雛形は、検証コマンドが `"true"` で、PR も開かない一般形です。[ワークフローを書く](/ja/guide/writing-workflows/)を読みながら、`.doctrine/workflows/default.yaml` をリポジトリに合わせて直します。

ウィザードが置いた `.doctrine/project.yaml` なども未コミットなので、リポジトリごとに差分を確かめてまとめてコミットします。

```sh
git add .doctrine
git commit -m "doctrine のワークフローを足す"
```

これで準備は終わりです。Intake で Issue を選び、「計画して進める」か「すぐ実行する」で取り込みます。進み具合とタスクのレビューは Execution で見ます。
```

- 「うまくいかなかったとき」の setup のタスクの段落と箇条書き（「setup のタスクが失敗したり…」から「どちらの場合も、置いたら上と同じくコミットします。」まで）を消す。章に他の内容が残らなければ章ごと消す

`docs/superpowers/specs/2026-09-27-quick-start-design.md` の「- 前提: ...」の行の次に足す:

```markdown
- 後続: [アプリの再構成: Intake と Execution](2026-10-14-intake-execution-design.md) の 8.2 で、setup のタスク（5 章）と方針の聞き取り（4.5）を取り除いた。ウィザードは workspace の登録だけを行う
```

- [ ] **Step 4: 確かめる**

Run: `rg -n "setup のタスク|終了したタスク|worktree と警告|コンポーザ|全タスク" docs/developer-guide docs/overview.md docs/prd site/src/content`
Expected: 何も出ない

- [ ] **Step 5: コミット**

```bash
git add docs/developer-guide/07-app.md docs/overview.md docs/prd/intake.md site/src/content/docs/ja/quick-start/index.md docs/superpowers/specs/2026-09-27-quick-start-design.md
git commit -m "Intake と Execution の画面に合わせてドキュメントを直す

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
