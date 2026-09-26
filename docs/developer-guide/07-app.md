# 7. デスクトップアプリ

`app/` は Tauri v2 + React + Vite のデスクトップアプリで、dctld の**薄い表示・操作層**である。
タスクや Intake の状態を決めるのはデーモンで、アプリは画面の状態と送信前の下書きだけを持つ。

## 7.1 アプリが持つもの・持たないもの

| 持つもの | 置き場 |
| --- | --- |
| 画面の状態（選択・ビュー・取得したデータのキャッシュ・トースト・モーダル） | React の `useReducer`（`app/src/store.tsx` と `app/src/model.ts`） |
| 送信前の下書き（行コメント、全体コメント、Intake の回答・コメント・人のプロセスの内容） | アプリのデータディレクトリの `drafts.json` |
| アプリの設定（エディタ・ターミナルの起動コマンド、worktree を古いとみなす日数） | 同じディレクトリの `settings.json` |
| トラッカーの応答のキャッシュ | WebView の IndexedDB `doctrine-tracker-cache` |

localStorage を使わないのは、WebView を作り直すと消えるためである。

持たないもの: 状態遷移（承認・差し戻し・中止のボタンは RPC を送るだけで `State.tasks` を書き換えない。結果はイベントと取り直しで戻る）、
ワークフローとプロジェクト設定の正本（ファイルを書くのはデーモン）、イベントの連番や再送。

## 7.2 React ⇄ Rust ⇄ dctld

```
┌──────────── Tauri アプリ ───────────────────────────────┐
│ React (WebView)                                          │
│   daemon/client.ts ── invoke("rpc", {method, params}) ─┐ │
│                    ── invoke("connection_status")      │ │
│                    ── invoke("load_drafts" / ...)      │ │
│                    ◀─ listen("daemon-event")           │ │
│                    ◀─ listen("daemon-connection")      │ │
│ Rust: lib.rs（コマンド）→ relay.rs（接続 1 本）          ▼ │
│       daemon.rs（ソケットパス、dctld の探索と起動）         │
└──────────────────────────┬──────────────────────────────┘
                           │ Unix ソケット・改行区切り JSON
                        dctld
```

### React 側の入口は 1 つ

`invoke` と `listen` を呼ぶのは [`app/src/daemon/client.ts`](../../app/src/daemon/client.ts) だけである。
`rpc(method, params)` は `shared/protocol.ts` の `ParamsOf<M>` / `ResultOf<M>` で型付けされる。
イベントは実行時に検証せず型を信じ、知らないイベントは reducer が無視する。

### Rust のコマンド（`app/src-tauri/src/lib.rs`）

| コマンド | 役割 |
| --- | --- |
| `rpc` | `Relay::call` で中継する。**method の中身は見ない**ので、デーモンに RPC を足しても Rust は変えない |
| `connection_status` | 最後に emit した接続状態（起動直後の追いつき用） |
| `load_drafts` / `save_drafts` | `drafts.json` の読み書き（tmp に書いて rename） |
| `load_settings` / `save_settings` | `settings.json` の読み書き。壊れた JSON は既定値に倒さずエラーにする |
| `open_path` | 設定のコマンドの `{path}` をクォートして置き換え、`/bin/sh -c` で切り離して起動する（今は画面から呼ばれていない） |

ソケットパスが決まらない環境（macOS で HOME も `DOCTRINE_STATE_DIR` も無いなど）でも panic せず、ウィンドウを出して理由をバナーで伝える。

### 中継（`app/src-tauri/src/relay.rs`）

- `Relay::call` は id を `AtomicU64` で振り、応答を `oneshot` で待つ。30 秒でタイムアウト（dctl と同じ）。未接続なら即「デーモンに接続していません」
- `pump` が 1 本の接続を読み書きする。`event` キーのある行は `daemon-event` として中身を見ずに emit、`id` のある行は待っている呼び出しへ返す。壊れた行や知らない id は捨てて次へ
- 接続が切れたら、書き込み口を閉じることと待っている要求をすべて「接続が切れました」で落とすことを、**同じロックの下で一度に**行う。分けると `call` と競合して要求がタイムアウトまで取り残される（`app/src-tauri/tests/relay.rs` が 300 ラウンド × 32 並列で固定している）
- `supervise` が常駐して再接続する。backoff は 0.5 秒から倍々で最大 30 秒
- ソケットが無い（ENOENT）か繋がらない（ECONNREFUSED）なら dctld を起こす
  - 起こした子プロセスを保持し、生きている間は二度と起こさない（二重起動で 2 つのデーモンが同じ DB に書くのを防ぐ）
  - 起こした dctld がすぐ死んだら「dctld が起動直後に終了しました。状態ディレクトリの dctld.log を確認してください」と伝え、backoff を挟んでから起こし直す
  - **ソケットファイルは消さない**（生きているデーモンを切り離す危険があるため。判定は dctld 側の `assertSocketNotLive` の仕事）

### dctld の探索と起動（`app/src-tauri/src/daemon.rs`）

- `DOCTRINE_DCTLD`（絶対パス）→ PATH の `dctld` の順に探す。ビルド済みの `.app` を Finder から起こすとシェルの PATH を継がないので、`DOCTRINE_DCTLD` を設定する
- `process_group(0)` で切り離して起こし、stdout / stderr を `<stateRoot>/dctld.log` に追記する。アプリを終了しても dctld は残る
- ソケットパスの規則は `core/src/daemon/server.ts:resolveSocketPath` と同じで、**両方を直す**（[4.6](04-daemon-and-persistence.md)）

## 7.3 状態管理

### `model.ts` と `store.tsx`

- [`app/src/model.ts`](../../app/src/model.ts): `State` と `Action` の型、純関数の `reduce`、画面の導出（サイドバーの区分、差し戻し文の組み立て、利用上限の表示、デーモンの形から画面の形への変換）。副作用を持たない
- [`app/src/store.tsx`](../../app/src/store.tsx): `StoreProvider` と副作用のすべて（購読、取り直し、下書きと設定の読み書き、レビュー中のタスクの diff / context / guide の取得、Intake の詳細の取得）。
  RPC を束ねるフック（`useDecide` / `useIntakeRpc` / `useSettingsRpc` / `useProjectConfigRpc` / `useWorkflowRpc` / `useSlotsRpc`）を export する
- 送信のフックは catch しない。呼び出し側が `app/src/decision.ts:sendDecision` で `{ ok }` / `{ ok: false, message }` に変え、成功したときだけ後片付けの action を dispatch する（失敗したときに下書きを消さないため）

`Loaded<T> = loading | ok | error` は「取れていない」と「無い」を区別するための型である。画面は error を黙って隠さない。

### 購読と取り直し

起動時の順序は次のとおり。

1. `daemon-connection` と `daemon-event` の購読を**先に張り終える**（状態を先に問い合わせると隙間の変化を取りこぼす）
2. `connectionStatus()` で今の接続状態に追いつく（Rust の接続は WebView が listen する前に終わっているので、最初の `connected` イベントは誰にも届かない）
3. `refresh()` を呼び、以後 15 秒ごと（`REFRESH_MS`）に呼ぶ

`refresh()` は `project.list`・`task.list`・`ratelimit.recent`・`intake.list` を取り、続けて `worktree.list`・`daemon.warnings` を取る。
呼ばれる契機は、15 秒ごと（`dctl add` の `queued` はイベントが飛ばないため）、再接続したとき、知らないタスクや Intake のイベントが来たとき、Intake のイベントが来たとき（`needs_human` などはイベントに載らないため）など。

レビュー中のタスクの `task.diff` / `task.context` / `task.guide`、選んでいる Intake の `intake.get` は、選んだときにまだ持っていなければ取る。15 秒の取り直しには乗せない。

### 競合を防ぐ仕掛け

- `app/src/refreshGate.ts`: 同時に走った取り直しのうち、**最後に始めた 1 本だけ**を反映する（古い応答で巻き戻らないため）
- 世代（`gen` / `intakeGen`）: 取得を始めたときの世代を持ち帰り、その間に捨てられていたら書かない（承認の直後に 1 つ前の diff が復活するのを防ぐ）
- `app/src/settleListeners.ts`: 購読の片方が失敗しても、成功した方の unlisten を漏らさない
- 承認・差し戻し・中止の後片付けは、手元の `t.state` を見ない。`task.stateChanged` が RPC の応答より先に届くことがあるため

### イベントの反映（`reduce` の `daemon`）

| event | 反映 |
| --- | --- |
| `task.stateChanged` | 状態を書き換え、そのタスクの diff / context / guide を捨てる。知らない状態は `unknown` として残す |
| `stepRun.started` / `stepRun.finished` | 今のステップ、差し戻しの印 |
| `log.line` / `intake.logLine` | ログの末尾（2000 行まで） |
| `task.cleanedUp` | worktree の有無と削除拒否 |
| `daemon.warning` | トーストと警告一覧（100 件まで） |
| `ratelimit.sample` | その枠の最新値 |
| `intake.stateChanged` / `intake.updated` | 一覧の行を直し、詳細を捨てる |

## 7.4 画面とファイルと RPC

骨格は `app/src/App.tsx`。左端のアイコン列（`Rail`）、サイドバー、本体、モーダル、トーストからなる。
本体は `view` と選んでいるタスクの状態で振り分け、`suspended` なら `ReviewView`、それ以外なら `TaskView` を出す。

| 画面 | ファイル | 使う RPC |
| --- | --- | --- |
| 接続バナー | `components/ConnectionBanner.tsx` | — |
| サイドバー（タスク・Intake・worktree・設定） | `components/Sidebar.tsx` | —（store が取る） |
| 利用上限 | `components/RateLimit.tsx` | —（store が取る） |
| タスク画面 | `components/TaskView.tsx`、`WorkflowRail.tsx`、`LogBlock.tsx` | `task.get`、`task.logs`、`task.pause` / `resume` / `cancel` |
| レビュー画面 | `components/ReviewView.tsx`、`ReadingFlow.tsx`、`Guide.tsx`、`DiffFileBlock.tsx`、`Diagrams.tsx` | `task.diff` / `task.context` / `task.guide`、`task.approve`、`task.reject`（`App.tsx:RejectModal`） |
| Intake の振り分け | `components/IntakeView.tsx` | `intake.abandonRevision`、`intake.cancel` |
| Issue の選択 | `components/IssuePicker.tsx` | `tracker.status` / `tracker.issues` / `tracker.issue`、`intake.start` |
| 質問に答える | `components/AnswerFace.tsx`、`QuestionForm.tsx`、`MaterialView.tsx`、`EvidenceView.tsx` | `intake.answer` |
| 計画のレビュー | `components/PlanReview.tsx`、`PfdDiagram.tsx`、`PfdElementPanel.tsx`、`IntakeHistory.tsx` | `intake.processPrompt`、`intake.reject`、`intake.approve`、`intake.draft` |
| 進行中の Intake | `components/IntakeProgress.tsx`、`StatusCounts.tsx` | `intake.completeHumanProcess`、`intake.redispatch`、`intake.refresh`、`intake.setDispatchPaused`、`intake.closeIssue`、`intake.revise` |
| Intake のログ | `components/IntakeLog.tsx` | `intake.logs` |
| worktree と警告 | `components/WorktreeView.tsx` | `worktree.remove` |
| 設定 | `components/SettingsView.tsx`、`ProjectConfigSection.tsx`、`WorkflowSettings.tsx` | `load_settings` / `save_settings`、`daemon.slots`、`daemon.setGlobalLimit`、`project.config.*`、`workflow.*` |

`shared/protocol.ts` の `Methods` にある RPC は `task.create` を除いてどこかの画面が使っている（コンポーザは後続）。

キー操作（`App.tsx:useKeys`）: `j` / `k` で一覧を移動、`n` / `p` でファイル（ガイドの順では hunk）、`[` / `]` でガイドのグループ、`Esc` でモーダルを閉じる。
**承認と差し戻しにはキーを割り当てない。**

## 7.5 純関数のモジュール

React も Tauri も持ち込まず、同名の `*.test.ts` で単体テストする。

| ファイル | 役割 |
| --- | --- |
| `intake.ts` | Intake 画面の導出（回答の正規化と検証、サイドバーの区分、どの面を出すか、コメントの操作、進行中の面の操作の出し分け） |
| `pfd.ts` | PFD の図の配置。列は `diagram.ts:layoutGraph` の最長路に任せ、列の中の順は重心法で交差を減らす |
| `rail.ts` | ワークフローの帯（タスク画面の実行状態付きと、設定画面の定義図） |
| `workflowEdit.ts` / `projectConfig.ts` / `settings.ts` | 設定フォームの変換・検証・差分・エラーの欄への振り分け。`workflowEdit.ts:TEMPLATE_VARIABLES` は `core/src/workflow/template.ts` と一致することをテストで固定している |
| `worktrees.ts` | worktree の古さと削除可否、警告の並び |
| `trackerCache.ts` | トラッカーの応答の stale-while-revalidate |
| `tone.ts` | 状態の色 5 種の唯一の対応表。**状態の色はここからだけ引く** |
| `patch.ts` / `flow.ts` / `guide.ts` / `moves.ts` / `diagram.ts` / `highlight.ts` | レビュー画面（[5 章](05-review-guide.md)） |

## 7.6 開発の仕方

- `mise run app:tauri` — ウィンドウで開く。dctld が居なければ起こす。`~/.deno/bin` を PATH に通しておく（`mise run core:install` で入る）
- `mise run app:dev` — ブラウザで開く。Tauri の `invoke` が無いのでデーモンには繋がらない
- PFD の図の目視: `mise run app:dev` の上で http://localhost:1420/pfd-preview.html（`app/src/dev/pfdPreview.tsx`）
- [`app/src/fixtures.ts`](../../app/src/fixtures.ts) はテストと開発用プレビュー専用で、**画面から import しない**。デモモードは無く、画面のデータは必ずデーモンから来る
- 別のデーモンに繋ぐときは `DOCTRINE_SOCKET` / `DOCTRINE_STATE_DIR` を設定して起動する
- `shared/protocol.ts` の union（`TaskState` など）に値を足したら、アプリ側の網羅的な `Record`（`tone.ts` の表など）も同じ変更で足す。足さないと `app:build` が落ちる
