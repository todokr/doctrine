# doctrine ワークフローレール設計

- 日付: 2026-09-20
- 状態: 実装済み。見せ方（4 章の「見せ方」以降と戻り矢印の規則）は [状態の見せ方の統一設計](2026-09-22-status-visual-design.md) の 3.1 で置き換えた
- 前提: [overview](../../overview.md)、[レビューアプリspec](2026-09-13-review-app-design.md)、[task.context spec](2026-09-19-task-context-design.md)

## 1. 何を作るか

`TaskView` は今、`stepRunHistory` の逆順リストで「何が起きたか」を出している。
足りないのは「ワークフロー全体のどこにいるか」である。ワークフロー定義を
一列の図にして、各ステップの状態・試行回数・差し戻しの本数を重ねた帯を、
状態ピルの下・ログの上に置く。履歴リストは残す（役割が違う）。

## 2. 描画手段の決定: React Flow は使わない

`core/src/workflow/schema.ts` のワークフローは `steps[]` の一列と、
`onFailure` / `onReject` の `goto` による後戻りだけで、任意の DAG ではない。
前へ進む辺は隣接ステップに固定、戻る辺は必ず左向き。ノードの座標は配列の
添字で決まり、レイアウト計算の余地がない。React Flow が持ち込む価値
（自動レイアウト・ドラッグ・パン/ズーム・ハンドル接続）はどれも使わないので、
依存を足さず、`app/src/components/Diagrams.tsx` と同じ手書き SVG で描く。

新しい依存パッケージを足さないこと。

## 3. 線に載せるもの: task.get に steps を足す

新しいデーモンのメソッドは作らない。帯が要るのは `useTaskDetail` が既に
`task.get` を取り直す契機（`t.state` / `t.step` / `t.degraded` の変化）と同じで、
別メソッドにすると同じ契機で 2 回叩くことになるだけである。

`shared/protocol.ts` に足す:

```ts
/** 帯が描くために要る分だけ。prompt / run / allowedTools / feed は出さない。 */
export type StepView = {
  id: string;
  type: "command" | "agent" | "approval";
  title?: string;
};

export type TaskDetail = { task: TaskSummary; stepRuns: StepRun[]; steps: StepView[] | null };
```

`core/src/daemon/handlers.ts` の `task.get` は、同じファイルの `task.context`
（`getProject` → `ctx.loadWorkflow` → `withSetupStep(..., project.setup ?? undefined)`
→ `.catch(() => null)`）をそのまま写す。

- `setup` は `project.yaml` に `setup` があるときだけ先頭に生える。画面には
  必ず `withSetupStep` を通した後の列を渡すこと。生の YAML を返すと、実際に
  走る列と図がずれる。
- `steps` が `null` になるのは **ワークフロー YAML が読めないとき**の意味。
  読み取り専用の経路をワークフローの不備で失敗させないための扱いで、
  `task.context` と同じ理由である。これ以外の用途に広げないこと。

## 4. 描画モデルは純関数に切る

`app/src/rail.ts` と `app/src/rail.test.ts` を新設する
（`app/src/patch.ts` / `app/src/tailStick.ts` と同じ流儀。副作用を持たない）。

`(steps, stepRuns, task) => { nodes, arcs, height }` の形にし、
`app/src/components/WorkflowRail.tsx` は `Diagrams.tsx` の隣に置いて、
このモデルを SVG に写すだけにする。

導出の規則:

- ノードの status は、その `step_id` の **最後の** `stepRun` の `status`。
  `core/src/db/stepRuns.ts` の `listStepRuns` は `orderBy("id")` の昇順なので末尾を取る。
  その `step_id` の run が 1 件も無ければ「まだ実行していない」状態にする。

見せ方: [状態の見せ方の統一設計](2026-09-22-status-visual-design.md) の 3.1 を見ること。

## 5. YAML が編集されて列がずれたとき

`core/src/domain/engine.ts` は既に同じ問題を踏んでいる（承認ステップが消えると
`findIndex` が -1 を返す件のコメントを参照）。画面側も次のように扱う。

- `steps` に無い `step_id` の `stepRun` と、`steps` に無い `current_step_id` は、
  **末尾に破線のノードとして生やす**。黙って落とすと、いま止まっているステップが
  図から消える。それが一番まずい失敗である。
- `steps` が `null` のときは帯を描かない。履歴リストだけで画面は成り立つ。

## 6. 片付け

`app/src/types.ts` の `StepDef` と `app/src/fixtures.ts` の `WORKFLOWS` を削除する。
どちらも今どこからも使われておらず（互いに参照し合っているだけ）、`onReject` が
`string` になっていて実際の `Branch` と形が違う、モック時代の遺物である。
doctrine にはまだ利用者がいないので、後方互換の仕掛けは作らず参照ごと書き換える。

## 7. テスト

`app/src/rail.test.ts`:

- `.doctrine/workflows/default.yaml` と同じ形（9 ステップ・後戻り 4 本）で、
  レーン割りの結果が交差しないこと
- status / 試行回数 / 差し戻し回数の導出
- `steps` に無い `step_id` が末尾の破線ノードになること
- `steps` が `null` のとき帯を描かないこと

`core/test/daemon/handlers.test.ts`:

- `task.get` が `setup` を先頭に含む `steps` を返すこと
- ワークフロー YAML が壊れているとき `steps` が `null` になり、
  `task` と `stepRuns` は従来どおり返ること

## 8. やらないこと

- 専用のワークフロー画面（縦に開いてステップごとの詳細・ログを出すもの）
- 複数タスクを 1 本のワークフローの上に並べる俯瞰画面
- 新しいデーモンのメソッド
- ワークフロー定義を画面から編集する手段
