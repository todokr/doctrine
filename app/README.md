# doctrine レビューアプリ

[レビューアプリ設計](../docs/superpowers/specs/2026-09-13-review-app-design.md) の画面を、
Tauri v2 + React + Vite で組んだもの。デーモンとの接続は
[Tauri↔dctld 中継設計](../docs/superpowers/specs/2026-09-18-tauri-dctld-relay-design.md) に従う。
サイドバー・レビュー画面・タスク画面は、いずれも Rust の中継を通じて `dctld`（デーモン本体、
リポジトリ直下の `core/src/daemon/`）から取った本物のタスク・プロジェクトの行で動く。デーモンがまだ
返せない項目（diff・ログの追従など）はモックで埋めず、「まだありません」という注記を出す
（[Tauri↔dctld 中継設計](../docs/superpowers/specs/2026-09-18-tauri-dctld-relay-design.md) 7章のとおり、
本物と作り物のデータが混ざった画面を残すより、この方が誠実である）。
`src/fixtures.ts` はテストと開発用のプレビュー（`src/dev/`）専用のフィクスチャで、アプリの画面は import しない。

```bash
mise install          # Deno / Node / pnpm / Rust（リポジトリ直下の mise.toml）
mise run setup        # core と app の依存を取得
mise run core:install # dctl / dctld を deno install する（~/.deno/bin に入る）
mise run app:tauri    # ウィンドウで開く（起動時に dctld を自動で起こす）
mise run app:dev      # ブラウザで開く（http://localhost:1420。Tauri の invoke が無いのでデーモンにはつながらない）
mise run app:test     # 状態の更新と導出（src/model.ts など）の単体テスト
```

PFD の図の目視: `mise run app:dev` で開発サーバーを起こし、`http://localhost:1420/pfd-preview.html` を開く。

`~/.deno/bin` が PATH に無いと `mise run app:tauri` が `dctld` を見つけられない。
`export PATH="$HOME/.deno/bin:$PATH"` を通してから起動する（`mise run core:install` の出力にも同じ案内が出る）。
ビルド済み `.app` を Finder などから直接起こす場合はシェルの PATH を継承しないため、
`DOCTRINE_DCTLD` に `dctld` の絶対パスを設定する。

Linux では WebKitGTK 4.1 などが要る（[Tauri の前提](https://tauri.app/start/prerequisites/)）。

## 構成

- `src/model.ts` — 画面の状態と reducer、サイドバーの区分・差し戻しコメントの組み立てなどの純関数
- `src/patch.ts` — `task.diff` の応答（ファイルの一覧 + 1 本の patch）を、画面が描くファイル単位の形に組み立てる
- `src/highlight.ts` — diff のシンタックスハイライト（Prism）。hunk 単位で解析するので、
  ブロックコメントやテンプレートリテラルのように行をまたぐトークンも続きの行に色が付く。
  削除行と追加行は別々の流れとして解析する（対になる変更で引用符が繋がらないようにするため）
- `src/pfd.ts` — PFD の図の配置と見た目の導出（`layoutGraph` を借りる）
- `src/fixtures.ts` — テストと開発用のプレビュー用のフィクスチャ。アプリの画面はここを import しない
- `src/daemon/client.ts` — `invoke("rpc")` / `listen("daemon-event")` / `listen("daemon-connection")` を
  呼ぶ唯一の場所。`../../../shared/protocol.ts` の型をそのまま import する（正本は 1 つ）
- `src/store.tsx` — reducer の置き場所、`task.list` / `project.list` の取得と 15 秒ごとの取り直し、
  レビュー中のタスクの `task.diff` / `task.context` の取得、下書きの保存。
  diff と経緯は 15 秒ごとの取り直しには乗せない（承認待ちの間 worktree は凍っているため）。
  取り直すのは状態が動いたとき・承認や差し戻しを送ったときで、そのとき reducer が捨てる
- 下書き（行コメントと全体コメント）はアプリのデータディレクトリの `drafts.json` に置く。
  読み書きは Rust 側の `load_drafts` / `save_drafts`。アプリを閉じても消えず、
  承認・差し戻しがデーモンに受理されたときにだけ捨てる
- `src/components/` — 画面（`ConnectionBanner.tsx` が接続状態のバナー）
- `src/components/PfdDiagram.tsx` — PFD の図。どの画面にもまだ置いていない
- `src-tauri/src/relay.rs` — ソケット接続を 1 本保持し `rpc` を中継する。method の種類は見ない
- `src-tauri/src/daemon.rs` — ソケットパスの解決、`dctld` の探索・切り離し起動・ログ
- `src-tauri/` — Tauri の最小構成

## デーモン（dctld）との接続

アプリは Linux では `$XDG_RUNTIME_DIR/doctrine/dctld.sock`、macOS では `XDG_RUNTIME_DIR` が無いため
`~/.local/state/doctrine/dctld.sock`（`DOCTRINE_STATE_DIR` があればそちらの下）に接続する。
解決の優先順位は `DOCTRINE_SOCKET`（直指定）→ `XDG_RUNTIME_DIR`（OS を問わない）→ OS ごとの既定、
という順。TypeScript 側（`core/src/daemon/server.ts` の `resolveSocketPath`）と Rust 側
（`src-tauri/src/daemon.rs` の `resolve_socket_path`）は同じ規則で、どちらのテストも用意してある。

- **ソケットパスが決められなくても、アプリは起動する。** 起動時に理由がバナー
  （画面上部の「dctld に接続できません — 再接続しています」）に出るだけで、ウィンドウは出る。
  この場合バナーの文言は「再接続しています」だが、パスが決まらない限り実際には再接続を試みない
  （メッセージが状況を厳密に言い分けていない既知の粗さ）
- 起動時にソケットへ繋がらなければ、アプリが `dctld` を切り離して起こす
  （`process_group(0)`）。アプリを終了しても、ターミナルで Ctrl-C しても `dctld` は残る。
  ソケットファイルが残っているだけで中身の `dctld` が居ない（`ECONNREFUSED` になる）場合も同じ
  扱いで起こす。ファイル自体は消さない（生きているデーモンを誤って切り離す危険があるため）
- `dctld` は `DOCTRINE_DCTLD`（絶対パス指定）→ PATH の `dctld` の順で探す。
  `mise run core:install` で `~/.deno/bin` に入る
- `dctld` の起動そのものに失敗した場合（見つからない・起動できない）も、起動には成功したがすぐに
  終了した場合（クラッシュループ）も、バナーに理由が出る。後者は「dctld が起動直後に終了しました。
  状態ディレクトリの dctld.log を確認してください」という案内になる（respawn 自体は backoff を
  挟みながら続けるので、直した後に何もしなくても自動で復帰する）
- アプリが起こした `dctld` の標準出力・標準エラーは状態ディレクトリの `dctld.log` に追記される
  （`DOCTRINE_STATE_DIR` を指定していれば macOS でもその下）
- 接続が切れると画面上部にバナーが出て、500ms から最大 30 秒まで倍々に間隔を伸ばしながら
  再接続する。繋がり直したときに `task.list` / `project.list` を取り直すので、
  その間のイベントの取りこぼしはそこで吸収される
