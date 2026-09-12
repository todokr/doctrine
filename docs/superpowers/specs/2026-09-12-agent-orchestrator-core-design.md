# doctrine コア設計 — ワークフローエンジン + 実行監督

- 日付: 2026-09-12

- 状態: 承認済み、実装計画の作成待ち

## 1. 背景と動機

ローカル環境で Claude Code を複数同時に走らせて管理したい。最大の困りごとは
**並行実行の管理** — 何本まで走らせていいのか、同じリポジトリで衝突しないか、
どれが自分の承認待ちで止まっているのかが分からない。

同時に、走り終わった後の扱い（コミットする／PRを作る／テストを流す／人が見る）は
プロジェクトごとに違うので、**ユーザーが宣言的に定義できる**必要がある。

### 2. スコープ

全体は4つのサブプロジェクトに分解済み。**本specは①のみを対象とする。**


| #   | サブプロジェクト    | 内容                                                     |
| --- | ----------- | ------------------------------------------------------ |
| ①   | コア（本spec）   | ワークフロースキーマ、FSM+永続化、worktreeライフサイクル、実行枠、Claude Codeアダプタ |
| ②   | デスクトップUIシェル | UIフレームワーク選定、カンバン、タスク詳細、コンポーザ                           |
| ③   | 差分レビュー      | 変更/コミット/PRペイン、ファイルツリー付きdiffビューア                        |
| ④   | HTML生成、編集   | 別エージェントによる静的HTMLレポートおよび注釈つき編集、直接編集                     |


①には薄いデバッグCLI `dctl`（`dctl add` / `dctl ls` / `dctl approve` など）を同梱するが、
これは**テスト・デバッグのための表面であって製品UIではない**。製品UIは②。

### アーキテクチャ方針: 常駐デーモン + クライアント

`dctld` デーモンがワークフローを進行させ、Claude Code を自前で spawn する。
UIはUnixソケット越しのクライアント（ビュー）にすぎない。

採用理由:

- ウィンドウを閉じてもタスクが走り続ける（「投げておいて後で見る」が成立する）
- エージェント実行の前後にステップを挟める。スケジューリングを1箇所に集約できる
- ①をUIなしでテストできる

**検討して却下した案**: Claude Code の背景エージェント機構（`claude --bg -w` +
`claude agents --json`）に全面的に乗る案。監督コードはほぼ消えるが、
ワークフローのステップ進行は結局自前で持つ必要があり、**2つの状態源を
突き合わせる**羽目になる。権威ある状態機械を1つ持つことに価値の中心がある。

## 3. ワークフロースキーマ

### ステップ型は3つのみ

- `command` — worktree内でシェルコマンドを実行。非0終了でステップ失敗
- `agent` — Claude Code を headless 実行。session id を記録し再開可能
- `approval` — FSMを `suspended` にして人の入力（承認/却下/追加指示）を待つ

配置: `<project>/.doctrine/workflows/<name>.yaml`

```yaml
name: feature
steps:
  - id: implement
    type: agent
    prompt: "{{ task.prompt }}"
    permissionMode: acceptEdits

  - id: test
    type: command
    run: pnpm test
    onFailure:
      goto: implement
      maxAttempts: 3
      feed: "テストが失敗した:\n{{ steps.test.stderr }}"

  - id: review
    type: approval
    title: "差分を確認してください"

  - id: open-pr
    type: command
    run: gh pr create --fill --head {{ task.branch }}
```

### `approval` ステップの結果

`approval` は2つの結果を持つ。

- **承認** → 次のステップへ進む
- **却下（コメント付き）** → `onReject` があればそこへ飛び、なければ `failed`

```yaml
  - id: review
    type: approval
    title: "差分を確認してください"
    onReject:
      goto: implement
      maxAttempts: 5
      feed: "レビューで却下された:\n{{ steps.review.stdout }}"
```

`onReject` の形は `onFailure` と同一である（`goto` / `maxAttempts` / `feed`）。
分岐の形式を2種類持たないため。`implement` へ戻る場合、`agent` ステップは
`claude_session_id` で `--resume` されるので会話は継続する（やり直しではない）。

### 失敗ハンドリングは `onFailure.goto` の1形式のみ

テストが落ちたら出力をエージェントに食わせて実装ステップへ戻る。
**これがシェルスクリプトとの唯一の本質的な差**であり、「投げておける」を成立させる。

- `onFailure` がなければ、ステップ失敗は即 `failed`
- `maxAttempts` 超過も `failed`
- 条件分岐・並列実行・サブワークフローは**入れない**（必要になってから）

### 変数

4系統のみ。

- `{{ task.prompt }}` `{{ task.title }}` `{{ task.id }}` `{{ task.branch }}`
- `{{ worktree.path }}`
- `{{ project.path }}`
- `{{ steps.<id>.stdout }}` `{{ steps.<id>.stderr }}` `{{ steps.<id>.exitCode }}`
— `agent` ステップの場合、`stdout` は最終結果テキスト
却下コメントに専用の変数は設けない。`**approval` ステップの `stdout` が
却下コメントそのもの**として `step_outputs` に保存される。`agent` ステップの
`stdout` を最終結果テキストとしたのと同じ扱いであり、変数の系統を増やさない。

### 形式は YAML（TSではない）

ワークフロー定義は**設定であって実行可能コードではない**。TSにすると読み込みが
任意コード実行になり、デーモンが信頼境界を跨ぐ。zod で検証し、
不正な定義は**デーモン起動時 / タスク作成時に落とす**。

### プロジェクト設定

配置: `<project>/.doctrine/project.yaml`

```yaml
setup: pnpm install --frozen-lockfile   # 全ワークフローの先頭に自動挿入される command ステップ
defaultWorkflow: feature
maxConcurrent: 1
baseBranch: main
```

`setup` は新しい概念ではなく、ただの `command` ステップに名前が付いたもの。
新品 worktree に `node_modules` がない問題への解（5章参照）。
**上の値は例である** — doctrine 自身は pnpm を使うが、`setup` の中身は
対象プロジェクトが決めるもので、doctrine がパッケージマネージャを強制することはない。

**ステップid `setup` は予約語**とする。自動挿入された結果として `step_runs` にも
変数空間（`{{ steps.setup.stdout }}`）にも現れるため、ユーザー定義のワークフローが
同じidを持つと静かに衝突する。検証時に**エラーとして弾く**。

## 4. 状態機械と永続化

### 状態（7つ）


| 状態          | 意味                     | 実行枠                     |
| ----------- | ---------------------- | ----------------------- |
| `queued`    | 作成済み、実行枠の空き待ち          | 占有しない                   |
| `running`   | ステップ実行中                | **占有する**                |
| `suspended` | `approval` ステップで人の入力待ち | **全体枠のみ解放**（プロジェクト枠は保持） |
| `paused`    | 人が明示的に保留した             | **全体枠のみ解放**（プロジェクト枠は保持） |
| `completed` | 正常終了                   | —                       |
| `failed`    | 失敗して終了                 | —                       |
| `canceled`  | 人が中止した                 | —                       |


設計判断:

- `**queued` を独立させる** — 「枠待ち」がこのツールの中心概念。
uncle-jam の `pending` はこれに置き換える
- `**suspended` と `paused` は別物** — 前者はワークフローが入力を要求している
（再開時に承認/却下という**値**を受け取る）、後者は人が割り込んだ（単に続きから）
- `**canceled` を `failed` に畳まない** — 自分で止めたものが「失敗」列に
並ぶとボードが嘘をつく
- **枠の解放はスコープごとに違う**（5章で詳述）— 全体枠は解放し、プロジェクト枠は保持する

### 枠の占有数はカウンタで持たない

`running` なタスクを数えて導出する。カウンタを持てば必ず状態とズレる。

### DB スキーマ（SQLite / WALモード / `node:sqlite`）

- `projects` — `path`, `default_workflow`, `max_concurrent`, `base_branch`, `setup`
- `tasks` — **これ自体がスナップショット**。`id`, `project_id`, `title`, `prompt`,
`workflow_name`, `state`, `current_step_id`, `attempt_counts`(JSON),
`branch`, `worktree_path`, `claude_session_id`, `child_pid`, `child_started_at`,
`priority`, `created_at`, `updated_at`
- `step_runs` — ステップ1回の実行記録。`task_id`, `step_id`, `attempt`, `status`,
`exit_code`, `started_at`, `ended_at`, `log_path`,
`cost_usd`, `num_turns`, `duration_ms`。**UIの「実行履歴」はこのテーブル**
- `step_outputs` — 変数展開に使う分だけ（stdout/stderr の末尾）
- `rate_limit_samples` — Claude Code から流れてくるレート消費率の記録（6章）

**ログ本文はDBに入れない。** ディスク上のファイル
（`~/.local/state/doctrine/logs/<task-id>/<step-id>.<attempt>.log`）に書き、
DBはパスと末尾数KBだけ持つ。エージェントのログは数MB級になり、
DBに入れると一覧クエリが道連れで重くなる。

### 耐久性モデル

ステップ境界ごとに、`tasks` の更新と `step_runs` の挿入を**1トランザクション**で書く。
落ちて失うのは最大1ステップ分。これは uncle-jam から据え置きの保証であり、
今後も崩さない。

### クラッシュ復帰

デーモンが死ねば子プロセスの stdout は誰も読んでいない。よって
**起動時に `running` のタスクはすべて古い**。復帰規則:

**復帰の前に、必ず古い子プロセスを殺す。** デーモンが SIGKILL された場合、
子の `claude` は**生き残ったまま同じ worktree に書き続けている**ことがある。
そこへ `--resume` で2本目を起動すると、同じ作業ツリーに2つのエージェントが並ぶ。
ステップ境界ごとの耐久性という本specの中心的な保証が、復帰経路で崩れる。

そのため `tasks` に `child_pid` と `child_started_at` を持ち、復帰時に
**pid と開始時刻の両方**で同一性を確認してから終了させる（pidは再利用されるため、
pid単独での判定は誤って無関係のプロセスを殺し得る）。

殺し終えてから:

- `**agent` ステップだった** → `claude_session_id` で `--resume` して続きから
- `**command` ステップだった** → そのステップを**頭から再実行**

この設計は**「`command` ステップは再実行安全でなければならない」という制約を
ユーザーに課す**。`pnpm install --frozen-lockfile` や `pnpm test` は問題ないが `gh pr create` は
二重実行になり得る。ワークフロー検証時に**終盤の非冪等コマンドを警告する**
（完全には防げないが、黙って壊れるよりよい）。この制約はドキュメントに明記する。

## 5. worktree ライフサイクルと実行枠

### 作成

**タスク作成時ではなく、実行枠が取れた瞬間**に作る。`queued` のタスクが
ディスクとgit refを抱える理由がない。

- 置き場所: `~/.local/state/doctrine/worktrees/<project>/<task-id>`
— **リポジトリの外**。中に置くと ripgrep・ファイル監視・IDEインデックスが
全部舐めに行き、エージェント自身も混乱する
- ブランチ: `doctrine/<task-id>-<slug>`、`project.baseBranch` から生やす
- 作成は自前の `git worktree add`（Claude Code の `-w` は使わない。
ライフサイクルの権威を1箇所に保つため）

### 後始末 — 成功と失敗で変える

- `**completed**` → worktree を削除、**ブランチは残す**。
完了後の扱いはワークフローの最終ステップが既に決めている
  - **例外**: 完了時に未コミットの変更が残っていたら**削除を拒否**し、警告として出す。
  これはワークフローの書き方のバグであり、黙って消してよいものではない
- `**failed` / `canceled`** → **worktree を残す**。
失敗した実行こそ中を見たい瞬間であり、そこで証拠を消すのは最悪の設計

残す判断の代償（溜まる）への対策:
UIで「古いworktree」を一覧表示 / `dctl gc` コマンド / N日経過で警告。
**溜まるのは見えていれば直せるが、消えたものは戻らない。**

### 孤児の照合

デーモン起動時に `git worktree list` とDBを突き合わせ、
対応するタスクのない worktree を検出して報告する（自動削除はしない）。

### 新品 worktree に `node_modules` がない問題

1タスク1worktree を選んだ時点で確定する問題であり、最初の実行で必ず踏む。

**解**: `project.yaml` の `setup` コマンドを全ワークフローの先頭に自動挿入する。

`**node_modules` をメインからシンボリックリンクする案は却下。**
ネイティブ依存で壊れ、複数タスクが同じ実体に同時に書けば破損する。
並行実行のために分離したのにそこだけ共有したら意味がない。

なお doctrine 自身は pnpm を使う（7章）。pnpm はグローバルな content-addressable
store から `node_modules` をハードリンクで張るため、worktree ごとの `setup` が
元から安い。**この性質は `setup` 自動挿入という解を採る前提を強くするが、
解そのものはパッケージマネージャに依存しない**（npm/yarn のプロジェクトでも
`setup` を書けば動く。ただし毎回フルインストールの代価を払う）。

### 実行枠

**2スコープ。両方に空きがある時だけ `queued` → `running` に遷移させる。**

- **全体** — マシン負荷とAPIコストの上限。既定 4
- **プロジェクト単位** — 既定 1

worktree で分離した以上、上限の理由は衝突回避ではなく**負荷とコスト**である。
プロジェクト単位の既定が1なのは衝突のためではなく、同じリポジトリに
複数エージェントをぶつけると後でマージが困難になるため。

**受付順**: 優先度（P0〜P3、既定P2）→ 作成時刻のFIFO。

### 枠の解放はスコープごとに違う

**2つの上限は理由が違うので、`suspended` / `paused` 時の扱いも違う。**

- **全体枠は解放する** — 理由はマシン負荷とAPIコスト。人間を待っている間、
タスクはCPUもトークンも消費していない。握り続ける理由がない
- **プロジェクト枠は保持する** — 理由は同一リポジトリでのマージ困難。
`suspended` のタスクは **worktree とブランチを生かしたまま**なので、
この理由は消えていない。ここで解放すると、まさに避けたかった状態
（同じリポジトリに複数の未マージブランチが並走する）を自分で作ることになる

**この非対称性が飢餓を消す。** `maxConcurrent: 1` のプロジェクトで、
タスクAが承認待ちの間にタスクBが割り込むことはない。承認した瞬間、
Aはプロジェクト枠を既に持っているので、全体枠さえ空けば即座に `running` に戻る。

**追加の規則**（全体枠の取り合いに対して）:

> **再開するタスクは行列の先頭に入る。進行中の仕事を、新規の仕事より先に終わらせる。**

画像の「実行枠を確保する」（suspend中も枠を握り続ける）は、この非対称性によって
**既定の挙動として組み込まれている**。ユーザーが操作するフラグとしては持たない。

### ①で意図的に落とすもの

- **先行タスク（依存関係）** — グラフのスケジューリング・循環検出・
依存先失敗時の伝播という別の設計が丸ごと必要になり、
「並行実行の管理」という中心から外れる
- **レート消費率に応じた枠の自動調整** — 記録はするが制御には使わない（6章）

## 6. Claude Code アダプタ

以下は `claude` v2.1.269 に対して**実測で確認した契約**である
（`claude --help` および `claude -p` の実行）。

### 起動コマンド

```
claude -p '<prompt>'
  --output-format stream-json --verbose
  --session-id <我々が生成したUUID>
  --permission-mode <workflowの指定>
  --permission-prompts none
  --model <workflowの指定>
```

確認事項:

- `**--output-format stream-json` は `-p` と併用時に `--verbose` 必須。**
付け忘れると
`Error: When using --print, --output-format=stream-json requires --verbose`
で即座に終了する
- `**--session-id <uuid>` で我々がIDを指定できる。**
出力からパースして拾う必要がない。タスク作成時にUUIDを採番してDBに書いてから
起動できるため、「起動したがIDを記録する前に落ちた」という穴が消える
- `**--permission-prompts none**` = プロンプトが出る操作は自動的に拒否される。
permission mode はそれ以外を決める。**headless でハングしないことを保証する**
- `--fork-session` は使わない（IDが変わるとDBとの対応が壊れる）

### 出力の読み取り

NDJSON（1行1JSON）。観測した `type`:
`system`（`subtype`: `init` / `hook_started` / `hook_response` / `thinking_tokens`）、
`rate_limit_event`、`assistant`、`result`。

**1行が極端に長くなる。** 実測では `hook_response` 行に skill 本文が丸ごと埋まっていた。
**行長に上限を仮定した読み取りを書いてはならない。**

### 終了判定

`type: "result"` の行が権威。含まれるフィールド:

- `subtype: "success"`, `is_error: false` — 成否
- `result` — 最終テキスト（`onFailure.feed` の素材、`{{ steps.<id>.stdout }}` の中身）
- `total_cost_usd`, `usage`, `num_turns`, `duration_ms` — `step_runs` に保存
- `permission_denials: []` — 権限で弾かれた操作の一覧。
`**--permission-prompts none` の下では、権限で弾かれた実行も
`is_error: false` で帰ってくる**（途中で何もできずに終わったことが成功に見える）。
そのため `permission_denials` が空でないステップ実行は
`step_runs.status` を `degraded` として記録し、UIで区別できるようにする。
ワークフローは停止させない（判断材料を出すところまでが①の責務）
- `terminal_reason: "completed"`

**実測結果**（`claude` v2.1.269、2026-09-12実施。以下2ケースのみ、詳細はTask 8レポート参照）:

| ケース | 終了コード | `is_error` | `permission_denials` |
|---|---|---|---|
| 正常終了（`say hi`） | `0` | `false` | `[]` |
| 権限で弾かれた実行（`--permission-mode default --permission-prompts none` で `rm` を試みさせる） | `0` | `false` | 非空（`tool_name: "Bash"` の1件） |

両ケースとも終了コードは `0` で、`is_error` も両方 `false` だった。つまり**終了コードは
成否はおろか degraded かどうかも区別しない**——プロセスが完走した場合、正常終了と
権限拒否のどちらも「終了コード0・`is_error: false`」という同じ組み合わせを返す。
終了コードが役立つのはプロセスが `result` 行を出さずに落ちた場合（クラッシュ等）の検知のみで、
その用途では非0を想定する（未計測。意図的にクラッシュさせる実測は本タスクの範囲外とした）。
これは設計時点の想定（result 行が権威、終了コードは補助）と完全に一致するため、
`resultFrom` の実装は変更していない。

### `rate_limit_event`

```json
{"type":"rate_limit_event","rate_limit_info":{
  "status":"allowed","rateLimitType":"five_hour",
  "unifiedWindows":{
    "five_hour":{"utilization":0.14,"resetsAt":...},
    "seven_day":{"utilization":0.04,"resetsAt":...}}}}
```

5時間枠・7日枠の消費率がストリームに流れてくる。

**①では `rate_limit_samples` に記録し、APIで読めるようにするだけ。
スケジューラの判断には使わない。** レート状況に応じた自動的な枠の絞り込みは
魅力的だが、閾値のチューニングという泥沼が待っている。必要になってから。

### 再開

```
claude -p --resume <session-id> --output-format stream-json --verbose ... '<追加指示>'
```

クラッシュ復帰と、`approval` ステップでの「却下＋追加指示」の両方をこれで賄う。

### アダプタの境界

デーモン本体は Claude Code 固有のことを知らない。アダプタが外に見せるのは:

- `start(prompt, opts) -> AgentRun`
- `resume(sessionId, prompt) -> AgentRun`
- `AgentRun`: `events`（正規化済みイベントの非同期イテレータ）、
`result`（成否・テキスト・コスト）、`kill()`

**この境界の目的は将来の他エージェント対応ではない**（対象は Claude Code のみと決定済み）。
**アダプタをモックしてエンジンをテストするため**である。
ワークフローエンジンのテストが実APIを叩いたらテストとして成立しない。

## 7. 技術スタック

- **ランタイム**: TypeScript + Node.js 24
  - Rust + 単一バイナリも検討したが、②のUIはどのフレームワークでもレンダラ側はTSになる。
  ワークフロースキーマとイベント型を**デーモンとUIで共有できる**価値が上回る。
  子プロセス起動と NDJSON の行単位読み取りは Node の得意領域
- **永続化**: SQLite（`node:sqlite`、組み込み。Node 24 では experimental 警告が出るが動作する）
  - uncle-jam の「1ジョブ = 1 JSONファイル」は捨てる。実行履歴・横断一覧・枠のカウントは
  クエリしたいデータであり、JSONファイル群では毎回全読みになる。
  書き手はデーモン1つだけなので同時書き込み問題は起きない
- **IPC**: Unix ドメインソケット + 改行区切りJSON
  - TCPポートは開かない。ローカル専用でポートを開くと待受アドレス・トークン・
  ポート衝突を全部考える羽目になる。ソケットはファイルパーミッションがそのまま認可になる
  - リクエスト/レスポンスに加え、**サーバ→クライアントのイベントプッシュ**
  （状態遷移、ステップ完了、ログ行）を同じ接続で流す。UIはポーリングしない
  - パス: `$XDG_RUNTIME_DIR/doctrine/dctld.sock`
- **依存パッケージは2つ**: `yaml`（パース）、`zod`（検証）
  - ユーザーが手で書く設定ファイルなので、**エラーメッセージの質が直接UXになる**。
  ここは手書きバリデータで妥協しない
  - uncle-jam のゼロ依存方針は引き継がない（学習用実装の制約であって本番の制約ではない）
- **テスト**: vitest
  - 「依存パッケージは2つ」はランタイム依存の話であり、vitest は devDependency なので
  デーモンの配布物は変わらない。テストの大半が実リポジトリ作成・子プロセス起動・
  ソケット接続を伴う統合寄りのものになるため、**失敗時に何が違うのかが読めること**と
  watch モードの価値が組み込みランナーで足りる範囲を上回る
  - アサーションは `node:assert/strict` を使う（ランナーを替えても書き方が変わらない）
- **ビルド**: `tsc` のみ
- **パッケージマネージャ**: pnpm
  - 5章で述べた worktree ごとの `setup` コストに直接効く。content-addressable store
  からのハードリンクなので、1タスク1worktree でも依存解決が重くならない
  - lockfile は `pnpm-lock.yaml` をコミットし、`setup` 相当は
  `pnpm install --frozen-lockfile`（`npm ci` に相当）で固定する
- **ツールチェーン管理**: mise（`mise.toml` をリポジトリ直下にコミット）
  - Node.js と pnpm のバージョンをリポジトリに固定する。
  デーモンが worktree の中でコマンドを走らせる以上、**worktree でも同じ
  バージョンが解決されなければならない**。`mise.toml` は追跡ファイルなので
  `git worktree add` で一緒に付いてくる（worktree はリポジトリ外に置くが、
  mise の設定探索は cwd から上に辿るだけなので問題にならない）

### 先送りを明示

**UIフレームワーク（Tauri / Deno Desktop / Electron）は②の決定事項。**
①はUnixソケット越しの契約しか持たないため、どれでも乗る。

現時点の調査結果（2026-09時点、実測ベンチと公式比較より）:

- 性能差は本用途では判断材料にならない。Tauri が有利なのは大量データがJSブリッジを
越える場面（映像フレーム等）であり、本用途（子プロセス起動・NDJSON読み取り・
数十枚のカード描画）では差が出ない
- Deno Desktop の最大の利点である in-process IPC は、**デーモン構成にした時点で
打ち消される**（どのみちソケットを跨ぐ）
- 実際に効く差は成熟度。Deno Desktop は 2.9（2026-06）で experimental。
既知バグに「ウィンドウを非表示にするとクラッシュする（可視ウィンドウが0になると
Denoランタイムが終了する）」があり、**常駐トレイ型UIと相性が悪い可能性がある**
- Tauri はレンダラからUnixソケットを開けないため、ソケット接続とイベント転送に
Rustのブリッジコード（150行程度）が要る
- **現時点の推奨は Tauri**（成熟度差が唯一の実質的な差であるため）。
②に着手する時点で Deno Desktop の安定度を再評価すること

## 8. デーモンAPI（②との契約）

Unix ソケット上の改行区切りJSON。リクエスト/レスポンスと、
サーバからのイベントプッシュが同一接続に流れる。

**リクエスト**

- `project.add` / `project.list` / `project.update`
- `task.create`（project, title, prompt, workflow?, priority?）
- `task.list`（フィルタ: project / state）/ `task.get`
- `task.approve`（task_id）/ `task.reject`（task_id, comment）
- `task.pause` / `task.resume` / `task.cancel`
- `task.logs`（task_id, step_run_id, tail? / follow?）
- `worktree.list` / `worktree.remove`（`dctl gc` の実体）
— 失敗したタスクの worktree は汚れているのが通常であり、git は削除を拒否する。
`git worktree remove --force` を使う。**未コミットの作業は失われる**ので、
UI側は必ず確認を挟むこと
- `ratelimit.recent`

**イベント（サーバ→クライアント）**

- `task.stateChanged`（task_id, from, to）
- `stepRun.started` / `stepRun.finished`
- `log.line`（task_id, step_run_id, line）— `follow` 中のみ
- `ratelimit.sample`

### 中断・保留・中止の意味

- `**task.pause**` — 実行中の子プロセスに SIGTERM を送り、`paused` へ。
`agent` ステップなら `claude_session_id` は保持され、`resume` で `--resume` から続く。
`command` ステップならそのステップを頭から再実行する（4章の冪等性制約と同じ）。
**全体枠は解放され、プロジェクト枠は保持される**（5章）
- `**task.resume**` — `paused` / `suspended` から `queued` へ。
行列の先頭に入る（5章の飢餓対策）
- `**task.cancel**` — 子プロセスを終了させ `canceled` へ。worktree は**残す**

## 9. 用語

- **タスク** — 1つのワークフロー実行。1つの worktree と1つのブランチを持つ
- **ステップ** — ワークフロー定義中の1要素
- **ステップ実行（step run）** — ステップの1回の試行。`onFailure.goto` により
同一ステップが複数回実行され得る
- **実行枠（slot）** — 同時に `running` でいられるタスクの数。全体とプロジェクト単位の2スコープ

