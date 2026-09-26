# 2. リポジトリとツールチェーン

## 2.1 トップレベル

| パス | 責務 |
| --- | --- |
| `core/` | デーモン `dctld` と CLI `dctl`。`deno.json` / `deno.lock` を持つ独立したパッケージ |
| `app/` | デスクトップアプリ。`package.json` / `pnpm-lock.yaml` と、Rust 側の `src-tauri/`（`Cargo.toml` / `Cargo.lock`） |
| `shared/` | core と app の両方が import する契約と純関数。自前の設定ファイルを持たない |
| `pfd/` | Intake 以前の試作 CLI。削除予定（2.7） |
| `prototype/` | 画面設計を確かめるための使い捨て HTML モック 2 枚。ビルド・テスト・CI のどれにも入らない |
| `docs/` | [`overview.md`](../overview.md)、[`prd/intake.md`](../prd/intake.md)、`superpowers/specs/`（設計）、`superpowers/plans/`（実装計画）、このガイド |
| `.doctrine/` | doctrine 自身を doctrine で開発するためのプロジェクト設定（2.6） |
| `.github/workflows/ci.yml` | CI（2.5） |
| `scripts/task-cost.sh` | タスク 1 件のステップ別コストとエージェントの探索量を出す調査用スクリプト |
| `mise.toml` | ツールの版の唯一の出どころと、`core:*` / `app:*` / `pfd:*` タスク |

## 2.2 `core/src` のサブディレクトリ

| ディレクトリ | 責務 | 章 |
| --- | --- | --- |
| `adapter/` | Claude Code の起動（`claude.ts`）、stream-json の読み取り（`ndjson.ts`）、ログ 1 行への整形（`render.ts`）、テスト用の偽物（`mock.ts`） | 3 |
| `cli/` | `dctl` | 4 |
| `daemon/` | 入口（`main.ts`）、ソケットサーバ（`server.ts`）、RPC ハンドラと `tick`（`handlers.ts`）、`config.json`（`config.ts`）、トラッカーの選択（`tracker.ts`）、警告（`warnings.ts`） | 4 |
| `db/` | Kysely の型（`schema.ts`）、マイグレーション（`migrations.ts` / `migrate.ts`）、`node:sqlite` 用の dialect、ステップ境界の書き込み（`boundary.ts`）、表ごとの読み書き | 4 |
| `domain/` | エンジン（`engine.ts`）、1 ステップの実行（`stepRunner.ts`）、状態遷移（`states.ts` / `intakeStates.ts`）、スケジューラ、worktree、上限待ち、復帰、diff、レビュー記録、ガイド | 3・5 |
| `github/` / `linear/` / `tracker/` | Issue トラッカーの抽象と 2 つの実装、PR の見張り | 6 |
| `intake/` | Intake のコマンド、runner、会話、出力検証、改訂、投入、sub-issue 同期、見張り。`intake/pfd/` は PFD の検証・ハッシュ・状態計算・タスク prompt | 6 |
| `util/` | 原子的書き込み、子プロセス実行、状態ディレクトリの解決（`home.ts:stateRoot`） | — |
| `workflow/` | ワークフロー YAML のスキーマ・読み込み・保存・テンプレート展開、`project.yaml`、`dctl project-add` が作る雛形 | 3 |

**名前の衝突に注意する。** `core/src/intake/pfd/`、`shared/intake/pfd.ts`、`app/src/pfd.ts`、`app/src/components/PfdDiagram.tsx`
は現役の Intake のコードで、トップレベルの `pfd/` とは別物である。

## 2.3 `shared/` の import のされ方

- 中身は `protocol.ts`（RPC とイベントの型）、`toolInput.ts`、`diff/`（移動検出とパスの解釈）、`guide/`（Review Guide のスキーマ・検証・JSON Schema・hunk id、`examples/` に見本）、`intake/`（PFD・質問・回答・トラッカー・プロセス状態の型と純関数）
- 外部依存は `zod/v4` だけ。core も app も import しない
- import は相対パス＋`.ts` 拡張子で、エイリアスは無い（例: core からは `../../../shared/protocol.ts`）。app は `allowImportingTsExtensions` で `.ts` 付き import を許している
- 型検査は 2 か所から掛かる。`core/deno.json` の `check`（`deno check src test ../shared`）と fmt / lint、`app/tsconfig.json` の `include: ["src", "../shared"]`
- `zod/v4` の解決は core と app で経路が違う。core は `deno.json` の import map、app は `shared/` の上に `node_modules` が無いので `tsconfig.json` の `paths` と `vite.config.ts` の `resolve.alias` で `app/node_modules/zod/v4` へ向けている（両方を揃える）

## 2.4 ツールチェーン

版は [`mise.toml`](../../mise.toml) だけが決める（deno / node / pnpm / rust）。CI も `jdx/mise-action` でこの表を読む。
`latest` のような動く別名は置かない。pnpm は `npm:pnpm` 経由で入れ、`app/package.json` の `packageManager` と一致させる。

```bash
mise install      # Deno / Node / pnpm / Rust
mise trust        # 新しい worktree では最初の 1 回だけ要る
mise run setup    # core・app・pfd の依存を lock 固定で取る
```

mise のタスクはすべて `core/deno.json` と `app/package.json` への 1 行の委譲である（実体を書き写すと二重管理になるため）。

| やりたいこと | コマンド |
| --- | --- |
| core の型検査 / テスト | `mise run core:check` / `mise run core:test` |
| core の整形・lint（CI と同じ） | `cd core && deno fmt --check && deno lint` |
| dctl / dctld を PATH に置く | `mise run core:install`（`~/.deno/bin` に、このチェックアウトのソースを実行するラッパーを置く。依存を変えたらやり直す） |
| 単一バイナリを作る | `mise run core:build`（`core/dist/` に `deno compile` の結果。約 100MB） |
| インストールせずに動かす | `deno run -A core/src/daemon/main.ts` / `deno run -A core/src/cli/dctl.ts` |
| アプリのテスト / ビルド | `mise run app:test` / `mise run app:build`（`tsc` で shared も含めて型検査） |
| アプリをウィンドウで開く | `mise run app:tauri`（dctld が居なければ起こす。`~/.deno/bin` を PATH に通しておく） |
| アプリをブラウザで開く | `mise run app:dev`（http://localhost:1420。Tauri の `invoke` が無いのでデーモンには繋がらない） |
| Rust のテスト | `cd app/src-tauri && cargo test --locked`（mise タスクは無い） |

1 ファイル・1 ケースだけ走らせる方法は [8 章](08-testing.md) にある。

## 2.5 CI

[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)。`develop` への push と `develop` 宛ての PR で動く。

| ジョブ | 条件 | 中身 |
| --- | --- | --- |
| `changes` | 常に | 変更されたパスから `core` / `app` / `pfd` のどれを流すか決める |
| `core-check` | core | `deno install --frozen` → `deno fmt --check` → `deno lint` → `deno task check` → `deno task build` |
| `core-test` | core | `deno task test` を `TZ=UTC` と `TZ=Asia/Tokyo` の 2 通りで回す（タイムゾーン依存のバグを拾うため） |
| `app` | app | Tauri の Linux 依存を apt で入れ、`pnpm install --frozen-lockfile` → `pnpm build` → `pnpm test` → `cargo check --locked --all-targets` → `cargo test --locked` |
| `pfd` | pfd | fmt / lint / check / test |
| `ci` | 常に（`if: always()`） | 他のジョブがすべて `success` か `skipped` なら緑。**ブランチ保護の必須チェックはこれ 1 つ** |

- path filter は `on.paths` ではなくジョブの `if` で掛けている。`on.paths` でワークフローごと起動しないと、必須チェックが pending のまま残るため
- `.github/` と `mise.toml` の変更は全ジョブ、`shared/` は core と app の両方を流す。develop への push では常に全ジョブを流す
- `docs/`・`.doctrine/`・`scripts/` だけの変更では何も流れない。ただし `.doctrine/workflows/default.yaml` は core のテスト（`core/test/workflow/defaultWorkflow.test.ts`）が読んでいるので、これを変える PR は手元で `mise run core:test` を通す
- アプリの TypeScript と Rust には fmt / lint の検査が無い

## 2.6 doctrine で doctrine を開発する

このリポジトリは自分自身を doctrine のプロジェクトとして登録し、機能追加をタスクとして流して開発している。

- [`.doctrine/project.yaml`](../../.doctrine/project.yaml): `baseBranch: develop`、`maxConcurrent: 10`、`setup: mise trust && mise run setup`
- [`.doctrine/workflows/default.yaml`](../../.doctrine/workflows/default.yaml): 次の 13 ステップ

```
plan → plan-review → plan-gate → implement → verify → agent-review → review-gate
  → guide → review → sync → verify-sync → open-pr → wait-merge
```

| ステップ | 種類 | 要点 |
| --- | --- | --- |
| `plan` / `plan-review` / `plan-gate` | agent / agent / command | 計画を `.doctrine-out/plan.md` に書き、別の役割が審査して 1 行目に `verdict:` を書き、ゲートが grep で見る |
| `implement` | agent | テストを先に書いて実装し、`.doctrine-out/implement-notes.md` を残す |
| `verify` | command | `core:check`・`core:test`・`app:test`・`app:build`・`pfd:*` を流す。落ちたら `implement` へ |
| `agent-review` / `review-gate` | agent / command | コードレビュー。`reject` なら `implement` へ、`escalate` は人へ回す |
| `guide` | guide | Review Guide を作る |
| `review` | approval | 人のレビュー |
| `sync` / `verify-sync` | agent / command | `origin/develop` を merge で取り込み、conflict を直してテストを通す |
| `open-pr` | command | push して PR を作る。再実行しても二重に作らないように書いてある |
| `wait-merge` | poll | `gh pr view` でマージを待つ。conflict なら `sync` へ戻る |

`dctl project-add` が他のリポジトリに作る雛形（`core/src/workflow/scaffold.ts:defaultWorkflowYamlFor`）とは別物である。
雛形は `review` で終わり、`verify` は何もしない `"true"` で、PR 作成とマージ待ちを持たない。

doctrine のエージェントは `allowedTools` の許可が先頭一致なので、`cd core && ...` や `git -C` の形を使えない。
このワークフローのプロンプトがルートからの相対パスでコマンドを叩かせているのはそのためである。
また `verify` は fmt・lint・cargo を流さないので、タスクが `verify` を通っても CI で落ちることがある。

## 2.7 `pfd/` と `prototype/`

- `pfd/` は Intake 以前に doctrine の外で作った試作 CLI で、`dctl add` を叩いて PFD のプロセスをタスクにしていた。
  その機能は Intake（[6 章](06-intake.md)）に移植済みで、core・shared・app のどこからも import されていない。
  [`overview.md`](../overview.md) 7 章のとおり削除する。削除するときは `mise.toml` の `pfd:*` と `setup` の依存、
  CI の `pfd` ジョブ、`.doctrine/workflows/default.yaml` の `verify` / `verify-sync` と `allowedTools`、`README.md` 7 章も一緒に消す
- `prototype/` はデーモンに繋がらない単一 HTML のモックで、spec の見た目を確かめるための資料である
