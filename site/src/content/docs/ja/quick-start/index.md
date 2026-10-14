---
title: Quick Start
description: リポジトリを取得してアプリを起動し、ウィザードでワークフローを作るまで。
---

doctrine はまだ配布用のビルドがありません。リポジトリをクローンし、手元でビルドして起動します。起動したらアプリのウィザードで workspace を登録し、プロジェクトごとのワークフロー（`.doctrine/workflows/default.yaml`）を doctrine のタスクに書かせます。YAML を手で書く必要はありません。

## 前提

次のツールを先に入れておきます。

| ツール | 用途 |
| --- | --- |
| [Git](https://git-scm.com/) | リポジトリの取得。doctrine はタスクごとに git worktree を作る |
| [mise](https://mise.jdx.dev/) | Node.js・pnpm・Rust を決まった版で入れる。版は `mise.toml` が決める |
| [Claude Code](https://docs.claude.com/en/docs/claude-code/overview)（`claude`） | ワークフローの各ステップを実行するエージェント。ログインまで済ませておく |
| [GitHub CLI](https://cli.github.com/)（`gh`） | Issue の取り込みと PR の作成・マージの見張り。`gh auth login` を済ませておく |

加えて、デスクトップアプリ（Tauri）のビルドに OS ごとの前提が要ります。

- macOS: Xcode Command Line Tools（`xcode-select --install`）
- Linux: WebKitGTK 4.1 など（[Tauri の前提](https://tauri.app/start/prerequisites/)）

mise はシェルで有効にしておきます（[mise の activate](https://mise.jdx.dev/getting-started.html)）。有効でないと、mise が入れた `node` や `pnpm` が PATH に乗りません。

## 1. リポジトリを取得する

```sh
git clone https://github.com/todokr/doctrine.git
cd doctrine
```

## 2. ツールと依存を入れる

```sh
mise trust        # このリポジトリの mise.toml を信頼する
mise install      # Node.js / pnpm / Rust
mise run setup    # 依存を lock ファイルどおりに取る
```

## 3. `dctld` を PATH に置く

```sh
mise run core:install
```

デーモンの `dctld` の起動スクリプトが `~/.local/bin` に入ります。`~/.local/bin` が PATH に無ければ、シェルの設定に足します。

```sh
export PATH="$HOME/.local/bin:$PATH"
```

## 4. アプリを起動する

```sh
mise run app:tauri
```

初回は Rust のビルドが走るので数分かかります。ウィンドウが開くと、アプリがデーモン `dctld` を自動で起動して接続します。

画面上部に「dctld に接続できません」と出続けるときは、`dctld` が PATH に無いか、起動直後に落ちています。`which dctld` で場所を確かめ、落ちている場合は `~/.local/state/doctrine/dctld.log` を見ます。

## 5. ウィザードで workspace を登録する

workspace が 1 つも登録されていなければ、アプリを開くとウィザードが全画面で出ます。2 つめ以降の workspace は、左端のアイコン列の「workspace を追加」から同じウィザードを開きます。

1. **ディレクトリ** — git リポジトリのルートか、複数の git リポジトリを直下に持つディレクトリを選びます。リポジトリのサブディレクトリや、登録済みのディレクトリは選べません。
2. **プロジェクト構成** — リポジトリのルートを選んだなら、そのリポジトリ 1 つで決まります。直下に複数あるなら、登録するものを選び、名前（英小文字・数字・ハイフン）を決めます。`.doctrine/workspace.yaml` が既にあれば、その中身で登録します。
3. **トラッカー** — Issue を GitHub Issues と Linear のどちらから取り込むかを選びます。Linear ならチームのキー（`ENG` など）を入れます。Linear の API key はアプリでは扱いません。設定ディレクトリ（既定は `~/.config/doctrine`）の `config.json` に `linearApiKey` として書き、`dctld` を起動し直します。後回しで構いません。`workspace.yaml` が既にあれば、この画面は出ません。
4. **確認** — 「登録する」を押すと workspace を登録します。

まだ `.doctrine/` が無いプロジェクトには、ワークフローの雛形（`.doctrine/workflows/default.yaml`）を置きます。既に `.doctrine/` があるプロジェクトには触りません。

## 6. ワークフローを直してコミットする

ウィザードが置いた雛形は、検証コマンドが `"true"` で、PR も開かない一般形です。[ワークフローを書く](/ja/guide/writing-workflows/)を読みながら、`.doctrine/workflows/default.yaml` をリポジトリに合わせて直します。

ウィザードが置いた `.doctrine/project.yaml` なども未コミットなので、リポジトリごとに差分を確かめてまとめてコミットします。

```sh
git add .doctrine
git commit -m "doctrine のワークフローを足す"
```

これで準備は終わりです。Intake で Issue を選び、「計画して進める」か「すぐ実行する」で取り込みます。進み具合とタスクのレビューは Execution で見ます。
