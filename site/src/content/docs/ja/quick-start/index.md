---
title: Quick Start
---

アプリのウィザードで workspace を登録し、プロジェクトごとのワークフロー（`.doctrine/workflows/default.yaml`）を doctrine のタスクに書かせる。YAML は書かない。

前提: `dctld` が動いていて、アプリがそれにつながっていること。

## 1. ウィザード

workspace が 1 つも登録されていなければ、アプリを開くとウィザードが全画面で出る。2 つめ以降の workspace は、左端のアイコン列の「workspace を追加」から同じウィザードを開く。

1. **ディレクトリ** — git リポジトリのルートか、複数の git リポジトリを直下に持つディレクトリを選ぶ。リポジトリのサブディレクトリや、登録済みのディレクトリは選べない。
2. **プロジェクト構成** — リポジトリのルートを選んだなら、そのリポジトリ 1 つで決まる。直下に複数あるなら、登録するものを選び、名前（英小文字・数字・ハイフン）を決める。`.doctrine/workspace.yaml` が既にあれば、その中身で登録する。
3. **トラッカー** — Issue を GitHub Issues と Linear のどちらから取り込むか。Linear ならチームのキー（`ENG` など）を入れる。Linear の API key はアプリでは扱わない。設定ディレクトリ（既定は `~/.config/doctrine`）の `config.json` に `linearApiKey` として書き、`dctld` を起動し直す。ワークフローを作るタスクはトラッカーを使わないので、後回しにしてよい。`workspace.yaml` が既にあれば、この画面は出ない。
4. **ワークフローの方針** — workspace のすべてのプロジェクトに共通の 7 問。計画と計画審査、AI によるコードレビュー、レビューガイド、人の承認の位置、PR を開いてマージを待つか、PR の前に base branch を取り込むか（PR を開くときだけ）、役割ごとのモデル。既定は doctrine 自身のワークフローと同じ。
5. **確認** — 「登録する」を押すと workspace を登録し、setup のタスクを作る。

setup のタスクを作るのは、今回ワークフローの雛形を置いたプロジェクト（まだ `.doctrine/` が無かったもの）だけである。既に `.doctrine/` があるプロジェクトのワークフローには触らない。対象が 1 つも無ければ「ワークフローは既存のものを使います」と出て終わる。

## 2. setup のタスクの承認

登録が終わるとタスク一覧に移り、setup のタスク（「`<プロジェクト名>` のワークフローを作る」）が選ばれている。
タスクはエージェントがリポジトリを調べて YAML を書き、`dctl workflow-check` で検証してから、承認の画面で止まる。

承認の画面では 2 つのファイルを読む。

- `.doctrine-out/default.yaml` — 書き上がったワークフロー。検証コマンド、実装ステップに許すコマンド、baseBranch は、エージェントがリポジトリ（package.json・mise.toml・Makefile・CI の設定など）から決めている。
- `.doctrine-out/setup-notes.md` — 何をどう決めたか、その根拠。方針とリポジトリが食い違ったとき（remote が無いのに PR を開く方針にした、など）は、どちらを取ったかもここにある。

直してほしいところがあれば、コメントを付けて差し戻す。エージェントがコメントを読んで直し、もう一度検証してから承認の画面に戻る。

## 3. 承認とコミット

承認すると、元のリポジトリの `.doctrine/workflows/default.yaml` が書き換わる。コミットはしないので、タスクの画面に

> `.doctrine/workflows/default.yaml` を書き換えました（未コミット）。コミットしてから、Issue を取り込むかタスクを作ってください。

と出る。ウィザードが置いた `.doctrine/project.yaml` なども未コミットなので、リポジトリごとに差分を確かめてまとめてコミットする。

```sh
git add .doctrine
git commit -m "doctrine のワークフローを足す"
```

これで準備は終わりである。Intake から Issue を取り込むか、「＋」からタスクを作る。ワークフローを後から直すときは[ワークフローを書く](/ja/guide/writing-workflows/)を読む。

## うまくいかなかったとき

setup のタスクが失敗したり中止したりしても、「同じ内容で投入し直す」は出ない。setup のタスクは作り直せないので、次のどちらかで `default.yaml` を置く。

- worktree が残っていれば、中の `.doctrine-out/default.yaml` を直して、元のリポジトリの `.doctrine/workflows/default.yaml` に写す。
- ウィザードが置いた雛形の `.doctrine/workflows/default.yaml` を、[ワークフローを書く](/ja/guide/writing-workflows/)を読みながら直接直す。

どちらの場合も、置いたら上と同じくコミットする。
