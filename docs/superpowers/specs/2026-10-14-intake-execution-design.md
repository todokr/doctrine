# アプリの再構成: Intake と Execution

- 日付: 2026-10-14
- 状態: 設計合意
- 前提: [Intake の PRD](../../prd/intake.md)、[Intake のコア設計](2026-09-21-intake-core-design.md)、[Quick Start の設計](2026-09-27-quick-start-design.md)（本 spec が setup のタスクを取り除く）

## 1. 何が問題か

いまのアプリは Rail に Intake・タスク・終了したタスク・worktree と警告の 4 つのビューを並べている。
Issue を取り込んで PFD で分解する流れは Intake に、ワークフローを直接走らせる流れは Composer とタスクの一覧に分かれていて、
同じ「Issue を片付ける」仕事が、大きさによって別の画面・別の操作になっている。
さらに Intake の進行中の面は、PFD の図でプロセスの状態を色の線 1 本で示すだけで、各タスクのワークフローがどこまで進んだかは
タスク画面を開かないと分からない。

**入口を Issue に一本化し、画面を「取り込む（Intake）」と「進める（Execution）」の 2 つに割る。**
Issue を取り込むとき、計画して複数の PR に分ける（plan）か、1 本の PR ですぐ実行する（direct）かを選ぶ。
どちらで取り込んでも、実行の様子は Execution の同じ図で見る。図のプロセスのノードにはワークフローのステップの帯が入り、
人の番のノードは強調される。ノードを選ぶと、画面の下にタスクの詳細が開く。

## 2. 決定の要約

| 項目 | 決定 | 章 |
| --- | --- | --- |
| Rail | Intake と Execution の 2 つ。下端に workspace の追加と設定 | 3 |
| 取り込みの種類 | `plan`（計画して進める）と `direct`（すぐ実行する）。`intakes.mode` に持つ | 4.2 |
| Intake の一覧 | 承認前の Intake と改訂中の Intake だけ。direct は一度も出ない | 4.1 |
| direct の中身 | 調査も分解も sub-issue も無し。開始と同時に `active`、プロセス 1 行とタスク 1 本を作る | 5 |
| direct のワークフロー | プロジェクトの既定 | 5.1 |
| Execution の骨格 | 左に Issue の一覧（進行中 / 終了）、右に選んだ Issue の図 | 6 |
| 図 | いまの PFD の図のまま、プロセスのノードを大きくしてステップの帯を描く | 6.2 |
| 人の番 | タスクの承認待ち・プロセスの要確認・人のプロセスの番 | 6.3 |
| ノードの詳細 | 画面の下のパネル。高さ可変・最大化あり。タスク画面もレビュー画面もここに出す | 6.5 |
| 承認後の操作 | すべて Execution。改訂を始めると Intake へ移る | 6.4 |
| ステップの帯のデータ | `intake.get` のプロセスに、いまのタスクの帯を載せる | 7.1 |
| 廃止 | Composer、タスクの一覧、終了したタスク、worktree と警告の画面、setup のタスク | 8 |
| 触らない | `task.create` と `dctl`（別の作業で消す） | 8.3 |

## 3. Rail とビュー

- Rail には Intake と Execution だけを置く。下端の workspace の追加と設定はいまのまま残す
- `view` は `"intake" | "execution" | "settings"` の 3 つにする。`"tasks"` / `"done"` / `"worktrees"` は消して参照をすべて書き換える
- Rail の点は 2 つの関数で決める。いまの `intake.ts:countIntakeAttention` は承認前の判断と承認後の人の番を混ぜて数えているので分ける

| 点 | 立つ条件 |
| --- | --- |
| Intake | `answering` / `reviewing` / `needs_attention` の Intake があるとき（改訂中の Intake もこの状態を通る） |
| Execution | 6.3 の「人の番」のノードを持つ Intake があるとき |

## 4. Intake

### 4.1 一覧

一覧に出すのは、承認前の Intake（`investigating` / `answering` / `decomposing` / `reviewing` / `needs_attention`）と、
改訂中（`revising = 1`）の Intake だけである。承認すると一覧から消えて Execution に現れ、改訂を始めると再び現れる。
終端（`completed` / `canceled`）は出さない。承認前に中止した Intake も Execution の「終了」で読み返す（6.1）。

一覧が空のときは、Issue を選ぶ画面（`IssuePicker`）をそのまま出す。

### 4.2 開始

Issue を選んだ後、開始のボタンの前で取り込みの種類を選ぶ。

| 種類 | 画面の文言 | 補足の文言 | その後 |
| --- | --- | --- | --- |
| `plan` | 計画して進める | 複数の PR に分ける | いまの流れ（調査 → 回答 → 分解 → レビュー → 承認） |
| `direct` | すぐ実行する | 1 本の PR で済ませる | 開始と同時に Execution へ移り、その Issue を選んだ状態になる |

既定の選択は置かない。どちらにするかは Issue の大きさを見て人が決める判断なので、毎回選ばせる。

### 4.3 改訂

改訂は Execution の見出しの「改訂を始める」から入る（6.4）。改訂中の Intake を Intake の一覧から選ぶと、いまの改訂の面
（コメントを付けて改訂を始める面、改訂の案のレビュー）が出る。再承認か改訂の放棄で `revising = 0` に戻り、Intake の一覧から消える。

## 5. direct

### 5.1 開始

`intake.start` に `mode: "plan" | "direct"`（省略不可）を足す。`intakes` に `mode` 列（`TEXT NOT NULL`、`plan` / `direct`）を足し、
`IntakeSummary` にも `mode` を載せる。

`direct` で開始すると、デーモンは 1 つのトランザクションで次を作る。

1. Intake の行。状態は `active`
2. `intake_processes` の行 1 つ。プロセスの id は `main`。sub-issue は持たない
3. タスク 1 本。タイトルは Issue のタイトル、プロンプトは Issue の本文、ワークフローはプロジェクトの既定、
   `issue_url` は Issue そのもの、`parent_issue_url` は null、`intake_id` / `intake_process_id` は 1 と 2 を指す

調査・分解の実行、PFD の案と承認、sub-issue の同期、投入（`dispatchIntake`）は direct では一度も走らない。

プロセスの行を 1 つ持たせるのは、承認後の仕組みがプロセスを単位に組まれているからである。
`TaskSummary` の「`intake_id` と `intake_process_id` は両方 null か両方非 null」を守ったまま、
再投入・PR の観測・要確認・`ProcessTrail`・`task_ids` を分岐なしで使い回せる。
PFD は保存しない。図は画面が組み立てる（6.2）。

### 5.2 状態

`core/src/domain/intakeStates.ts:INTAKE_TRANSITIONS` に `[*] → active`（direct の開始）を足す。

| 操作 | direct での扱い |
| --- | --- |
| `intake.revise` | 拒否する（改訂する計画が無い） |
| `intake.setDispatchPaused` | 拒否する（投入が無い） |
| `intake.redispatch` | `main` に新しいタスクを作って置き換える。sub-issue の有無は確かめない |
| `intake.cancel` | いまと同じ。`stop` は走っているタスクを止める。閉じる sub-issue は無い |
| `intake.closeIssue` | いまと同じ |
| `intake.completeHumanProcess` | 対象が無い（人のプロセスが無い） |

### 5.3 プロセスの状態と完了

`computeProcessStatuses` は PFD を入力に取るので direct には使えない。direct 用に、`main` のタスクと観測した PR だけから
状態を求める関数を `core/src/intake/` に足す。取りうる状態は `running` / `pr_open` / `merged` / `needs_attention` だけである
（`waiting` / `your_turn` / `done` は人のプロセスか入力の成果物が要るので起きない。`ready` はタスクを開始と同時に作るので起きない）。

見張りは direct の Intake も対象にする。sub-issue の同期と投入は飛ばし、PR の観測だけを行う。
`main` が `merged`（マージコミットが `origin/<base>` に届いたことの確認まで含む、いまの判定）になったら `completed` にする。
親 Issue を閉じないのは plan と同じ。

## 6. Execution

### 6.1 一覧

左のサイドバーに Issue（Intake）を並べる。上部に「進行中」と「終了」の切り替えと、workspace の絞り込み（`WorkspaceFilterSelect`）を置く。

| 区切り | 出すもの | 並び |
| --- | --- | --- |
| 進行中 | `active` の Intake（改訂中を含む） | 人の番があるものを上に、その中は更新の新しい順 |
| 終了 | `completed` / `canceled` の Intake（承認前に中止したものも含む） | 更新の新しい順 |

行には workspace の点と名前、`#番号 タイトル`、plan / direct の印、進み具合（`progress`）を出し、人の番がある行には点を付ける。
改訂中の行には「改訂中」の印を付ける。改訂中に選んでも、図はいま承認されている案で描く。

承認前に中止した Intake は図を持たないので、選ぶといまと同じく経緯（`IntakeHistory`）だけを出す。

### 6.2 図

いまの進行中の面の図（`PfdDiagram`、配置は `pfd.ts`）を使い回し、プロセスのノードの高さを足して、ラベルの下にステップの帯を描く。

- 帯の 1 区画がワークフローの 1 ステップ。区画の色は最後の実行の状態で、`tone.ts` から引く。いまのステップには印を付ける
- 区画はノードの幅を等分する。ステップが多くて区画が細くなりすぎる場合も、幅を広げず詰める
- タスクがまだ無いプロセス（`waiting` / `ready`）は帯を灰色の 1 本で描く。人のプロセスは帯を描かず、状態の文言を出す
- direct は、Issue（成果物）→ タスクのプロセス（`main`）→ PR（成果物）の 3 つのノードを画面で組み立てて描く。
  組み立ては `pfd.ts` に置き、`buildPfdView` が受け取れる形にする。保存はしない

### 6.3 人の番

人の番のノードは、枠を太くして強調の色にする。判定は画面で行う。

| 人の番 | 判定 |
| --- | --- |
| タスクの承認待ち | そのプロセスのいまのタスクが `suspended` |
| 要確認 | プロセスが `needs_attention` |
| 人のプロセスの番 | プロセスが `your_turn` |

PR のマージ待ち（`pr_open`）は人の番に入れない。

`IntakeSummary.needs_human` は承認前の状態を含み、タスクの承認待ちを含まないので、Execution では使わない。
一覧の点と Rail の点は、`active` の Intake について「`needs_human` が真（`active` ではプロセスの `your_turn` / `needs_attention` と同じ意味になる）、
または store のタスクの一覧にその `intake_id` を持つ `suspended` のタスクがある」で求める。要約に列を足す必要は無い。

図の上の `StatusCounts` に「あなたの番 N 件」を足す。押すと、図の中の先頭の人の番のノードを選ぶ。

### 6.4 見出しと操作

図の上に見出しを置く。`#番号 タイトル`、workspace、状態、plan / direct の印、Issue の URL。
Issue を単位にした操作は、いまの `IntakeProgress` の `ProgressActions` と中止をここへ移す。

| 操作 | plan | direct |
| --- | --- | --- |
| 今すぐ確認 | ○ | ○ |
| 自動投入の一時停止 / 再開 | ○ | — |
| 改訂を始める | ○ | — |
| Issue を閉じる | ○ | ○ |
| 中止 | ○ | ○ |

見張りの警告（`WatchAlert`）も見出しの下に出す。

「改訂を始める」を押すと `intake.revise.enter` 相当の状態にして Intake のビューへ移り、その Intake を選ぶ。
いまの改訂の面（コメントを集めて `intake.revise` を送る）は Intake 側にそのまま置く。

### 6.5 下のパネル

ノードを選ぶと、画面の下にパネルが開く。図との境目をドラッグして高さを変えられ、最大化（図を隠す）と閉じるのボタンを持つ。
高さは `localStorage` に覚える。読めないときは既定の高さで開く。

パネルの中身は、選んだノードで切り替える。

| 選んだもの | 中身 |
| --- | --- |
| プロセス・いまのタスクが `suspended` | レビュー画面（`ReviewView`。差分・ガイド・承認・差し戻し） |
| プロセス・いまのタスクがある（`suspended` 以外） | タスク画面（`TaskView`。帯・ログ・一時停止・再開・中止） |
| プロセス・`your_turn` | 決めたことのメモと完了の記録（いまの `ActionNeeded` の人のプロセスの部分） |
| プロセス・`needs_attention` | 理由・再投入、それとタスク画面 |
| プロセス・タスクがまだ無い | プロセスの説明・入力と出力・タスクのプロンプト（いまの `PfdElementPanel`） |
| 成果物 | 成果物の説明（いまの `PfdElementPanel`） |

タスクを持つプロセスでは、パネルの上部に `ProcessTrail` を置き、再投入で置き換えられた過去のタスクも選び直して開けるようにする。

worktree が残っているタスク（失敗したタスクと、後片付けで削除を断ったタスク）は、タスク画面に「worktree を消す」を出す。
中身はいまの `RemoveWorktreeModal` と `worktree.remove` である。

キー操作の `j` / `k` は、Execution では一覧の Issue を移る。`n` / `p` / `[` / `]` はレビュー画面がパネルに開いているときに効く。

## 7. データの受け渡し

### 7.1 ステップの帯

`IntakeProcessView` にいまのタスクの帯を足す。

```ts
export type IntakeProcessView =
  & { id: string }
  & ProcessStatus
  & { sub_issue_url: string | null; task_ids: string[]; rail: RailNode[] | null };
```

`rail` はプロセスのいまのタスクの帯で、タスクが無いプロセスでは null。組み立ては `app/src/rail.ts:buildRail` と同じ規則
（YAML から外れた step_id を末尾に生やす）にする。`buildRail` と `RailNode` / `RailStatus` を `shared/` へ移し、
デーモンの `intake/view.ts` とアプリのタスク画面の両方がそれを使う。

デーモンで組み立てるのは、タスクが作成時のワークフローを pin していて（`daemon/handlers.ts` の `task.get`）、
いまの YAML から画面で組み立てると、YAML が編集された後に実際に走っている列とずれるからである。

### 7.2 取り直し

Execution で選んでいる Intake について、それに属するタスクの `task.*` イベント（状態・ステップの変化）が届いたら `intake.get` を取り直す。
連続したイベントはいまの `refreshGate` で間引く。一覧の点は要約とタスクの一覧だけで決まるので、取り直しは要らない。

### 7.3 protocol の変更

- `intake.start` の params に `mode`
- `IntakeSummary` に `mode`
- `IntakeProcessView` に `rail`
- `workspace.setup` を消す（8.2）

## 8. 廃止するもの

### 8.1 画面

| 消すもの | ファイル | 置き換え |
| --- | --- | --- |
| Composer | `components/Composer.tsx`、`composer.ts`、store の `composer` / `composer.open` | Intake の direct |
| やり直しのボタン | `TaskView.tsx` の `RetryButton`、`model.ts` の `retryInit` / `canRetry` | 再投入（`intake.redispatch`） |
| タスクの一覧 | `Sidebar.tsx` のタスクの区分と `GROUPS` を使う部分、view の `tasks` / `done` | Execution |
| worktree と警告 | `components/WorktreeView.tsx`、`worktrees.ts` の画面専用の部分、view の `worktrees` | worktree を消す操作はパネル（6.5）。警告はいまどおりトースト |
| Intake の進行中の面 | `IntakeProgress.tsx` の面そのもの | 中身の部品（`ActionNeeded` / `ProgressActions` / `WatchAlert` / `ProcessTrail` / `CancelDialog`）は Execution が使う |

Intake から投入されていないタスク（Composer や `dctl add` で作ったもの）は、どの画面にも出なくなる。
まだ利用者がいないので、移す仕組みは作らない。

### 8.2 setup のタスク

初回ウィザードと「workspace を追加」は、workspace の登録だけを行うものに縮める。

- ウィザードからワークフローの方針の質問（`Policy`）と、setup のタスクを作れなかった画面（`SetupFailedScreen`）を消す
- `workspace.setup` の RPC、`core/src/workflow/setupWorkflow.ts`、そのテスト（`core/test/workflow/setupWorkflow.test.ts`、
  `core/test/daemon/workspaceSetup.test.ts`、`core/test/integration/setupTask.test.ts`）を消す
- `workspace.add` が置く default.yaml の雛形はそのまま残す。利用者が直す
- プロジェクトの `setup` コマンド（`withSetupStep`）は別の機能なので残す

Quick Start の spec と plan は経緯として残し、spec の冒頭に本 spec で setup のタスクを取り除いたことを書き足す。

### 8.3 触らないもの

`task.create` の RPC、`shared/protocol.ts` のその定義、`dctl` は、別の作業で消す。ここで触ると衝突する。

## 9. 実装の段階

1 本の spec を、3 つの段階の実装計画に割る。

1. **デーモンの direct**: `mode` 列、`intake.start` の分岐、direct の状態の計算と完了、見張りの分岐、操作の拒否と再投入の分岐、
   `IntakeSummary.mode`、`IntakeProcessView.rail`（`buildRail` の `shared/` への移動を含む）
2. **画面の骨格**: Rail と view、Intake の一覧の絞り込みと種類の選択、Execution の一覧・見出し・操作、Intake の進行中の面の移設、
   8.1 / 8.2 の削除
3. **ノードと下のパネル**: ステップの帯、人の番の強調と件数、direct の図の組み立て、パネルの中身の切り替えと高さ

2 は既存の plan の Intake のデータだけで動くので、1 に先行してもよい。

## 10. テスト

- `intakeStates` の遷移表: direct の開始の辺
- direct の開始: 1 トランザクションで Intake・プロセス・タスクが揃う。途中で落ちたら何も残らない
- direct の状態の計算: タスクの状態と PR の観測の組から 4 つの状態
- 見張り: direct は sub-issue の同期と投入をせず、マージで `completed` になる
- 操作の拒否: direct への `intake.revise` / `intake.setDispatchPaused`
- `buildRail` の移動後も、タスク画面の帯と `intake.get` の `rail` が同じ規則で出る
- アプリの純関数（`intake.ts` / `pfd.ts` / `model.ts`）: Intake の一覧の絞り込み、Execution の一覧の区切りと並び、人の番の判定、
  Rail の 2 つの点、direct の図の組み立て、パネルの中身の切り替え
- コンポーネント: ノードの帯と強調、パネルの最大化と閉じる、改訂を始めたときの Intake への移動

## 11. ドキュメント

- `docs/developer-guide/06-intake.md`: direct、状態の表と図、見張りの分岐
- `docs/developer-guide/07-app.md`: 7.4 の画面とファイルの表、7.5 の純関数の表
- `docs/prd/intake.md`: 体験の流れに plan / direct の選択と Execution を足す
