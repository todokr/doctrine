# Tauri アプリを dctld につなぐ中継

- 日付: 2026-09-18
- 状態: 実装済み
- issue: [#41](https://github.com/todokr/doctrine/issues/41)、[#42](https://github.com/todokr/doctrine/issues/42)
- 前提: [レビューアプリ設計spec](2026-09-13-review-app-design.md) 4章・11章、[overview](../../overview.md)

## 1. 位置づけ

アプリは今、全画面がモックデータで動くガワである（`app/src-tauri/src/lib.rs` は 8 行で、Tauri コマンドが
1 つも無い）。本specは**デーモンとやりとりする経路**と、その経路に乗る**最初の画面（サイドバー）**を決める。

ロードマップ（#63）の M1 では、コア側（#43 → #44 #45）とアプリ側（#41 → #42）が並行して進み、#46 で合流する。
本specはアプリ側の 2 つ、#41 と #42 をまとめて扱う。中央の画面（レビュー画面・タスク画面）を実データで
動かすのは #46 / #47 であり、本specの範囲外である。

## 2. 決定の要約

| 項目 | 決定 | 章 |
| --- | --- | --- |
| 範囲 | #41（中継）＋ #42（サイドバー）を 1 つにする | 1 |
| ソケットパス | macOS の分岐を足す。`XDG_RUNTIME_DIR` が無い macOS では状態ディレクトリに置く | 3 |
| 接続の保持と再接続 | **Rust** が 1 本の接続を保持し、指数バックオフで再接続する | 4 |
| Tauri コマンド | `rpc` の 1 つだけ。Rust はメソッドの種類を知らない | 4 |
| Tauri イベント | `daemon-event`（素通し）と `daemon-connection`（接続状態） | 4 |
| `dctld` の探索 | `DOCTRINE_DCTLD` → PATH の `dctld`。externalBin での同梱は配布を考える段で | 5 |
| 切り離し起動 | `process_group(0)` ＋ stdin を `/dev/null` に | 5 |
| `dctld` のログ | 状態ディレクトリの `dctld.log` に追記 | 5 |
| 型の共有 | `src/daemon/protocol.ts` を app から直接 import する（正本は 1 つ） | 6 |
| サイドバー | `task.list` ＋ `project.list` ＋ イベント ＋ 15 秒の取り直し | 7 |
| デーモン側の変更 | `socketPath()` の macOS 分岐、`task.list` の `has_degraded` | 3・8 |

## 3. 前提の修正 — macOS で dctld が起動できない

`src/daemon/server.ts` の `socketPath()` は、`XDG_RUNTIME_DIR` が無ければ `/run/user/<uid>` に倒す。

```ts
const base = Deno.env.get("XDG_RUNTIME_DIR") ?? `/run/user/${Deno.uid() ?? 1000}`;
```

**macOS には `XDG_RUNTIME_DIR` が無く、`/run` は read-only である**（`mkdir: cannot create directory
'/run': Read-only file system`）。`server.listen()` の `Deno.mkdir` がここで失敗するので、現在の macOS では
`dctld` がそもそも起動しない。レビューアプリ設計spec 1章は対象 OS を macOS と Linux と決めており、
#41 の完了条件（「アプリから `task.list` を呼んで本物の応答が返る」）はこれを直さないと満たせない。

### 決定

`XDG_RUNTIME_DIR` が無いときの落とし先を OS で分ける。

| 条件 | ソケット |
| --- | --- |
| `XDG_RUNTIME_DIR` がある | `$XDG_RUNTIME_DIR/doctrine/dctld.sock`（今までどおり） |
| 無い・Linux | `/run/user/<uid>/doctrine/dctld.sock`（今までどおり） |
| 無い・macOS | `<状態ディレクトリ>/dctld.sock` |

状態ディレクトリは既存の `stateRoot()`（`DOCTRINE_STATE_DIR` ?? `~/.local/state/doctrine`）である。
DB とログが既にそこにあり、`0o700` で作られている。`server.ts` の「ファイルパーミッションがそのまま
認可になる」という前提を保てる。

`$TMPDIR` も候補だが採らない。macOS の `/var/folders/…/T` は一定期間アクセスが無いと OS が掃除するので、
**動いているデーモンの足元からソケットファイルが消える**経路ができる。Unix ドメインソケットのパス長
制限（macOS で 104 バイト）にも近づく。

再起動をまたいで古いソケットファイルが残る点は、`assertSocketNotLive()`（`src/daemon/main.ts`）が
既に扱っている。接続を試して ECONNREFUSED なら古いものとして消し、判定できなければ起動を拒否する。

### 置き場所

`stateRoot()` は今 `src/daemon/main.ts` にあり、`main.ts` は `server.ts` を import している。
`socketPath()` から呼ぶと循環するので、`stateRoot()` を `src/util/home.ts` へ移す（`homeDir()` の隣）。
`main.ts` は再 export して呼び出し側を変えない。

## 4. Rust の中継

```
app/src-tauri/src/
├── lib.rs      Builder の組み立て、.manage(Relay)、invoke_handler
├── relay.rs    接続の保持・id 採番・応答の対応付け・イベント転送・再接続
└── daemon.rs   ソケットパスの解決、dctld の探索と切り離し起動
app/src-tauri/tests/relay.rs   偽のソケットサーバーに対する結合テスト
```

依存に `tokio`（`net` / `io-util` / `sync` / `time` / `rt`）を足す。CI は `cargo check --locked` を
流すので `Cargo.lock` も一緒にコミットする。

### コマンドは 1 つだけ

```rust
#[tauri::command]
async fn rpc(method: String, params: Value, relay: State<'_, Relay>) -> Result<Value, String>
```

**Rust は `method` の中身を見ない。** `params` は素通しする。デーモンの応答が `ok: true` なら `result` を
返し、`ok: false` なら `error` を `Err` にする。デーモンの API が増えても Rust は変わらない。

### イベントは 2 本

| イベント | 中身 |
| --- | --- |
| `daemon-event` | ソケットから来た `{ event: … }` の行をそのまま |
| `daemon-connection` | `{ status: "connecting" \| "connected" \| "disconnected", detail?: string }` |

`detail` には、`dctld` が見つからない・起動に失敗したといった、人が読んで対処できる理由を入れる。
画面上部のバナーはこの 1 本だけを見る。

### 接続の一生

Rust の常駐タスクが次を回す。

1. ソケットに接続を試みる
2. 失敗し、かつ**ソケットファイルが存在しない**なら `dctld` を起動し、ソケットが現れるまで
   100ms ごとに最大 5 秒待つ（5章）
3. つながったら `connected` を emit し、reader ループへ入る
4. reader は行ごとに JSON を parse する。`id` があれば pending から `oneshot` を取り出して解決し、
   `event` があれば emit する。壊れた行は捨てて次の行へ進む
5. EOF またはエラーで、pending 全部に「接続が切れました」を返し、`disconnected` を emit する。
   バックオフして 1 へ戻る

**ソケットファイルが在るのに繋がらないとき、中継はそれを消さない。** 生きているデーモンを気づかれずに
切り離す危険があり、その判定は `assertSocketNotLive()` の担当である（3章）。

バックオフは 0.5 秒から倍にし、上限 30 秒。`connecting` は 1 回だけ emit する（毎回の試行では出さない。
バナーがちらつくだけで、人が得る情報が増えない）。

書き込みは単一の writer タスクに mpsc で送って直列化する。`src/daemon/server.ts` が書き込み側で
`client.writing` を数珠つなぎにしているのと同じ理由である。

### リクエストの対応付け

- id は中継が採番する（`AtomicU64`）。フロントエンドは id を知らない
- pending は `Mutex<HashMap<u64, oneshot::Sender<…>>>`
- 1 リクエストのタイムアウトは 30 秒。`dctl` の `REQUEST_TIMEOUT_MS` と揃える。切れたら pending から
  外して `Err` にする（外さないと切断まで残り続ける）
- 切断中の `rpc` は待たせず即 `Err` にする。フロントは接続状態を見てから呼ぶが、競合は避けられない

### テストできる形にする

`Relay` は Tauri を起動せずに構築できるようにし、emit は `AppHandle` ではなくコールバック
（`Fn(&str, Value)`）で受け取る。`lib.rs` がそこに `app_handle.emit(…)` を差す。
結合テスト（9章）はこのコールバックに対して主張する。

## 5. dctld の起動

### 探索

1. `DOCTRINE_DCTLD`（絶対パス）
2. PATH 上の `dctld`（`deno task install` で入る）

どちらも無ければ起動を諦め、`daemon-connection` の `detail` に
「`dctld` が見つかりません（`deno task install` で入ります）」を載せる。
`deno compile` したバイナリを externalBin で同梱するのは、配布を考える段の別 issue とする。

### 切り離し

```rust
use std::os::unix::process::CommandExt;

Command::new(dctld)
    .process_group(0)        // 新しいプロセスグループ
    .stdin(Stdio::null())
    .stdout(log.try_clone()?)
    .stderr(log)
    .spawn()?;
```

Unix では親が死んでも子は自動では死なないが、**ターミナルの Ctrl-C は前面プロセスグループ全体に
SIGINT を送る**。`pnpm tauri dev` を Ctrl-C で止めると `dctld` も巻き添えになるので、
新しいプロセスグループに移して断つ。`process_group` は std にあり（Rust 1.64 以降、`mise.toml` は
1.98.1 を固定）、macOS と Linux の両方で動く。`setsid` コマンドは macOS に標準で無いので使わない。

### ログ

切り離すと `dctld` の stdout / stderr の行き先が無くなる。`dctld` は起動時の復帰結果・孤児の検出・
tick の失敗・後始末の警告を stderr に出すだけなので、捨てると起動に失敗した理由が一切残らない。

`<状態ディレクトリ>/dctld.log` に追記で開いて渡す。状態ディレクトリの解決は Rust 側にも要る
（`DOCTRINE_STATE_DIR` ?? `$HOME/.local/state/doctrine`）。

レビューアプリ設計spec 9章の `daemon.warning` / `daemon.warnings` はデーモン側の別 issue であり、
起動時の復帰ログはそこにも乗らない。ログファイルはその後も残す。

### パス解決が 2 箇所にある

ソケットパスと状態ディレクトリの決め方が TypeScript（`src/`）と Rust（`app/src-tauri/`）の両方に
書かれることになる。片方だけ直すと、症状が「繋がらない」としか出ない食い違いになる。
両方にテストを置いて、規則を明示的に固定する（9章）。

## 6. フロントエンドの薄いクライアント

`app/src/daemon/client.ts` に置く。

```ts
export function rpc<M extends Method>(method: M, params: Params<M>): Promise<Result<M>>;
export function onDaemonEvent(fn: (ev: ServerEvent) => void): () => void;
export function onConnection(fn: (c: ConnectionStatus) => void): () => void;
```

### 型は protocol.ts を直接 import する

`app/tsconfig.json` の `include` に `../src/daemon` を足し、Vite の `server.fs.allow` にリポジトリルートを
足す。コピーも生成もしない。CI のパス判定（`.github/workflows/ci.yml`）は既に
`src/daemon/protocol.ts` をアプリ側のトリガに入れており、共有を前提にしている。

`protocol.ts` は今 `Request` / `Response` / `ServerEvent` しか持たず、**メソッドごとの params と result の
型が無い**。本specで使う分を `protocol.ts` に足す。正本を 1 つに保つという指示の筋であり、
アプリ側に置くと #44〜#47 が同じものを別の場所に書き足すことになる。

足すのは次の 5 つ。既存のデーモンの振る舞いを書き写すだけで、API は変えない。

| メソッド | params | result |
| --- | --- | --- |
| `task.list` | `{ project?, state? }` | `TaskSummary[]`（8章で `has_degraded` を足す） |
| `project.list` | `{}` | `ProjectSummary[]` |
| `task.approve` | `{ task_id }` | `TaskSummary` |
| `task.reject` | `{ task_id, comment }` | `TaskSummary` |
| `task.cancel` | `{ task_id }` | `TaskSummary` |

`TaskSummary` はデーモンが返す `TaskRow` の形である。DB の行の型（`src/db/schema.ts`）をそのまま
export すると、UI が DB のスキーマに直結してしまう。`protocol.ts` に「API が返す形」として別に書く。

`deno fmt --check` と `deno lint` が CI で走るので、`protocol.ts` の変更はそれを通す（`lineWidth` は 100）。

## 7. サイドバーを実データで動かす

### 取得と反映

- 起動時に `project.list` と `task.list` を取る
- `daemon-event` を reducer に流す
- `daemon-connection` が `connected` になったら取り直す（レビューアプリ設計spec 4章
  「イベントの取りこぼしはこの取り直しで吸収する」）
- **15 秒ごとにも取り直す。** `dctl add` で作られた `queued` のタスクは、実行枠が取れて `running` に
  なるまで `task.stateChanged` が飛ばない。`task.create` は何も broadcast しないので、
  取り直しが無いと画面に出てこない。デーモンに `task.created` を足す案もあるが、
  「取りこぼしは取り直しで吸収する」という既に決めた形の中で解ける

`model.ts` の `reduce` に `{ type: "sync"; tasks; projects }` と `{ type: "daemon"; ev }` を足す。
副作用は `store.tsx` に閉じ、`reduce` は純関数のまま保つ。テストは vitest（9章）。

`types.ts` の `Task` はそのまま残し、`TaskSummary` から写す関数を置く。
デーモンが持たない欄（`diff` / `guide` / `reviews` / `reviewFiles` / `lastCommand`）は空にする。

### 割り切り

- **「待ち始めた時刻」「今の状態になってからの経過」は `updated_at` で代用する。**
  レビュー 1 回を 1 件の記録として残すのは #43 の仕事である
- **`project` の表示名と色。** `task.list` は `project_id`（数値）しか返さない。`project.list` の
  `path` の末尾を名前にし、色は `path` のハッシュから決める。プロジェクトの色と表示名を
  デーモンに持たせる話は本specでは扱わない
- **要確認の判定。** `failed` は state から分かる。削除拒否は `completed` かつ `worktree_path` が
  非 null で分かる（レビューアプリ設計spec 5章）。degraded は 8章でデーモンに足す
- **モック前提の非 null 参照を外す。** `model.ts` の `stepDef()` は `s.workflows[t.wf]` が必ずある前提で
  `.find()` を呼び、`Sidebar.tsx` は `s.projects.find(…)!` と書いている。実データでは
  ワークフロー定義を持たず、プロジェクトも取得の前後でずれうるので、どちらも無いときに落ちない形にする

### 中央の画面

レビュー画面とタスク画面はモックの `diff` / `guide` / `reviews` に依存している。タスクを実データに
差し替えると中身が無くなるので、**「diff はまだ取得できません（#44）」に相当する表示に留める**。
見た目としては後退するが、モックと実データが混ざった画面を残すより誠実である。
埋めるのは #44〜#47 である。

`app/src/mock.ts` は消す。残すと、どの画面が本物でどの画面が偽物か分からなくなる。
今 import しているのは 3 箇所で、扱いはそれぞれ違う。

| 参照元 | 扱い |
| --- | --- |
| `store.tsx`（`seedTasks` / `PROJECTS` / `WORKFLOWS` / `NOW`） | デーモンからの取得に置き換える |
| `model.test.ts`（同上） | テスト用のフィクスチャとして `app/src/fixtures.ts` に移す |
| `TaskView.tsx`（`FOLLOW_POOL`） | ログ追従の偽物なので消す。本物は `task.logs` の follow で #47 |

`WORKFLOWS`（ステップ定義）はデーモンに問い合わせる口がまだ無い（`workflow.list` は #58）。
ステップ定義が要るのは中央の画面だけなので、本specでは持たない。

## 8. デーモン側の変更

本specがコアに触るのは 2 箇所だけである。

### `socketPath()` の macOS 分岐

3章のとおり。`stateRoot()` を `src/util/home.ts` へ移す。

### `task.list` に `has_degraded` を足す

サイドバーの要確認の判定に要る（レビューアプリ設計spec 5章・9章、第 1 段階に含まれている）。
`step_runs` に `status = 'degraded'` の行があるタスクに `true` を立てる。

`listTasks()`（`src/db/tasks.ts`）は DB の行をそのまま返す関数なので、ここは変えない。
`handlers.ts` の `task.list` が結果に足す。`dctl ls` の出力にも 1 列増えるが害は無い。

**これ以外のデーモン側の変更は本specに入れない。** `task.diff` / `task.context` / `task.cleanedUp` /
`daemon.warning` はレビューアプリ設計spec 9章のとおり #43〜#45 の仕事である。

## 9. テスト

### Rust の結合テスト（`app/src-tauri/tests/relay.rs`）

テスト内で偽の Unix ソケットサーバーを立てる。実物の `dctld` は要らない（CI は Ubuntu で
`cargo test --locked` を流す）。

- **リクエストと応答の対応**: 3 本同時に投げ、サーバーが逆順に応答しても取り違えない
- **イベントの転送**: `{ event: … }` の行が emit コールバックに届く。応答の待ちを壊さない
- **切断と再接続**: サーバーを落とすと pending が `Err` になり `disconnected` が届く。
  立て直すと `connected` が届き、`rpc` がまた通る
- **壊れた行**: JSON として読めない行を捨てて、次の行を処理できる
- **タイムアウト**: 応答を返さないサーバーに対して、待ち続けずに `Err` になり pending から外れる
- **エラー応答**: `ok: false` が `Err` になる
- **ソケットパスの解決**: `DOCTRINE_SOCKET` / `XDG_RUNTIME_DIR` / macOS の順序が規則どおり

### vitest（`app/src/`）

reducer は純関数なので、Tauri を起動せずにテストできる。

- サイドバーの区分の判定（`failed` / 削除拒否 / `has_degraded`）
- `task.stateChanged` を受けて区分が移ること
- 取り直しによる状態の合わせ込み（知らないタスクが増える、消えたタスクが落ちる、選択中のタスクが
  消えたときの選択の行き先）
- `TaskSummary` から `Task` への写し

### deno test（`test/`）

- `task.list` が `has_degraded` を返すこと（degraded な step_run を持つタスクだけ `true`）
- `socketPath()` の分岐（`XDG_RUNTIME_DIR` あり / 無し・Linux / 無し・macOS）

### 手で確かめること（完了条件）

- `dctld` を止めた状態でアプリを起動すると、アプリが `dctld` を起こしてサイドバーが埋まる
- アプリを終了しても `dctld` が残る。`pnpm tauri dev` を Ctrl-C で止めても残る
- `dctld` を落とすとバナーが出て、上げ直すと自動で復帰しサイドバーが合う
- `dctl add` で足したタスクが 15 秒以内にサイドバーへ出る

画面の E2E テストは書かない（レビューアプリ設計spec 11章）。

## 10. 範囲外と未決

### 範囲外

- **externalBin での `dctld` 同梱** — 配布を考える段で別 issue
- **トレイ・OS 通知・single-instance** — #54 / #55
- **`task.diff` / `task.context` / `task.cleanedUp` / `daemon.warning`** — #43〜#45
- **レビュー画面とタスク画面の実データ化** — #46 / #47
- **`task.logs` の follow** — #47。1 本の接続を UI 全体で共有するので、follow の上書き
  （レビューアプリ設計spec 9章）と噛み合わせる設計がそこで要る
- **コンポーザ** — #58
- ログイン時の自動起動、署名・公証・自動更新

### 未決

- **`daemon-event` の型の絞り込み。** Rust は素通しするので、フロントに届く値は `unknown` である。
  `ServerEvent` へ絞る検証を置くかどうかは実装計画で決める（置かないなら、知らない `event` を
  黙って無視する形にする）
- **バックオフの上限 30 秒が長すぎないか。** 使ってみて決める

## 11. 検討して採らなかった案

- **フロントエンドが再接続を駆動する**（Rust は `connect` / `disconnect` だけ持つ）— Rust はさらに
  薄くなるが、レビューアプリ設計spec 11章が要求する「切断と再接続を Rust の結合テストで確かめる」から
  外れる。再接続は接続を持っている側の責務である
- **リクエストごとに接続する**（`dctl` と同じ形）— イベントを受け続けるには接続を張りっぱなしに
  する必要があり、採れない
- **`protocol.ts` を `app/src` にコピーする** — 設定は要らないが正本が 2 つになる。
  CI のパス判定が既に共有を前提にしている
- **`$TMPDIR` を macOS のソケット置き場にする** — OS の掃除で動いているデーモンの足元から
  ソケットが消える（3章）
- **`setsid` コマンドで切り離す** — macOS に標準で無い（5章）
- **デーモンに `task.created` イベントを足す** — 取り直しで足りる（7章）
- **`#41` と `#42` を別 PR にする** — 中継だけでは画面に何も出ず、「本物の応答が返る」ことを
  テストでしか示せない。1 つにすると、動いているところを見て判断できる
