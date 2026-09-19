# doctrine レビューアプリ

[レビューアプリ設計](../docs/superpowers/specs/2026-09-13-review-app-design.md) の画面を、
Tauri v2 + React + Vite で組んだもの。デーモンとの接続は
[Tauri↔dctld 中継設計](../docs/superpowers/specs/2026-09-18-tauri-dctld-relay-design.md) に従う。
サイドバー・レビュー画面・タスク画面は、いずれも Rust の中継を通じて `dctld`（デーモン本体、
リポジトリ直下の `src/daemon/`）から取った本物のタスク・プロジェクトの行で動く。デーモンがまだ
返せない項目（diff・ログの追従など）はモックで埋めず、「まだありません」という注記を出す
（レビュー画面設計spec 11章のとおり、本物と作り物のデータは混ぜない）。
`src/fixtures.ts` はテスト（`src/model.test.ts`）専用のフィクスチャで、画面には出てこない。

```bash
mise install          # Rust（リポジトリ直下の mise.toml）
pnpm install
deno task install     # dctl / dctld を deno install する（リポジトリ直下、~/.deno/bin に入る）
pnpm tauri dev        # ウィンドウで開く（起動時に dctld を自動で起こす）
pnpm dev              # ブラウザで開く（http://localhost:1420。Tauri の invoke が無いのでデーモンにはつながらない）
pnpm test             # 状態の更新と導出（src/model.ts など）の単体テスト
```

`~/.deno/bin` が PATH に無いと `pnpm tauri dev` が `dctld` を見つけられない。
`export PATH="$HOME/.deno/bin:$PATH"` を通してから起動する（`deno task install` の出力にも同じ案内が出る）。
ビルド済み `.app` を Finder などから直接起こす場合はシェルの PATH を継承しないため、
`DOCTRINE_DCTLD` に `dctld` の絶対パスを設定する。

Linux では WebKitGTK 4.1 などが要る（[Tauri の前提](https://tauri.app/start/prerequisites/)）。

## 構成

- `src/model.ts` — 画面の状態と reducer、サイドバーの区分・差し戻しコメントの組み立てなどの純関数
- `src/fixtures.ts` — `src/model.test.ts` 用のフィクスチャ。画面はここを import しない
- `src/daemon/client.ts` — `invoke("rpc")` / `listen("daemon-event")` / `listen("daemon-connection")` を
  呼ぶ唯一の場所。`../../../src/daemon/protocol.ts` の型をそのまま import する（正本は 1 つ）
- `src/store.tsx` — reducer の置き場所、`task.list` / `project.list` の取得と 15 秒ごとの取り直し、
  下書きの保存（当面 localStorage）
- `src/components/` — 画面（`ConnectionBanner.tsx` が接続状態のバナー）
- `src-tauri/src/relay.rs` — ソケット接続を 1 本保持し `rpc` を中継する。method の種類は見ない
- `src-tauri/src/daemon.rs` — ソケットパスの解決、`dctld` の探索・切り離し起動・ログ
- `src-tauri/` — Tauri の最小構成

## デーモン（dctld）との接続

アプリは Linux では `$XDG_RUNTIME_DIR/doctrine/dctld.sock`、macOS では `XDG_RUNTIME_DIR` が無いため
`~/.local/state/doctrine/dctld.sock`（`DOCTRINE_STATE_DIR` があればそちらの下）に接続する。
解決の優先順位は `DOCTRINE_SOCKET`（直指定）→ `XDG_RUNTIME_DIR`（OS を問わない）→ OS ごとの既定、
という順。TypeScript 側（`src/daemon/server.ts` の `resolveSocketPath`）と Rust 側
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
  `deno task install` で `~/.deno/bin` に入る
- `dctld` の起動そのものに失敗した場合（見つからない・起動できない）は、その理由をバナーに出す。
  起動には成功したがすぐに終了した場合（クラッシュループ）は理由がバナーには出ず、状態ディレクトリの
  `dctld.log` にしか残らないので、再接続が続くようならまずそこを見る
- アプリが起こした `dctld` の標準出力・標準エラーは状態ディレクトリの `dctld.log` に追記される
  （`DOCTRINE_STATE_DIR` を指定していれば macOS でもその下）
- 接続が切れると画面上部にバナーが出て、500ms から最大 30 秒まで倍々に間隔を伸ばしながら
  再接続する。繋がり直したときに `task.list` / `project.list` を取り直すので、
  その間のイベントの取りこぼしはそこで吸収される
