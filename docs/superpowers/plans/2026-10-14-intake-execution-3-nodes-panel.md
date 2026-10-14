# Intake / Execution 段階 3: ノードと下のパネル Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execution の図のプロセスのノードにワークフローのステップの帯を描き、人の番を強調し、ノードを選ぶと画面の下のパネルにタスク画面・レビュー画面・人の操作を出す。段階 2 が暫定で図の上に置いた `ActionNeeded` と、図の下の `exec-panel-slot` に積んだ `OpenedTask` / `DirectProcess` は、このパネルへ移して撤去する。

**Architecture:** 図の見た目は `app/src/pfd.ts:buildPfdView` に `rails` と `attention` の入力を足して純関数で決め、`PfdDiagram` はそれを描くだけにする。パネルに何を出すかは `app/src/execution.ts:panelContentOf` という純関数で決め、パネルの枠（高さ・最大化・閉じる）は props だけで描く `ExecPanel`、中身の組み立ては store を使う `ExecDetail` に分ける。plan と direct の本体（段階 2 の `PlanBody` / `DirectBody`）は、図とパネルを持つ共通の `GraphBody` に寄せ、direct は `directPfd` で組み立てた図を渡す。パネルのタスクは `s.sel` が決め、帯を新しく保つため、Intake に属するタスクのイベントで詳細を「消さずに」取り直す。

**Tech Stack:** React 19 / TypeScript 6 / vitest 5（`app/`）。テスト `builtin cd /Users/shunsuke.tadokoro/orca/workspaces/doctrine/app_ux/app && pnpm test`、型 `builtin cd /Users/shunsuke.tadokoro/orca/workspaces/doctrine/app_ux/app && pnpm exec tsc`。

**Spec:** `docs/superpowers/specs/2026-10-14-intake-execution-design.md`（6.2 / 6.3 / 6.5 / 7.2 / 10 / 11 章）

## Global Constraints

- 段階 1（`docs/superpowers/plans/2026-10-14-intake-execution-1-daemon-direct.md`）と段階 2（`...-2-app-skeleton.md`）がマージ済みであること。着手前に `builtin cd /Users/shunsuke.tadokoro/orca/workspaces/doctrine/app_ux/app && pnpm exec tsc && pnpm test` が通ることを確かめる
- 状態の色は `app/src/tone.ts` からだけ引く（ステップの区画は `RUN_TONE`、プロセスは `PROCESS_TONE`）。`tone.ts` の `executionTone` と `groupTone`（段階 2 が `groupOf` / `Group` ごと残したもの）はこの段階では触らない
- 人の番は「タスクの承認待ち（いまのタスクが `suspended`）・プロセスの `needs_attention`・プロセスの `your_turn`」の 3 つだけ。`pr_open` は入れない（spec 6.3）
- 図の上の件数のボタンの文言は「要対応 N 件」。既存の凡例の `LOOK.your_turn`（「あなたの番」、人のプロセスだけを数える）と区別する
- 区画はノードの幅を等分し、ステップが多くても幅を広げず詰める（spec 6.2）
- タスクが無いプロセス（`waiting` / `ready`）は灰色の帯 1 本。人のプロセスは帯を描かず状態の文言を出す（spec 6.2）
- direct の図は Issue（成果物）→ `main` → PR（成果物）。画面で組み立て、保存しない（spec 6.2）
- パネルの高さは `localStorage` に覚え、読めないときは既定の高さで開く。読み書きは必ず try/catch（spec 6.5）
- 承認と差し戻しにキーを割り当てない（`App.tsx:useKeys` の既存の約束）
- 後方互換の仕掛けを作らない。消すものは参照ごと消す
- コードのコメントはそのコード固有の事実だけ。一般論は書かない。既存のコメントの密度に合わせる
- `task.create`・`shared/protocol.ts` の `task.create` には触らない（spec 8.3。dctl はすでに無い）

## Review Focus

1. **一覧に無いタスクを指すプロセス**（投入直後で `task.list` の取り直しがまだ）: パネルはタスク画面ではなくプロセスの説明を出し、落ちない → Task 4 のテスト「タスクが一覧に無ければ要素の欄に倒す」
2. **タスクはあるが `rail` が null**（ワークフロー YAML が読めない）: 灰色の帯 1 本で描き、例外を投げない → Task 1 のテスト「rail が null のエージェントのプロセスは灰色の帯 1 本」
3. **`localStorage` が投げる・壊れた値が入っている**: 既定の高さで開き、書き込みの失敗で画面が止まらない → Task 5 のテスト
4. **ステップが非常に多いワークフロー**（30〜100 ステップ）: 区画がノードの外にはみ出さず、幅が負にならない → Task 1 のテスト「100 ステップでも枠内に収まる」
5. **選んでいた要素が図から消える**（改訂の再承認でプロセスが retired）と、`s.sel` が別のプロセスや別の Intake のタスクを指している: パネルは閉じる／そのプロセスのいまのタスクを開く → Task 4 のテストと Task 6 の `processKeyOfTask` のテスト

---

## 前段から使うもの

| 名前 | 置き場所 | 段階 |
| --- | --- | --- |
| `IntakeMode`、`IntakeSummary.mode` | `shared/protocol.ts` | 1 |
| `DIRECT_PROCESS_ID = "main"` | `shared/intake/processStatus.ts` | 1 |
| `RailStatus` / `RailNode` / `buildRail` | `shared/rail.ts`（`app/src/rail.ts` から移したもの。`tone.ts` も `shared/rail.ts` から `RailStatus` を import している） | 1 |
| `IntakeProcessView.rail: RailNode[] \| null` | `shared/protocol.ts`。`fixtures.ts` の `INTAKE_ACTIVE.processes` は `rail: null` | 1 |
| `View = "intake" \| "execution" \| "settings"`、`State.execSel` / `State.execClosed` | `app/src/model.ts` | 2 |
| `case "select"` は無い。タスクを開くのは `task.open`（`view: "execution"`・`execSel`・`execClosed`・`sel` を書く。Intake に属さないタスクはトースト） | `app/src/model.ts` | 2 |
| `j` / `k` は Execution では `executionOrder(s.intakes, s.tasks, s.workspace, s.execClosed)` の順で `execSel` を動かす（`move`） | `app/src/model.ts`、`app/src/execution.ts` | 2 |
| Execution の詳細の取得は `store.tsx` の「開いている Intake の詳細」の effect が `s.view === "execution" ? s.execSel` で行う | `app/src/store.tsx` | 2 |
| `executionOrder` / `isExecutionAttention` / `countExecutionAttention` / `inExecution` / `executionSection`。テストの補助 `task(id, state, intakeId)` | `app/src/execution.ts`、`app/src/execution.test.ts` | 2 |
| `ExecutionSidebar`（`executionOrder` で並べる）、`ExecutionRow` | `app/src/components/ExecutionSidebar.tsx` | 2 |
| `ExecutionView` / `PlanBody` / `DirectBody` / `OpenedTask` / `useCall` / `Ops` / `DirectProcess`。`PlanBody` は図の上に暫定の `ActionNeeded` を置き、図の下の `<div className="exec-panel-slot">` に `PfdElementPanel` + `ProcessTrail` と `OpenedTask` を積む。`DirectBody` はスロットに `DirectProcess` と `OpenedTask` を積む | `app/src/components/ExecutionView.tsx` | 2 |
| `.exec-panel-slot{...}` | `app/src/styles.css` | 2 |
| `useApprovedPfd(detail)`、`ActionNeeded` / `ProcessTrail({ view, onOpenTask, showSubIssue? })` / `ProgressActions` / `WatchAlert` / `CancelDialog` | `app/src/components/IntakeProgress.tsx` | 2 |
| `intake.note` / `intake.sent` / `intake.fresh` の action（段階 2 で残っている） | `app/src/model.ts` | 既存 |
| `RemoveWorktreeButton({ taskId, path, dirty })` / `RemoveWorktreeModal`。`TaskView` は失敗したタスクと削除を断ったタスクにこのボタンを出す | `app/src/components/RemoveWorktree.tsx` | 2 |

この段階で撤去するもの: `PlanBody` の図の上の `ActionNeeded`、`OpenedTask`、`DirectProcess`（と `ExecutionView.test.tsx` のそのテスト）、`exec-panel-slot` の要素と CSS。

---

### Task 1: `buildPfdView` に帯と人の番を足し、区画の座標と direct の図を純関数にする

**Files:**
- Modify: `app/src/pfd.ts`
- Test: `app/src/pfd.test.ts`

**Interfaces:**
- Consumes: `RailNode` / `RailStatus`（`shared/rail.ts`）、`DIRECT_PROCESS_ID`（`shared/intake/processStatus.ts`）
- Produces:
  - `PfdNode.rail: RailNode[] | null` — Execution の図のエージェントのプロセスだけ配列（タスクが無ければ `[]`）。それ以外は null
  - `PfdNode.railRow: boolean` — 帯の行の高さを取ったか（Execution の図のプロセス）
  - `PfdNode.attention: boolean`
  - `buildPfdView(pfd, { ..., rails?: Record<string, RailNode[] | null>; attention?: ReadonlySet<string> })` — `rails` のキーと `attention` の要素はプロセスの id
  - `export const RAIL_BAR_H = 6`
  - `export type RailSegment = { x: number; y: number; w: number; status: RailStatus; current: boolean }`
  - `export function railSegments(n: PfdNode): RailSegment[]`
  - `export function directPfd(issueTitle: string): Pfd`

- [ ] **Step 1: 失敗するテストを書く**

`app/src/pfd.test.ts` の import に `railSegments, directPfd, RAIL_BAR_H` を足し、`RailNode` を import する。末尾に足す:

```ts
import type { RailNode } from "../../shared/rail.ts";
import { DIRECT_PROCESS_ID } from "../../shared/intake/processStatus.ts";

const step = (id: string, status: RailNode["status"], current = false): RailNode =>
  ({ id, type: "agent", status, current, unknown: false });

describe("buildPfdView の帯", () => {
  const rails = { "build-api": [step("impl", "success"), step("test", "running", true), step("review", "pending")] };

  test("rails を渡さない図は帯の行を取らず、高さも変わらない", () => {
    const plain = buildPfdView(PFD_SAMPLE);
    const withRails = buildPfdView(PFD_SAMPLE, { rails });
    const p = node(plain, "p:build-api");
    expect(p.rail).toBeNull();
    expect(p.railRow).toBe(false);
    expect(node(withRails, "p:build-api").h).toBeGreaterThan(p.h);
    // 成果物の高さは変えない
    expect(node(withRails, "a:api").h).toBe(node(plain, "a:api").h);
  });

  test("rails のキーに無いエージェントのプロセスは空の帯、人のプロセスは null", () => {
    const view = buildPfdView(PFD_SAMPLE, { rails });
    expect(node(view, "p:build-api").rail).toHaveLength(3);
    expect(node(view, "p:design").rail).toEqual([]);
    expect(node(view, "p:approve").rail).toBeNull();
    expect(node(view, "p:approve").railRow).toBe(true);
    expect(node(view, "a:api").rail).toBeNull();
  });

  test("rail が null のエージェントのプロセスは灰色の帯 1 本", () => {
    const view = buildPfdView(PFD_SAMPLE, { rails: { "build-api": null } });
    const segs = railSegments(node(view, "p:build-api"));
    expect(segs).toHaveLength(1);
    expect(segs[0].status).toBe("pending");
  });

  test("区画はステップの数だけ等分し、今のステップに印を付ける", () => {
    const n = node(buildPfdView(PFD_SAMPLE, { rails }), "p:build-api");
    const segs = railSegments(n);
    expect(segs.map((x) => x.status)).toEqual(["success", "running", "pending"]);
    expect(segs.map((x) => x.current)).toEqual([false, true, false]);
    expect(new Set(segs.map((x) => x.w)).size).toBe(1);
    expect(segs[0].x).toBeLessThan(segs[1].x);
  });

  test("100 ステップでも枠内に収まる", () => {
    const many = Array.from({ length: 100 }, (_, i) => step(`s${i}`, "pending"));
    const n = node(buildPfdView(PFD_SAMPLE, { rails: { "build-api": many } }), "p:build-api");
    const segs = railSegments(n);
    expect(segs).toHaveLength(100);
    for (const s of segs) {
      expect(s.w).toBeGreaterThan(0);
      expect(s.x).toBeGreaterThanOrEqual(n.x);
      expect(s.x + s.w).toBeLessThanOrEqual(n.x + n.w + 1e-9);
      expect(s.y + RAIL_BAR_H).toBeLessThanOrEqual(n.y + n.h);
    }
  });

  test("区画はラベルの行より下にある", () => {
    const n = node(buildPfdView(PFD_SAMPLE, { rails }), "p:build-api");
    // ラベルの最後の行のベースライン（PfdDiagram は y + 31 から 13 ずつ下げる）
    const lastBaseline = n.y + 31 + (n.lines.length - 1) * 13;
    expect(railSegments(n)[0].y).toBeGreaterThan(lastBaseline);
  });

  test("人のプロセスと成果物は区画を持たない", () => {
    const view = buildPfdView(PFD_SAMPLE, { rails });
    expect(railSegments(node(view, "p:approve"))).toEqual([]);
    expect(railSegments(node(view, "a:api"))).toEqual([]);
  });

  test("attention のプロセスだけ印が立つ", () => {
    const view = buildPfdView(PFD_SAMPLE, { attention: new Set(["approve"]) });
    expect(node(view, "p:approve").attention).toBe(true);
    expect(node(view, "p:design").attention).toBe(false);
    expect(node(view, "a:api").attention).toBe(false);
  });
});

describe("directPfd", () => {
  test("Issue → main → PR の 3 要素", () => {
    const pfd = directPfd("CSV を出す");
    expect(pfd.goal).toEqual(["pr"]);
    expect(pfd.processes).toEqual([
      { id: DIRECT_PROCESS_ID, name: "CSV を出す", actor: "agent", inputs: ["issue"], outputs: ["pr"] },
    ]);
    const view = buildPfdView(pfd);
    expect(view.nodes.map((n) => n.key)).toEqual(["a:issue", "a:pr", `p:${DIRECT_PROCESS_ID}`]);
    expect(node(view, "a:issue").x).toBeLessThan(node(view, `p:${DIRECT_PROCESS_ID}`).x);
    expect(node(view, `p:${DIRECT_PROCESS_ID}`).x).toBeLessThan(node(view, "a:pr").x);
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `builtin cd /Users/shunsuke.tadokoro/orca/workspaces/doctrine/app_ux/app && pnpm vitest run src/pfd.test.ts`
Expected: FAIL（`railSegments` / `directPfd` / `RAIL_BAR_H` が export されていない、`rail` プロパティが無い）

- [ ] **Step 3: 実装する**

`app/src/pfd.ts`:

import に足す:

```ts
import { DIRECT_PROCESS_ID } from "../../shared/intake/processStatus.ts";
import type { RailNode, RailStatus } from "../../shared/rail.ts";
```

`PfdNode` の末尾（`marks` の後）に足す:

```ts
  /** Execution の図のエージェントのプロセスだけが持つ、いまのタスクの帯。タスクが無ければ []。それ以外は null */
  rail: RailNode[] | null;
  /** 帯の行の高さを取った（Execution の図のプロセス） */
  railRow: boolean;
  /** 人の番（spec 6.3）。Execution の図だけが立てる */
  attention: boolean;
```

寸法の定数の並び（`PAD_TOP` の後）に足す:

```ts
/** 帯の行の高さ。区画の太さと、ラベルとの間 */
const RAIL_ROW_H = 12;
export const RAIL_BAR_H = 6;
const RAIL_GAP = 2;
```

`buildPfdView` の `o` に足す:

```ts
    /** Execution の図だけ渡す。キーはプロセスの id。null はタスクがあるが帯が読めない */
    rails?: Record<string, RailNode[] | null>;
    /** 人の番のプロセスの id */
    attention?: ReadonlySet<string>;
```

`sized` の高さの計算を変える:

```ts
    const railRow = o.rails !== undefined && s.kind === "process";
    // 印の行は、印が無くても取る。状態の印（承認）や 🔒（改訂）が付いたときに箱の高さが変わらないように
    const h = BOX_PAD_Y * 2 + MARK_H + lines.length * LINE_H + (railRow ? RAIL_ROW_H : 0);
    return [k, { w, h, lines, marks, railRow }];
```

`nodes` の組み立てで `sized.get(key)!` から `railRow` も取り出し、オブジェクトの末尾に足す:

```ts
      rail: railRow && !s.human ? o.rails?.[s.id] ?? [] : null,
      railRow,
      attention: s.kind === "process" && (o.attention?.has(s.id) ?? false),
```

`buildPfdView` の後に足す:

```ts
export type RailSegment = { x: number; y: number; w: number; status: RailStatus; current: boolean };

/**
 * ノードの帯の区画。プロセスの両端は丸い（rx = 高さの半分）ので、左右に rx を空けて丸みの内側に収める。
 * 空の帯はタスクが無い（か帯が読めない）ので灰色の 1 本にする
 */
export function railSegments(n: PfdNode): RailSegment[] {
  if (n.rail === null) return [];
  const inset = n.h / 2;
  const x0 = n.x + inset;
  const width = n.w - inset * 2;
  const y = n.y + n.h - BOX_PAD_Y - RAIL_BAR_H;
  if (n.rail.length === 0) return [{ x: x0, y, w: width, status: "pending", current: false }];
  const count = n.rail.length;
  // ステップが多いと隙間だけで幅を食い尽くすので、隙間も区画の半分までに詰める
  const gap = Math.min(RAIL_GAP, width / (count * 2));
  const w = (width - gap * (count - 1)) / count;
  return n.rail.map((r, i) => ({ x: x0 + i * (w + gap), y, w, status: r.status, current: r.current }));
}

/** direct の Intake の図。PFD は保存しないので、Issue の題から組み立てる（spec 6.2） */
export function directPfd(issueTitle: string): Pfd {
  return {
    title: issueTitle,
    goal: ["pr"],
    artifacts: [
      { id: "issue", name: "Issue", given: true },
      { id: "pr", name: "PR", given: false },
    ],
    processes: [{ id: DIRECT_PROCESS_ID, name: issueTitle, actor: "agent", inputs: ["issue"], outputs: ["pr"] }],
  };
}
```

`buildPfdView` の `sources` は成果物を先に並べるので、`directPfd` の図のノードの順は `a:issue`, `a:pr`, `p:main` になる（テストのとおり）。

- [ ] **Step 4: 通ることを確かめる**

Run: `builtin cd /Users/shunsuke.tadokoro/orca/workspaces/doctrine/app_ux/app && pnpm vitest run src/pfd.test.ts`
Expected: PASS。既存の `buildPfdView` のテスト（配置・重なり・折り返し）も通ること

- [ ] **Step 5: コミット**

```bash
git add app/src/pfd.ts app/src/pfd.test.ts
git commit -m "PFD の図のノードにステップの帯と人の番を持たせる

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `PfdDiagram` で帯と人の番を描く

**Files:**
- Modify: `app/src/components/PfdDiagram.tsx`
- Modify: `app/src/styles.css`（`.pfd-bar` の近く、550 行付近）
- Test: `app/src/components/PfdDiagram.test.tsx`

**Interfaces:**
- Consumes: Task 1 の `railSegments`、`RAIL_BAR_H`、`PfdNode.rail` / `railRow` / `attention`
- Produces: 描画だけ。箱の `<rect>` に `className="pfd-box"` を付ける（CSS の選択子が区画の `<rect>` と区別するため）

- [ ] **Step 1: 失敗するテストを書く**

`app/src/components/PfdDiagram.test.tsx` に足す（既存の `render` / `block` / `openTag` を使う）:

```tsx
import type { RailNode } from "../../../shared/rail.ts";
import { RUN_TONE } from "../tone";

const step = (id: string, status: RailNode["status"], current = false): RailNode =>
  ({ id, type: "agent", status, current, unknown: false });

describe("PfdDiagram の帯と人の番", () => {
  const rails = { "build-api": [step("impl", "success"), step("test", "running", true)] };

  test("区画をステップの数だけ、状態の色で描き、今のステップに now を付ける", () => {
    const html = render(buildPfdView(PFD_SAMPLE, { rails }));
    const b = block(html, "プロセス", "API を作る");
    const steps = b.match(/<rect class="pfd-step[^"]*"/g)!;
    expect(steps).toHaveLength(2);
    expect(steps[0]).toContain(toneClass(RUN_TONE.success));
    expect(steps[1]).toContain(toneClass(RUN_TONE.running));
    expect(steps[1]).toContain(" now");
  });

  test("タスクの無いプロセスは区画 1 本、人のプロセスは区画を描かず状態の文言を出す", () => {
    const view = buildPfdView(PFD_SAMPLE, { rails, statuses: PFD_STATUSES_B });
    const html = render(view);
    expect(block(html, "プロセス", "スキーマを設計する").match(/class="pfd-step/g)).toHaveLength(1);
    const human = block(html, "プロセス", "受け入れる");
    expect(human).not.toContain("pfd-step");
    expect(human).toContain('class="pfd-railword"');
    expect(human).toContain(LOOK.your_turn.word);
  });

  test("rails を渡さない図は区画も文言も描かない", () => {
    const html = render(buildPfdView(PFD_SAMPLE, { statuses: PFD_STATUSES_B }));
    expect(html).not.toContain("pfd-step");
    expect(html).not.toContain("pfd-railword");
  });

  test("人の番のノードに attention を付け、読み上げにも入れる", () => {
    const html = render(buildPfdView(PFD_SAMPLE, { attention: new Set(["approve"]) }));
    const human = block(html, "プロセス", "受け入れる");
    expect(openTag(human)).toContain("attention");
    expect(openTag(human)).toContain("人の番");
    expect(openTag(block(html, "プロセス", "API を作る"))).not.toContain("attention");
  });

  test("箱の rect は pfd-box を持つ", () => {
    const html = render(buildPfdView(PFD_SAMPLE));
    expect(block(html, "成果物", "Issue")).toContain('class="pfd-box"');
  });
});
```

`PFD_STATUSES_B` を fixtures の import に足す。

- [ ] **Step 2: 失敗を確かめる**

Run: `builtin cd /Users/shunsuke.tadokoro/orca/workspaces/doctrine/app_ux/app && pnpm vitest run src/components/PfdDiagram.test.tsx`
Expected: FAIL（`pfd-step` / `pfd-railword` / `attention` / `pfd-box` が出ない）

- [ ] **Step 3: 実装する**

`app/src/components/PfdDiagram.tsx`:

```tsx
import { useId, type KeyboardEvent } from "react";
import { LOOK, RAIL_BAR_H, railSegments, type PfdNode, type PfdView } from "../pfd";
import { PROCESS_TONE, RUN_TONE, toneClass } from "../tone";
```

`nodeClass` の配列に `n.attention && "attention",` を `selected && "selected"` の前に足す。

`nodeLabel` の配列に足す（`n.look && ...` の後）:

```ts
    n.attention && "人の番",
    n.rail?.find((r) => r.current) && `ステップ ${n.rail.find((r) => r.current)!.id}`,
```

箱の `<rect>` に class を付ける:

```tsx
              <rect className="pfd-box" x={n.x} y={n.y} width={n.w} height={n.h} rx={rx} />
```

ラベルの `<text className="pfd-label">` の直後に足す:

```tsx
              {railSegments(n).map((seg, i) => (
                <rect
                  key={i}
                  className={`pfd-step ${toneClass(RUN_TONE[seg.status])}${seg.current ? " now" : ""}`}
                  x={seg.x}
                  y={seg.y}
                  width={seg.w}
                  height={RAIL_BAR_H}
                  rx={1.5}
                />
              ))}
              {n.railRow && n.human && n.look && (
                <text x={n.x + n.w / 2} y={n.y + n.h - 8} textAnchor="middle" className="pfd-railword">{LOOK[n.look].word}</text>
              )}
```

`app/src/styles.css` の `.pfd-bar.dashed{...}` の行の後に足す:

```css
/* Execution の図のステップの区画。.pfd-node rect の塗りと枠、選択の枠を区画には当てない */
.pfd-node rect.pfd-step,.pfd-node.selected rect.pfd-step,.pfd-node:focus-visible rect.pfd-step{fill:var(--tone);stroke:none}
.pfd-node rect.pfd-step.now{stroke:var(--ink);stroke-width:1}
.pfd-railword{font-size:9.5px;fill:var(--human-text)}
.pfd-node.attention rect.pfd-box{stroke:var(--human-text);stroke-width:3}
.pfd-node.attention.selected rect.pfd-box,.pfd-node.attention:focus-visible rect.pfd-box{stroke:var(--accent)}
```

- [ ] **Step 4: 通ることを確かめる**

Run: `builtin cd /Users/shunsuke.tadokoro/orca/workspaces/doctrine/app_ux/app && pnpm vitest run src/components/PfdDiagram.test.tsx src/pfd.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add app/src/components/PfdDiagram.tsx app/src/components/PfdDiagram.test.tsx app/src/styles.css
git commit -m "PFD の図にステップの区画と人の番の強調を描く

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: 人の番のプロセスを求め、件数から先頭のノードへ飛べるようにする

**Files:**
- Modify: `app/src/execution.ts`
- Modify: `app/src/components/StatusCounts.tsx`
- Modify: `app/src/styles.css`（`.counts` の近く）
- Test: `app/src/execution.test.ts`、`app/src/StatusCounts.test.tsx`（新規）

**Interfaces:**
- Consumes: `IntakeProcessView`（`task_ids` は古い順、末尾がいまのタスク）、`Task`、`PfdView`、`RailNode`
- Produces:
  - `export function attentionProcessIds(processes: readonly IntakeProcessView[], tasks: readonly Task[]): Set<string>`
  - `export function firstAttentionKey(view: PfdView): string | null`
  - `export function railsOf(processes: readonly IntakeProcessView[]): Record<string, RailNode[] | null>`
  - `StatusCounts` の props に `attention?: { count: number; onJump: () => void }`

段階 2 の `isExecutionAttention` は一覧の行（Intake の要約）の判定で、ここで足す `attentionProcessIds` は図のプロセスごとの判定である。数える 3 種類は同じ。

- [ ] **Step 1: 失敗するテストを書く**

`app/src/execution.test.ts`: 既存の import に `attentionProcessIds, firstAttentionKey, railsOf`（`./execution`）、`INTAKE_ACTIVE, PFD_SAMPLE`（`./fixtures`）、`buildPfdView`（`./pfd`）を足し、末尾に足す（`task(id, state, intakeId)` は段階 2 が置いた補助）:

```ts
describe("attentionProcessIds", () => {
  test("your_turn と needs_attention のプロセス", () => {
    // INTAKE_ACTIVE は approve が your_turn、design が needs_attention
    expect(attentionProcessIds(INTAKE_ACTIVE.processes, [])).toEqual(new Set(["approve", "design"]));
  });

  test("いまのタスクが承認待ちのプロセス。古いタスクの承認待ちは数えない", () => {
    const processes = [
      { ...INTAKE_ACTIVE.processes[1], id: "build-api", state: "running" as const, taskId: "t9", task_ids: ["t9"] },
      { ...INTAKE_ACTIVE.processes[1], id: "build-ui", state: "running" as const, taskId: "t8", task_ids: ["t7", "t8"] },
    ];
    const tasks = [task("t9", "suspended", "i2"), task("t7", "suspended", "i2"), task("t8", "running", "i2")];
    expect(attentionProcessIds(processes, tasks)).toEqual(new Set(["build-api"]));
  });

  test("pr_open は人の番に入れない", () => {
    const pr = { number: 1, url: "u", state: "OPEN" as const, baseRef: "develop", mergedAt: null, mergeCommit: null };
    const processes = [{ ...INTAKE_ACTIVE.processes[0], state: "pr_open" as const, taskId: "t1", pr }];
    expect(attentionProcessIds(processes, [task("t1", "waiting", "i2")]).size).toBe(0);
  });
});

describe("firstAttentionKey", () => {
  test("図のノードの順で最初の人の番", () => {
    const view = buildPfdView(PFD_SAMPLE, { attention: new Set(["approve", "design"]) });
    expect(firstAttentionKey(view)).toBe("p:design");
    expect(firstAttentionKey(buildPfdView(PFD_SAMPLE))).toBeNull();
  });
});

describe("railsOf", () => {
  test("プロセスの id から帯", () => {
    expect(railsOf([{ ...INTAKE_ACTIVE.processes[0], id: "x", rail: null }])).toEqual({ x: null });
  });
});
```

`app/src/StatusCounts.test.tsx` を作る:

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { StatusCounts } from "./components/StatusCounts";
import { PFD_SAMPLE, PFD_STATUSES_B } from "./fixtures";
import { buildPfdView } from "./pfd";

const view = buildPfdView(PFD_SAMPLE, { statuses: PFD_STATUSES_B });

describe("StatusCounts", () => {
  test("attention を渡すと「要対応 N 件」のボタンを先頭に出す", () => {
    const html = renderToStaticMarkup(<StatusCounts view={view} attention={{ count: 2, onJump: () => {} }} />);
    expect(html).toMatch(/<button[^>]*class="count attn-jump[^"]*"[^>]*>.*要対応.*2 件/);
    expect(html.indexOf("attn-jump")).toBeLessThan(html.indexOf("入力待ち"));
  });

  test("0 件ならボタンを押せない", () => {
    const html = renderToStaticMarkup(<StatusCounts view={view} attention={{ count: 0, onJump: () => {} }} />);
    expect(html).toMatch(/<button[^>]*class="count attn-jump[^"]*"[^>]*disabled=""/);
  });

  test("attention を渡さなければボタンを出さない", () => {
    expect(renderToStaticMarkup(<StatusCounts view={view} />)).not.toContain("attn-jump");
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `builtin cd /Users/shunsuke.tadokoro/orca/workspaces/doctrine/app_ux/app && pnpm vitest run src/execution.test.ts src/StatusCounts.test.tsx`
Expected: FAIL（関数が無い、`attn-jump` が出ない）

- [ ] **Step 3: 実装する**

`app/src/execution.ts` に足す（import は既存の並びに合わせて、`RailNode`（`../../shared/rail.ts`）、`IntakeProcessView`（`../../shared/protocol.ts`）、`PfdView`（`./pfd`）を足す。`Task` は段階 2 が import 済み）:

```ts
/** 図のプロセスごとの人の番（spec 6.3）。task_ids は古い順なので、末尾がいまのタスク */
export function attentionProcessIds(processes: readonly IntakeProcessView[], tasks: readonly Task[]): Set<string> {
  const ids = new Set<string>();
  for (const p of processes) {
    if (p.state === "your_turn" || p.state === "needs_attention") ids.add(p.id);
    const current = p.task_ids.at(-1);
    if (current !== undefined && tasks.some((t) => t.id === current && t.state === "suspended")) ids.add(p.id);
  }
  return ids;
}

export function firstAttentionKey(view: PfdView): string | null {
  return view.nodes.find((n) => n.attention)?.key ?? null;
}

export function railsOf(processes: readonly IntakeProcessView[]): Record<string, RailNode[] | null> {
  return Object.fromEntries(processes.map((p) => [p.id, p.rail]));
}
```

`app/src/components/StatusCounts.tsx` の `StatusCounts` を次にする（`counts.map` から下は既存のまま）:

```tsx
/** 状態ごとの件数（spec 3.5）。図の凡例を兼ねる。attention は Execution の人の番の件数で、押すと先頭へ飛ぶ（spec 6.3） */
export function StatusCounts({ view, attention }: { view: PfdView; attention?: { count: number; onJump: () => void } }) {
  const { counts, merged, total } = statusCounts(view);
  return (
    <div className="counts" aria-label="状態ごとの件数">
      {attention && (
        <button className={`count attn-jump ${toneClass("human")}`} disabled={attention.count === 0} onClick={attention.onJump}>
          <span className="lbl">要対応</span>
          {/* 数と「件」を 1 つの文字列にする。分けると静的な描画で間に <!-- --> が入る */}
          <span className="v">{`${attention.count} 件`}</span>
          <span className="b" />
        </button>
      )}
      {counts.map((c) => (
```

`app/src/styles.css` の `.counts .count{...}` の後に足す:

```css
.counts .attn-jump{font:inherit;text-align:left;background:none;border:none;padding:0;cursor:pointer;color:inherit}
.counts .attn-jump:disabled{cursor:default;opacity:.6}
```

- [ ] **Step 4: 通ることを確かめる**

Run: `builtin cd /Users/shunsuke.tadokoro/orca/workspaces/doctrine/app_ux/app && pnpm vitest run src/execution.test.ts src/StatusCounts.test.tsx`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add app/src/execution.ts app/src/execution.test.ts app/src/components/StatusCounts.tsx app/src/StatusCounts.test.tsx app/src/styles.css
git commit -m "Execution の人の番のプロセスを求め、要対応の件数から先頭へ飛べるようにする

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: パネルの中身を決める純関数 `panelContentOf`

**Files:**
- Modify: `app/src/execution.ts`
- Test: `app/src/execution.test.ts`

**Interfaces:**
- Consumes: `parsePfdKey`（`pfd.ts`）、`IntakeProcessView`、`Task`
- Produces:

```ts
export type PanelContent =
  /** 成果物・タスクの無いプロセス・完了した人のプロセス・一覧にまだ無いタスクのプロセス */
  | { kind: "element"; key: string }
  | { kind: "human"; key: string; processId: string }
  | { kind: "review"; key: string; processId: string; taskId: string }
  /** attention はいまのタスクを見ていて、プロセスが needs_attention（理由と再投入を上に出す） */
  | { kind: "task"; key: string; processId: string; taskId: string; attention: boolean };

export function panelContentOf(o: {
  key: string | null;
  keys: ReadonlySet<string>;
  processes: readonly IntakeProcessView[];
  tasks: readonly Task[];
  chosenTaskId: string | null;
}): PanelContent | null;
```

- [ ] **Step 1: 失敗するテストを書く**

`app/src/execution.test.ts` の import に `panelContentOf` を足し、末尾に足す（`task(id, state, intakeId)` は段階 2 の補助）:

```ts
describe("panelContentOf", () => {
  const keys = new Set(buildPfdView(PFD_SAMPLE).nodes.map((n) => n.key));
  const running = (id: string, task_ids: string[]) =>
    ({ ...INTAKE_ACTIVE.processes[0], id, state: "running" as const, taskId: task_ids.at(-1)!, task_ids });
  const base = { keys, processes: INTAKE_ACTIVE.processes, tasks: [] as Task[], chosenTaskId: null };

  test("何も選んでいない、または図に無いキーなら null（パネルを閉じる）", () => {
    expect(panelContentOf({ ...base, key: null })).toBeNull();
    expect(panelContentOf({ ...base, key: "p:retired" })).toBeNull();
  });

  test("成果物は要素の欄", () => {
    expect(panelContentOf({ ...base, key: "a:api" })).toEqual({ kind: "element", key: "a:api" });
  });

  test("your_turn は人の操作", () => {
    expect(panelContentOf({ ...base, key: "p:approve" })).toEqual({ kind: "human", key: "p:approve", processId: "approve" });
  });

  test("タスクの無いプロセスは要素の欄", () => {
    expect(panelContentOf({ ...base, key: "p:build-api" })).toEqual({ kind: "element", key: "p:build-api" });
  });

  test("いまのタスクが承認待ちならレビュー画面", () => {
    const processes = [running("build-api", ["t9"])];
    const r = panelContentOf({ ...base, processes, tasks: [task("t9", "suspended", "i2")], key: "p:build-api" });
    expect(r).toEqual({ kind: "review", key: "p:build-api", processId: "build-api", taskId: "t9" });
  });

  test("承認待ち以外ならタスク画面", () => {
    const processes = [running("build-api", ["t9"])];
    const r = panelContentOf({ ...base, processes, tasks: [task("t9", "running", "i2")], key: "p:build-api" });
    expect(r).toEqual({ kind: "task", key: "p:build-api", processId: "build-api", taskId: "t9", attention: false });
  });

  test("needs_attention はいまのタスクに理由と再投入を添える", () => {
    // INTAKE_ACTIVE の design は needs_attention で、task_ids は t-old, t1
    const tasks = [task("t1", "failed", "i2"), task("t-old", "canceled", "i2")];
    const r = panelContentOf({ ...base, tasks, key: "p:design" });
    expect(r).toEqual({ kind: "task", key: "p:design", processId: "design", taskId: "t1", attention: true });
  });

  test("s.sel がそのプロセスの過去のタスクならそれを開き、再投入は添えない", () => {
    const tasks = [task("t1", "failed", "i2"), task("t-old", "canceled", "i2")];
    const r = panelContentOf({ ...base, tasks, key: "p:design", chosenTaskId: "t-old" });
    expect(r).toEqual({ kind: "task", key: "p:design", processId: "design", taskId: "t-old", attention: false });
  });

  test("s.sel が別のプロセスのタスクなら、このプロセスのいまのタスクを開く", () => {
    const tasks = [task("t1", "failed", "i2")];
    const r = panelContentOf({ ...base, tasks, key: "p:design", chosenTaskId: "other" });
    expect(r).toMatchObject({ kind: "task", taskId: "t1" });
  });

  test("タスクが一覧に無ければ要素の欄に倒す", () => {
    const processes = [running("build-api", ["t-new"])];
    expect(panelContentOf({ ...base, processes, key: "p:build-api" })).toEqual({ kind: "element", key: "p:build-api" });
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `builtin cd /Users/shunsuke.tadokoro/orca/workspaces/doctrine/app_ux/app && pnpm vitest run src/execution.test.ts`
Expected: FAIL（`panelContentOf` が無い）

- [ ] **Step 3: 実装する**

`app/src/execution.ts` に Interfaces の `PanelContent` 型と次を足す（`parsePfdKey` を `./pfd` から import）:

```ts
/** 下のパネルに出すもの（spec 6.5）。key が図に無ければ（改訂で消えた・Intake を切り替えた）null で閉じる */
export function panelContentOf(o: {
  key: string | null;
  keys: ReadonlySet<string>;
  processes: readonly IntakeProcessView[];
  tasks: readonly Task[];
  /** いま選んでいるタスク（s.sel）。そのプロセスの task_ids に無ければ使わない */
  chosenTaskId: string | null;
}): PanelContent | null {
  if (o.key === null || !o.keys.has(o.key)) return null;
  const key = o.key;
  const parsed = parsePfdKey(key);
  if (parsed?.kind !== "process") return { kind: "element", key };
  const view = o.processes.find((p) => p.id === parsed.id);
  if (!view) return { kind: "element", key };
  if (view.state === "your_turn") return { kind: "human", key, processId: view.id };
  const current = view.task_ids.at(-1);
  const taskId = o.chosenTaskId !== null && view.task_ids.includes(o.chosenTaskId) ? o.chosenTaskId : current;
  const task = taskId === undefined ? undefined : o.tasks.find((t) => t.id === taskId);
  // 投入の直後は task.list の取り直しがまだで、タスクが一覧に無いことがある
  if (!task) return { kind: "element", key };
  if (task.state === "suspended") return { kind: "review", key, processId: view.id, taskId: task.id };
  return { kind: "task", key, processId: view.id, taskId: task.id, attention: view.state === "needs_attention" && task.id === current };
}
```

- [ ] **Step 4: 通ることを確かめる**

Run: `builtin cd /Users/shunsuke.tadokoro/orca/workspaces/doctrine/app_ux/app && pnpm vitest run src/execution.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add app/src/execution.ts app/src/execution.test.ts
git commit -m "Execution の下のパネルに出すものを決める純関数を足す

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: パネルの高さの記憶と、パネルの枠 `ExecPanel`

**Files:**
- Modify: `app/src/execution.ts`
- Create: `app/src/components/ExecPanel.tsx`
- Modify: `app/src/styles.css`
- Test: `app/src/execution.test.ts`、`app/src/ExecPanel.test.tsx`（新規）

**Interfaces:**
- Produces:
  - `export const PANEL_MIN = 160`、`export const PANEL_DEFAULT = 360`
  - `export function clampPanelHeight(h: number, room: number): number` — room は Execution の領域の高さ。図の分として上に 120px 残す
  - `export function panelStorage(): Pick<Storage, "getItem" | "setItem"> | null`
  - `export function readPanelHeight(storage: Pick<Storage, "getItem"> | null): number`
  - `export function writePanelHeight(storage: Pick<Storage, "setItem"> | null, h: number): void`
  - `ExecPanel` の props: `{ height: number; maximized: boolean; title: ReactNode; onResize: (h: number) => void; onResizeEnd: (h: number) => void; onMaximize: () => void; onClose: () => void; children: ReactNode }`

- [ ] **Step 1: 失敗するテストを書く**

`app/src/execution.test.ts` の import に `clampPanelHeight, PANEL_DEFAULT, PANEL_MIN, readPanelHeight, writePanelHeight`（`./execution`）と `vi`（`vitest`）を足し、末尾に足す:

```ts
describe("パネルの高さ", () => {
  test("下限と、図の分を残した上限に収める", () => {
    expect(clampPanelHeight(10, 800)).toBe(PANEL_MIN);
    expect(clampPanelHeight(5000, 800)).toBe(680);
    expect(clampPanelHeight(400.4, 800)).toBe(400);
    // 領域が狭くても下限は守る
    expect(clampPanelHeight(400, 200)).toBe(PANEL_MIN);
  });

  test("覚えた値を読む。無い・壊れている・投げるなら既定", () => {
    const of = (v: string | null) => ({ getItem: () => v });
    expect(readPanelHeight(of("420"))).toBe(420);
    expect(readPanelHeight(of(null))).toBe(PANEL_DEFAULT);
    expect(readPanelHeight(of("abc"))).toBe(PANEL_DEFAULT);
    expect(readPanelHeight(of("-3"))).toBe(PANEL_DEFAULT);
    expect(readPanelHeight(null)).toBe(PANEL_DEFAULT);
    expect(readPanelHeight({ getItem: () => { throw new Error("denied"); } })).toBe(PANEL_DEFAULT);
  });

  test("書き込みが投げても止まらない", () => {
    const set = vi.fn();
    writePanelHeight({ setItem: set }, 333.7);
    expect(set).toHaveBeenCalledWith(expect.any(String), "334");
    expect(() => writePanelHeight({ setItem: () => { throw new Error("quota"); } }, 300)).not.toThrow();
    expect(() => writePanelHeight(null, 300)).not.toThrow();
  });
});
```

`app/src/ExecPanel.test.tsx` を作る:

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { ExecPanel } from "./components/ExecPanel";

const noop = () => {};
const render = (maximized: boolean) =>
  renderToStaticMarkup(
    <ExecPanel height={300} maximized={maximized} title="API を作る" onResize={noop} onResizeEnd={noop} onMaximize={noop} onClose={noop}>
      <p>中身</p>
    </ExecPanel>,
  );

describe("ExecPanel", () => {
  test("高さを持ち、境目と最大化・閉じるを出す", () => {
    const html = render(false);
    expect(html).toContain("height:300px");
    expect(html).toContain('role="separator"');
    expect(html).toContain(">最大化</button>");
    expect(html).toContain(">閉じる</button>");
    expect(html).toContain("API を作る");
    expect(html).toContain('<div class="exec-panel-body"><p>中身</p></div>');
  });

  test("最大化中は高さと境目を持たず、元に戻すを出す", () => {
    const html = render(true);
    expect(html).toContain('class="exec-panel max"');
    expect(html).not.toContain("height:300px");
    expect(html).not.toContain('role="separator"');
    expect(html).toContain(">元に戻す</button>");
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `builtin cd /Users/shunsuke.tadokoro/orca/workspaces/doctrine/app_ux/app && pnpm vitest run src/execution.test.ts src/ExecPanel.test.tsx`
Expected: FAIL

- [ ] **Step 3: 実装する**

`app/src/execution.ts` に足す:

```ts
export const PANEL_MIN = 160;
export const PANEL_DEFAULT = 360;
/** 図の分として、パネルの上に残す高さ */
const PANEL_ROOM_TOP = 120;
const PANEL_KEY = "doctrine.execution.panelHeight";

export function clampPanelHeight(h: number, room: number): number {
  const max = Math.max(PANEL_MIN, room - PANEL_ROOM_TOP);
  return Math.min(max, Math.max(PANEL_MIN, Math.round(h)));
}

/** プライベートウィンドウなどでは localStorage に触るだけで投げる */
export function panelStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readPanelHeight(storage: Pick<Storage, "getItem"> | null): number {
  try {
    const v = Number(storage?.getItem(PANEL_KEY) ?? NaN);
    return Number.isFinite(v) && v > 0 ? v : PANEL_DEFAULT;
  } catch {
    return PANEL_DEFAULT;
  }
}

export function writePanelHeight(storage: Pick<Storage, "setItem"> | null, h: number): void {
  try {
    storage?.setItem(PANEL_KEY, String(Math.round(h)));
  } catch {
    // 覚えられなくても、いまの高さは効いている
  }
}
```

`app/src/components/ExecPanel.tsx` を作る:

```tsx
import { useRef, type ReactNode } from "react";

/** Execution の下のパネルの枠（spec 6.5）。高さは親が持ち、境目のドラッグは差分を onResize に渡すだけ */
export function ExecPanel(p: {
  height: number;
  maximized: boolean;
  title: ReactNode;
  onResize: (height: number) => void;
  onResizeEnd: (height: number) => void;
  onMaximize: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const drag = useRef<{ y: number; h: number } | null>(null);
  // 境目を上へ引くとパネルが高くなる
  const heightAt = (clientY: number) => drag.current!.h - (clientY - drag.current!.y);
  return (
    <section className={p.maximized ? "exec-panel max" : "exec-panel"} style={p.maximized ? undefined : { height: p.height }} aria-label="詳細">
      {!p.maximized && (
        <div
          className="exec-split"
          role="separator"
          aria-orientation="horizontal"
          aria-label="パネルの高さ"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = { y: e.clientY, h: p.height };
          }}
          onPointerMove={(e) => {
            if (drag.current) p.onResize(heightAt(e.clientY));
          }}
          onPointerUp={(e) => {
            if (!drag.current) return;
            const h = heightAt(e.clientY);
            drag.current = null;
            p.onResizeEnd(h);
          }}
        />
      )}
      <div className="exec-panel-head">
        <span className="exec-panel-title">{p.title}</span>
        <span className="spacer" />
        <button className="btn sm" aria-pressed={p.maximized} onClick={p.onMaximize}>{p.maximized ? "元に戻す" : "最大化"}</button>
        <button className="btn sm" onClick={p.onClose}>閉じる</button>
      </div>
      <div className="exec-panel-body">{p.children}</div>
    </section>
  );
}
```

`app/src/styles.css` の末尾に足す（`.exec` / `.exec-top` は Task 6 の `GraphBody` の外枠と上の領域）:

```css
/* Execution: 図の領域と下のパネル（spec 6.5）。外枠が main の高さを埋め、図とパネルがそれぞれスクロールする */
.exec{display:flex;flex-direction:column;flex:1;min-height:0}
.exec-top{flex:1;min-height:0;overflow:auto}
.exec.maximized .exec-top{display:none}
.exec-panel{display:flex;flex-direction:column;min-height:0;border-top:1px solid var(--line);background:var(--surface);position:relative}
.exec-panel.max{flex:1}
.exec-split{position:absolute;top:-4px;left:0;right:0;height:8px;cursor:row-resize;touch-action:none}
.exec-panel-head{display:flex;align-items:center;gap:8px;padding:6px 14px;border-bottom:1px solid var(--line)}
.exec-panel-title{font-weight:500;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.exec-panel-body{flex:1;min-height:0;overflow:auto}
.exec-trail{display:flex;gap:18px;flex-wrap:wrap;padding:10px 24px 0}
```


- [ ] **Step 4: 通ることを確かめる**

Run: `builtin cd /Users/shunsuke.tadokoro/orca/workspaces/doctrine/app_ux/app && pnpm vitest run src/execution.test.ts src/ExecPanel.test.tsx`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add app/src/execution.ts app/src/execution.test.ts app/src/components/ExecPanel.tsx app/src/ExecPanel.test.tsx app/src/styles.css
git commit -m "Execution の下のパネルの枠と高さの記憶を足す

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: 図とパネルの本体に組み替え、暫定の ActionNeeded・OpenedTask・DirectProcess を撤去する

**Files:**
- Create: `app/src/components/useCall.ts`（段階 2 の `ExecutionView.tsx` の `useCall` を移す）
- Create: `app/src/components/ExecDetail.tsx`
- Modify: `app/src/components/ExecutionView.tsx`（`PlanBody` / `DirectBody` を `GraphBody` に寄せる。`OpenedTask` / `DirectProcess` / 図の上の `ActionNeeded` / `exec-panel-slot` を消す）
- Modify: `app/src/execution.ts`（`processKeyOfTask`）
- Modify: `app/src/components/ReviewView.tsx:42-50`（`rememberPosition` のスクロールの基準）
- Modify: `app/src/App.tsx`（`moveBy` のスクロールの基準）
- Modify: `app/src/styles.css`（`.exec-panel-slot` の行を消す）
- Test: `app/src/execution.test.ts`、`app/src/ExecutionView.test.tsx`（`DirectProcess` のテストを消す）

**Interfaces:**
- Consumes: Task 1 の `buildPfdView` の `rails` / `attention`、`directPfd`。Task 3 の `attentionProcessIds` / `firstAttentionKey` / `railsOf`、`StatusCounts` の `attention`。Task 4 の `panelContentOf`。Task 5 の `ExecPanel` / `clampPanelHeight` / `panelStorage` / `readPanelHeight` / `writePanelHeight`。段階 2 の `useApprovedPfd` / `Ops` / `ProgressActions` / `WatchAlert` / `CancelDialog` / `IntakeHistory` / `ActionNeeded` / `ProcessTrail({ showSubIssue })`、`task.open`、`intake.note` / `intake.sent` / `intake.fresh`、`useIntakeRpc` の `completeHumanProcess` / `redispatch` / `processPrompt`
- Produces:
  - `export function processKeyOfTask(tasks: readonly Task[], sel: string | null, intakeId: string): string | null`（`execution.ts`）
  - `export function useCall(): { pending: string | null; call: <T>(key: string, send: Promise<T>, failed: string, onOk: (value: T) => void) => Promise<void> }`（`components/useCall.ts`）
  - `ExecDetail(p: { detail: IntakeDetail; pfd: Pfd; view: PfdView; selected: string | null; onSelect: (key: string | null) => void; maximized: boolean; onMaximize: (on: boolean) => void; room: () => number })`

パネルのタスク画面とレビュー画面は、既存の `TaskView` / `ReviewView` をそのまま載せる。どちらも、差し戻しのモーダル（`App.tsx:RejectModal`）・diff と経緯の取得（`store.tsx` の `reviewing`）・キー操作（`useKeys`）が `s.sel`（`selectedTask(s)`）を見ている。そこでパネルに出すタスクは `s.sel` で決める:

- ノードを選ぶと、`ExecDetail` がそのプロセスのいまのタスクを `task.open` して `s.sel` を合わせる。`s.sel` が既にそのプロセスの過去のタスクなら、そのまま過去のタスクを出す（`panelContentOf` の `chosenTaskId` に `s.sel` を渡す）
- `ProcessTrail` で過去のタスクを押すと `task.open` する
- 外から `s.sel` が変わったとき（承認・差し戻しの後の `selectNextReview`、ほかの画面からの `task.open`）は、`GraphBody` がそのタスクのプロセスのノードを選び直す（`processKeyOfTask`）

段階 2 の `OpenedTask` が担っていた「`s.sel` のタスクの画面を出す」はこれで下のパネルに移る。

- [ ] **Step 1: 失敗するテストを書く**

`app/src/execution.test.ts` の import に `processKeyOfTask` を足し、末尾に足す:

```ts
describe("processKeyOfTask", () => {
  test("選んでいるタスクがこの Intake のものなら、そのプロセスのキー", () => {
    const tasks = [task("t1", "running", "i2"), task("t2", "running", "i5"), task("t3", "running", null)];
    // task() の intake.processId は p1
    expect(processKeyOfTask(tasks, "t1", "i2")).toBe("p:p1");
    expect(processKeyOfTask(tasks, "t2", "i2")).toBeNull();
    expect(processKeyOfTask(tasks, "t3", "i2")).toBeNull();
    expect(processKeyOfTask(tasks, "gone", "i2")).toBeNull();
    expect(processKeyOfTask(tasks, null, "i2")).toBeNull();
  });
});
```

`app/src/ExecutionView.test.tsx` から、`describe("DirectProcess", ...)`、補助の `direct`、`DirectProcess` と `IntakeProcessView` の import を消す（`ExecutionRow` のテストは残す）。

- [ ] **Step 2: 失敗を確かめる**

Run: `builtin cd /Users/shunsuke.tadokoro/orca/workspaces/doctrine/app_ux/app && pnpm vitest run src/execution.test.ts`
Expected: FAIL（`processKeyOfTask` が無い）

- [ ] **Step 3: processKeyOfTask と useCall**

`app/src/execution.ts` に足す（`pfdKey` を `./pfd` から import）:

```ts
/** s.sel のタスクがこの Intake のものなら、そのプロセスの図のキー。パネルの外から開いたタスクのノードを選び直すのに使う */
export function processKeyOfTask(tasks: readonly Task[], sel: string | null, intakeId: string): string | null {
  const t = sel === null ? undefined : tasks.find((x) => x.id === sel);
  return t?.intake?.id === intakeId ? pfdKey("process", t.intake.processId) : null;
}
```

`app/src/components/useCall.ts` を作る。中身は段階 2 の `ExecutionView.tsx` の `useCall` をそのまま移したもの:

```ts
import { useState } from "react";
import { sendDecision } from "../decision";
import { useStore } from "../store";

/** RPC を送り、成功したときだけ後片付けをする。失敗はトースト */
export function useCall() {
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
```

`.ts` のファイルでジェネリックの矢印関数 `<T,>` は書けるが、tsc が拒んだら `function call<T>(...)` の宣言に書き換える。`ExecutionView.tsx` の `useCall` の定義は消し、`import { useCall } from "./useCall";` にする。

- [ ] **Step 4: ExecDetail を書く**

`app/src/components/ExecDetail.tsx` を作る:

```tsx
import { useEffect, useMemo, useState } from "react";
import type { Pfd } from "../../../shared/intake/pfd.ts";
import type { IntakeDetail } from "../../../shared/protocol.ts";
import { clampPanelHeight, panelContentOf, panelStorage, readPanelHeight, writePanelHeight } from "../execution";
import { actionNeeded } from "../intake";
import { intakeDraftOf, type Loaded } from "../model";
import { pfdElement, type PfdView } from "../pfd";
import { useIntakeRpc, useStore } from "../store";
import { ExecPanel } from "./ExecPanel";
import { ActionNeeded, ProcessTrail } from "./IntakeProgress";
import { PfdElementPanel } from "./PfdElementPanel";
import { ReviewView } from "./ReviewView";
import { TaskView } from "./TaskView";
import { useCall } from "./useCall";

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 選んだ要素の下のパネル（spec 6.5）。何を出すかは panelContentOf が決め、タスクは s.sel に合わせる */
export function ExecDetail(p: {
  detail: IntakeDetail;
  pfd: Pfd;
  view: PfdView;
  selected: string | null;
  onSelect: (key: string | null) => void;
  maximized: boolean;
  onMaximize: (on: boolean) => void;
  /** Execution の領域の高さ。パネルの上限を決める */
  room: () => number;
}) {
  const { s, dispatch } = useStore();
  const api = useIntakeRpc();
  const { pending, call } = useCall();
  const [height, setHeight] = useState(() => readPanelHeight(panelStorage()));
  const [prompts, setPrompts] = useState<Record<string, Loaded<string>>>({});
  const keys = useMemo(() => new Set(p.view.nodes.map((n) => n.key)), [p.view]);

  const content = panelContentOf({ key: p.selected, keys, processes: p.detail.processes, tasks: s.tasks, chosenTaskId: s.sel });
  const taskId = content?.kind === "review" || content?.kind === "task" ? content.taskId : null;
  useEffect(() => {
    if (taskId !== null && s.sel !== taskId) dispatch({ type: "task.open", id: taskId });
  }, [taskId]);

  if (content === null) return null;

  const openTask = (id: string) => dispatch({ type: "task.open", id });
  const local = intakeDraftOf(s, p.detail.id);
  const info = pfdElement(p.pfd, content.key, p.detail.question_sets);
  const processView = info?.kind === "process" ? p.detail.processes.find((x) => x.id === info.process.id) : undefined;
  const trail = processView && <ProcessTrail view={processView} onOpenTask={openTask} showSubIssue={p.detail.mode !== "direct"} />;
  // direct は案を持たないので、プロセスのプロンプトはタスク画面のプロンプトで読む
  const draftId = p.detail.approval?.draft_id ?? null;
  const processId = info?.kind === "process" ? info.process.id : null;

  const complete = (id: string) => {
    // 送る値は、後片付けの dispatch が下書きを消す前に読んでおく
    const note = local.notes[id] ?? "";
    void call(id, api.completeHumanProcess(p.detail.id, id, note), "完了を記録できませんでした", (d) => {
      dispatch({ type: "intake.sent", id: p.detail.id, what: "complete", processId: id });
      dispatch({ type: "intake.fresh", id: p.detail.id, detail: d });
    });
  };
  const redispatch = (id: string) =>
    void call(id, api.redispatch(p.detail.id, id), "再投入できませんでした", (d) => {
      dispatch({ type: "intake.fresh", id: p.detail.id, detail: d });
      dispatch({ type: "toast", message: "再投入しました" });
    });
  const openPrompt = () => {
    if (processId === null || draftId === null || prompts[processId]) return;
    setPrompts((m) => ({ ...m, [processId]: { kind: "loading" } }));
    api.processPrompt(p.detail.id, draftId, processId).then(
      (value) => setPrompts((m) => ({ ...m, [processId]: { kind: "ok", value } })),
      (e) => setPrompts((m) => ({ ...m, [processId]: { kind: "error", message: errorMessage(e) } })),
    );
  };

  const items = actionNeeded(p.detail, p.pfd);
  const actionsFor = (id: string, what: "yourTurn" | "needsAttention") => (
    <ActionNeeded
      pfd={p.pfd}
      items={{
        yourTurn: what === "yourTurn" ? items.yourTurn.filter((x) => x.process.id === id) : [],
        needsAttention: what === "needsAttention" ? items.needsAttention.filter((x) => x.process.id === id) : [],
      }}
      notes={local.notes}
      pending={pending}
      onNote={(pid, text) => dispatch({ type: "intake.note", id: p.detail.id, processId: pid, text })}
      onComplete={complete}
      onRedispatch={redispatch}
      onOpenTask={openTask}
    />
  );
  const element = (
    <PfdElementPanel
      pfd={p.pfd}
      info={info}
      onSelect={p.onSelect}
      extra={trail}
      prompt={processId === null ? undefined : prompts[processId]}
      onOpenPrompt={draftId === null ? null : openPrompt}
      comments={[]}
      previous={[]}
      onAddComment={null}
      onDeleteComment={null}
    />
  );
  const task = taskId === null ? undefined : s.tasks.find((t) => t.id === taskId);

  return (
    <ExecPanel
      height={height}
      maximized={p.maximized}
      title={info?.kind === "artifact" ? info.artifact.name : info?.process.name}
      onResize={(h) => setHeight(clampPanelHeight(h, p.room()))}
      onResizeEnd={(h) => {
        const c = clampPanelHeight(h, p.room());
        setHeight(c);
        writePanelHeight(panelStorage(), c);
      }}
      onMaximize={() => p.onMaximize(!p.maximized)}
      onClose={() => {
        p.onMaximize(false);
        p.onSelect(null);
      }}
    >
      {content.kind === "element" && <div className="pad">{element}</div>}
      {content.kind === "human" && <div className="pad">{actionsFor(content.processId, "yourTurn")}{element}</div>}
      {content.kind === "review" && task && (
        <>
          <div className="exec-trail">{trail}</div>
          <ReviewView key={task.id} t={task} />
        </>
      )}
      {content.kind === "task" && task && (
        <>
          {content.attention && <div className="pad">{actionsFor(content.processId, "needsAttention")}</div>}
          <div className="exec-trail">{trail}</div>
          <TaskView key={task.id} t={task} />
        </>
      )}
    </ExecPanel>
  );
}
```

失敗したタスクと削除を断ったタスクの「worktree を削除」は、パネルの `TaskView` が段階 2 の `RemoveWorktreeButton` で出す。確認のモーダル（`RemoveWorktreeModal`）は `App.tsx` に置かれたままなので、パネルから押しても開く。

- [ ] **Step 5: ExecutionView を GraphBody に組み替える**

`app/src/components/ExecutionView.tsx`:

1. `OpenedTask` と `DirectProcess` を消す
2. `PlanBody` と `DirectBody` を次に置き換え、`GraphBody` を足す:

```tsx
/** plan と direct の本体。上に見出し・操作・件数・図、下に選んだ要素のパネル（spec 6.2〜6.5） */
function GraphBody(p: { detail: IntakeDetail; pfd: Pfd; heading: ReactNode; history: boolean }) {
  const { s } = useStore();
  const { pending, call } = useCall();
  const execRef = useRef<HTMLDivElement>(null);
  const [maximized, setMaximized] = useState(false);
  const follow = processKeyOfTask(s.tasks, s.sel, p.detail.id);
  const [selected, setSelected] = useState<string | null>(follow);
  // 承認・差し戻しの後の次のレビュー待ちや、ほかから task.open したタスクのノードを選び直す
  useEffect(() => {
    if (follow !== null) setSelected(follow);
  }, [follow]);
  const attention = useMemo(() => attentionProcessIds(p.detail.processes, s.tasks), [p.detail.processes, s.tasks]);
  const view = useMemo(
    () => buildPfdView(p.pfd, { statuses: processStatuses(p.detail.processes), rails: railsOf(p.detail.processes), attention }),
    [p.pfd, p.detail.processes, attention],
  );
  return (
    <div className={maximized ? "exec maximized" : "exec"} ref={execRef}>
      <div className="exec-top pad">
        {p.heading}
        {p.detail.state === "completed" && <h2 className="plan-title">完了しました</h2>}
        <WatchAlert watch={p.detail.watch} now={s.now} />
        <Ops detail={p.detail} pending={pending !== null} call={call} />
        <StatusCounts view={view} attention={{ count: attention.size, onJump: () => setSelected(firstAttentionKey(view)) }} />
        <PfdDiagram view={view} selected={selected} onSelect={setSelected} />
        {p.history && <IntakeHistory detail={p.detail} />}
      </div>
      <ExecDetail
        detail={p.detail}
        pfd={p.pfd}
        view={view}
        selected={selected}
        onSelect={setSelected}
        maximized={maximized}
        onMaximize={setMaximized}
        room={() => execRef.current?.clientHeight ?? window.innerHeight}
      />
    </div>
  );
}

function PlanBody({ detail, heading }: { detail: IntakeDetail; heading: ReactNode }) {
  const { pfd, error } = useApprovedPfd(detail);
  const title = detail.state === "completed" ? <h2 className="plan-title">完了しました</h2> : null;
  if (detail.approval === null) {
    // 承認の前に中止した。図は無いので経緯だけ読み返せる
    return <div className="pad">{heading}{title}<IntakeHistory detail={detail} /></div>;
  }
  if (!pfd) {
    return <div className="pad">{heading}{title}<p className="hint">{error ?? "承認された案を読み込み中"}</p></div>;
  }
  return <GraphBody detail={detail} pfd={pfd} heading={heading} history />;
}

function DirectBody({ detail, heading }: { detail: IntakeDetail; heading: ReactNode }) {
  const pfd = useMemo(() => directPfd(detail.issue_title), [detail.issue_title]);
  return <GraphBody detail={detail} pfd={pfd} heading={heading} history={false} />;
}
```

段階 2 の `PlanBody` にあった図の上の `ActionNeeded`（完了の記録・再投入）と、`complete` / `redispatch` / `openPrompt` / `openTask` / `prompts` はパネル（`ExecDetail`）へ移ったので、ここには残さない。`DirectBody` の再投入も、`main` の要確認のパネルの `ActionNeeded` から行う。

3. `ExecutionView` の振り分けで、Intake を切り替えたら選択と最大化が残らないよう key を付ける:

```tsx
      {d.mode === "direct"
        ? <DirectBody key={d.id} detail={d} heading={heading} />
        : <PlanBody key={`${d.id}:${d.approval?.draft_id}`} detail={d} heading={heading} />}
```

4. import を整える。足す: `useEffect` / `useRef`、`Pfd`（`../../../shared/intake/pfd.ts`）、`attentionProcessIds` / `firstAttentionKey` / `processKeyOfTask` / `railsOf`（`../execution`）、`directPfd`（`../pfd`）、`ExecDetail`、`useCall`。消す（`pnpm exec tsc` の指摘どおり）: `DIRECT_PROCESS_ID`、`actionNeeded`、`intakeDraftOf`、`selectedTask`、`type Loaded`、`pfdElement`、`ActionNeeded`、`ProcessTrail`、`PfdElementPanel`、`ReviewView`、`TaskView`、`statusText`、`PROCESS_TONE`、`StatusDot`、`IntakeProcessView`、`errorMessage`（使わなくなっていれば）

`app/src/styles.css` から段階 2 の `.exec-panel-slot{...}` の行を消す。`rg -n "exec-panel-slot|OpenedTask|DirectProcess" app/src` が何も出さないこと。

- [ ] **Step 6: レビュー画面のスクロールの基準をパネルにする**

レビュー画面はパネルの中でだけ開くので、スクロールする要素は `main.main` ではなく `.exec-panel-body` になる。

`app/src/components/ReviewView.tsx` の `rememberPosition`:

```ts
function rememberPosition(): string | null {
  const main = document.querySelector(".exec-panel-body");
```

`app/src/App.tsx` の `moveBy`:

```ts
function moveBy(selector: string, delta: 1 | -1) {
  const main = document.querySelector(".exec-panel-body");
```

両方の関数の上のコメントの「main の上端」を「パネルの上端」に直す。`rg -n '"main.main"' app/src` が何も出さないこと（`App.tsx` の `mainRef` は `<main>` の ref なので触らない）。

- [ ] **Step 7: 型と全体のテストを確かめる**

Run: `builtin cd /Users/shunsuke.tadokoro/orca/workspaces/doctrine/app_ux/app && pnpm exec tsc && pnpm test`
Expected: tsc が通り、テストがすべて PASS

- [ ] **Step 8: 画面で確かめる**

Run: `mise run app:tauri`（dctld に繋がる。`mise run app:dev` はデーモンに繋がらないので図が出ない）

確かめること:
- 進行中の plan の Intake を選ぶと、エージェントのプロセスに区画が並び、走っているステップに枠が付く。タスクの無いプロセスは灰色の 1 本、人のプロセスは文言。図の上に `ActionNeeded` の欄は無い
- 承認待ちのタスクのプロセスは太い枠。「要対応 N 件」を押すとそのノードが選ばれ、パネルにレビュー画面が開く。`n` / `p` でファイルが動き、差し戻しのモーダルが開く。承認すると同じ Intake の次のレビュー待ちのノードが選ばれる
- 人のプロセスの番のノードでは、パネルに決めた内容の欄と「完了を記録する」が出る
- 境目のドラッグで高さが変わり、アプリを開き直しても高さが残る。最大化で図が隠れ、閉じるでパネルが消える
- direct の Intake は Issue → タイトル → PR の図で、プロセスを選ぶとタスク画面が出る。sub-issue の欄は出ない
- 失敗したタスクのプロセスでは、理由と「再投入する」とタスク画面が出て、タスク画面の「worktree を削除」で確認のモーダルが開く
- `ProcessTrail` で過去のタスクを押すと、パネルがそのタスクの画面になる

- [ ] **Step 9: コミット**

```bash
git add app/src/components/useCall.ts app/src/components/ExecDetail.tsx app/src/components/ExecutionView.tsx app/src/ExecutionView.test.tsx app/src/execution.ts app/src/execution.test.ts app/src/components/ReviewView.tsx app/src/App.tsx app/src/styles.css
git commit -m "Execution の図に帯と人の番を描き、選んだノードを下のパネルで開く

段階 2 が暫定で置いた図の上の ActionNeeded と、スロットの OpenedTask・DirectProcess をパネルへ移して撤去する。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: タスクが動いたら、詳細を消さずに帯を取り直す

**Files:**
- Modify: `app/src/model.ts`（`State`、`reduce` の `daemon`）
- Modify: `app/src/store.tsx`（`initialState` と取り直しの effect）
- Test: `app/src/model.test.ts`

**Interfaces:**
- Consumes: `invalidateIntake` の隣の仕組み（`intakeGen` / `intakeGenOf`）、`createRefreshGate`（`refreshGate.ts`）、段階 2 の `s.execSel`
- Produces: `State.intakeStale: Record<string, number>` — Intake の詳細を消さずに取り直したい回数。その Intake のタスクのイベントで増える

詳細を `invalidateIntake` で消すと、取り直しの間 `ExecutionView` が「読み込み中」になり、パネルのタスク画面・レビュー画面が外れて読んでいた位置を失う。ステップのたびにそれが起きるので、帯の取り直しは詳細を残したまま行い、古い応答の追い越しは `refreshGate` で防ぐ。`j` / `k` は段階 2 の `move` が Execution の一覧を動かすので、この段階では足さない。

- [ ] **Step 1: 失敗するテストを書く**

`app/src/model.test.ts` の `base` の既定値に `intakeStale: {},` を足し、末尾に足す（`base` / `detailOk` / `intakeEv` / `NOW` は既存のもの）:

```ts
describe("Intake に属するタスクのイベントで帯を取り直す", () => {
  const owned = { ...seedTasks()[0], id: "t-x", intake: { id: "a", processId: "p1", issueUrl: null, parentIssueUrl: null } };
  const loose = { ...seedTasks()[0], id: "t-y", intake: null };
  const withDetail = () => base({ tasks: [owned, loose], intakeDetails: { a: detailOk("a") }, intakeStale: {} });

  test.each([
    { event: "task.stateChanged", task_id: "t-x", from: "running", to: "suspended" },
    { event: "stepRun.started", task_id: "t-x", step_run_id: 1, step_id: "impl" },
    { event: "stepRun.finished", task_id: "t-x", step_run_id: 1, step_id: "impl", status: "success", attempt: 1, goto_step_id: null },
  ] as ServerEvent[])("$event は詳細を残したまま取り直しを頼む", (ev) => {
    const after = intakeEv(ev, withDetail());
    expect(after.intakeStale.a).toBe(1);
    expect(after.intakeDetails.a).toEqual(detailOk("a"));
  });

  test("Intake に属さないタスクと、詳細を持っていない Intake は頼まない", () => {
    expect(intakeEv({ event: "stepRun.started", task_id: "t-y", step_run_id: 1, step_id: "impl" }, withDetail()).intakeStale).toEqual({});
    const s = base({ tasks: [owned], intakeDetails: {}, intakeStale: {} });
    expect(intakeEv({ event: "stepRun.started", task_id: "t-x", step_run_id: 1, step_id: "impl" }, s).intakeStale).toEqual({});
  });
});
```

`stepRun.finished` のイベントの形は `shared/protocol.ts` の `ServerEvent` に合わせる（足りないフィールドがあれば足す）。

- [ ] **Step 2: 失敗を確かめる**

Run: `builtin cd /Users/shunsuke.tadokoro/orca/workspaces/doctrine/app_ux/app && pnpm vitest run src/model.test.ts`
Expected: FAIL（`intakeStale` が無い）

- [ ] **Step 3: 実装する**

`app/src/model.ts`:

`State` の `intakeGen` の隣に足す:

```ts
  /** Intake の詳細を消さずに取り直したい回数。その Intake のタスクのステップと状態が動くたびに増える（spec 7.2） */
  intakeStale: Record<string, number>;
```

`invalidateIntake` の後に足す:

```ts
/** タスクが動いたら、詳細を持っている Intake の帯を取り直す。消すと取り直しの間パネルが外れる */
function touchIntakeOfTask(s: State, taskId: string): Partial<Pick<State, "intakeStale">> {
  const id = s.tasks.find((x) => x.id === taskId)?.intake?.id;
  if (id === undefined || s.intakeDetails[id]?.kind !== "ok") return {};
  return { intakeStale: { ...s.intakeStale, [id]: (s.intakeStale[id] ?? 0) + 1 } };
}
```

`reduce` の `daemon` で:
- `task.stateChanged` の戻り値に `...touchIntakeOfTask(s, ev.task_id),` を足す
- `stepRun.started` の戻り値を `{ ...s, now: a.now, tasks: updateTask(s, ev.task_id, { step: ev.step_id }), ...touchIntakeOfTask(s, ev.task_id) }` にする
- `stepRun.finished` の `if (Object.keys(patch).length === 0) return s;` を `return { ...s, ...touchIntakeOfTask(s, ev.task_id) };` にし、最後の戻り値にも `...touchIntakeOfTask(s, ev.task_id)` を足す

`app/src/store.tsx`:

`initialState` に `intakeStale: {},` を足す。

`StoreProvider` の `refreshGate` の隣に足す:

```ts
  // 帯の取り直しは詳細を消さずに何本も走る。最後に始めた 1 本だけを反映する
  const [detailGate] = useState(() => createRefreshGate());
```

「開いている Intake の詳細」の effect の後に足す:

```ts
  // Execution で開いている Intake のタスクが動いたら、詳細を残したまま取り直す（spec 7.2）
  const execId = s.view === "execution" ? s.execSel : null;
  const stale = execId === null ? 0 : s.intakeStale[execId] ?? 0;
  useEffect(() => {
    if (execId === null || stale === 0) return;
    const id = execId;
    const gen = intakeGenOf(latest.current, id);
    const token = detailGate.begin();
    void rpc("intake.get", { intake_id: id })
      .then((value) => {
        if (detailGate.isLatest(token)) dispatch({ type: "intake.detail", id, gen, loaded: { kind: "ok", value } });
      })
      // 落ちたら前の詳細を残す。次のイベントか 15 秒の取り直しで追いつく
      .catch(() => {});
  }, [execId, stale]);
```

`intake.detail` の reducer は gen が古ければ捨てるので、取り直しの最中に `intake.updated` で詳細が消えた場合もこの応答は反映されない。

- [ ] **Step 4: 通ることを確かめる**

Run: `builtin cd /Users/shunsuke.tadokoro/orca/workspaces/doctrine/app_ux/app && pnpm vitest run src/model.test.ts && pnpm exec tsc`
Expected: PASS、tsc が通る

- [ ] **Step 5: コミット**

```bash
git add app/src/model.ts app/src/model.test.ts app/src/store.tsx
git commit -m "タスクが動いたら Execution の帯を詳細を消さずに取り直す

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: 開発者ガイドを直す

**Files:**
- Modify: `docs/developer-guide/07-app.md`（7.3、7.4 の冒頭と表、7.5 の表。段階 2 が書き換えた後の文面を直す）

- [ ] **Step 1: 7.4 を直す**

冒頭の段落（段階 2 が書いたもの）:

```markdown
本体は `view`（`intake` / `execution` / `settings`）で振り分ける。Execution の本体（`ExecutionView`）は選んだ Intake の図を出し、
図の下のスロットに、選んだ要素の欄と、開いたタスクの画面（`suspended` なら `ReviewView`、それ以外なら `TaskView`）を出す。
```

を次にする:

```markdown
本体は `view`（`intake` / `execution` / `settings`）で振り分ける。Execution の本体（`ExecutionView`）は選んだ Intake の図を出す。
plan は承認された案、direct は `pfd.ts:directPfd` で組み立てた Issue → タスク → PR の図で、プロセスのノードにはいまのタスクのステップの帯が入る。
ノードを選ぶと画面の下のパネル（`ExecDetail`、枠は `ExecPanel`）に、要素の欄・人の操作・タスク画面・レビュー画面のどれかを出す（`execution.ts:panelContentOf`）。
パネルのタスクは `s.sel` が決め、ノードを選ぶと `task.open` で合わせる。
```

表の「Execution」の行のファイルに `components/ExecDetail.tsx`、`ExecPanel.tsx`、`useCall.ts`、`PfdDiagram.tsx`、`PfdElementPanel.tsx` を足し、RPC に `intake.completeHumanProcess`、`intake.redispatch`、`intake.processPrompt` が入っていることを確かめる（無ければ足す）。タスク画面とレビュー画面の行の説明に「Execution の下のパネルに開く」を足す。

- [ ] **Step 2: 7.5 と 7.3 を直す**

7.5 の表:

```markdown
| `execution.ts` | Execution の導出（一覧に並ぶか・区切り・並び、一覧の行とプロセスごとの人の番、下のパネルに出すもの `panelContentOf`、パネルの高さの記憶） |
| `pfd.ts` | PFD の図の配置。列は `diagram.ts:layoutGraph` の最長路に任せ、列の中の順は重心法で交差を減らす。Execution の図のステップの区画（`railSegments`）と direct の図（`directPfd`）もここ |
```

7.3「イベントの反映」に 1 行足す: 「Intake に属するタスクの `task.stateChanged` / `stepRun.*` は `intakeStale` を増やし、Execution で開いている Intake の詳細を消さずに取り直す（古い応答は `refreshGate` で捨てる）」。

- [ ] **Step 3: コミット**

```bash
git add docs/developer-guide/07-app.md
git commit -m "開発者ガイドに Execution の図の帯と下のパネルを書く

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
