# doctrine

ローカルマシンで複数の Claude Code を同時に走らせ、決められた手順で最後まで走らせきるためのデスクトップツール。

- 使い方（セットアップ、ワークフローの書き方、運用と制約）は [ドキュメントサイト](https://todokr.github.io/doctrine/) にある。
- 全体像・原則・用語は [`docs/overview.md`](docs/overview.md) にある。

サイトはまだ公開していない。手元では `mise run setup` の後に `mise run site:dev` で開ける。

## インストール

[GitHub Releases](https://github.com/todokr/doctrine/releases) の .dmg から入れる。対象は Apple Silicon の Mac。

### 前提

| ツール | 用途 |
| --- | --- |
| [Git](https://git-scm.com/) | doctrine はタスクごとに git worktree を作る |
| [Claude Code](https://docs.claude.com/en/docs/claude-code/overview)（`claude`） | ワークフローの各ステップを実行するエージェント。ログインまで済ませておく |
| [GitHub CLI](https://cli.github.com/)（`gh`） | .dmg の取得、Issue の取り込み、PR の作成・マージの見張り。`gh auth login` を済ませておく |

アプリは起動時にログインシェルの PATH を読む。`claude`・`gh`・`git` はターミナルで使える状態にしておく。

### 手順

```sh
gh release download --repo todokr/doctrine --pattern '*.dmg'
open doctrine_*.dmg
```

開いたウィンドウで doctrine.app を Applications にドラッグし、Applications から開く。gh で取った .dmg には quarantine 属性が付かないので、Gatekeeper の操作は要らない。dctld はアプリに同梱されていて、アプリが起動する。

画面上部に「dctld に接続できません」と出続けるときは、`~/.local/state/doctrine/dctld.log` を見る。

### ブラウザで取った場合

[Releases のページ](https://github.com/todokr/doctrine/releases)から取った .dmg は、初回起動で止められる。止められた後に「システム設定 > プライバシーとセキュリティ」を開き、下の方に出る「このまま開く」を押す。ターミナルなら、Applications に入れた後で次を流す。

```sh
xattr -dr com.apple.quarantine /Applications/doctrine.app
```

ad-hoc 署名なので、更新のたびにこの確認を聞き直されることがある。フォルダへのアクセスなどの許可も聞き直されることがある。

### 更新

自動更新は無く、手動で入れ直す。前の版の dctld が残っている場合があり、残っていると新しいアプリも古い dctld に繋がる。アプリを終了して dctld を止めてから、入れ直して開く。

```sh
pkill dctld
gh release download --repo todokr/doctrine --pattern '*.dmg' --clobber
```

`--clobber` は同名の .dmg があるときに上書きする。あとは手順と同じく doctrine.app を Applications に上書きでドラッグして開く。ブラウザで取ったなら、上の「ブラウザで取った場合」をもう一度行う。

## 開発者向け: ソースからビルドする

リポジトリをクローンし、手元でビルドして起動する。

### 前提

| ツール | 用途 |
| --- | --- |
| [Git](https://git-scm.com/) | リポジトリの取得。doctrine はタスクごとに git worktree を作る |
| [mise](https://mise.jdx.dev/) | Node.js・pnpm・Rust を [`mise.toml`](mise.toml) の版で入れる。シェルで activate しておく |
| [Claude Code](https://docs.claude.com/en/docs/claude-code/overview)（`claude`） | ワークフローの各ステップを実行するエージェント。ログインまで済ませておく |
| [GitHub CLI](https://cli.github.com/)（`gh`） | Issue の取り込みと PR の作成・マージの見張り。`gh auth login` を済ませておく |

デスクトップアプリ（Tauri）のビルドには、macOS では Xcode Command Line Tools（`xcode-select --install`）、Linux では WebKitGTK 4.1 など（[Tauri の前提](https://tauri.app/start/prerequisites/)）が要る。

### 手順

```sh
git clone https://github.com/todokr/doctrine.git
cd doctrine

mise trust              # このリポジトリの mise.toml を信頼する
mise install            # Node.js / pnpm / Rust
mise run setup          # 依存を lock ファイルどおりに取る
mise run core:install   # dctld を ~/.local/bin に置く

export PATH="$HOME/.local/bin:$PATH"  # 未設定ならシェルの設定に足す
mise run app:tauri      # アプリを起動する（dctld はアプリが自動で起こす）
```

初回の `mise run app:tauri` は Rust のビルドで数分かかる。画面上部に「dctld に接続できません」と出続けるときは、`which dctld` で PATH を確かめ、`~/.local/state/doctrine/dctld.log` を見る。

.dmg から入れたアプリと併用するときは、片方の dctld を `pkill dctld` で止めてから起動する。
