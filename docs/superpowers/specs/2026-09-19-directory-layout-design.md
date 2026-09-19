# ディレクトリ構成の見直し — core / shared / app

- 日付: 2026-09-19
- 状態: 設計のみ（未実装）
- 前提: [overview](../../overview.md)、[Tauri アプリを dctld につなぐ中継](2026-09-18-tauri-dctld-relay-design.md) 6 章（型の共有）

## 1. 位置づけ

リポジトリのルートに `src/` と `app/` が並んでいる。`app/` は自前の `package.json`・`tsconfig.json`・
`src-tauri/` を持つ独立したパッケージの名前であり、`src/` はパッケージの中身の名前である。並んでいる
2 つの粒度が揃っていない。

CI（`.github/workflows/ci.yml`）はすでに「コア」と「アプリ」という対等な語彙で 2 つを扱っており、
ジョブもパスフィルタもその前提で書かれている。ディレクトリ側だけがその語彙に追いついていない。

本specは**ディレクトリの配置だけ**を扱う。コードの振る舞い、CLI のインターフェース、デーモンの
プロトコルは一切変えない。

## 2. 決定の要約

| 項目 | 決定 | 章 |
| --- | --- | --- |
| レイアウト | コア側（`src` `test` `deno.json` `deno.lock`）を `core/` に寄せ、`app/` と対等な兄弟にする | 3 |
| コア内部の名前 | `src/core` → `src/domain`（`core/src/core/` という重複を避ける）。`test/core` も同様 | 3 |
| 共有物 | `daemon/protocol.ts` を `shared/protocol.ts` に切り出し、core と app が対称に依存する | 4 |
| タスクの入口 | `mise.toml` に `core:*` と `app:*` の委譲タスクを置き、ルートから `mise run core:test` のように回す | 5 |
| タスクの正本 | `core/deno.json` と `app/package.json` のまま。mise 側は一行の委譲に留める | 5 |
| CI | `mise run` には寄せない。`working-directory: core` ＋ `deno task` を続ける | 5・6 |
| `.gitignore` | `app/.gitignore` を畳んでルート 1 本にする | 6 |
| `prototype/` `docs/` | 触らない | 1 |
| コミットの区切り | 移動 3 つ ＋ 設定・文書 1 つの計 4 コミット | 7 |

## 3. 目標の構成

```
doctrine/
├── core/                     ← Deno 製のコア（dctl / dctld）
│   ├── src/
│   │   ├── domain/           ← 旧 src/core
│   │   ├── cli/  daemon/  adapter/  db/  workflow/  util/
│   ├── test/
│   │   ├── domain/           ← 旧 test/core
│   │   └── adapter/  daemon/  db/  helpers/  integration/  util/  workflow/
│   ├── deno.json
│   └── deno.lock
├── shared/
│   └── protocol.ts           ← dctld の wire 契約
├── app/                      ← Tauri + React（配置は現状のまま）
├── docs/
├── prototype/
├── mise.toml
├── .gitignore
└── .github/
```

依存の向きは `core → shared ← app` の一方向のみになる。`app` が `core` の内部を覗く現状
（`../../src/daemon/protocol.ts`）は解消される。

コア内部の相対参照は移動しても壊れない。`test/*` からの `../../src/...` も、
`test/core/recovery.test.ts` が `new URL("../../deno.json", import.meta.url)` で設定ファイルを
指している箇所も、すべてユニット内の相対パスであり、4 つをまとめて動かす限り解決先は変わらない。
`deno.json` の `tasks` に書かれたパス（`src/cli/dctl.ts` など）も、タスクの cwd が `core/` に
なるだけで無変更でよい。`deno compile` の出力先が `core/dist/` に移るが、ルート `.gitignore` の
`dist/` は階層を問わず一致する。

### `src/core` を `src/domain` にする理由

CI の語彙に合わせて外側を `core/` にすると、素直に移した場合 `core/src/core/stepRunner.ts` という
パスができる。内側は `engine.ts` `scheduler.ts` `stepRunner.ts` `states.ts` `worktree.ts` など、
タスクを進行させる実体が入っているので `domain` で通る。doctrine にはまだ外部の利用者がいないため、
改名は参照の一括置換だけで完結する。

### 共有ディレクトリを `shared/` と呼ぶ理由

今そこに入るのは protocol 1 本だが、`protocol/protocol.ts` は読みにくく、`protocol/` という名前は
protocol 以外の共有物が来た時点で嘘になる。「両者が共有する物置」として `shared/` を使う。

## 4. protocol.ts の切り出し

`src/daemon/protocol.ts` は import を 1 つも持たない 74 行の型定義だけのファイルである。切り出しても
依存が付いてこない。

書き換えはコア側 6 ファイル 7 箇所。`core/src/*/` と `core/test/*/` は同じ深さなので、すべて
`../../../shared/protocol.ts` に揃う。

| ファイル | 現在 |
| --- | --- |
| `core/src/cli/dctl.ts` | `../daemon/protocol.ts` |
| `core/src/daemon/handlers.ts` | `./protocol.ts` |
| `core/src/daemon/server.ts` | `./protocol.ts` |
| `core/test/daemon/handlers.test.ts` | `../../src/daemon/protocol.ts` |
| `core/test/integration/taskContext.test.ts` | 同上 |
| `core/test/integration/fullCycle.test.ts` | 同上 |

app 側は 3 ファイル ＋ tsconfig。

| ファイル | 現在 | 変更後 |
| --- | --- | --- |
| `app/src/model.ts` | `../../src/daemon/protocol.ts` | `../../shared/protocol.ts` |
| `app/src/model.test.ts` | 同上 | 同上 |
| `app/src/daemon/client.ts` | `../../../src/daemon/protocol.ts` | `../../../shared/protocol.ts` |
| `app/tsconfig.json` | `include: ["src", "../src/daemon/protocol.ts"]` | `["src", "../shared/protocol.ts"]` |

Vite 側に追加設定は要らない。`server.fs.allow` を絞っていないので、今 `../../src/...` が解決できて
いるのと同じ経路で `../../shared/...` も通る（深さも同じ）。

`core/deno.json` の `fmt` / `lint` の `include` に `../shared/` を足し、`tasks.check` を
`deno check src test ../shared` にする。設定ファイルの置き場所より上を指す include が
`deno fmt --check` / `deno lint` / `deno check` のいずれでも期待どおり効くことは、実際に試して
確認した。

## 5. タスクの入口

`deno task` は今後 `core/` から叩くものになる。ルートから回せるように `mise.toml` に委譲タスクを置く。
`app` 側の pnpm も元々 `cd app` を要求していたので、同じ形で揃える。ルートに立ったまま両方の
パッケージを操作できる状態が、`core/` と `app/` が対等に並ぶ構成の見え方と一致する。

```toml
[tasks."core:test"]
dir = "core"
run = "deno task test"

[tasks."app:test"]
dir = "app"
run = "pnpm test"
```

置くタスクは、コア側が `core:test` / `core:check` / `core:install` / `core:build`（`core/deno.json` の
`tasks` と 1 対 1）、アプリ側が `app:dev` / `app:build` / `app:test` / `app:tauri`（`app/package.json` の
`scripts` と 1 対 1）。タスクの正本はそれぞれ `core/deno.json` と `app/package.json` に残し、mise 側は
一行の委譲に留める。委譲は委譲先とズレようがないので、入口が増えても内容が食い違うことはない。
`dir` が mise.toml の位置からの相対で解決されること、`:` を含むタスク名が扱えることは実際に試して
確認した。

依存の取得は `setup` が両方を呼ぶ形にする。`deno install --frozen` は `deno.lock` の隣、
`pnpm install --frozen-lockfile` は `pnpm-lock.yaml` の隣で走る必要があり、1 つの `dir` では
書けないため、実体を 2 つに割って `depends` で束ねる。

```toml
[tasks."core:deps"]
dir = "core"
run = "deno install --frozen"

[tasks."app:deps"]
dir = "app"
run = "pnpm install --frozen-lockfile"

[tasks.setup]
description = "worktree を作業可能な状態にする（依存の取得）"
depends = ["core:deps", "app:deps"]
```

これは `setup` の振る舞いの変更でもある。今の `setup` はコアの依存しか取らず、アプリを触るには
別途 `cd app && pnpm install` が要る。`app:*` を置くなら `mise run app:test` が依存の入っていない
worktree でいきなり落ちるのは筋が悪いので、`setup` の説明文（「依存の取得」）どおりに両方を揃える。
`depends` は並列に走ることも確認した。

`core:install` はバイナリの設置、`core:deps` / `app:deps` は依存の取得で、名前が紛らわしくなる。
pnpm 側を `app:install` と呼ばず `app:deps` に揃えているのはそのためである。

CI は `mise run` に寄せない。コア系のジョブは `install_args: deno` で deno だけを入れており、
`mise run` に切り替えると `[tools]` 全体（rust を含む）の解決が絡む。ビルド時間に跳ねるリスクを
今回背負う理由がないので、CI は `working-directory: core` ＋ `deno task` を続ける。寄せるかどうかは
別の機会に判断する。

CI と手元でコマンド名が違う状態は残るが、これは今日すでにそうである（CI は `deno fmt --check` と
`deno lint` を `deno task` を経由せず直接叩いている）。

## 6. 設定ファイルの変更

**`.github/workflows/ci.yml`** — パスフィルタ 2 箇所、キャッシュキー、`working-directory`。

```diff
-  if matches "$common" || matches '^(src/|test/|deno\.json$|deno\.lock$)'; then
+  if matches "$common" || matches '^(core/|shared/)'; then
     core=true

-  # src/daemon/protocol.ts は #42 でアプリと共有し始める。共有後は
-  # コア側の変更でアプリも壊れうるので、今のうちから対象に入れておく。
-  if matches "$common" || matches '^(app/|src/daemon/protocol\.ts$)'; then
+  # shared/ は app と core の双方が依存する wire 契約なので、両方の対象に入れる。
+  if matches "$common" || matches '^(app/|shared/)'; then
     app=true
```

`core-check` と `core-test` の 2 ジョブに `defaults.run.working-directory: core` を足し、Deno の
キャッシュキーを `hashFiles('core/deno.lock')` にする。`hashFiles` はリポジトリルート基準なので
`working-directory` の影響を受けない。

**`.gitignore`** — `app/.gitignore` を削除して中身をルートへ統合する。`node_modules` `dist`
`.DS_Store` などはもともと階層を問わないパターンなので、そのまま移せば効く。`.vscode/*` と
`!.vscode/extensions.json` は否定パターンで順序に意味があるため、並びを保ったまま移す。

**文書** — ルート `README.md` の `deno task install` / `build` / `test` / `check` を
`mise run core:…` に、`deno run -A src/daemon/main.ts` を `core/src/daemon/main.ts` に書き換える。
`app/README.md` は `../../../src/daemon/protocol.ts` を `../../../shared/protocol.ts` にし、
`pnpm` を直に叩いている箇所があれば `mise run app:…` に寄せる。
`docs/overview.md` にパス参照は無い。`docs/superpowers/` 配下の過去の spec / plan は当時の記録なので
触らない。

## 7. 実施順序

移動と内容編集を混ぜると `git log --follow` もレビューも読めなくなるので 4 コミットに割る。
1〜3 では `git mv` を使い、内容編集を同じコミットに入れない。

| # | 内容 | 検証 |
| --- | --- | --- |
| 1 | `mkdir core` → `git mv src test deno.json deno.lock core/` | `cd core && deno task check && deno task test` |
| 2 | `mkdir shared` → protocol.ts の切り出し ＋ 参照 11 箇所（app の `tsconfig.json` を含む）＋ `deno.json` の include | 上に加えて `cd app && pnpm build && pnpm test` |
| 3 | `src/core`→`src/domain`、`test/core`→`test/domain` ＋ 参照 33 箇所（16 ファイル） | `cd core && deno fmt --check && deno lint && deno task check && deno task test` |
| 4 | `mise.toml` / `.gitignore` / `ci.yml` / README ×2 | `mise run setup`、`mise run core:test`、`mise run app:test`、`git status` が空 |

CI が緑になるのは 4 の後である。1〜3 の時点ではパスフィルタが古いままでスキップ判定を誤るため、
4 つを 1 本の PR にまとめて流す。

## 8. リスク

**`deno task install` 済みの環境。** `~/.deno/bin/dctl` はチェックアウト内の `src/cli/dctl.ts` を
`deno run` するシェルスクリプトなので、移動した時点で壊れる。段階 1 の直後に `mise run core:install`
をやり直す必要がある。README にもその旨を書く。

**新しい worktree での `mise trust`。** 事情はタスクが増える前と変わらないが、`mise run core:test` が
未信頼の設定で黙って動かないと分かりにくいので、README に `mise trust` の一行を添える。
