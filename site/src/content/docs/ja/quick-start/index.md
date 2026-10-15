---
title: Quick Start
description: .dmg からアプリを入れて起動し、ウィザードでワークフローを作るまで。
---

GitHub Releases の .dmg からアプリを入れます。対象は Apple Silicon の Mac です。入れたらアプリのウィザードで workspace を登録し、プロジェクトごとのワークフロー（`.doctrine/workflows/default.yaml`）を doctrine のタスクに書かせます。YAML を手で書く必要はありません。ソースからビルドして動かしたい人は、末尾の[開発者向け: ソースからビルドする](#開発者向け-ソースからビルドする)を見てください。

## 前提

次のツールを先に入れておきます。

| ツール | 用途 |
| --- | --- |
| [Git](https://git-scm.com/) | doctrine はタスクごとに git worktree を作る |
| [Claude Code](https://docs.claude.com/en/docs/claude-code/overview)（`claude`） | ワークフローの各ステップを実行するエージェント。ログインまで済ませておく |
| [GitHub CLI](https://cli.github.com/)（`gh`） | .dmg の取得、Issue の取り込み、PR の作成・マージの見張り。`gh auth login` を済ませておく |

アプリは起動時にログインシェルの PATH を読むので、`claude`・`gh`・`git` はターミナルで使える状態にしておきます。

## 1. .dmg を取得する

```sh
gh release download --repo todokr/doctrine --pattern '*.dmg'
```

gh で取った .dmg には quarantine 属性が付かないので、後の Gatekeeper の操作は要りません。[Releases のページ](https://github.com/todokr/doctrine/releases)からブラウザで取ってもかまいませんが、その場合は「3. ブラウザで取った場合」の手順が要ります。

## 2. Applications に入れる

```sh
open doctrine_*.dmg
```

Finder で .dmg をダブルクリックして開いてもかまいません。開いたウィンドウで doctrine.app を Applications にドラッグします。

## 3. ブラウザで取った場合: 初回起動で止められたら

gh で取った人は、この節を飛ばして構いません。

ブラウザで取った .dmg から入れたアプリは、初回起動で止められます。止められた後に「システム設定 > プライバシーとセキュリティ」を開き、下の方に出る「このまま開く」を押します。ターミナルで済ませるなら、Applications に入れた後で次を流します。

```sh
xattr -dr com.apple.quarantine /Applications/doctrine.app
```

ad-hoc 署名なので、更新のたびにこの確認を聞き直されることがあります。フォルダへのアクセスなどの許可も聞き直されることがあります。

## 4. アプリを起動する

Applications（または Launchpad や Spotlight）から doctrine を開きます。デーモンの `dctld` はアプリに同梱されていて、アプリが自動で起動して接続します。PATH の設定は要りません。

画面上部に「dctld に接続できません」と出続けるときは、`~/.local/state/doctrine/dctld.log` を見ます。前の版やソースから入れた `dctld` が動いたままだと古いデーモンに繋がるので、その場合は[更新する](#更新する)のとおり止めてから開き直します。

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

## 更新する

自動更新は無く、手動で入れ直します。前の版の `dctld` が残っている場合があり、残っていると新しいアプリも古いデーモンに繋がります。アプリを終了して `dctld` を止めてから、入れ直して開きます。

```sh
pkill dctld
gh release download --repo todokr/doctrine --pattern '*.dmg' --clobber
```

`--clobber` は同名の .dmg があるときに上書きします。あとは「2. Applications に入れる」と同じく doctrine.app を Applications に上書きでドラッグして開きます。ブラウザで取ったなら、「3. ブラウザで取った場合」をもう一度行います。

## 開発者向け: ソースからビルドする

リポジトリをクローンし、手元でビルドして起動します。次のツールを先に入れておきます。

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

### リポジトリを取得する

```sh
git clone https://github.com/todokr/doctrine.git
cd doctrine
```

### ツールと依存を入れる

```sh
mise trust        # このリポジトリの mise.toml を信頼する
mise install      # Node.js / pnpm / Rust
mise run setup    # 依存を lock ファイルどおりに取る
```

### `dctld` を PATH に置く

```sh
mise run core:install
```

デーモンの `dctld` の起動スクリプトが `~/.local/bin` に入ります。`~/.local/bin` が PATH に無ければ、シェルの設定に足します。

```sh
export PATH="$HOME/.local/bin:$PATH"
```

### アプリを起動する

```sh
mise run app:tauri
```

初回は Rust のビルドが走るので数分かかります。ウィンドウが開くと、アプリがデーモン `dctld` を自動で起動して接続します。

画面上部に「dctld に接続できません」と出続けるときは、`dctld` が PATH に無いか、起動直後に落ちています。`which dctld` で場所を確かめ、落ちている場合は `~/.local/state/doctrine/dctld.log` を見ます。

.dmg から入れたアプリと併用するときは、片方の `dctld` を `pkill dctld` で止めてから起動します。
