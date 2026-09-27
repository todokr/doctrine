---
title: Quick Start
description: リポジトリを取得して、doctrine のアプリを起動するまで。
---

doctrine はまだ配布用のビルドがありません。リポジトリをクローンし、手元でビルドして起動します。

## 前提

次のツールを先に入れておきます。

| ツール | 用途 |
| --- | --- |
| [Git](https://git-scm.com/) | リポジトリの取得。doctrine はタスクごとに git worktree を作る |
| [mise](https://mise.jdx.dev/) | Deno・Node.js・pnpm・Rust を決まった版で入れる。版は `mise.toml` が決める |
| [Claude Code](https://docs.claude.com/en/docs/claude-code/overview)（`claude`） | ワークフローの各ステップを実行するエージェント。ログインまで済ませておく |
| [GitHub CLI](https://cli.github.com/)（`gh`） | Issue の取り込みと PR の作成・マージの見張り。`gh auth login` を済ませておく |

加えて、デスクトップアプリ（Tauri）のビルドに OS ごとの前提が要ります。

- macOS: Xcode Command Line Tools（`xcode-select --install`）
- Linux: WebKitGTK 4.1 など（[Tauri の前提](https://tauri.app/start/prerequisites/)）

mise はシェルで有効にしておきます（[mise の activate](https://mise.jdx.dev/getting-started.html)）。有効でないと、mise が入れた `deno` や `pnpm` が PATH に乗りません。

## 1. リポジトリを取得する

```sh
git clone https://github.com/todokr/doctrine.git
cd doctrine
```

## 2. ツールと依存を入れる

```sh
mise trust        # このリポジトリの mise.toml を信頼する
mise install      # Deno / Node.js / pnpm / Rust
mise run setup    # 依存を lock ファイルどおりに取る
```

## 3. `dctl` と `dctld` を PATH に置く

```sh
mise run core:install
```

CLI の `dctl` とデーモンの `dctld` が `~/.deno/bin` に入ります。`~/.deno/bin` が PATH に無ければ、シェルの設定に足します。

```sh
export PATH="$HOME/.deno/bin:$PATH"
```

## 4. アプリを起動する

```sh
mise run app:tauri
```

初回は Rust のビルドが走るので数分かかります。ウィンドウが開くと、アプリがデーモン `dctld` を自動で起動して接続します。

画面上部に「dctld に接続できません」と出続けるときは、`dctld` が PATH に無いか、起動直後に落ちています。`which dctld` で場所を確かめ、落ちている場合は `~/.local/state/doctrine/dctld.log` を見ます。

## 次にやること

doctrine で進めたいリポジトリを登録し、ワークフローを書きます。[ワークフローを書く](../guide/writing-workflows/) を参照してください。
