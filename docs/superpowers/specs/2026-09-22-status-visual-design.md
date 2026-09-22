# doctrine 状態の見せ方の統一設計

- 日付: 2026-09-22
- 状態: 承認済み。実装計画の作成待ち
- 前提: [ワークフローレールspec](2026-09-20-workflow-rail-design.md)、[レビューアプリspec](2026-09-13-review-app-design.md)、[Intake UI spec](2026-09-21-intake-ui-design.md)
- UI 案: <https://claude.ai/artifact/M5u918bk667C3KEDxxoyk8>（v2）

## 1. 何を作るか

アプリの状態の見せ方を、画面ごとのピル・記号アイコン・塗りから、**5 つの色（トーン）と
バー・ドット**に揃える。あわせて、見出しに mono の小さなラベルを付け、レビュー画面の
指示と差し戻しの出し方を変える。

変えないもの:

- 文字の大きさと余白（本文 13px / 1.5、題名 19px、`.pad` の 18px 22px、サイドバー 288px）
- 画面の構成と操作、キー操作
- PFD の図のレイアウトと線

見た目はライトで決める。ダークは見た目を作り込まず、壊れないように新しいトークンの
ダークの値だけを足す。色はすべてトークンを通す。

## 2. トーン

状態の色はアプリ全体で次の 5 つだけにする。バー・ドット・淡い地・文字で使うトークンを
トーンごとに決める。

| トーン | 意味 | バー・ドット | 淡い地・輪 | 文字 |
|---|---|---|---|---|
| `ok` | 済んだ（成功・完了・マージ済み） | `--ok` | `--ok-bg` | `--ok` |
| `run` | 機械が動いている | `--run` | `--run-bg` | `--run` |
| `danger` | 失敗した・差し戻された・人が見に行く必要がある | `--danger` | `--danger-bg` | `--danger` |
| `human` | 人の判断を待っている | `--accent` | `--accent-soft` | `--human-text`（新設） |
| `idle` | まだ・待ち・止めてある | `--idle`（新設） | `--surface-2` | `--ink-3` |

新設するトークンは 2 つ。どちらもダークの 2 か所の定義（`prefers-color-scheme` の中と
`[data-theme="dark"]`）の両方に足す。

- `--idle`: ライト `#D3D9DF`、ダーク `#3A414B`。バーにだけ使う。白地の文字には薄すぎるので、
  idle の文字は `--ink-3` にする
- `--human-text`: ライト `#8A5A17`、ダーク `#E0A857`。アンバーの文字用。今の
  `--accent-text` はライトで `#20140A`（ほぼ黒）で、アンバーの地の上の文字のためのもの
  なので、白地のアンバーの文字には使えない。UI 案の `--accent-link` と同じ値である

### 2.1 対応表は `app/src/tone.ts` に 1 つにまとめる

`tone.ts` と `tone.test.ts` を新設する。`Tone = "ok" | "run" | "danger" | "human" | "idle"` と、
次の 6 つの対応を持つ。文言は今の定義から動かさない。

| 対象 | ok | run | danger | human | idle |
|---|---|---|---|---|---|
| TaskState | completed | running | failed, unknown | suspended | queued, paused, rate_limited, canceled |
| StepRun status（+ pending） | success | running | failed, bounced | awaiting | interrupted, rate_limited, pending |
| IntakeState | completed | investigating, decomposing, active | needs_attention | answering, reviewing | canceled |
| ProcessStatus | merged, done | running, ready（破線） | needs_attention | your_turn, pr_open | waiting（破線） |
| サイドバーのタスクの区分（`groupOf`） | done のうち completed | running | check | review | limited, queued, paused、done のうち completed 以外 |
| サイドバーの Intake の区分（`intakeSection`） | closed のうち completed | working | attention のうち needs_attention | attention のうち needs_attention 以外 | active、closed のうち completed 以外 |

- `STATE_PILL`（TaskView.tsx）、`RUN_PILL`（model.ts）、`INTAKE_STATE`（intake.ts）は、
  `[文言, pillクラス]` から `[文言, Tone]` に変える。`LOOK`（pfd.ts）は `cls` を `tone` と
  `dashed` に置き換える。
- **UI 案からの変更が 1 つある。** 案の「状態の色」タブでは interrupted を danger に入れた。
  しかし `model.test.ts` は「interrupted と failed は見た目で区別できること」を確かめている。
  中断はデーモンの再起動で起きるもので、ステップの失敗ではない。この区別を残すため
  interrupted は idle にする。
- bounced は今の muted から danger に変える。帯で「差し戻された」を赤で見せるためである
  （3.1）。
- **pr_open は今の run（青）から human に変える。** UI 案では描いていない。PR のマージは
  overview で人が判断する 4 か所の 1 つなので、機械が動いている青ではなく人の色にする。
- **active の Intake は今の muted から run に変える。** UI 案で「進行中」を青で描いたとおり。
- サイドバーは TaskState ではなく区分（`groupOf` / `intakeSection`）からトーンを引く。
  要確認の区分には、削除を拒否された completed のタスク（`refused`）も入るので、状態から
  引くとそこだけ緑になってしまう。

## 3. 見せ方

### 3.1 ワークフローの帯（WorkflowRail）

SVG の箱と戻り矢印をやめ、ステップごとに **6px のバーとその下の mono のステップ名**を
横一列に並べる。帯は枠で囲まず、`.pad` の幅いっぱいに使う。各ステップは
`flex: 1 0 92px` で、合計が幅を超えるときだけ帯の中で横にスクロールする。

- バーの色はそのステップの最後の run のトーン。run が無ければ idle
- 今のステップ（`current`）は、バーに同じトーンの淡い 3px の輪を付け、名前を太くする
- `type: "approval"` のステップは、まだ来ていないうちはアンバーの破線、今そこで止まって
  いるときはアンバーの実線にする。済んだ後は ok
- steps に無いステップ（`unknown`）は、バーを `--ink-3` の破線にする
- approval の `title` はこれまでどおりツールチップ（`title` 属性）に出す
- 帯の下に凡例を 1 行置く: 済み / 実行中 / 失敗・差し戻し / 人の承認 / 未実行。
  凡例はタスク画面だけに置き、レビュー画面の帯には置かない
- `steps` が null（ワークフロー YAML が読めない）なら、これまでどおり帯を描かない

**戻り矢印と試行回数のバッジ（×N）は描かない。** 何回戻ったかは実行履歴で読む。

これに合わせて、矢印のためだけにある値を消す。

- `shared/protocol.ts` の `StepView.branch` を消す。`core/src/daemon/handlers.ts` の
  `toStepViews` から `branchOf` の呼び出しを消す（`branchOf` はエンジンが使うので残す）。
  `core/test/daemon/handlers.test.ts` と `workflowPin.test.ts` の `branch` / `maxAttempts`
  を期待しているアサーションを直す
- `rail.ts` を削る。`buildRail` は `nodes`（`id` / `type` / `title` / `status` /
  `current` / `unknown`）だけを返す。`RailArc`・`lane`・`laneY`・`attempt`・`NODE_W`
  などの座標の定数は消す。`rail.test.ts` のうち矢印・レーン・attempt のアサーションは
  消し、status と unknown の導出のテストは残す

[ワークフローレールspec](2026-09-20-workflow-rail-design.md) の 4 章の「戻り矢印」の
規則と見せ方は、この spec で置き換えたと書き換える。

帯は **タスク画面とレビュー画面の両方**に出す。レビュー画面は今 `task.get` を取っていない
ので、TaskView.tsx の `useTaskDetail` を export し、ReviewView でも呼ぶ。

### 3.2 状態のドット（ピルの置き換え）

`.pill` と `.p-*` を消し、**色のドットと文字**の `StatusDot`（`tone` と文言を受け取る）に
置き換える。ドットは 7px で、同じトーンの淡い 3px の輪を付ける。文字もトーンの色にする。

置き換える場所:

- タスク画面の見出しの状態（STATE_PILL）
- 実行履歴の表の状態（RUN_PILL）。権限拒否があるときのボタンはそのまま `StatusDot` を包む
- レビュー画面の見出し。「◆ {step}」と「N回目のレビュー」の 2 つのピルは、
  `StatusDot`（レビュー待ち）+「ステップ {step}」+「N 回目のレビュー」の文字にする
- Intake の見出し（INTAKE_STATE）、「操作が必要」の各行（あなたの番 / 要確認）
- worktree の表の状態、「未コミットの変更あり」「古い」（human）
- IssuePicker の「Intake あり」（idle）

### 3.3 サイドバーの一覧

行頭の記号アイコン（StateIcon / IntakeIcon と `.diamond` `.bang` `.spin` `.ring`
`.pause` `.hourglass` `.check` `.xmark`）をやめ、**行の左端の 3px の縦バー**をトーンの
色にする。グループの見出しで状態の違い（待ち / 一時停止 / 上限待ち）を読む。

Intake の行の状態ピルもやめ、メタ行に文言だけを出す（例: 「進行中 · 0/9」）。

### 3.4 PFD のプロセス

プロセスの状態を、箱の塗りと枠線の種類で表すのをやめる。**箱の上端に 4px のバー**を
描き、トーンの色にする。ready と waiting はバーを破線にする。

- 箱の塗りは状態によらず `--surface` にする。人のプロセスの二重枠、`given` `goal`
  `decision` `available` `frozen` `selected` の見せ方は変えない
- 状態の記号（▷ ⟳ PR ✓ ◆ !）は描かない。`LOOK.mark` を消す。状態の文言は今どおり
  `aria-label` に入れる。`n.marks`（状態以外の記号）はそのまま描く

### 3.5 Intake の状態ごとの件数

Intake の進行中の面の、ボタンの行の下に**状態ごとの件数**を並べる。各項目は mono のラベル
（状態の文言）・件数・4px のバー（3.4 と同じ色と破線）で、凡例を兼ねる。

- 凡例を兼ねるので、件数 0 の状態も出す。並びは ProcessStatus の定義順。ただし
  merged は末尾に「マージ済み n / 全プロセス数」の形で出す
- 件数は `pfd.ts` に `statusCounts(view)` として純関数で足す

### 3.6 レビュー画面の指示とフィードバック

`Context` と `History` を、次の縦の並びに作り直す。

1. **指示**: `t.prompt` を、既定では 4 行で切って出す（`-webkit-line-clamp: 4`）。
   下に「全文を表示」/「4 行に畳む」のトグルを置く。開閉はコンポーネントの中だけで持ち、
   タスクを切り替えたら畳んだ状態に戻す。4 行に収まる指示ではトグルを出さない。
   収まるかどうかは、畳んだ状態で `scrollHeight > clientHeight` を `useLayoutEffect` で
   測って決める
2. **前回のフィードバック**: `rejections(c)` の最後（`listStepRuns` が id の昇順なので、
   最後がいちばん新しい）を、畳まずに出す。アンバーの 3px の左線と `--accent-soft` の地。
   ラベルの横に時刻・経過・ステップ id を出す。差し戻しが無ければこの行ごと出さない
3. **それ以前の N 件**: 2 件以上あるとき、残りを新しい順に畳んで出す
4. **直近の command ステップの結果**: 今の `details` のまま、ラベルだけ変える

`review.files` の折りたたみは今のまま。

### 3.7 ガイド

- **目次（flowtoc）**: 枠と `✓` をやめ、各項目の左端に 3px の縦バーを置く。読み終えた節は
  `--ink-3`、今の節は `--accent`（地は `--accent-soft`）、まだの節は idle
- **グループの解説（flow-note）**: アンバーの地と枠の箱をやめ、左の 3px のアンバーの線だけ
  で区切る。「判断」「リスク」「テスト」の見出しは mono のラベルにする
- **影響（ImpactBadge）**: 地と枠の違う 3 種類のバッジをやめ、短いバー + mono の文言に
  する。色は大 = `--danger`、中 = `--human-text`、小 = `--ink-3`
- **hunk の上のリスク（RiskNote）**: 地を、載っているリスクのうち最も大きい影響の淡い色
  にする（大 = `--danger-bg`、中 = `--accent-soft`、小 = `--surface-2`）

## 4. mono のラベル

`.lbl` を足す: `font-family: var(--mono)`、10px、`letter-spacing: .14em`、大文字、
`--ink-3`、500。グループの見出し（Group i / n）だけは `--human-text` にする。日本語の見出しにも同じクラスを使う（大文字化は英字にだけ効く）。

付ける場所:

| 画面 | 今 | ラベル |
|---|---|---|
| パンくず | — | 先頭に Task / Review / Intake |
| タスク | `<b>ログ</b>`、`<summary>実行履歴</summary>` | Workflow（帯の上）、Log、History |
| レビュー | `<b>元の指示</b>`、`<b>変更</b>` | 指示、前回のフィードバック、Last command、Changes |
| ガイド | flowtoc の「ガイドの順」、グループの「グループ i / n」 | Guide · ガイドの順、Group i / n |
| サイドバー | `.grp h3` のグループ名 | 同じ文言を `.lbl` で |
| 利用上限 | 「5時間枠」「7日枠」 | 同じ文言を `.lbl` で |
| Intake 詳細パネル | 種類・説明・確かめ方・前段・後続の見出し | 同じ文言を `.lbl` で |

ここに挙げていない画面（worktree・設定・IssuePicker・PlanReview・IntakeHistory）の
見出しは変えない。ピルの置き換え（3.2）だけが及ぶ。

## 5. 消すもの

- ログの見出しの「追従中」の表示（`TaskView.tsx` の `.spin` の行）。追従そのものは続ける
- `.pill` `.p-*` `.runtable button.pill`、サイドバーの記号アイコンのクラスとキーフレーム
- `.wr-*` の SVG 用のクラス、`.impact-*`、`.flow-note` の地と枠

## 6. テスト

- `tone.test.ts`（新設）: 6 つの対応表が、それぞれの状態の全値を覆っていること。
  interrupted と failed のトーンが違うこと
- `rail.test.ts`: 3.1 のとおり削る。approval のステップに `type` が載ることを足す
- core: `handlers.test.ts` / `workflowPin.test.ts` の `StepView.branch` を期待する箇所を直す
- `model.test.ts:1301-1305`: クラスの比較をトーンの比較に変える
- `pfd.test.ts:135-155`、`PfdDiagram.test.tsx:85-100`: `cls` と `mark` のアサーションを、
  トーンと破線、`aria-label` の文言の確認に変える
- `pfd.test.ts` に `statusCounts` のテストを足す（件数 0 の状態も返す、マージ済みの
  分母は全プロセス数）
- ReviewView のテストを足す: 差し戻しが 0 / 1 / 3 件のときの「前回のフィードバック」と
  「それ以前の N 件」の出方。4 行を超えない指示でトグルが出ないこと
- 文言に依存している既存のテスト（IntakeProgress / IntakeView / WorktreeView /
  PlanReview / intake）は、文言を変えないので通ったままになる

## 7. やらないこと

- 文字の大きさ・余白・画面の構成の変更
- 4 章の表に無い画面の見出しの変更
- PFD の図のレイアウト・線・節の形の変更
- 実行中を示すアニメーション（スピナーの代わり）の追加
