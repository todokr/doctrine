# 4. デーモン・永続化・RPC

対象は `core/src/daemon/`、`core/src/db/`、`shared/protocol.ts`、`core/src/cli/dctl.ts`。

## 4.1 dctld の起動（`main.ts:startDaemon`）

1. ソケットパスを決める（4.6）
2. **二重起動を検査する**（`assertSocketNotLive`）。パスに繋がれば生きているデーモンが居るので起動を拒否する。
   `ConnectionRefused` / `NotFound` なら古いソケットファイルとみなして消す。それ以外（権限エラーなど）は判定できないので拒否する。
   `server.listen()` はパスを無条件に unlink するので、この検査が無いと 2 つのデーモンが同じ DB に書く
3. DB を開く（`<stateRoot>/doctrine.db`）。親ディレクトリを `0o700` で作り、`PRAGMA journal_mode = WAL`、`foreign_keys = ON`、マイグレーションを適用する。失敗したら起動しない
4. `config.json` を読む（失敗しても投げず、既定値と警告を返す）
5. `DaemonContext` を組み立てる。本物のアダプタ、`workflowOf`（作成時に固定した定義を読む）、`trackerOf`、Intake の見張り、警告ログなど
6. サーバを作って listen する
7. **クラッシュ復帰**（[3.12](03-workflow-engine.md)）。listen の後に行うので復帰中にも RPC が届きうる。そのため復帰の書き込みも `requireState` 付き
8. プロジェクトごとに孤児の worktree を探して警告する
9. Intake の見張りを 1 周回す
10. タイマーを張る。`tick` を 1 秒ごと、見張りを 120 秒ごと（`WATCH_INTERVAL_MS`）。どちらも `Deno.unrefTimer` 済みで、プロセスを生かしているのはソケットのリスナーだけ

`startDaemon` は `{ stop() }` を返すが、呼ぶのはテストだけである。**シグナル処理は無い。** SIGINT / SIGTERM では即座に終わり、
後始末は次の起動に任せる（残ったソケットは `assertSocketNotLive` が消し、書きかけのトランザクションは WAL が捨て、生き残った `claude` は復帰処理が殺す）。

## 4.2 ソケットとワイヤ形式（`server.ts`）

- Unix ドメインソケットだけで、TCP は開かない。ファイルのパーミッションがそのまま認可になる
- 1 行 1 メッセージの改行区切り JSON。行長に上限は無い
- メッセージの形（`shared/protocol.ts`）

| 向き | 形 |
| --- | --- |
| リクエスト | `{ id: number, method: string, params?: object }` |
| 成功応答 | `{ id, ok: true, result }` |
| 失敗応答 | `{ id, ok: false, error: string }`（投げた `Error.message` がそのまま入る。エラーコードは無い） |
| 読めない行への応答 | `{ id: null, ok: false, error: "JSONとして読めません" }`（接続は切らない） |
| イベント | `{ event: "...", ... }`（`id` を持たない） |

- 同じ接続のリクエストは**並行に**処理され、応答の順は保証されない。クライアントは `id` で対応付ける
- 書き込みは接続ごとに直列化しているので、応答とイベントが行の途中で混ざることは無い
- **追従先は 1 接続につき 1 つ。** `task.logs` / `intake.logs` の `follow: true` で移す。`log.line` と `intake.logLine` は追従している接続にだけ送る。
  アプリは 1 本の接続を画面全体で共有するので、画面を離れるときは必ず `follow: false` を送る

## 4.3 RPC メソッド

`shared/protocol.ts` の `Methods` 型が「UI が呼ぶメソッドの表」で、`ParamsOf<M>` / `ResultOf<M>` で引ける。
実装は `handlers.ts:createHandler` の `switch` で、未知のメソッドは `未知のメソッドです` を投げる。
デーモンは DB の行をそのまま返すので実際の応答には型より多い列が載るが、UI が頼ってよいのは型に書いた分だけである。

`project.add` / `project.update` の 2 つは `Methods` に無い（dctl 専用）。ただし中継は何でも通すので、アプリからも呼べてしまう。

### プロジェクトとワークフローの設定

| method | すること |
| --- | --- |
| `project.add` | `.doctrine/` の雛形を作り（既存のファイルは上書きしない）、`projects` に登録する。2 回目は `alreadyRegistered: true` |
| `project.update` | `project.yaml` を読み直して DB の行に写す |
| `project.list` | 登録済みのプロジェクト |
| `project.config.get` / `project.config.save` | `project.yaml` の読み書き。保存はコメントと `tracker` を残し、DB の行も同期する |
| `workflow.list` / `workflow.get` / `workflow.save` | `.doctrine/workflows/*.yaml` の一覧・詳細・ステップ単位の編集（検証に落ちたら書かない。コミットはしない）。`workflow.list` の各要素は `default`（`projects.default_workflow` と名前が一致するか）を持ち、検証を通ったものは `steps`（setup を差し込んだ後の `StepView` の列。`task.get` の `steps` と同じ形）も持つ |

`project.yaml` を手で編集しただけでは DB の `projects` 行（`max_concurrent` など）は変わらない。`project.update` か画面からの保存で写る。

### タスク

| method | すること |
| --- | --- |
| `task.create` | ワークフローを検証し、定義を固定して `queued` で作る。worktree はまだ作らない。応答に非冪等コマンドの `warnings` |
| `task.list` / `task.get` | 一覧 / 詳細（`stepRuns`、`steps`）。`permission_denials` は JSON を展開して返す |
| `task.context` | レビュー画面の経緯（[5 章](05-review-guide.md)） |
| `task.diff` / `task.guide` | diff と Review Guide（[5 章](05-review-guide.md)） |
| `task.approve` / `task.reject` | `applyApproval`。reject は `comment` 必須 |
| `task.pause` / `task.resume` / `task.cancel` | [3.11](03-workflow-engine.md) |
| `task.logs` | 最後（または指定）の実行のログ末尾。`follow` で追従を切り替える |

### worktree・デーモン・利用上限

| method | すること |
| --- | --- |
| `worktree.list` | 全プロジェクトの worktree（タスク・Intake・孤児の区別、未コミットの有無付き） |
| `worktree.remove` | `task_id` か `path` で 1 つ消す。`path` は置き場の配下で `git worktree list` に出るものだけ。終わっていないタスク・Intake は `force` でも拒否 |
| `daemon.warnings` | 警告の新しい順（最大 100 件、メモリのみ） |
| `daemon.slots` / `daemon.setGlobalLimit` | 実行枠の使用状況 / 全体枠の変更（即時に効き、`config.json` に保存） |
| `ratelimit.recent` | 利用上限の標本 |

### トラッカーと Intake

`tracker.status` / `tracker.issues` / `tracker.issue` と、`intake.start` / `list` / `get` / `answer` / `reject` / `approve` / `revise` /
`abandonRevision` / `draft` / `processPrompt` / `cancel` / `completeHumanProcess` / `redispatch` / `refresh` / `setDispatchPaused` /
`closeIssue` / `logs`。中身は [6 章](06-intake.md)。

## 4.4 イベント（`ServerEvent`）

| event | 配信先 | 出すところ |
| --- | --- | --- |
| `task.stateChanged` | 全員 | tick、エンジン、承認・却下・pause・resume・cancel、Intake の中止 |
| `stepRun.started` / `stepRun.finished` | 全員 | エンジン |
| `log.line` | そのタスクを追従している接続 | エンジン |
| `task.cleanedUp` | 全員 | 完了後の worktree の後始末（`removed` / `refused`） |
| `daemon.warning` | 全員 | `warnings.ts` の `push` |
| `ratelimit.sample` | 全員 | タスクの実行（Intake の実行からは配らない） |
| `intake.stateChanged` | 全員 | Intake の操作、runner、見張り |
| `intake.updated` | 全員 | 状態以外の変化（見張りの健康状態、人のプロセスの完了など） |
| `intake.logLine` | その Intake を追従している接続 | Intake の runner |

イベントには連番も再送も無い。取りこぼしはクライアントが定期的に取り直して吸収する（アプリは 15 秒ごと、再接続時にも取り直す）。

### 警告の出口

人に見せたい警告は `ctx.warnings.push` に集める（`warnings.ts:createWarningLog`）。これが stderr への出力、`daemon.warning` イベント、
`daemon.warnings` の保持の 3 つにまとめて出す。ワークフローの警告を積むのは `task.create` だけで、tick や承認では積まない（毎秒積み上がるのを防ぐ）。

## 4.5 永続化

### 構成

- ドライバは `node:sqlite` の `DatabaseSync`（ネイティブ依存を増やさないため）。その上に Kysely を載せる
- Kysely 公式の `SqliteDialect` は better-sqlite3 前提なので、SQL の組み立ては公式のものを使い、実行部分だけを `db/dialect.ts:NodeSqliteDialect` で自前で持つ
- **接続は 1 本で、`ConnectionMutex` で排他する。** トランザクションは BEGIN から COMMIT まで接続を占有するので、途中に他のクエリは割り込めない。
  トランザクションのコールバックの中で `trx` ではなく外側の `db` を使うと、自分の解放を待って**永久に止まる**
- `BEGIN IMMEDIATE` で始める（書き込みロックを BEGIN の時点で取る）
- テーブルの形は `db/schema.ts` の `Database` インターフェースが唯一の定義。JSON の列は文字列のまま持ち、中身の型は `shared/` 側が持つ。時刻は ISO 8601 の TEXT、真偽値は 0/1

### テーブル

| テーブル | 1 行が表すもの | 主な列 |
| --- | --- | --- |
| `projects` | 登録したリポジトリ | `path`（UNIQUE）、`default_workflow`、`max_concurrent`、`base_branch`、`setup`。`project.yaml` の写し |
| `tasks` | タスク | `state`（CHECK 9 値）、`current_step_id`、`attempt_counts`、`branch`、`worktree_path`、`child_pid` / `child_started_at`、`pending_feed`、`rate_limited_until`、`waiting_until`、`priority`、`resumed`、`intake_id` / `intake_process_id`、`issue_url` / `parent_issue_url`、`workflow_yaml` / `workflow_setup` |
| `task_sessions` | タスクの役割ごとの Claude の会話 | `(task_id, role)` PK、`session_id` |
| `step_runs` | ステップ 1 回の実行 | `step_id`、`attempt`、`status`（CHECK 8 値）、`exit_code`、`log_path`、`cost_usd` / `num_turns` / `duration_ms`、`review_tree`、`goto_step_id`、`permission_denials` |
| `step_outputs` | 実行 1 回の出力の末尾 | `step_run_id` PK、`last_stdout` / `last_stderr`（8192 バイト）、`exit_code` |
| `rate_limit_samples` | 観測した利用上限 | `window`、`utilization`、`resets_at`（生の値） |
| `intakes` | Intake | `state`（CHECK 8 値）、`revising`、`attention_reason`、`dispatch_paused`、`worktree_path`、`claude_session_id`、`rate_limited_until`、`revision_run_id`、`issue_phase` |
| `intake_runs` | Intake のエージェント実行 | `purpose`（investigate / decompose / revise）、`status` |
| `intake_question_sets` | 質問と仮定のまとまりと、その回答 | `questions`、`assumptions`、`answers`、`assumption_responses` |
| `intake_drafts` | PFD の案（書いたら変えない） | `(intake_id, seq)` UNIQUE、`pfd`（正規化 JSON）、`hash` |
| `intake_comments` | 案への差し戻しコメント | `target_kind`、`target_id`、`run_id` |
| `intake_approvals` | 承認（追記だけ） | `draft_id`、`hash` |
| `intake_processes` | 承認された PFD のプロセスと sub-issue・タスクの紐づけ | `(intake_id, process_id)` PK、`sub_issue_url`、`current_task_id`、`human_done_at`、`retired_at`（行は消さない） |
| `pr_observations` | 見張りが観測した PR | `task_id` PK、`state`、`base_ref`、`merge_commit` |

ログの本文は DB に入れない。エージェントのログは数 MB になり一覧のクエリが重くなるので、DB は `log_path` と出力の末尾だけを持つ。

### ステップ境界のトランザクション（`boundary.ts:commitStepBoundary`）

1 回の呼び出しで次をすべて 1 トランザクションで書く。

- タスク行の更新（`updated_at` は必ず進める）
- `step_runs` の挿入（`stepRun`）、待ちから戻るときの開き直し（`stepRunReopen`）、終了の記録（`stepRunUpdate`）
- 会話の記録の upsert / 削除
- `step_outputs` の upsert

`requireState` を渡すと `UPDATE ... WHERE id = ? AND state = ?` にし、更新行数が 0 なら今の状態を読んで `StateConflictError` を投げる（全体が巻き戻る）。
**状態を変える書き込みは必ず `requireState` を付ける。** 付けないのは `worktree_path` や子プロセスの記録のように状態を変えないものだけである。

### マイグレーション

`db/migrations.ts` の静的なオブジェクト `migrations` を Kysely の `Migrator` に渡す。起動のたびに `openDb` が最新まで流す。

| 番号 | 内容 |
| --- | --- |
| `0001_baseline` | 手書き DDL 時代の最終形 |
| `0002_task_sessions` | 役割ごとの会話 |
| `0003_review_records` | `awaiting` / `interrupted`、`review_tree` |
| `0004_step_outputs_last_names` | `stdout` / `stderr` を `last_*` に改名 |
| `0005_rate_limited` | `rate_limited` 状態 |
| `0006_step_run_bounced` | `bounced` と `goto_step_id` |
| `0007_step_run_permission_denials` | 権限拒否の記録 |
| `0008_step_run_drop_degraded` | `degraded` を廃止 |
| `0009_intake` | Intake の 8 表と、タスクの紐づけ列 |
| `0010_intake_revision` | 改訂 |
| `0011_task_workflow_pin` | ワークフローの固定 |
| `0012_intake_assumptions` | 仮定 |
| `0013_waiting` | `waiting` 状態 |
| `0014_issue_phase` | Linear の状態同期 |

**マイグレーションはトランザクションに入らない。** Kysely の `SqliteAdapter.supportsTransactionalDdl` が `false` なので、`Migrator` は各マイグレーションをそのまま流す。
途中で落ちると半端な DDL が残り、次の起動でも同じマイグレーションが失敗し続けうる（`migrations.ts:migrateToLatest` の doc コメントはこの点を誤って書いている。[10 章](10-known-gaps.md)）。

新しいマイグレーションの足し方は [9.4](09-contributing.md) にある。

## 4.6 ディスク上の配置

### 環境変数

| 変数 | 意味 |
| --- | --- |
| `DOCTRINE_STATE_DIR` | 状態ディレクトリ。既定は `~/.local/state/doctrine`。空文字は未設定として扱う（`util/home.ts:stateRoot`） |
| `DOCTRINE_SOCKET` | ソケットパスを直接指定する |
| `XDG_RUNTIME_DIR` | ソケットの置き場（OS を問わない） |
| `DOCTRINE_DCTLD` | アプリが起動する dctld の絶対パス（無ければ PATH の `dctld`） |

### 状態ディレクトリ（`0o700`）

```
<stateRoot>/
├── doctrine.db            SQLite（WAL なので -wal / -shm も並ぶ）
├── config.json            デーモンの設定（0o600）
├── dctld.sock             macOS で XDG_RUNTIME_DIR が無いときのソケット
├── dctld.log              アプリが dctld を起動したときだけ作る stdout / stderr
├── logs/
│   ├── <task-id>/<step-id>.<attempt>.log
│   └── intake-<intake-id>/<purpose>.<attempt>.log
└── worktrees/<basename(projectPath)>/
    ├── <task-id>/            タスクの worktree
    └── intake-<intake-id>/   Intake の detached worktree
```

状態ディレクトリの外に置くものが 2 つある。

- `refs/doctrine/reviews/<task-id>/<step-run-id>` — プロジェクトのリポジトリに張るレビュー時点のツリーの参照（[5 章](05-review-guide.md)）
- `<worktree>/.doctrine-out/` — ワークフローが成果物を受け渡す規約上の置き場。`guide.json` と `guide-hunks.json` は doctrine が書く

### ソケットパスの解決

1. `DOCTRINE_SOCKET`
2. `$XDG_RUNTIME_DIR/doctrine/dctld.sock`
3. macOS: `<stateRoot>/dctld.sock`（macOS には `XDG_RUNTIME_DIR` が無く、`$TMPDIR` は OS の掃除で消えるため）
4. Linux: `/run/user/<uid>/doctrine/dctld.sock`

**同じ規則が TypeScript（`core/src/daemon/server.ts:resolveSocketPath`）と Rust（`app/src-tauri/src/daemon.rs:resolve_socket_path`）の 2 か所にある。**
直すときは両方を直す。片方だけ直すと、症状は「繋がらない」としか出ない。どちらにもテストがある。

### `config.json`（`daemon/config.ts`）

| キー | 意味 | 効き方 |
| --- | --- | --- |
| `globalLimit` | 全体の実行枠（既定 4） | 起動時に読み、`daemon.setGlobalLimit` で即時に変わる |
| `linearApiKey` | Linear の Personal API key | 起動時に 1 度だけ読む。変えたらデーモンの再起動が要る |

スキーマは `.strict()` で、読めない・壊れている・知らないキーがある場合は既定値と警告で起動する。書き込みは tmp に `0o600` で書いてから rename する。
`project.yaml` の `tracker` は呼ぶたびに読み直すので、こちらは再起動が要らない。

## 4.7 dctl

1 コマンドを 1 RPC にし、`result` を整形した JSON で標準出力に出す。失敗は標準エラーに出して終了コード 1。タイムアウトは 30 秒。

| コマンド | RPC |
| --- | --- |
| `add --project --title --prompt [--workflow] [--priority]` | `task.create` |
| `ls [--project] [--state]` / `get <id>` | `task.list` / `task.get` |
| `approve <id>` / `reject <id> --comment` | `task.approve` / `task.reject` |
| `pause` / `resume` / `cancel <id>` | `task.pause` / `task.resume` / `task.cancel` |
| `logs <id> [--tail] [--step_run_id] [--follow]` | `task.logs` |
| `diff <id> [--since last_review]` | `task.diff` |
| `projects` / `project-add --path` / `project-update --path` | `project.list` / `project.add` / `project.update` |
| `intake ls` / `intake get <id>` / `intake logs <id>` | `intake.list` / `intake.get` / `intake.logs` |
| `worktrees` / `gc <id>` / `gc --path <path>` | `worktree.list` / `worktree.remove` |
| `ratelimit` / `slots` / `slots set --limit <n>` | `ratelimit.recent` / `daemon.slots` / `daemon.setGlobalLimit` |

Intake を動かす操作（開始・回答・承認・人のプロセスの完了など）は dctl にあえて置いていない。承認と人の完了は人だけが行うためである。

数値のフラグは CLI 側で NaN を弾く（NaN は JSON で null になり、デーモンが黙って既定値に倒すため）。
`logs --follow` は追従を張り、`log.line` / `intake.logLine` を 1 行ずつ出し続ける。SIGINT で終了コード 0。
