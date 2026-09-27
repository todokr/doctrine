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

## 5. ウィザードで workspace を登録する

workspace が 1 つも登録されていなければ、アプリを開くとウィザードが全画面で出ます。2 つめ以降の workspace は、左端のアイコン列の「workspace を追加」から同じウィザードを開きます。

1. **ディレクトリ** — git リポジトリのルートか、複数の git リポジトリを直下に持つディレクトリを選びます。リポジトリのサブディレクトリや、登録済みのディレクトリは選べません。
2. **プロジェクト構成** — リポジトリのルートを選んだなら、そのリポジトリ 1 つで決まります。直下に複数あるなら、登録するものを選び、名前（英小文字・数字・ハイフン）を決めます。`.doctrine/workspace.yaml` が既にあれば、その中身で登録します。
3. **トラッカー** — Issue を GitHub Issues と Linear のどちらから取り込むかを選びます。Linear ならチームのキー（`ENG` など）を入れます。Linear の API key はアプリでは扱いません。設定ディレクトリ（既定は `~/.config/doctrine`）の `config.json` に `linearApiKey` として書き、`dctld` を起動し直します。ワークフローを作るタスクはトラッカーを使わないので、後回しで構いません。`workspace.yaml` が既にあれば、この画面は出ません。
4. **ワークフローの方針** — workspace のすべてのプロジェクトに共通の 7 問です。計画と計画審査、AI によるコードレビュー、レビューガイド、人の承認の位置、PR を開いてマージを待つか、PR の前に base branch を取り込むか（PR を開くときだけ）、役割ごとのモデル。既定は doctrine 自身のワークフローと同じです。
5. **確認** — 「登録する」を押すと workspace を登録し、setup のタスクを作ります。

setup のタスクを作るのは、今回ワークフローの雛形を置いたプロジェクト（まだ `.doctrine/` が無かったもの）だけです。既に `.doctrine/` があるプロジェクトのワークフローには触りません。対象が 1 つも無ければ「ワークフローは既存のものを使います」と出て終わります。

## 6. setup のタスクを承認する

登録が終わるとタスク一覧に移り、setup のタスク（「`<プロジェクト名>` のワークフローを作る」）が選ばれています。
タスクではエージェントがリポジトリを調べて YAML を書き、`dctl workflow-check` で検証してから、承認の画面で止まります。

承認の画面では 2 つのファイルを読みます。

- `.doctrine-out/default.yaml` — 書き上がったワークフロー。検証コマンド、実装ステップに許すコマンド、baseBranch は、エージェントがリポジトリ（package.json・mise.toml・Makefile・CI の設定など）から決めています。
- `.doctrine-out/setup-notes.md` — 何をどう決めたか、その根拠。方針とリポジトリが食い違ったとき（remote が無いのに PR を開く方針にした、など）は、どちらを取ったかもここにあります。

直してほしいところがあれば、コメントを付けて差し戻します。エージェントがコメントを読んで直し、もう一度検証してから承認の画面に戻ります。

## 7. 承認してコミットする

承認すると、元のリポジトリの `.doctrine/workflows/default.yaml` が書き換わります。コミットはしないので、タスクの画面に次のように出ます。

> `.doctrine/workflows/default.yaml` を書き換えました（未コミット）。コミットしてから、Issue を取り込むかタスクを作ってください。

ウィザードが置いた `.doctrine/project.yaml` なども未コミットなので、リポジトリごとに差分を確かめてまとめてコミットします。

```sh
git add .doctrine
git commit -m "doctrine のワークフローを足す"
```

これで準備は終わりです。Intake から Issue を取り込むか、「＋」からタスクを作ります。ワークフローを後から直すときは[ワークフローを書く](/ja/guide/writing-workflows/)を参照してください。

## うまくいかなかったとき

setup のタスクが失敗したり中止したりしても、「同じ内容で投入し直す」は出ません。setup のタスクは作り直せないので、次のどちらかで `default.yaml` を置きます。

- worktree が残っていれば、中の `.doctrine-out/default.yaml` を直して、元のリポジトリの `.doctrine/workflows/default.yaml` に写す。
- ウィザードが置いた雛形の `.doctrine/workflows/default.yaml` を、[ワークフローを書く](/ja/guide/writing-workflows/)を読みながら直接直す。

どちらの場合も、置いたら上と同じくコミットします。
