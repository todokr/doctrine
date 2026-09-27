# doctrine

ローカルマシンで複数の Claude Code を同時に走らせ、決められた手順で最後まで走らせきるためのデスクトップツール。

- 使い方（セットアップ、ワークフローの書き方、運用と制約）は [ドキュメントサイト](https://todokr.github.io/doctrine/) にある。
- 全体像・原則・用語は [`docs/overview.md`](docs/overview.md) にある。

サイトはまだ公開していない。手元では `mise run setup` の後に `mise run site:dev` で開ける。

## インストール

配布用のビルドはまだ無い。リポジトリをクローンし、手元でビルドして起動する。

### 前提

| ツール | 用途 |
| --- | --- |
| [Git](https://git-scm.com/) | リポジトリの取得。doctrine はタスクごとに git worktree を作る |
| [mise](https://mise.jdx.dev/) | Deno・Node.js・pnpm・Rust を [`mise.toml`](mise.toml) の版で入れる。シェルで activate しておく |
| [Claude Code](https://docs.claude.com/en/docs/claude-code/overview)（`claude`） | ワークフローの各ステップを実行するエージェント。ログインまで済ませておく |
| [GitHub CLI](https://cli.github.com/)（`gh`） | Issue の取り込みと PR の作成・マージの見張り。`gh auth login` を済ませておく |

デスクトップアプリ（Tauri）のビルドには、macOS では Xcode Command Line Tools（`xcode-select --install`）、Linux では WebKitGTK 4.1 など（[Tauri の前提](https://tauri.app/start/prerequisites/)）が要る。

### 手順

```sh
git clone https://github.com/todokr/doctrine.git
cd doctrine

mise trust              # このリポジトリの mise.toml を信頼する
mise install            # Deno / Node.js / pnpm / Rust
mise run setup          # 依存を lock ファイルどおりに取る
mise run core:install   # dctl / dctld を ~/.deno/bin に置く

export PATH="$HOME/.deno/bin:$PATH"   # 未設定ならシェルの設定に足す
mise run app:tauri      # アプリを起動する（dctld はアプリが自動で起こす）
```

初回の `mise run app:tauri` は Rust のビルドで数分かかる。画面上部に「dctld に接続できません」と出続けるときは、`which dctld` で PATH を確かめ、`~/.local/state/doctrine/dctld.log` を見る。
