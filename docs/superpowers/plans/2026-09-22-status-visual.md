# 状態の見せ方の統一 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** アプリの状態の見せ方を、ピル・記号アイコン・塗りから、5 つのトーンとバー・ドットに揃える。見出しに mono のラベルを付け、レビュー画面の指示と差し戻しの出し方を変える。

**Architecture:** トーンの対応表は `app/src/tone.ts` に 1 つだけ置く。CSS は `.tone-<name>` が 3 つのカスタムプロパティ（`--tone` / `--tone-soft` / `--tone-text`）を立て、バー・ドット・縦線はそれを読む。文言の表（`STATE_WORD` など）は今の場所に残し、クラスを持たせない。ワークフローの帯は SVG をやめて HTML の flex 列にする。

**Tech Stack:** React 19 + TypeScript（`app/`、vitest + `react-dom/server` の `renderToStaticMarkup`）、Deno（`core/`、`@std/testing/bdd` + `node:assert/strict`）

**Spec:** [`docs/superpowers/specs/2026-09-22-status-visual-design.md`](../specs/2026-09-22-status-visual-design.md)
（UI 案: <https://claude.ai/artifact/M5u918bk667C3KEDxxoyk8> v2）

## Global Constraints

- **doctrine にはまだ利用者がいない。** 名前を変えたら参照を全部書き換える。旧名のエイリアスや移行の仕掛けを作らない
- **コードコメントに一般的な実装原則を書かない。** そのコード固有の事実だけ書く。設計の理由は spec にある
- コメント・画面の文言は日本語。**既存の文言は変えない**（spec 2.1「文言は今の定義から動かさない」）
- 文字の大きさと余白は変えない（本文 13px / 1.5、題名 19px、`.pad` の 18px 22px、サイドバー 288px）
- 色はすべてトークンを通す。新設するトークンは `--idle`（ライト `#D3D9DF` / ダーク `#3A414B`）と `--human-text`（ライト `#8A5A17` / ダーク `#E0A857`）の 2 つだけ
- ダークのトークンは `styles.css` の 2 か所（`@media (prefers-color-scheme: dark)` の中と `:root[data-theme="dark"]`）の両方に足す
- 新しい依存パッケージを足さない
- app の完了条件: `cd app && pnpm test` と `cd app && pnpm build`（`tsc && vite build`）が両方通る
- core に触れるタスクの完了条件: `mise run core:test` と `mise run core:check` が両方通る
- コミットの末尾に `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>` を付ける

## File Structure

| ファイル | 責務 | タスク |
| --- | --- | --- |
| `app/src/styles.css` | トークン・`.tone-*`・`.st`・`.lbl`・各部品の見た目。消すクラスの削除 | 1–7 |
| `app/src/tone.ts`（新規） | `Tone` 型と 6 つの対応表 | 1 |
| `app/src/tone.test.ts`（新規） | 対応表のテスト | 1 |
| `app/src/components/StatusDot.tsx`（新規） | ドット + 文字 | 1 |
| `app/src/components/TaskView.tsx` | `STATE_WORD`、見出し・実行履歴のドット、帯・ログのラベル、「追従中」の削除、`useTaskDetail` の export | 2, 4, 6 |
| `app/src/model.ts` / `model.test.ts` | `RUN_PILL` → `RUN_WORD` | 2 |
| `app/src/intake.ts` | `INTAKE_STATE` → `INTAKE_WORD` | 2 |
| `app/src/components/{WorktreeView,IntakeView,IntakeProgress,IssuePicker}.tsx` | ピルをドットに | 2 |
| `app/src/components/Sidebar.tsx`、`RateLimit.tsx` | 縦バー、ラベル | 2, 3 |
| `shared/protocol.ts`、`core/src/daemon/handlers.ts` | `StepView.branch` の削除 | 4 |
| `app/src/rail.ts` / `rail.test.ts`、`components/WorkflowRail.tsx` | 帯の作り直し | 4 |
| `app/src/pfd.ts` / `pfd.test.ts`、`components/PfdDiagram.tsx` / `PfdDiagram.test.tsx` | `LOOK` の整理、上端のバー、`statusCounts` | 5 |
| `app/src/components/StatusCounts.tsx`（新規） | Intake の状態ごとの件数 | 5 |
| `app/src/components/ReviewView.tsx`、`app/src/ReviewContext.test.tsx`（新規） | 指示・前回のフィードバック・帯・ラベル | 2, 4, 6 |
| `app/src/components/Guide.tsx`、`ReadingFlow.tsx` | 目次・解説・影響・リスクの地 | 7 |
| `docs/superpowers/specs/2026-09-20-workflow-rail-design.md` | 置き換えた規則の書き換え | 8 |

---

### Task 1: トークン・トーンの対応表・StatusDot

**Files:**
- Create: `app/src/tone.ts`
- Create: `app/src/tone.test.ts`
- Create: `app/src/components/StatusDot.tsx`
- Modify: `app/src/styles.css`（トークン 3 か所と、末尾に新しいクラス）
- Modify: `docs/superpowers/specs/2026-09-22-status-visual-design.md`（2.1 の 1 文）

**Interfaces:**
- Produces:
  - `type Tone = "ok" | "run" | "danger" | "human" | "idle"`
  - `TASK_TONE: Record<TaskState, Tone>`（`TaskState` は `app/src/types.ts`）
  - `RUN_TONE: Record<RailStatus, Tone>`（`StepRun["status"] | "pending"`。`RailStatus` は `app/src/rail.ts` から import）
  - `INTAKE_TONE: Record<IntakeState, Tone>`（`shared/intake/state.ts`）
  - `PROCESS_TONE: Record<PfdLook, { tone: Tone; dashed: boolean }>`（`PfdLook` は `app/src/pfd.ts`）
  - `groupTone(g: Group, t: Task): Tone`（`Group` は `app/src/model.ts`）
  - `sectionTone(s: IntakeSection, i: IntakeSummary): Tone`（`IntakeSection` は `app/src/intake.ts`）
  - `toneClass(tone: Tone): string` → `"tone-ok"` など
  - `<StatusDot tone={Tone} word={string} />`（`components/StatusDot.tsx`）
  - CSS: `.tone-*`（`--tone` / `--tone-soft` / `--tone-text` を立てる）、`.st`、`.lbl`、`.lbl.human`

- [ ] **Step 1: spec 2.1 の 1 文を、この計画の形に合わせて直す**

`docs/superpowers/specs/2026-09-22-status-visual-design.md` の 2.1 の最初の箇条書きを置き換える。

変更前:
```markdown
- `STATE_PILL`（TaskView.tsx）、`RUN_PILL`（model.ts）、`INTAKE_STATE`（intake.ts）は、
  `[文言, pillクラス]` から `[文言, Tone]` に変える。`LOOK`（pfd.ts）は `cls` を `tone` と
  `dashed` に置き換える。
```

変更後:
```markdown
- トーンは `tone.ts` の表にだけ持つ。`STATE_PILL`（TaskView.tsx）、`RUN_PILL`（model.ts）、
  `INTAKE_STATE`（intake.ts）は文言だけの表 `STATE_WORD` / `RUN_WORD` / `INTAKE_WORD` に
  改名する。`LOOK`（pfd.ts）は `mark` と `cls` を消し、`word` だけを持つ。
```

- [ ] **Step 2: 失敗するテストを書く**

`app/src/tone.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { seedTasks } from "./fixtures";
import { groupOf } from "./model";
import { INTAKE_TONE, PROCESS_TONE, RUN_TONE, TASK_TONE, groupTone, sectionTone, toneClass } from "./tone";
import type { IntakeSummary } from "../../shared/protocol.ts";
import type { Task } from "./types";

const task = (o: Partial<Task>): Task => ({ ...seedTasks()[0], ...o });

describe("トーンの対応表", () => {
  test("中断は失敗と別のトーンになる", () => {
    expect(RUN_TONE.interrupted).toBe("idle");
    expect(RUN_TONE.failed).toBe("danger");
  });

  test("差し戻しは danger、人を待つ実行は human、まだの実行は idle", () => {
    expect(RUN_TONE.bounced).toBe("danger");
    expect(RUN_TONE.awaiting).toBe("human");
    expect(RUN_TONE.pending).toBe("idle");
    expect(RUN_TONE.success).toBe("ok");
  });

  test("タスクの状態", () => {
    expect(TASK_TONE.suspended).toBe("human");
    expect(TASK_TONE.running).toBe("run");
    expect(TASK_TONE.failed).toBe("danger");
    expect(TASK_TONE.unknown).toBe("danger");
    expect(TASK_TONE.completed).toBe("ok");
    for (const s of ["queued", "paused", "rate_limited", "canceled"] as const) expect(TASK_TONE[s]).toBe("idle");
  });

  test("Intake の状態。進行中は run", () => {
    expect(INTAKE_TONE.active).toBe("run");
    expect(INTAKE_TONE.answering).toBe("human");
    expect(INTAKE_TONE.reviewing).toBe("human");
    expect(INTAKE_TONE.needs_attention).toBe("danger");
    expect(INTAKE_TONE.canceled).toBe("idle");
  });

  test("プロセスの状態。PR レビュー中は human、入力待ちと着手可能は破線", () => {
    expect(PROCESS_TONE.pr_open).toEqual({ tone: "human", dashed: false });
    expect(PROCESS_TONE.your_turn).toEqual({ tone: "human", dashed: false });
    expect(PROCESS_TONE.waiting).toEqual({ tone: "idle", dashed: true });
    expect(PROCESS_TONE.ready).toEqual({ tone: "run", dashed: true });
    expect(PROCESS_TONE.merged.tone).toBe("ok");
    expect(PROCESS_TONE.done.tone).toBe("ok");
    expect(PROCESS_TONE.needs_attention.tone).toBe("danger");
  });

  test("サイドバーは状態ではなく区分から引く。削除を拒否した completed は要確認で danger", () => {
    const refused = task({ state: "completed", refused: true, worktree: "/w" });
    expect(groupOf(refused)).toBe("check");
    expect(groupTone(groupOf(refused), refused)).toBe("danger");
    const done = task({ state: "completed", refused: false, worktree: null });
    expect(groupTone(groupOf(done), done)).toBe("ok");
    const canceled = task({ state: "canceled", refused: false, worktree: null });
    expect(groupTone(groupOf(canceled), canceled)).toBe("idle");
  });

  test("Intake の区分", () => {
    const i = (o: Partial<IntakeSummary>) => ({ state: "active", ...o }) as IntakeSummary;
    expect(sectionTone("attention", i({ state: "needs_attention" }))).toBe("danger");
    expect(sectionTone("attention", i({ state: "reviewing" }))).toBe("human");
    expect(sectionTone("working", i({ state: "investigating" }))).toBe("run");
    expect(sectionTone("active", i({ state: "active" }))).toBe("idle");
    expect(sectionTone("closed", i({ state: "completed" }))).toBe("ok");
    expect(sectionTone("closed", i({ state: "canceled" }))).toBe("idle");
  });

  test("クラス名", () => {
    expect(toneClass("human")).toBe("tone-human");
  });
});
```

`app/src/components/StatusDot.test.tsx`:

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { StatusDot } from "./StatusDot";

test("トーンのクラスと文言を出す", () => {
  const html = renderToStaticMarkup(<StatusDot tone="run" word="実行中" />);
  expect(html).toBe('<span class="st tone-run"><i aria-hidden="true"></i>実行中</span>');
});
```

- [ ] **Step 3: テストが落ちることを確かめる**

Run: `cd app && pnpm vitest run src/tone.test.ts src/components/StatusDot.test.tsx`
Expected: FAIL（`./tone` と `./StatusDot` が無い）

- [ ] **Step 4: `tone.ts` を書く**

`app/src/tone.ts`:

```ts
// 状態の色（トーン）の対応表。画面の状態の色はここからだけ引く（spec 2 章）
import type { IntakeState } from "../../shared/intake/state.ts";
import type { IntakeSummary } from "../../shared/protocol.ts";
import type { IntakeSection } from "./intake";
import type { Group } from "./model";
import type { PfdLook } from "./pfd";
import type { RailStatus } from "./rail";
import type { Task, TaskState } from "./types";

export type Tone = "ok" | "run" | "danger" | "human" | "idle";

export const toneClass = (tone: Tone) => `tone-${tone}`;

export const TASK_TONE: Record<TaskState, Tone> = {
  suspended: "human",
  running: "run",
  queued: "idle",
  paused: "idle",
  rate_limited: "idle",
  failed: "danger",
  completed: "ok",
  canceled: "idle",
  unknown: "danger",
};

/** interrupted はデーモンの再起動で閉じた実行で、ステップの失敗ではないので idle */
export const RUN_TONE: Record<RailStatus, Tone> = {
  running: "run",
  awaiting: "human",
  success: "ok",
  failed: "danger",
  bounced: "danger",
  interrupted: "idle",
  rate_limited: "idle",
  pending: "idle",
};

export const INTAKE_TONE: Record<IntakeState, Tone> = {
  investigating: "run",
  decomposing: "run",
  answering: "human",
  reviewing: "human",
  needs_attention: "danger",
  active: "run",
  completed: "ok",
  canceled: "idle",
};

/** pr_open はマージを人が決めるので human */
export const PROCESS_TONE: Record<PfdLook, { tone: Tone; dashed: boolean }> = {
  waiting: { tone: "idle", dashed: true },
  ready: { tone: "run", dashed: true },
  running: { tone: "run", dashed: false },
  pr_open: { tone: "human", dashed: false },
  merged: { tone: "ok", dashed: false },
  your_turn: { tone: "human", dashed: false },
  done: { tone: "ok", dashed: false },
  needs_attention: { tone: "danger", dashed: false },
};

/** 要確認の区分には削除を拒否した completed も入るので、状態ではなく区分から引く */
export function groupTone(g: Group, t: Task): Tone {
  switch (g) {
    case "review": return "human";
    case "check": return "danger";
    case "running": return "run";
    case "limited":
    case "queued":
    case "paused": return "idle";
    case "done": return t.state === "completed" ? "ok" : "idle";
  }
}

export function sectionTone(s: IntakeSection, i: IntakeSummary): Tone {
  switch (s) {
    case "attention": return i.state === "needs_attention" ? "danger" : "human";
    case "working": return "run";
    case "active": return "idle";
    case "closed": return i.state === "completed" ? "ok" : "idle";
  }
}
```

注意: `groupOf` はこのタスクの時点の `model.ts` にそのままある。`sectionTone("active")` が idle なのは spec 2.1 の表の最終行のとおり（サイドバーの区分としての「進行中」。Intake の状態としての active は `INTAKE_TONE` で run）。

- [ ] **Step 5: `StatusDot.tsx` を書く**

`app/src/components/StatusDot.tsx`:

```tsx
import { toneClass, type Tone } from "../tone";

/** 状態の色のドットと文言（spec 3.2）。ピルの代わり */
export function StatusDot({ tone, word }: { tone: Tone; word: string }) {
  return <span className={`st ${toneClass(tone)}`}><i aria-hidden="true" />{word}</span>;
}
```

- [ ] **Step 6: トークンとクラスを足す**

`app/src/styles.css` の `:root{...}`（2–14 行）に、`--ok:#296B49; --ok-bg:#DEEFE4;` の行の後へ 1 行足す:

```css
  --idle:#D3D9DF; --human-text:#8A5A17;
```

ダークの 2 か所（`@media (prefers-color-scheme: dark){ :root:not([data-theme="light"]){...} }` と `:root[data-theme="dark"]{...}`）のそれぞれで、`--ok:#7FCB9E; --ok-bg:#16301F;` の行の後へ 1 行足す:

```css
  --idle:#3A414B; --human-text:#E0A857;
```

ファイルの末尾に足す:

```css
/* 状態のトーン（spec 2 章）。バー・ドット・縦線は --tone を読む */
.tone-ok{--tone:var(--ok);--tone-soft:var(--ok-bg);--tone-text:var(--ok)}
.tone-run{--tone:var(--run);--tone-soft:var(--run-bg);--tone-text:var(--run)}
.tone-danger{--tone:var(--danger);--tone-soft:var(--danger-bg);--tone-text:var(--danger)}
.tone-human{--tone:var(--accent);--tone-soft:var(--accent-soft);--tone-text:var(--human-text)}
.tone-idle{--tone:var(--idle);--tone-soft:var(--surface-2);--tone-text:var(--ink-3)}
.st{display:inline-flex;align-items:center;gap:7px;font-weight:500;color:var(--tone-text);white-space:nowrap}
.st > i{width:7px;height:7px;border-radius:50%;background:var(--tone);box-shadow:0 0 0 3px var(--tone-soft);flex:none}
.lbl{font-family:var(--mono);font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-3);font-weight:500}
.lbl.human{color:var(--human-text)}
```

- [ ] **Step 7: テストが通ることを確かめる**

Run: `cd app && pnpm vitest run src/tone.test.ts src/components/StatusDot.test.tsx`
Expected: PASS

Run: `cd app && pnpm build`
Expected: 成功（`tone.ts` は `rail.ts` / `pfd.ts` / `intake.ts` / `model.ts` から型だけを import する）

- [ ] **Step 8: コミット**

```bash
git add app/src/tone.ts app/src/tone.test.ts app/src/components/StatusDot.tsx app/src/components/StatusDot.test.tsx app/src/styles.css docs/superpowers/specs/2026-09-22-status-visual-design.md
git commit -m "状態のトーンの対応表と StatusDot を足す

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: ピルを StatusDot に置き換える

**Files:**
- Modify: `app/src/components/TaskView.tsx:26-36`（`STATE_PILL`）、`:189-200`（見出し）、`:328-350`（実行履歴）
- Modify: `app/src/model.ts:233-242`（`RUN_PILL`）
- Modify: `app/src/model.test.ts:1300-1305`
- Modify: `app/src/intake.ts:91-100`（`INTAKE_STATE`）
- Modify: `app/src/components/WorktreeView.tsx:8,43,52,54`
- Modify: `app/src/components/IntakeView.tsx:38-45,52-57`
- Modify: `app/src/components/IntakeProgress.tsx:52-53,78-79`
- Modify: `app/src/components/IssuePicker.tsx:74`
- Modify: `app/src/components/ReviewView.tsx:288-291`
- Modify: `app/src/components/Sidebar.tsx:109-130`（`IntakeItem`）
- Modify: `app/src/styles.css`（`.pill` `.p-*` `.runtable button.pill` を消す）

**Interfaces:**
- Consumes: `StatusDot`、`TASK_TONE`、`RUN_TONE`、`INTAKE_TONE`（Task 1）
- Produces:
  - `STATE_WORD: Record<TaskState, string>`（TaskView.tsx から export。WorktreeView が使う）
  - `RUN_WORD: Record<StepRun["status"], string>`（model.ts）
  - `INTAKE_WORD: Record<IntakeState, string>`（intake.ts）

- [ ] **Step 1: model.test.ts を新しい名前で書き換える（落ちる）**

`app/src/model.test.ts:1300-1305` を置き換える:

```ts
  test("中断（interrupted）の実行は失敗と別の表示になる", () => {
    expect(RUN_WORD.interrupted).toBe("中断");
    expect(RUN_WORD.failed).toBe("失敗");
    expect(RUN_TONE.interrupted).not.toBe(RUN_TONE.failed);
  });
```

同じファイルの import で `RUN_PILL` を `RUN_WORD` に替え、`import { RUN_TONE } from "./tone";` を足す。

Run: `cd app && pnpm vitest run src/model.test.ts`
Expected: FAIL（`RUN_WORD` が無い）

- [ ] **Step 2: 文言の表を改名する**

`app/src/model.ts:233-242`:

```ts
/** 実行履歴の状態の表示名。interrupted は人やデーモンの停止で外から閉じた実行で、失敗ではない */
export const RUN_WORD: Record<StepRun["status"], string> = {
  running: "実行中",
  awaiting: "レビュー待ち",
  success: "成功",
  failed: "失敗",
  interrupted: "中断",
  bounced: "差し戻し",
  rate_limited: "上限待ち",
};
```

`app/src/components/TaskView.tsx:26-36`:

```ts
export const STATE_WORD: Record<TaskState, string> = {
  suspended: "レビュー待ち",
  running: "実行中",
  queued: "待ち",
  paused: "一時停止",
  rate_limited: "上限待ち",
  failed: "失敗",
  completed: "完了",
  canceled: "中止",
  unknown: "不明な状態",
};
```

`app/src/intake.ts:91-100`:

```ts
export const INTAKE_WORD: Record<IntakeState, string> = {
  investigating: "調査中",
  decomposing: "分解中",
  answering: "回答待ち",
  reviewing: "レビュー待ち",
  needs_attention: "要確認",
  active: "進行中",
  completed: "完了",
  canceled: "中止",
};
```

- [ ] **Step 3: 使っている場所を書き換える**

TaskView.tsx の見出し（`const [stateName, stateCls] = STATE_PILL[t.state];` と `<span className={`pill ${stateCls}`}>{stateName}</span>`）:

```tsx
        <StatusDot tone={TASK_TONE[t.state]} word={STATE_WORD[t.state]} />
```

（`const [stateName, stateCls] = ...` の行は消す。import に `StatusDot` と `TASK_TONE`、`RUN_TONE` を足し、`RUN_PILL` を `RUN_WORD` に替える）

TaskView.tsx の実行履歴の状態のセル:

```tsx
                        <td>
                          {denials
                            ? (
                              <button
                                className="st-btn"
                                aria-expanded={open}
                                title="拒否された操作を見る"
                                onClick={() => setOpenDenials(open ? null : r.id)}
                              >
                                <StatusDot tone={RUN_TONE[r.status]} word={RUN_WORD[r.status]} />
                              </button>
                            )
                            : <StatusDot tone={RUN_TONE[r.status]} word={RUN_WORD[r.status]} />}
                        </td>
```

（`const [name, cls] = RUN_PILL[r.status];` の行は消す）

WorktreeView.tsx（import を `STATE_WORD` に替え、`StatusDot` と `TASK_TONE` を import）:

```tsx
                  {task.title}
                  {" "}
                  <StatusDot tone={TASK_TONE[task.state]} word={STATE_WORD[task.state]} />
```

```tsx
      <td>{e.dirty && <StatusDot tone="human" word="未コミットの変更あり" />}</td>
      <td>
        {stale && <StatusDot tone="human" word="古い" />}
        {" "}
        {ago(Date.parse(e.age_basis), p.now)}
      </td>
```

IntakeView.tsx の見出し（`state` は `INTAKE_STATE[intake.state]` だった変数。消す）:

```tsx
        <StatusDot tone={INTAKE_TONE[intake.state]} word={INTAKE_WORD[intake.state]} />
```

IntakeView.tsx の `IntakeFacePlaceholder`:

```tsx
      {INTAKE_WORD[intake.state]}
```

IntakeProgress.tsx の ActionNeeded:

```tsx
              <StatusDot tone="human" word="あなたの番" />
```

```tsx
            <StatusDot tone="danger" word={statusText(view)} />
```

IssuePicker.tsx:74:

```tsx
          {issueTarget(i.url, intakes).kind === "open" ? <StatusDot tone="idle" word="Intake あり" /> : <span />}
```

ReviewView.tsx:288-291（見出しの 2 つのピル）:

```tsx
          <StatusDot tone="human" word="レビュー待ち" />
          {t.step && <span>ステップ <span className="mono">{t.step}</span></span>}
          {c && reviewRound(c) > 1 && <span>{reviewRound(c)} 回目のレビュー</span>}
```

Sidebar.tsx の `IntakeItem` のピル（`state` 変数を消し、ピルの行を文言にする）:

```tsx
        <span>{INTAKE_WORD[i.state]}</span>
```

`INTAKE_STATE` を import していた場所（Sidebar.tsx、IntakeView.tsx）は `INTAKE_WORD` に替える。

- [ ] **Step 4: ピルの CSS を消し、ボタンの中のドットの CSS を足す**

`app/src/styles.css` から次の行を消す:

```css
.pill{font-size:11px;font-weight:500;padding:0 7px;border-radius:4px;line-height:19px;white-space:nowrap;display:inline-flex;gap:5px;align-items:center}
.p-attn{background:var(--accent-soft);color:var(--accent-text)}
.p-danger{background:var(--danger-bg);color:var(--danger)}
.p-run{background:var(--run-bg);color:var(--run)}
.p-muted{background:var(--surface-2);color:var(--ink-2)}
.p-ok{background:var(--ok-bg);color:var(--ok)}
```

```css
.runtable button.pill{border:0;font:inherit;cursor:pointer}
```

末尾の `.lbl.human{...}` の後に足す:

```css
.st-btn{border:0;background:transparent;padding:0;font:inherit;cursor:pointer;text-decoration:underline dotted;text-underline-offset:3px}
```

- [ ] **Step 5: 残りが無いことを確かめる**

Run: `grep -rnE "pill|p-(attn|run|muted|ok|danger)|RUN_PILL|STATE_PILL|INTAKE_STATE" app/src`
Expected: 出力なし

- [ ] **Step 6: テストとビルド**

Run: `cd app && pnpm test && pnpm build`
Expected: PASS。文言に依存する既存のテスト（`WorktreeView.test.tsx` の「失敗」「未コミットの変更あり」、`IntakeProgress.test.tsx` の「あなたの番」「要確認（タスクが止まった）」、`IntakeView.test.tsx` の「レビュー待ち」）は文言が同じなので通る

- [ ] **Step 7: コミット**

```bash
git add -A app/src
git commit -m "状態のピルを StatusDot に置き換える

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: サイドバーの縦バーと mono のラベル

**Files:**
- Modify: `app/src/components/Sidebar.tsx:66-130, 176-181, 219-226`
- Modify: `app/src/components/RateLimit.tsx:15`
- Modify: `app/src/styles.css:86-108`

**Interfaces:**
- Consumes: `groupTone`、`sectionTone`、`toneClass`（Task 1）

- [ ] **Step 1: StateIcon と IntakeIcon を消し、行にトーンのクラスを付ける**

`Sidebar.tsx` の `StateIcon`（`export function StateIcon ...` の関数全体）と `IntakeIcon` を消す。

`Item`:

```tsx
function Item({ t }: { t: Task }) {
  const { s, dispatch } = useStore();
  const p = s.projects.find((x) => x.id === t.project);
  return (
    <button
      className={`it ${toneClass(groupTone(groupOf(t), t))}`}
      aria-current={s.sel === t.id}
      onClick={() => dispatch({ type: "select", id: t.id })}
    >
      <span className="t">{t.title}</span>
      <span className="m">
        <span className="pj">
          <span className="pjdot" style={{ background: p?.color ?? "#666" }} />
          {p?.id ?? t.project}
        </span>
        {t.intake && <span className="tag">{taskIntakeMark(t.intake)}</span>}
        <span className="tm">{timeLabel(t, s.now)}</span>
      </span>
    </button>
  );
}
```

`IntakeItem` の `<button className="it" ...>` を `className={`it ${toneClass(sectionTone(intakeSection(i), i))}`}` にし、`<span className="ico"><IntakeIcon i={i} /></span>` の行を消す。

import に `import { groupTone, sectionTone, toneClass } from "../tone";` を足す。

- [ ] **Step 2: グループの見出しを mono のラベルにする**

`Sidebar.tsx` の 2 か所の `<h3>{sec.name} <span className="count">{list.length}</span></h3>` と `<h3>{g.name} <span className="count">{list.length}</span></h3>` を、それぞれ次にする:

```tsx
              <h3><span className="lbl">{sec.name}</span> <span className="count">{list.length}</span></h3>
```

```tsx
                <h3><span className="lbl">{g.name}</span> <span className="count">{list.length}</span></h3>
```

`RateLimit.tsx:15`:

```tsx
            <span className="limit-name lbl">{v.label}</span>
```

- [ ] **Step 3: CSS を書き換える**

`styles.css` の `.it` と `.it .ico` を書き換え、記号アイコンのクラスを消す。

変更前（該当行）:

```css
.it{width:100%;border:0;background:transparent;border-radius:6px;padding:6px 8px 6px 6px;display:grid;grid-template-columns:18px minmax(0,1fr);gap:2px 6px;text-align:left}
.it .ico{grid-row:span 2;display:grid;place-items:center;height:20px}
.diamond{...}
.bang{...}
.spin{...}
.ring{...}
.pause{...}
/* 上限待ち: 実行中（回る点線）でも一時停止（人が止めた）でもない、止まって待っている印 */
.hourglass{...}
.check{...}
.xmark{...}
@keyframes spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.spin{animation:none}}
```

変更後:

```css
.it{position:relative;width:100%;border:0;background:transparent;border-radius:6px;padding:6px 8px 6px 16px;display:grid;grid-template-columns:minmax(0,1fr);gap:1px;text-align:left}
.it::before{content:"";position:absolute;left:6px;top:8px;bottom:8px;width:3px;border-radius:2px;background:var(--tone,var(--idle))}
```

`.grp h3` はそのまま残す（中の `.lbl` が見た目を決める）。`.spin` は Task 4 で TaskView からも消えるので、ここで消してよい（Task 4 までの間、TaskView の「追従中」のアイコンは形が無くなる。Task 4 でその行ごと消す）。

- [ ] **Step 4: 残りが無いことを確かめる**

Run: `grep -rnE "StateIcon|IntakeIcon|\\.ico\\b|diamond|hourglass|\\bbang\\b|xmark" app/src`
Expected: 出力なし

- [ ] **Step 5: テストとビルド**

Run: `cd app && pnpm test && pnpm build`
Expected: PASS

- [ ] **Step 6: 目で確かめる**

Run: `mise run app:tauri`
確かめること: タスクと Intake のサイドバーで、レビュー待ち = アンバー、要確認 = 赤、実行中 = 青、待ち・一時停止・上限待ち = 灰の縦バーになっている。グループ見出しと「5時間枠」「7日枠」が mono の小さなラベルになっている。

- [ ] **Step 7: コミット**

```bash
git add app/src/components/Sidebar.tsx app/src/components/RateLimit.tsx app/src/styles.css
git commit -m "サイドバーの状態を行の縦バーにする

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: ワークフローの帯を作り直す

**Files:**
- Modify: `shared/protocol.ts:140-145`（`StepView`）
- Modify: `core/src/daemon/handlers.ts:3,132-141`（`toStepViews`）
- Modify: `app/src/rail.ts`（全体を書き換え）
- Modify: `app/src/rail.test.ts`（全体を書き換え）
- Modify: `app/src/components/WorkflowRail.tsx`（全体を書き換え）
- Modify: `app/src/components/TaskView.tsx:283-297`（帯・ログの見出し）、`:320-321`（実行履歴）
- Modify: `app/src/components/ReviewView.tsx:48-66`（`Crumbs`）
- Modify: `app/src/styles.css`（`.wr-*` を消し、`.wf-*` を足す）

**Interfaces:**
- Consumes: `RUN_TONE`、`toneClass`（Task 1）
- Produces:
  - `type RailNode = { id: string; type: StepView["type"] | null; title?: string; status: RailStatus; current: boolean; unknown: boolean }`
  - `buildRail(steps, stepRuns, task): RailNode[] | null`
  - `<WorkflowRail detail={TaskDetail} legend={boolean} />`
  - `<Crumbs t={Task} kind={"Task" | "Review"} />`
  - `StepView` から `branch` が無くなる

- [ ] **Step 1: rail.test.ts を書き換える（落ちる）**

`app/src/rail.test.ts` を全体で置き換える:

```ts
import { describe, expect, it } from "vitest";
import type { StepRun, StepView } from "../../shared/protocol.ts";
import { buildRail } from "./rail";

// .doctrine/workflows/default.yaml と同じ並び。app から core / YAML を読まないので、ここに手書きする。
const cmd = (id: string): StepView => ({ id, type: "command" });
const agent = (id: string): StepView => ({ id, type: "agent" });
const DEFAULT_STEPS: StepView[] = [
  cmd("setup"),
  agent("plan"),
  agent("plan-review"),
  cmd("plan-gate"),
  agent("implement"),
  cmd("verify"),
  agent("agent-review"),
  cmd("review-gate"),
  { id: "review", type: "approval", title: "レビュー" },
];

const stepRun = (o: Partial<StepRun> = {}): StepRun => ({
  id: 1,
  step_id: "implement",
  attempt: 1,
  status: "success",
  exit_code: 0,
  started_at: "2026-09-18T00:00:00.000Z",
  ended_at: "2026-09-18T00:01:00.000Z",
  permission_denials: null,
  ...o,
});

const at = (current: string | null) => ({ current_step_id: current });

const nodeOf = (nodes: NonNullable<ReturnType<typeof buildRail>>, id: string) => nodes.find((n) => n.id === id)!;

describe("ノードの状態", () => {
  it("status はその step_id の最後の run から取る", () => {
    const nodes = buildRail(DEFAULT_STEPS, [
      stepRun({ id: 1, step_id: "implement", attempt: 1, status: "bounced" }),
      stepRun({ id: 2, step_id: "implement", attempt: 2, status: "success" }),
    ], at("verify"))!;
    expect(nodeOf(nodes, "implement").status).toBe("success");
  });

  it("差し戻された直後のステップは bounced", () => {
    const nodes = buildRail(DEFAULT_STEPS, [
      stepRun({ id: 1, step_id: "verify", status: "bounced" }),
    ], at("implement"))!;
    expect(nodeOf(nodes, "verify").status).toBe("bounced");
  });

  it("run が 1 件も無いステップは pending", () => {
    const nodes = buildRail(DEFAULT_STEPS, [stepRun({ id: 1, step_id: "plan" })], at("plan-review"))!;
    expect(nodeOf(nodes, "agent-review").status).toBe("pending");
    expect(nodeOf(nodes, "review").status).toBe("pending");
  });

  it("現在のステップだけに current が立つ", () => {
    const nodes = buildRail(DEFAULT_STEPS, [], at("implement"))!;
    expect(nodes.filter((n) => n.current).map((n) => n.id)).toEqual(["implement"]);
  });

  it("type と approval の title を引き継ぐ", () => {
    const nodes = buildRail(DEFAULT_STEPS, [], at(null))!;
    expect(nodeOf(nodes, "review")).toMatchObject({ type: "approval", title: "レビュー", unknown: false });
    expect(nodeOf(nodes, "plan")).toMatchObject({ type: "agent", unknown: false });
    expect(nodeOf(nodes, "plan").title).toBeUndefined();
  });

  it("steps の並びのまま返す", () => {
    const nodes = buildRail(DEFAULT_STEPS, [], at(null))!;
    expect(nodes.map((n) => n.id)).toEqual(DEFAULT_STEPS.map((s) => s.id));
  });
});

describe("steps に無い step_id", () => {
  it("run の step_id が steps に無ければ、末尾の unknown ノードになる", () => {
    const nodes = buildRail(DEFAULT_STEPS, [stepRun({ id: 1, step_id: "gone", status: "failed" })], at("plan"))!;
    expect(nodes).toHaveLength(10);
    expect(nodes[9]).toMatchObject({ id: "gone", unknown: true, type: null, status: "failed" });
  });

  it("current_step_id が steps に無ければ、末尾の unknown ノードになる", () => {
    const nodes = buildRail(DEFAULT_STEPS, [], at("vanished"))!;
    expect(nodes[9]).toMatchObject({ id: "vanished", unknown: true, current: true, status: "pending" });
  });

  it("同じ step_id は重複させず、出てきた順に並べる", () => {
    const nodes = buildRail(DEFAULT_STEPS, [
      stepRun({ id: 1, step_id: "gone-a" }),
      stepRun({ id: 2, step_id: "gone-b" }),
      stepRun({ id: 3, step_id: "gone-a", attempt: 2 }),
    ], at("gone-b"))!;
    expect(nodes.slice(9).map((n) => n.id)).toEqual(["gone-a", "gone-b"]);
    expect(nodeOf(nodes, "gone-b").current).toBe(true);
  });
});

describe("steps が null", () => {
  it("帯を描かない", () => {
    expect(buildRail(null, [stepRun({ step_id: "plan" })], at("plan"))).toBeNull();
  });
});
```

Run: `cd app && pnpm vitest run src/rail.test.ts`
Expected: FAIL（`buildRail` がまだ `{ nodes, arcs, ... }` を返すので `nodes.find` が無い、`StepView` に `branch` が要らない型の不一致は tsc だけが言う）

- [ ] **Step 2: `StepView.branch` を消す**

`shared/protocol.ts:140-145`:

```ts
export type StepView = {
  id: string;
  type: "command" | "agent" | "approval" | "guide";
  title?: string;
};
```

`core/src/daemon/handlers.ts` の `toStepViews`:

```ts
/** 帯が描く分だけを残す。title は approval だけが持つ。 */
function toStepViews(workflow: Workflow): StepView[] {
  return workflow.steps.map((step) => {
    const view: StepView = { id: step.id, type: step.type };
    if (step.type === "approval") view.title = step.title;
    return view;
  });
}
```

同じファイルの 3 行目の import から `branchOf` を外す（`import { type Workflow } from "../workflow/schema.ts";`）。`branchOf` をこのファイルの他の場所で使っていないことを `grep -n branchOf core/src/daemon/handlers.ts` で確かめる（出力なしになること）。

Run: `mise run core:check && mise run core:test`
Expected: PASS（core のテストに `branch` を期待するアサーションは無い。`handlers.test.ts:1992-2015` は id / type / title だけを見ている）

- [ ] **Step 3: `rail.ts` を書き換える**

`app/src/rail.ts` を全体で置き換える:

```ts
// task.get の steps / stepRuns / current_step_id を、ワークフローの帯が描くノードの列にする。
// 副作用を持たない（テストは rail.test.ts）
import type { StepRun, StepView, TaskSummary } from "../../shared/protocol.ts";

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
  stepRuns: StepRun[],
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
  const lastOf = new Map<string, StepRun>();
  for (const r of stepRuns) lastOf.set(r.step_id, r);

  return [
    ...steps.map((s) => ({ id: s.id, type: s.type, title: s.title, unknown: false })),
    ...extra.map((id) => ({ id, type: null, title: undefined, unknown: true })),
  ].map(({ title, ...n }) => ({
    ...n,
    ...(title !== undefined && { title }),
    status: lastOf.get(n.id)?.status ?? "pending",
    current: n.id === task.current_step_id,
  }));
}
```

- [ ] **Step 4: `WorkflowRail.tsx` を書き換える**

`app/src/components/WorkflowRail.tsx` を全体で置き換える:

```tsx
import type { TaskDetail } from "../../../shared/protocol.ts";
import { buildRail, type RailNode } from "../rail";
import { RUN_TONE, toneClass } from "../tone";

/**
 * approval のステップは、まだ来ていないうちはアンバーの破線（gate）、止まっているときは
 * awaiting の human で実線になる。済んだ後は success の ok。
 */
const nodeClass = (n: RailNode) =>
  [
    "wf-step",
    toneClass(RUN_TONE[n.status]),
    n.type === "approval" && n.status === "pending" && "gate",
    n.unknown && "unknown",
    n.current && "now",
  ]
    .filter(Boolean)
    .join(" ");

const LEGEND: { tone: Parameters<typeof toneClass>[0]; word: string }[] = [
  { tone: "ok", word: "済み" },
  { tone: "run", word: "実行中" },
  { tone: "danger", word: "失敗・差し戻し" },
  { tone: "human", word: "人の承認" },
  { tone: "idle", word: "未実行" },
];

export function WorkflowRail({ detail, legend }: { detail: TaskDetail; legend: boolean }) {
  const nodes = buildRail(detail.steps, detail.stepRuns, detail.task);
  if (!nodes) return null;
  return (
    <div className="wf">
      <div className="wf-scroll">
        <ol className="wf-steps" aria-label={`ワークフロー: ${nodes.map((n) => n.id).join(" → ")}`}>
          {nodes.map((n) => (
            <li key={n.id} className={nodeClass(n)} aria-current={n.current ? "step" : undefined} title={n.title}>
              <span className="bar" />
              <span className="nm">{n.id}</span>
            </li>
          ))}
        </ol>
      </div>
      {legend && (
        <div className="wf-legend">
          {LEGEND.map((l) => <span key={l.word} className={toneClass(l.tone)}><i aria-hidden="true" />{l.word}</span>)}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: 帯の CSS**

`styles.css` から `.wr-scroll{...}` と `.wr{...}` から `.wr-badge text{...}` までの `.wr-*` の行をすべて消し、末尾に足す:

```css
/* ワークフローの帯（spec 3.1）。枠で囲まず .pad の幅いっぱいに使う */
.wf{display:grid;gap:10px;min-width:0}
.wf-scroll{overflow-x:auto;padding-bottom:2px}
.wf-steps{list-style:none;margin:0;padding:0;display:flex}
.wf-step{flex:1 0 92px;display:grid;gap:6px;padding-right:8px;min-width:0}
.wf-step .bar{height:6px;border-radius:3px;background:var(--tone)}
.wf-step .nm{font-family:var(--mono);font-size:11.5px;color:var(--ink-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wf-step.tone-danger .nm{color:var(--danger)}
.wf-step.gate .bar{background:repeating-linear-gradient(90deg,var(--accent) 0 6px,transparent 6px 10px);opacity:.65}
.wf-step.gate .nm,.wf-step.tone-human .nm{color:var(--human-text)}
.wf-step.unknown .bar{background:repeating-linear-gradient(90deg,var(--ink-3) 0 6px,transparent 6px 10px)}
.wf-step.now .bar{box-shadow:0 0 0 3px var(--tone-soft)}
.wf-step.now .nm{color:var(--ink);font-weight:500}
.wf-legend{display:flex;gap:14px;flex-wrap:wrap;font-size:11.5px;color:var(--ink-3)}
.wf-legend span{display:inline-flex;align-items:center;gap:6px}
.wf-legend i{width:14px;height:4px;border-radius:2px;background:var(--tone)}
```

- [ ] **Step 6: `Crumbs` にラベルを足す**

`ReviewView.tsx` の `Crumbs`:

```tsx
export function Crumbs({ t, kind }: { t: Task; kind: "Task" | "Review" }) {
  const { s, dispatch } = useStore();
  const p = s.projects.find((x) => x.id === t.project);
  return (
    <div className="crumbs">
      <span className="lbl">{kind}</span>
      {p && <span className="pjdot" style={{ background: p.color }} />}
      <span>{p?.id ?? t.project}</span>
      <span className="mono">{t.wf}</span>
      <span className="mono">{t.id}</span>
      <span className="mono">P{t.prio}</span>
      {t.intake && (
        <button className="el-link" onClick={() => dispatch({ type: "intake.open", id: t.intake!.id })}>
          {taskIntakeLabel(t.intake, s.intakes)}
        </button>
      )}
    </div>
  );
}
```

ReviewView の `<Crumbs t={t} />` を `<Crumbs t={t} kind="Review" />` に、TaskView の `<Crumbs t={t} />` を `<Crumbs t={t} kind="Task" />` にする。

- [ ] **Step 7: タスク画面の帯・ログ・実行履歴の見出し**

`TaskView.tsx` の `{detail && <WorkflowRail detail={detail} />}` から「ログ」の `headrow` の閉じまでを、次で置き換える:

```tsx
      {detail && (
        <div className="blk">
          <div className="headrow"><span className="lbl">Workflow</span><span className="mono hint">{t.wf}</span></div>
          <WorkflowRail detail={detail} legend />
        </div>
      )}

      <div className="headrow">
        <span className="lbl">Log</span>
        <span className="mono hint">
          {history.find((r) => r.id === log?.stepRunId)?.step_id ?? ""}
        </span>
        <span className="spacer" />
        {!following && <span className="hint">末尾 {TAIL} 行</span>}
      </div>
```

実行履歴の `<summary>実行履歴</summary>` を次にする:

```tsx
          <summary><span className="lbl">History</span> 実行履歴</summary>
```

`styles.css` の末尾に足す:

```css
.blk{display:grid;grid-template-columns:minmax(0,1fr);gap:8px;min-width:0}
```

`following` はログを末尾へ追う処理（`useTaskLogs`）で引き続き使われている。「追従中」の文字と `.spin` のアイコンだけが消える。

- [ ] **Step 8: テストとビルド**

Run: `cd app && pnpm test && pnpm build`
Expected: PASS

Run: `grep -rnE "wr-|RailArc|laneY|NODE_W|attempt" app/src/rail.ts app/src/components/WorkflowRail.tsx app/src/styles.css`
Expected: 出力なし

- [ ] **Step 9: 目で確かめる**

Run: `mise run app:tauri`
確かめること: 実行中のタスクで、済んだステップが緑、今のステップが輪付きの青、`review` がアンバーの破線、まだのステップが灰のバーになっている。帯に枠が無く、幅いっぱいに広がる。帯の下に凡例が 1 行ある。ログの見出しに「追従中」が無い。

- [ ] **Step 10: コミット**

```bash
git add shared/protocol.ts core/src/daemon/handlers.ts app/src/rail.ts app/src/rail.test.ts app/src/components/WorkflowRail.tsx app/src/components/TaskView.tsx app/src/components/ReviewView.tsx app/src/styles.css
git commit -m "ワークフローの帯をバーの列にし、戻り矢印をやめる

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: PFD のプロセスの上端のバーと、状態ごとの件数

**Files:**
- Modify: `app/src/pfd.ts:110-119`（`LOOK`）、末尾に `statusCounts`
- Modify: `app/src/pfd.test.ts:135-155`
- Modify: `app/src/components/PfdDiagram.tsx:7-21,53,69-71`
- Modify: `app/src/components/PfdDiagram.test.tsx:85-100`
- Create: `app/src/components/StatusCounts.tsx`
- Modify: `app/src/components/IntakeProgress.tsx`（`ProgressActions` の後）
- Modify: `app/src/components/IntakeView.tsx:32`（パンくずの「Intake」）
- Modify: `app/src/styles.css`（`.pfd-<状態>` を消し、バー・件数・`.el-sec h3` を書き換え）

**Interfaces:**
- Consumes: `PROCESS_TONE`、`toneClass`（Task 1）
- Produces:
  - `LOOK: Record<PfdLook, { word: string }>`
  - `type StatusCount = { look: PfdLook; word: string; count: number }`
  - `statusCounts(view: PfdView): { counts: StatusCount[]; merged: number; total: number }`
  - `<StatusCounts view={PfdView} />`

- [ ] **Step 1: テストを書き換える（落ちる）**

`app/src/pfd.test.ts:135-155` の「ProcessStatus を LOOK に写す」テストの最後の行を消す:

```ts
    for (const [state, look] of Object.entries(LOOK)) expect(look.cls).toBe(`pfd-${state}`);
```

同じファイルの末尾に足す（`PFD_SAMPLE` / `PFD_STATUSES_A` / `buildPfdView` / `pfdKey` はファイル冒頭で import 済み。`statusCounts` を import に足す）:

```ts
describe("statusCounts", () => {
  test("merged 以外の状態を定義順に、件数 0 も含めて返す", () => {
    const view = buildPfdView(PFD_SAMPLE, { statuses: PFD_STATUSES_A });
    const { counts } = statusCounts(view);
    expect(counts.map((c) => c.look)).toEqual([
      "waiting", "ready", "running", "pr_open", "your_turn", "done", "needs_attention",
    ]);
    const expected = (look: string) =>
      Object.values(PFD_STATUSES_A).filter((s) => s.state === look).length;
    for (const c of counts) expect(c.count).toBe(expected(c.look));
  });

  test("マージ済みの分母は全プロセス数", () => {
    const view = buildPfdView(PFD_SAMPLE, { statuses: PFD_STATUSES_A });
    const { merged, total } = statusCounts(view);
    expect(total).toBe(PFD_SAMPLE.processes.length);
    expect(merged).toBe(Object.values(PFD_STATUSES_A).filter((s) => s.state === "merged").length);
  });

  test("承認前（状態が無い）ならすべて 0", () => {
    const { counts, merged } = statusCounts(buildPfdView(PFD_SAMPLE));
    expect(counts.every((c) => c.count === 0)).toBe(true);
    expect(merged).toBe(0);
  });
});
```

`app/src/components/PfdDiagram.test.tsx:85-100` の「状態で塗り分ける」テストを置き換える:

```tsx
  test("状態をプロセスの上端のバーのトーンで示す", () => {
    const html = render(buildPfdView(PFD_SAMPLE, { statuses: PFD_STATUSES_A }));
    for (const p of PFD_SAMPLE.processes) {
      const state = PFD_STATUSES_A[p.id].state;
      const b = block(html, "プロセス", p.name);
      expect(openTag(b)).toContain(LOOK[state].word);
      expect(b).toContain(`class="pfd-bar ${toneClass(PROCESS_TONE[state].tone)}${PROCESS_TONE[state].dashed ? " dashed" : ""}"`);
    }
    const plain = render(buildPfdView(PFD_SAMPLE));
    expect(plain).not.toContain("pfd-bar");
    for (const l of Object.values(LOOK)) expect(plain).not.toContain(l.word);
  });
```

import に `import { PROCESS_TONE, toneClass } from "../tone";` を足す。

Run: `cd app && pnpm vitest run src/pfd.test.ts src/components/PfdDiagram.test.tsx`
Expected: FAIL（`statusCounts` が無い、`pfd-bar` を描いていない）

- [ ] **Step 2: `LOOK` と `statusCounts`**

`app/src/pfd.ts:110-119`:

```ts
export const LOOK: Record<PfdLook, { word: string }> = {
  waiting: { word: "入力待ち" },
  ready: { word: "着手可能" },
  running: { word: "実行中" },
  pr_open: { word: "PR レビュー中" },
  merged: { word: "マージ済み" },
  your_turn: { word: "あなたの番" },
  done: { word: "完了（人）" },
  needs_attention: { word: "要確認" },
};
```

`pfd.ts` の末尾に足す:

```ts
export type StatusCount = { look: PfdLook; word: string; count: number };

/**
 * 進行中の面の状態ごとの件数（spec 3.5）。凡例を兼ねるので件数 0 も返す。
 * merged は counts に入れず、merged / total として返す
 */
export function statusCounts(view: PfdView): { counts: StatusCount[]; merged: number; total: number } {
  const processes = view.nodes.filter((n) => n.kind === "process");
  const count = (look: PfdLook) => processes.filter((n) => n.look === look).length;
  const counts = (Object.keys(LOOK) as PfdLook[])
    .filter((look) => look !== "merged")
    .map((look) => ({ look, word: LOOK[look].word, count: count(look) }));
  return { counts, merged: count("merged"), total: processes.length };
}
```

- [ ] **Step 3: 図にバーを描く**

`PfdDiagram.tsx` の `nodeClass` から `n.look && LOOK[n.look].cls,` の行を消す。`const mark = n.look ? LOOK[n.look].mark : "";` の行を消し、記号の行を次にする:

```tsx
              <text x={n.x + 8} y={n.y + 16} className="pfd-mark">
                {n.marks.join(" ")}
              </text>
```

同じ `<g>` の中、`{n.human && <rect className="pfd-inner" .../>}` の次の行に足す:

```tsx
              {n.look && (
                <line
                  className={`pfd-bar ${toneClass(PROCESS_TONE[n.look].tone)}${PROCESS_TONE[n.look].dashed ? " dashed" : ""}`}
                  x1={n.x + rx}
                  x2={n.x + n.w - rx}
                  y1={n.y + 4}
                  y2={n.y + 4}
                />
              )}
```

import に `import { PROCESS_TONE, toneClass } from "../tone";` を足す。

- [ ] **Step 4: 件数の部品**

`app/src/components/StatusCounts.tsx`:

```tsx
import { PROCESS_TONE, toneClass } from "../tone";
import { statusCounts, type PfdView } from "../pfd";

/** 状態ごとの件数（spec 3.5）。図の凡例を兼ねる */
export function StatusCounts({ view }: { view: PfdView }) {
  const { counts, merged, total } = statusCounts(view);
  return (
    <div className="counts" aria-label="状態ごとの件数">
      {counts.map((c) => (
        <div key={c.look} className={`count ${toneClass(PROCESS_TONE[c.look].tone)}${PROCESS_TONE[c.look].dashed ? " dashed" : ""}`}>
          <span className="lbl">{c.word}</span>
          <span className="v">{c.count}</span>
          <span className="b" />
        </div>
      ))}
      <div className={`count ${toneClass(PROCESS_TONE.merged.tone)}`}>
        <span className="lbl">マージ済み</span>
        <span className="v">{merged} / {total}</span>
        <span className="b" />
      </div>
    </div>
  );
}
```

`IntakeProgress.tsx` の `<ProgressActions ... />` の閉じの直後、`<div className="plan-body">` の前に足す:

```tsx
        <StatusCounts view={view} />
```

import に `import { StatusCounts } from "./StatusCounts";` を足す。

`IntakeView.tsx:32` のパンくずの `<span>Intake</span>` を `<span className="lbl">Intake</span>` にする。

- [ ] **Step 5: CSS**

`styles.css` から次の行を消す:

```css
.pfd-waiting rect{stroke:var(--line);stroke-dasharray:4 3}
.pfd-ready rect{stroke:var(--ink-3)}
.pfd-running rect{fill:var(--run-bg);stroke:var(--run)}
.pfd-pr_open rect{fill:var(--run-bg);stroke:var(--run);stroke-width:2.2}
.pfd-merged rect,.pfd-done rect{fill:var(--ok-bg);stroke:var(--ok)}
.pfd-your_turn rect{fill:var(--accent-soft);stroke:var(--accent);stroke-width:2.2}
.pfd-needs_attention rect{fill:var(--danger-bg);stroke:var(--danger)}
```

`.el-sec h3,.el-sec-title{...}` の行を置き換える（詳細パネルの見出しを mono のラベルにする）:

```css
.el-sec h3,.el-sec-title{margin:0;font-family:var(--mono);font-size:10px;font-weight:500;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-3)}
```

末尾に足す:

```css
/* PFD のプロセスの状態（spec 3.4） */
.pfd-bar{stroke:var(--tone);stroke-width:4;stroke-linecap:round}
.pfd-bar.dashed{stroke-dasharray:5 3;stroke-linecap:butt}
/* Intake の状態ごとの件数（spec 3.5） */
.counts{display:flex;gap:18px;flex-wrap:wrap}
.count{display:grid;gap:3px;min-width:88px}
.count .v{font-family:var(--mono);font-size:12px}
.count .b{height:4px;border-radius:2px;background:var(--tone)}
.count.dashed .b{background:repeating-linear-gradient(90deg,var(--tone) 0 5px,transparent 5px 8px)}
```

- [ ] **Step 6: テストとビルド**

Run: `cd app && pnpm test && pnpm build`
Expected: PASS。`intake.test.ts:224-227`（`statusText` が `LOOK[state].word` と一致）は `word` を残したので通る

Run: `grep -rnE "LOOK\\[[^]]*\\]\\.(mark|cls)|pfd-(waiting|ready|running|pr_open|merged|your_turn|done|needs_attention)" app/src`
Expected: 出力なし

- [ ] **Step 7: 目で確かめる**

Run: `mise run app:tauri`、または開発用のプレビュー `cd app && pnpm dev` で `/pfd-preview.html` を開く
確かめること: 承認後のプロセスの箱の上端にバーが出て、入力待ち・着手可能は破線になっている。箱の塗りは状態で変わらない。Intake の進行中の面に件数の列が出ている。

- [ ] **Step 8: コミット**

```bash
git add app/src/pfd.ts app/src/pfd.test.ts app/src/components/PfdDiagram.tsx app/src/components/PfdDiagram.test.tsx app/src/components/StatusCounts.tsx app/src/components/IntakeProgress.tsx app/src/components/IntakeView.tsx app/src/styles.css
git commit -m "PFD のプロセスの状態を上端のバーにし、状態ごとの件数を出す

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: レビュー画面の指示・前回のフィードバック・帯

**Files:**
- Modify: `app/src/components/ReviewView.tsx:83-131`（`Context` / `History`）、`:264-333`（`ReviewView` の見出しと「変更」の行）
- Modify: `app/src/components/TaskView.tsx:48`（`useTaskDetail` を export）
- Modify: `app/src/model.ts`（`rejections` の近くに `feedbackOf` を足す）
- Modify: `app/src/model.test.ts`
- Create: `app/src/ReviewContext.test.tsx`
- Modify: `app/src/styles.css`

**Interfaces:**
- Consumes: `WorkflowRail`（Task 4、`legend={false}`）、`Crumbs`（Task 4）
- Produces:
  - `feedbackOf(c: TaskContext): { latest: RejectedReview | null; earlier: RejectedReview[] }`（`RejectedReview = ReviewEntry & { status: "rejected" }`。`earlier` は新しい順）
  - `<Prompt text={string} />`、`<Feedback c={TaskContext} now={number} />`（ReviewView.tsx から export）

- [ ] **Step 1: `feedbackOf` のテストを書く（落ちる）**

`app/src/model.test.ts` の末尾に足す（`feedbackOf` を import に足す）:

```ts
describe("feedbackOf", () => {
  const rejected = (stepRunId: number) => ({
    stepRunId,
    stepId: "review",
    status: "rejected" as const,
    endedAt: `2026-09-22T0${stepRunId}:00:00.000Z`,
    comment: `c${stepRunId}`,
  });
  const ctx = (reviews: unknown[]) =>
    ({ prompt: "p", reviews, lastCommand: null, lastAgentMessage: null, reviewFiles: [] }) as unknown as TaskContext;

  test("差し戻しが無ければ latest は null", () => {
    expect(feedbackOf(ctx([]))).toEqual({ latest: null, earlier: [] });
  });

  test("reviews は古い順に届くので、最後の差し戻しが latest", () => {
    const got = feedbackOf(ctx([rejected(1), { stepRunId: 2, stepId: "review", status: "approved", endedAt: "x" }, rejected(3), rejected(5)]));
    expect(got.latest?.stepRunId).toBe(5);
    expect(got.earlier.map((r) => r.stepRunId)).toEqual([3, 1]);
  });
});
```

`ReviewBase` のフィールド名は `shared/protocol.ts` の `ReviewBase` の定義に合わせる（`stepRunId` / `stepId`。`ReviewView.tsx` の `History` が `r.stepRunId` / `r.stepId` / `r.endedAt` / `r.comment` を使っている）。`TaskContext` の型が import されていなければ `import type { TaskContext } from "./types";` を足す。

Run: `cd app && pnpm vitest run src/model.test.ts`
Expected: FAIL（`feedbackOf` が無い）

- [ ] **Step 2: `feedbackOf` を書く**

`app/src/model.ts` の `rejections` の直後に足す:

```ts
export type RejectedReview = ReturnType<typeof rejections>[number];

/** 前回のフィードバックと、それより前の差し戻し（新しい順）。reviews は step_runs の id の昇順で届く */
export function feedbackOf(c: TaskContext): { latest: RejectedReview | null; earlier: RejectedReview[] } {
  const past = rejections(c);
  return { latest: past.at(-1) ?? null, earlier: past.slice(0, -1).reverse() };
}
```

Run: `cd app && pnpm vitest run src/model.test.ts`
Expected: PASS

- [ ] **Step 3: 画面の部品のテストを書く（落ちる）**

`app/src/ReviewContext.test.tsx`:

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { Feedback, Prompt } from "./components/ReviewView";
import type { TaskContext } from "./types";

const NOW = Date.parse("2026-09-22T12:00:00.000Z");
const rejected = (stepRunId: number, comment: string) => ({
  stepRunId,
  stepId: "review",
  status: "rejected" as const,
  endedAt: `2026-09-22T0${stepRunId}:00:00.000Z`,
  comment,
});
const ctx = (reviews: unknown[]) =>
  ({ prompt: "p", reviews, lastCommand: null, lastAgentMessage: null, reviewFiles: [] }) as unknown as TaskContext;

describe("Feedback", () => {
  test("差し戻しが 0 件なら何も出さない", () => {
    expect(renderToStaticMarkup(<Feedback c={ctx([])} now={NOW} />)).toBe("");
  });

  test("1 件なら前回のフィードバックだけを出し、それ以前は出さない", () => {
    const html = renderToStaticMarkup(<Feedback c={ctx([rejected(1, "直して")])} now={NOW} />);
    expect(html).toContain("前回のフィードバック");
    expect(html).toContain("直して");
    expect(html).not.toContain("それ以前");
  });

  test("3 件なら最新を開いて出し、残り 2 件を新しい順に畳む", () => {
    const html = renderToStaticMarkup(
      <Feedback c={ctx([rejected(1, "一回目"), rejected(2, "二回目"), rejected(3, "三回目")])} now={NOW} />,
    );
    const latest = html.indexOf("三回目");
    const fold = html.indexOf("それ以前の 2 件");
    expect(latest).toBeGreaterThan(-1);
    expect(fold).toBeGreaterThan(latest);
    expect(html.indexOf("二回目")).toBeGreaterThan(fold);
    expect(html.indexOf("一回目")).toBeGreaterThan(html.indexOf("二回目"));
  });
});

describe("Prompt", () => {
  test("指示を 4 行で畳んだ状態で出す", () => {
    const html = renderToStaticMarkup(<Prompt text={"一行目\n二行目"} />);
    expect(html).toContain("指示");
    expect(html).toContain('class="prompt clamp"');
  });

  test("サーバー描画（測る前）ではトグルを出さない", () => {
    const html = renderToStaticMarkup(<Prompt text={"短い"} />);
    expect(html).not.toContain("全文を表示");
  });
});
```

Run: `cd app && pnpm vitest run src/ReviewContext.test.tsx`
Expected: FAIL（`Feedback` / `Prompt` が export されていない）

- [ ] **Step 4: `Context` と `History` を作り直す**

`ReviewView.tsx` の `Context` と `History`（83–131 行）を、次で置き換える。import に `useLayoutEffect`（既にある）、`useEffect`、`feedbackOf` を足し、`rejections` の import は使わなくなれば外す。

```tsx
/** 指示は長くなるので 4 行で畳む。4 行に収まるかは描いた後に測る */
export function Prompt({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  // タスクを切り替えたら畳んだ状態に戻す（ReviewView は key={t.id} で作り直されるが、明示しておく）
  useEffect(() => setOpen(false), [text]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && !open) setOverflows(el.scrollHeight > el.clientHeight);
  }, [text, open]);
  return (
    <div className="ctx-row">
      <span className="lbl">指示</span>
      <div ref={ref} className={`prompt${open ? "" : " clamp"}`}>{text}</div>
      {(overflows || open) && (
        <button className="toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "4 行に畳む" : "全文を表示"}
        </button>
      )}
    </div>
  );
}

function FeedbackBody({ r, now }: { r: RejectedReview; now: number }) {
  const at = Date.parse(r.endedAt);
  return (
    <>
      <span className="hint">{clock(at)} · {ago(at, now)} · <span className="mono">{r.stepId}</span></span>
      <div className="feedback">{r.comment}</div>
    </>
  );
}

/** 前回のフィードバックは畳まずに出し、それより前は新しい順に畳む（spec 3.6） */
export function Feedback({ c, now }: { c: TaskContext; now: number }) {
  const { latest, earlier } = feedbackOf(c);
  if (!latest) return null;
  return (
    <div className="ctx-row">
      <span className="lbl">前回のフィードバック</span>
      <FeedbackBody r={latest} now={now} />
      {earlier.length > 0 && (
        <details className="ctx">
          <summary>それ以前の {earlier.length} 件</summary>
          <div style={{ display: "grid", gap: 8 }}>
            {earlier.map((r) => <div key={r.stepRunId} className="ctx-row"><FeedbackBody r={r} now={now} /></div>)}
          </div>
        </details>
      )}
    </div>
  );
}

function Context({ t, loaded }: { t: Task; loaded: Loaded<TaskContext> | undefined }) {
  const { s } = useStore();
  const c = loaded?.kind === "ok" ? loaded.value : null;
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {/* 指示だけは task.list が持っているので、経緯を取れなくても出せる */}
      <Prompt text={t.prompt} />
      {(loaded === undefined || loaded.kind === "loading") && <p className="hint">経緯を読み込んでいます…</p>}
      {loaded?.kind === "error" && <LoadError what="経緯（task.context）" message={loaded.message} />}
      {c && <Feedback c={c} now={s.now} />}
      {c?.lastCommand && (
        <details className="ctx">
          <summary>
            <span className="lbl">Last command</span> 直近の command ステップの結果（<span className="mono">{c.lastCommand.stepId}</span> · exit{" "}
            {c.lastCommand.exitCode === null ? "シグナルで停止（終了コードなし）" : c.lastCommand.exitCode}）
          </summary>
          <pre className="block">
            {c.lastCommand.stdout}{c.lastCommand.stderr ? "\n" + c.lastCommand.stderr : ""}
          </pre>
        </details>
      )}
    </div>
  );
}
```

`RejectedReview` と `feedbackOf` を `../model` から import する。

- [ ] **Step 5: 見出しの下に帯、「変更」をラベルに**

`TaskView.tsx:48` の `function useTaskDetail(t: Task) {` を `export function useTaskDetail(t: Task) {` にする。

`ReviewView.tsx` の `ReviewView` で、`const layout = layoutOf(s, t.id);` の後に足す:

```tsx
  useTaskDetail(t);
  const detail = s.detail[t.id];
```

見出しの `headrow` の閉じ（`<OpenInEditor />` を含む div）の直後、`<Context t={t} loaded={context} />` の前に足す:

```tsx
        {detail && <WorkflowRail detail={detail} legend={false} />}
```

「変更」の行の `<b>変更</b>` を `<span className="lbl">Changes</span>` にする。

import に `import { useTaskDetail } from "./TaskView";` と `import { WorkflowRail } from "./WorkflowRail";` を足す。TaskView.tsx は ReviewView.tsx から `Crumbs` / `OpenInEditor` を import しているので相互 import になるが、どちらもトップレベルで相手の値を使わない（関数の中でだけ使う）ので、ES モジュールの循環は問題にならない。

- [ ] **Step 6: CSS**

`styles.css` の末尾に足す:

```css
/* レビュー画面の指示とフィードバック（spec 3.6） */
.ctx-row{display:grid;gap:6px;justify-items:start}
.ctx-row > *{justify-self:stretch}
.prompt{background:var(--sunken);border-radius:7px;padding:10px 12px;line-height:1.65;white-space:pre-wrap;overflow-wrap:anywhere}
.prompt.clamp{display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}
.toggle{justify-self:start !important;border:0;background:transparent;padding:0;color:var(--human-text);font-size:12px;text-decoration:underline;text-underline-offset:3px;cursor:pointer}
.feedback{border-left:3px solid var(--accent);background:var(--accent-soft);border-radius:0 7px 7px 0;padding:10px 12px;line-height:1.65;white-space:pre-wrap;overflow-wrap:anywhere}
```

- [ ] **Step 7: テストとビルド**

Run: `cd app && pnpm test && pnpm build`
Expected: PASS

- [ ] **Step 8: 目で確かめる**

Run: `mise run app:tauri`
確かめること: レビュー待ちのタスクで、帯（凡例なし）の下に「指示」が 4 行で畳まれ、長い指示にだけ「全文を表示」が出る。差し戻したことのあるタスクでは「前回のフィードバック」がアンバーの左線で開いて出る。2 回以上差し戻したタスクでは「それ以前の N 件」が畳まれて出る。

- [ ] **Step 9: コミット**

```bash
git add app/src/components/ReviewView.tsx app/src/components/TaskView.tsx app/src/model.ts app/src/model.test.ts app/src/ReviewContext.test.tsx app/src/styles.css
git commit -m "レビュー画面に帯を出し、指示を畳み、前回のフィードバックを開いて出す

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: ガイドの目次・解説・影響

**Files:**
- Modify: `app/src/components/ReadingFlow.tsx:94-96,136-155`
- Modify: `app/src/components/Guide.tsx:98-100,146-166`
- Modify: `app/src/styles.css:316-336`

**Interfaces:**
- Consumes: `.lbl`、`.lbl.human`（Task 1）

- [ ] **Step 1: 目次とグループの見出し**

`ReadingFlow.tsx` の目次の見出し `<header>ガイドの順</header>` を次にする:

```tsx
        <header className="lbl">Guide · ガイドの順</header>
```

グループの見出しの `<span className="eyebrow">グループ {g.index + 1} / {flow.groups.length}</span>` を次にする:

```tsx
          <span className="lbl human">Group {g.index + 1} / {flow.groups.length}</span>
```

`flow-note` の中の `<b>判断</b>`、`<b>リスク</b>`、`<b>テスト</b>` を、それぞれ `<span className="lbl">判断</span>`、`<span className="lbl">リスク</span>`、`<span className="lbl">テスト</span>` にする。

- [ ] **Step 2: 影響のバッジと hunk の上のリスク**

`Guide.tsx` の `ImpactBadge`:

```tsx
/** 影響の段階。文字そのもので段階が分かるので、色に頼らない */
function ImpactBadge({ impact }: { impact: Risk["impact"] }) {
  return <span className={`impact impact-${impact}`}><i aria-hidden="true" />{IMPACT_LABEL[impact]}</span>;
}
```

`RiskNote` の外側の `div` に、載っているリスクのうち最も大きい影響をクラスで付ける。`IMPACT_ORDER`（同じファイルで既に使っている。大 → 小の順）を使う:

```tsx
export function RiskNote({ risks }: { risks: Risk[] | undefined }): ReactNode {
  if (!risks?.length) return null;
  const { shown, folded } = splitRisks(risks);
  const top = IMPACT_ORDER.find((i) => risks.some((r) => r.impact === i))!;
  return (
    <div className={`hunk-risk impact-${top}`} role="note">
```

（以降の中身は変えない）

`IMPACT_ORDER` は `app/src/guide.ts:49` で `["high", "medium", "low"]`（大 → 小）なので、`find` の最初の一致が最も大きい影響になる。

- [ ] **Step 3: CSS**

`styles.css` の次の行を置き換える。

変更前:

```css
.flow-head .eyebrow{font-size:11px;letter-spacing:.04em;color:var(--accent-text);font-family:var(--mono)}
.flow-note{border:1px solid var(--accent);border-radius:9px;background:var(--accent-soft);padding:12px 14px;display:grid;gap:8px}
```

変更後:

```css
.flow-note{border-left:3px solid var(--accent);padding:2px 0 2px 14px;display:grid;gap:8px}
```

変更前:

```css
.flowtoc{border:1px solid var(--line);border-radius:9px;overflow:hidden;position:sticky;top:0}
.flowtoc header{padding:7px 10px;background:var(--surface-2);border-bottom:1px solid var(--line);font-size:11.5px;color:var(--ink-2)}
.flowtoc .fl.passed .nm{color:var(--ink-3)}
.flowtoc .fl.passed::before{content:"✓ ";color:var(--ok);font-size:10.5px}
```

変更後:

```css
.flowtoc{position:sticky;top:0;display:grid;gap:2px}
.flowtoc header{padding:0 8px 6px}
.flowtoc .fl{position:relative;border:0;background:transparent;border-radius:6px;padding:5px 8px 5px 16px}
.flowtoc .fl::before{content:"";position:absolute;left:6px;top:7px;bottom:7px;width:3px;border-radius:2px;background:var(--idle)}
.flowtoc .fl.passed::before{background:var(--ink-3)}
.flowtoc .fl.passed .nm{color:var(--ink-3)}
.flowtoc .fl[aria-current="true"]::before{background:var(--accent)}
```

変更前:

```css
.hunk-risk{background:var(--surface-2);color:var(--ink);padding:5px 10px;font-family:var(--sans);font-size:11.5px;border-top:1px solid var(--line);display:grid;gap:4px}
```

変更後:

```css
.hunk-risk{background:var(--surface-2);color:var(--ink);padding:5px 10px;font-family:var(--sans);font-size:11.5px;border-top:1px solid var(--line);display:grid;gap:4px}
.hunk-risk.impact-high{background:var(--danger-bg)}
.hunk-risk.impact-medium{background:var(--accent-soft)}
```

変更前:

```css
.impact{font-size:11px;font-weight:500;padding:0 7px;border-radius:4px;line-height:19px;white-space:nowrap;display:inline-flex;align-items:center;border:1px solid transparent}
.impact-high{background:var(--danger-bg);color:var(--danger);border:1px solid var(--danger)}
.impact-medium{background:var(--accent-soft);color:var(--accent-text)}
.impact-low{background:var(--surface-2);color:var(--ink-2);border:1px dashed var(--line)}
```

変更後（`.hunk-risk.impact-*` と衝突しないよう、バッジは `span.impact` に限る）:

```css
span.impact{font-family:var(--mono);font-size:10px;letter-spacing:.1em;font-weight:500;white-space:nowrap;display:inline-flex;align-items:center;gap:6px}
span.impact > i{width:14px;height:4px;border-radius:2px;background:currentColor}
span.impact-high{color:var(--danger)}
span.impact-medium{color:var(--human-text)}
span.impact-low{color:var(--ink-3)}
```

`.flowtoc .fl` は `.fl` の既定（`border-top` と `background:var(--surface)`）を上書きする。`.fl[aria-current="true"]{background:var(--accent-soft)}` は残すので、今の節の地はアンバーのまま。

- [ ] **Step 4: テストとビルド**

Run: `cd app && pnpm test && pnpm build`
Expected: PASS

Run: `grep -rn "eyebrow" app/src`
Expected: 出力なし（`.flow-head .eyebrow` の他に `eyebrow` を使っている場所があれば、その行は残す）

- [ ] **Step 5: 目で確かめる**

Run: `mise run app:tauri`
確かめること: ガイドのあるレビューで、目次に枠と ✓ が無く、読み終えた節は灰、今の節はアンバーの縦バーになっている。グループの解説がアンバーの地ではなく左線だけになっている。影響が短いバーと色の mono の文字になり、影響 大のリスクの載った hunk の上は赤の淡い地になっている。

- [ ] **Step 6: コミット**

```bash
git add app/src/components/ReadingFlow.tsx app/src/components/Guide.tsx app/src/styles.css
git commit -m "ガイドの目次・解説・影響の見せ方を揃える

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: 置き換えた spec の書き換えと全体の確認

**Files:**
- Modify: `docs/superpowers/specs/2026-09-20-workflow-rail-design.md`
- Modify: `docs/superpowers/specs/2026-09-22-status-visual-design.md`（状態の行）

- [ ] **Step 1: 旧 spec を書き換える**

`2026-09-20-workflow-rail-design.md` の冒頭の「状態」の行を次にする:

```markdown
- 状態: 実装済み。見せ方（4 章の「見せ方」以降と戻り矢印の規則）は [状態の見せ方の統一設計](2026-09-22-status-visual-design.md) の 3.1 で置き換えた
```

同じファイルの 4 章の導出の規則から、次の 3 項目を消す:

- 「ノードの試行回数は、その最後の run の `attempt`。1 のときはバッジを出さない。」
- 「戻り矢印の使用回数は、始点ステップの run のうち `status === "bounced"` の件数。矢印には `goto` 先と `使用回数 / maxAttempts` を出す。」
- 「戻り矢印のレーンは、**またぐステップ数の昇順で内側から**割り当てる。この規則だけで `.doctrine/workflows/default.yaml` の 4 本は 1 本も交差しない。」

3 章の `StepView` の型の例から `branch?: { goto: string; maxAttempts: number };` の行と、その下の「`branch` は `core/src/workflow/schema.ts` の `branchOf(step)` で取り出す」の段落を消す。4 章の「見せ方:」以降の箇条書きを「[状態の見せ方の統一設計](2026-09-22-status-visual-design.md) の 3.1 を見ること。」の 1 行にする。

- [ ] **Step 2: 新 spec の状態を実装済みにする**

`2026-09-22-status-visual-design.md` の `- 状態: 承認済み。実装計画の作成待ち` を `- 状態: 実装済み` にする。

- [ ] **Step 3: 全体を確かめる**

Run: `cd app && pnpm test && pnpm build`
Expected: PASS

Run: `mise run core:test && mise run core:check`
Expected: PASS

Run: `grep -rnE "pill|p-(attn|run|muted|ok|danger)\\b|StateIcon|IntakeIcon|wr-|flow-note\\{border:1px" app/src`
Expected: 出力なし

- [ ] **Step 4: 目で通しで確かめる**

Run: `mise run app:tauri`
確かめること（UI 案 v2 と並べて見る）:
- タスク画面（実行中・失敗・一時停止・上限待ち）
- レビュー画面（差し戻し 0 件 / 1 件 / 2 件以上、ガイドあり / なし）
- Intake の進行中の面（件数と PFD のバー）
- worktree と警告、Issue の選択
- ダークに切り替えて、文字とバーが読めること（見た目の作り込みはしない）

- [ ] **Step 5: コミット**

```bash
git add docs/superpowers/specs/2026-09-20-workflow-rail-design.md docs/superpowers/specs/2026-09-22-status-visual-design.md
git commit -m "ワークフローレールの spec を、状態の見せ方の統一で置き換えた箇所に合わせる

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```
