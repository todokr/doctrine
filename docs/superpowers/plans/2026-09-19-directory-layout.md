# ディレクトリ構成の見直し 実装プラン

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended)
> or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`)
> syntax for tracking.

**Goal:** ルート直下で粒度のズレている `src/` と `app/` を、`core/` `shared/` `app/` の対等な
3 つに組み直す。

**Architecture:** Deno 側の 4 つ（`src` `test` `deno.json` `deno.lock`）を丸ごと `core/` へ移し、
両者が共有する `daemon/protocol.ts` を `shared/` に切り出して依存を `core → shared ← app` の
一方向にする。加えて `core/src/core` の名前の重複を `src/domain` で解く。コードの振る舞いは
一切変えない。

**Tech Stack:** Deno 2.9.4 / TypeScript / Tauri 2 + React 19 + Vite / mise / GitHub Actions

**元になった spec:** [ディレクトリ構成の見直し](../specs/2026-09-19-directory-layout-design.md)

## Global Constraints

- コードの振る舞い・CLI のインターフェース・デーモンのプロトコルは変えない。移動と参照の付け替えだけ。
- コミットは 4 つ。1〜3 は `git mv` による移動のみで、内容編集を同じコミットに混ぜない（spec 7 章）。
- `prototype/` と `docs/` は触らない。`docs/superpowers/` 配下の過去の spec / plan は当時の記録なので
  パスを書き換えない。
- CI が緑になるのは Task 4 の後。1〜3 の時点ではパスフィルタが古く、スキップ判定を誤る。4 つを
  1 本の PR にまとめて流す。
- Deno のフォーマットは `lineWidth: 100`。参照の付け替えで行が伸びたら `deno fmt` を通す。
- `mise` のタスク名は `core:*` / `app:*` の名前空間。依存の取得は `:deps`、バイナリの設置は
  `core:install`。
- 以下のコマンド例の `/path/to/doctrine` はリポジトリのルート（`mise.toml` がある場所）に読み替える。

---

### Task 1: コアを `core/` へ移す

**Files:**
- Create: `core/`（ディレクトリ）
- Move: `src/` → `core/src/`、`test/` → `core/test/`、`deno.json` → `core/deno.json`、
  `deno.lock` → `core/deno.lock`

**Interfaces:**
- Consumes: なし（最初のタスク）
- Produces: 以降のタスクが触るパスの起点。`core/src/...` `core/test/...` `core/deno.json`

このタスクで**ファイルの中身は 1 文字も変えない**。コア内部の参照はすべてユニット内の相対パス
（`core/test/daemon/cli.test.ts` の `../../src/cli/dctl.ts`、`core/test/core/recovery.test.ts` の
`new URL("../../deno.json", import.meta.url)`）なので、4 つをまとめて動かす限り解決先は変わらない。

- [ ] **Step 1: 移動前の状態を記録する**

```bash
cd /path/to/doctrine
deno task test 2>&1 | tail -3
```

Expected: 全テストが PASS。ここが通らないなら、それは本プランと無関係の既存の失敗なので、先に
原因を切り分けること。

- [ ] **Step 2: `core/` を作って 4 つを移す**

```bash
mkdir core
git mv src test deno.json deno.lock core/
```

- [ ] **Step 3: 移動できたことを確認する**

```bash
ls core
git status --short | head -20
```

Expected: `ls core` が `deno.json  deno.lock  src  test` を返す。`git status --short` の行が
すべて `R ` （rename）で始まる。`A `（新規追加）や `D `（削除）が混ざっているなら `git mv` が
rename として記録できていないので、`git add -A` し直して再確認する。

- [ ] **Step 4: コアが `core/` の中で動くことを確認する**

```bash
cd core && deno task check && deno task test
```

Expected: `deno task check` がエラー 0。`deno task test` が全件 PASS。`cd core` が要るのは、
`deno.json` が `core/` に移ったため。

- [ ] **Step 5: コミット**

```bash
cd /path/to/doctrine
git add -A
git commit -m "refactor: コアを core/ に移す

src / test / deno.json / deno.lock を core/ にまとめ、app/ と対等な
兄弟にする。中身の編集はしない。"
```

---

### Task 2: `protocol.ts` を `shared/` に切り出す

**Files:**
- Create: `shared/`（ディレクトリ）
- Move: `core/src/daemon/protocol.ts` → `shared/protocol.ts`
- Modify: `core/src/cli/dctl.ts`、`core/src/daemon/handlers.ts`、`core/src/daemon/server.ts`、
  `core/test/daemon/handlers.test.ts`、`core/test/integration/taskContext.test.ts`、
  `core/test/integration/fullCycle.test.ts`、`core/deno.json`、
  `app/src/model.ts`、`app/src/model.test.ts`、`app/src/daemon/client.ts`、`app/tsconfig.json`

**Interfaces:**
- Consumes: Task 1 が作った `core/` 以下のパス
- Produces: `shared/protocol.ts`。export される型は移動前と同一（`Request` / `Response` /
  `ServerEvent` / `ProjectSummary` / `TaskListEntry` など）。core からも app からも
  `../../../shared/protocol.ts` で届く（`core/src/*/` `core/test/*/` `app/src/daemon/` が同じ深さ、
  `app/src/` だけ `../../shared/protocol.ts`）。

`protocol.ts` は import を 1 つも持たない 74 行の型定義だけのファイルなので、移動しても依存が
付いてこない。

- [ ] **Step 1: `shared/` を作って移す**

```bash
cd /path/to/doctrine
mkdir shared
git mv core/src/daemon/protocol.ts shared/protocol.ts
```

- [ ] **Step 2: 壊れたことを確認する（失敗を先に見る）**

```bash
cd core && deno task check
```

Expected: FAIL。`core/src/daemon/server.ts` などで `Module not found` 系のエラーが出る。ここで
エラーが出ないなら移動できていないので Step 1 に戻る。

- [ ] **Step 3: core 側の import を付け替える**

対象は 6 ファイル 6 箇所。`core/src/*/` と `core/test/*/` は同じ深さなので、いずれも
`../../../shared/protocol.ts` になる。

```bash
cd /path/to/doctrine/core
sed -i '' 's|"\.\./daemon/protocol\.ts"|"../../../shared/protocol.ts"|' src/cli/dctl.ts
sed -i '' 's|"\./protocol\.ts"|"../../../shared/protocol.ts"|' src/daemon/handlers.ts src/daemon/server.ts
sed -i '' 's|"\.\./\.\./src/daemon/protocol\.ts"|"../../../shared/protocol.ts"|' \
  test/daemon/handlers.test.ts test/integration/taskContext.test.ts test/integration/fullCycle.test.ts
```

（Linux で作業している場合は `sed -i ''` ではなく `sed -i` を使う。）

- [ ] **Step 4: 付け替え漏れが無いことを確認する**

```bash
cd /path/to/doctrine
grep -rn "daemon/protocol\.ts" core/src core/test
```

Expected: 出力なし（1 件も残っていない）。

- [ ] **Step 5: `core/deno.json` を `shared/` まで見るようにする**

`fmt` と `lint` の `include` に `../shared/` を足し、`tasks.check` の対象に `../shared` を足す。
設定ファイルより上を指す include が `deno fmt` / `deno lint` / `deno check` のいずれでも効くことは
確認済み（spec 4 章）。

```json
{
  "fmt": {
    "include": ["src/", "test/", "../shared/"],
    "lineWidth": 100
  },
  "lint": {
    "include": ["src/", "test/", "../shared/"],
    "rules": {
      // async のシグネチャがインターフェース側（kysely の Dialect / DatabaseConnection、
      // createServer のハンドラ）から要求される箇所が多く、await の有無で判断できない。
      "exclude": ["require-await"]
    }
  },
  "tasks": {
    "test": "deno test --allow-all test/",
    "check": "deno check src test ../shared",
    "install": "deno install -g -A -f --config deno.json -n dctl src/cli/dctl.ts && deno install -g -A -f --config deno.json -n dctld src/daemon/main.ts",
    "build": "deno compile -A --output dist/dctl src/cli/dctl.ts && deno compile -A --output dist/dctld src/daemon/main.ts"
  },
  "imports": {
    "@std/path": "jsr:@std/path@^1",
    "@std/testing": "jsr:@std/testing@^1.0.20",
    "kysely": "npm:kysely@^0.28.17",
    "yaml": "npm:yaml@^2.6.0",
    "zod": "npm:zod@^3.24.0"
  }
}
```

- [ ] **Step 6: コアが通ることを確認する**

```bash
cd /path/to/doctrine/core
deno fmt --check && deno lint && deno task check && deno task test
```

Expected: 全部 PASS。`deno fmt --check` が差分を出したら `deno fmt` を流してから進む
（付け替えで行が 100 桁を越えた場合）。

- [ ] **Step 7: app 側の import を付け替える**

```bash
cd /path/to/doctrine/app
sed -i '' 's|"\.\./\.\./src/daemon/protocol\.ts"|"../../shared/protocol.ts"|' src/model.ts src/model.test.ts
sed -i '' 's|"\.\./\.\./\.\./src/daemon/protocol\.ts"|"../../../shared/protocol.ts"|' src/daemon/client.ts
sed -i '' 's|"\.\./src/daemon/protocol\.ts"|"../shared/protocol.ts"|' tsconfig.json
```

`app/tsconfig.json` の `include` はこれで `["src", "../shared/protocol.ts"]` になる。Vite 側の
追加設定は要らない（`server.fs.allow` を絞っていないので、今 `../../src/...` が解決できているのと
同じ経路で通る。深さも同じ）。

- [ ] **Step 8: 付け替え漏れが無いことを確認する**

```bash
cd /path/to/doctrine
grep -rn "src/daemon/protocol\.ts" app/src app/tsconfig.json
```

Expected: ヒットするのは `app/src/types.ts:1`（先頭コメント）と `app/src/fixtures.ts` の 3 行
（349〜351 行目。エージェントの会話ログを模したテスト用の文字列）の**計 4 行だけ**。import 文が
1 つも残っていないことがここで分かる。この 4 行は文章であって import ではないので、このタスクでは
触らない（`types.ts` の扱いは Task 4 Step 11）。

- [ ] **Step 9: app が通ることを確認する**

```bash
cd /path/to/doctrine/app
pnpm install --frozen-lockfile   # node_modules がまだ無い場合のみ
pnpm build && pnpm test
```

Expected: `pnpm build`（`tsc && vite build`）が型エラー 0 で完了。`pnpm test`（vitest）が全件 PASS。

- [ ] **Step 10: コミット**

```bash
cd /path/to/doctrine
git add -A
git commit -m "refactor: protocol.ts を shared/ に切り出す

app が core の内部を覗く形（../../src/daemon/protocol.ts）をやめ、
依存を core → shared ← app の一方向にする。"
```

---

### Task 3: `src/core` を `src/domain` に改名する

**Files:**
- Move: `core/src/core/` → `core/src/domain/`、`core/test/core/` → `core/test/domain/`
- Modify: `core/src/daemon/handlers.ts`、`core/src/daemon/main.ts`、`core/src/workflow/schema.ts`、
  `core/test/domain/*.test.ts`（10 本）、`core/test/daemon/handlers.test.ts`、
  `core/test/integration/reviewRecord.test.ts`、`core/test/integration/taskContext.test.ts`

**Interfaces:**
- Consumes: Task 1 / Task 2 の結果
- Produces: `core/src/domain/` 以下のモジュール群（`engine.ts` `scheduler.ts` `stepRunner.ts`
  `states.ts` `worktree.ts` `recovery.ts` `diff.ts` `reviewFiles.ts` `reviewTree.ts`
  `taskContext.ts`）。export される名前は一切変わらず、パスだけが変わる。

外側を `core/` にした結果できる `core/src/core/stepRunner.ts` というパスの重複を解く。doctrine には
まだ外部の利用者がいないので、改名は参照の一括置換だけで完結する。

- [ ] **Step 1: 2 つのディレクトリを改名する**

```bash
cd /path/to/doctrine
git mv core/src/core core/src/domain
git mv core/test/core core/test/domain
```

- [ ] **Step 2: 壊れたことを確認する（失敗を先に見る）**

```bash
cd core && deno task check
```

Expected: FAIL。`core/src/daemon/main.ts` などが `../core/engine.ts` を見つけられない。

- [ ] **Step 3: 参照を一括で付け替える**

現れる形は 2 つだけ。`core/src/daemon/` と `core/src/workflow/` からの `../core/X.ts`（10 箇所）と、
`core/test/` からの `../../src/core/X.ts`（19 箇所）。後者のパターンは
`core/src/domain/reviewFiles.ts` を指す doc コメント 1 行も一緒に直す。

```bash
cd /path/to/doctrine/core
grep -rl '\.\./core/' src test | xargs sed -i '' 's|\.\./core/|../domain/|g'
grep -rl 'src/core/' src test | xargs sed -i '' 's|src/core/|src/domain/|g'
```

`../../src/core/X.ts` は `../core/` を部分文字列として含まないので（`core/` の直前が `src/`）、
2 つの sed が二重に当たることはない。

- [ ] **Step 4: 付け替え漏れが無いことを確認する**

```bash
cd /path/to/doctrine
grep -rn '\.\./core/\|src/core/' core/src core/test
```

Expected: 出力なし。

- [ ] **Step 5: コアが通ることを確認する**

```bash
cd /path/to/doctrine/core
deno fmt --check && deno lint && deno task check && deno task test
```

Expected: 全部 PASS。`deno fmt --check` が差分を出したら `deno fmt` を流す。

- [ ] **Step 6: コミット**

```bash
cd /path/to/doctrine
git add -A
git commit -m "refactor: src/core を src/domain に改名する

core/src/core/ というパスの重複を解く。export される名前は変えない。"
```

---

### Task 4: 設定と文書を新しい構成に追随させる

**Files:**
- Modify: `mise.toml`、`.gitignore`、`.github/workflows/ci.yml`、`README.md`、`app/README.md`、
  `app/src/types.ts:1`
- Delete: `app/.gitignore`

**Interfaces:**
- Consumes: Task 1〜3 の結果
- Produces: ルートから叩けるタスク群 — `mise run setup`、`mise run core:{deps,test,check,install,build}`、
  `mise run app:{deps,dev,build,test,tauri}`

- [ ] **Step 1: `mise.toml` にタスクを置く**

既存の `[tools]` ブロックはそのまま残し、`[tasks.setup]` を下記で置き換える。タスクの正本は
`core/deno.json` と `app/package.json` に残し、mise 側は一行の委譲に留める（委譲は委譲先と
ズレようがない）。`dir` は mise.toml の位置からの相対で解決される。

```toml
# タスクはすべて core/deno.json と app/package.json への一行の委譲。実体をここに
# 書き写さないのは、書き写した瞬間に二重管理になるため。
[tasks."core:deps"]
description = "コアの依存を取る"
dir = "core"
run = "deno install --frozen"

[tasks."core:test"]
description = "コアのテスト"
dir = "core"
run = "deno task test"

[tasks."core:check"]
description = "コアの型検査"
dir = "core"
run = "deno task check"

[tasks."core:install"]
description = "dctl / dctld を ~/.deno/bin に置く"
dir = "core"
run = "deno task install"

[tasks."core:build"]
description = "dctl / dctld の単一バイナリを作る"
dir = "core"
run = "deno task build"

[tasks."app:deps"]
description = "アプリの依存を取る"
dir = "app"
run = "pnpm install --frozen-lockfile"

[tasks."app:dev"]
description = "アプリをブラウザで開く"
dir = "app"
run = "pnpm dev"

[tasks."app:build"]
description = "アプリをビルドする"
dir = "app"
run = "pnpm build"

[tasks."app:test"]
description = "アプリのテスト"
dir = "app"
run = "pnpm test"

[tasks."app:tauri"]
description = "アプリをウィンドウで開く"
dir = "app"
run = "pnpm tauri dev"

# worktree 初期化で使う。`mise run setup` を worktree 内で実行する。
# 注意: 新しい worktree のパスは mise にとって未信頼なので、このタスクを呼ぶ前に
# `mise trust`（または MISE_TRUSTED_CONFIG_PATHS）が必要。信頼判定は設定の
# パース時点で走るため、タスク自身が自分の信頼をブートストラップすることはできない
#
# deno と pnpm はそれぞれの lock ファイルの隣で走る必要があり、1 つの dir では
# 書けないので、実体を 2 つに割って depends で束ねている。
[tasks.setup]
description = "worktree を作業可能な状態にする（依存の取得）"
depends = ["core:deps", "app:deps"]
```

- [ ] **Step 2: タスクが動くことを確認する**

```bash
cd /path/to/doctrine
mise tasks
mise run core:test
mise run app:test
```

Expected: `mise tasks` に `app:build` `app:deps` `app:dev` `app:tauri` `app:test` `core:build`
`core:check` `core:deps` `core:install` `core:test` `setup` が並ぶ。`mise run core:test` と
`mise run app:test` が PASS。未信頼と言われたら `mise trust` を先に実行する。

- [ ] **Step 3: `.gitignore` をルートに集約する**

`app/.gitignore` を消し、中身をルートへ畳む。`node_modules` `dist` `.DS_Store` はもともと階層を
問わないパターンなので、そのまま移せば効く。`.vscode/*` と `!.vscode/extensions.json` は
否定パターンで順序に意味があるため、並びを保つ。

ルート `.gitignore` を下記の内容にする。

```gitignore
dist/
dist-ssr
node_modules
*.local
logs
*.log
npm-debug.log*
yarn-debug.log*
yarn-error.log*
pnpm-debug.log*
lerna-debug.log*

.superpowers/
.idea
.DS_Store

.vscode/*
!.vscode/extensions.json

*.suo
*.ntvs*
*.njsproj
*.sln
*.sw?
```

そのうえで `app/.gitignore` を消す。

```bash
cd /path/to/doctrine
git rm app/.gitignore
```

- [ ] **Step 4: 無視の効き方が変わっていないことを確認する**

```bash
cd /path/to/doctrine
git status --short
git check-ignore -v app/node_modules app/dist core/dist app/src-tauri/target 2>&1
```

Expected: `git status --short` に `node_modules` や `dist` 配下のファイルが 1 つも現れない
（現れたら畳み方が足りていない）。`git check-ignore` が 4 つすべてについて、どのルールで無視されて
いるかを出す。なお `app/src-tauri/target` は Rust のビルド成果物で、`app/src-tauri/.gitignore` が
別にあるならそちらが効く（今回は触らない）。

- [ ] **Step 5: CI のパスフィルタを直す**

`.github/workflows/ci.yml` の `changes` ジョブ。

```diff
-          core=false
-          if matches "$common" || matches '^(src/|test/|deno\.json$|deno\.lock$)'; then
-            core=true
-          fi
+          core=false
+          if matches "$common" || matches '^(core/|shared/)'; then
+            core=true
+          fi

           app=false
-          # src/daemon/protocol.ts は #42 でアプリと共有し始める。共有後は
-          # コア側の変更でアプリも壊れうるので、今のうちから対象に入れておく。
-          if matches "$common" || matches '^(app/|src/daemon/protocol\.ts$)'; then
+          # shared/ は app と core の双方が依存する wire 契約なので、両方の対象に入れる。
+          if matches "$common" || matches '^(app/|shared/)'; then
             app=true
           fi
```

- [ ] **Step 6: CI のコア系ジョブを `core/` で走らせる**

`core-check` と `core-test` の 2 ジョブに `defaults` を足す。`runs-on: ubuntu-latest` の次の行
（`core-test` では `strategy:` の前）に入れる。`actions/checkout` は action なので
`working-directory` の影響を受けず、リポジトリルートに展開される。

```yaml
  core-check:
    name: コア（整形・型・ビルド）
    needs: changes
    if: needs.changes.outputs.core == 'true'
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: core
    steps:
```

```yaml
  core-test:
    # TZ は UTC 以外でも流す。ランナーの既定が UTC なので、#39 のような
    # タイムゾーン依存のバグは UTC だけでは再現しない。
    name: コアのテスト (TZ=${{ matrix.tz }})
    needs: changes
    if: needs.changes.outputs.core == 'true'
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: core
    strategy:
```

- [ ] **Step 7: CI の Deno キャッシュキーを直す**

2 ジョブそれぞれの `actions/cache` の `key`。`hashFiles` はリポジトリルート基準なので
`working-directory` の影響を受けない。

```diff
-          key: deno-${{ runner.os }}-${{ hashFiles('deno.lock') }}
+          key: deno-${{ runner.os }}-${{ hashFiles('core/deno.lock') }}
```

CI は `mise run` には寄せない。コア系のジョブは `install_args: deno` で deno だけを入れており、
`mise run` に切り替えると `[tools]` 全体（rust を含む）の解決が絡んでビルド時間に跳ねる。

- [ ] **Step 8: CI の YAML が壊れていないことを確認する**

```bash
cd /path/to/doctrine
python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml')); print('yaml ok')"
grep -n "working-directory: core\|hashFiles('core/deno.lock')\|\^(core/|shared/)\|\^(app/|shared/)" .github/workflows/ci.yml
```

Expected: `yaml ok` が出る。`working-directory: core` が 2 箇所、`hashFiles('core/deno.lock')` が
2 箇所、パスフィルタの 2 行がそれぞれ 1 箇所ずつ見つかる。

- [ ] **Step 9: ルート `README.md` を直す**

「1. セットアップ」節（10 行目付近から）を下記に置き換える。`mise install` はツールを入れる
コマンドで、依存の取得は `mise run setup` に移る。

````markdown
## 1. セットアップ

```bash
mise install                        # Deno / Node / pnpm / Rust の版をリポジトリに固定
mise trust                          # 新しい worktree では最初の 1 回だけ必要
mise run setup                      # core と app の依存（lock 固定）を取得
```

`dctl` / `dctld` をコマンドとして使うには、次のどちらかを行う。

```bash
mise run core:install   # ~/.deno/bin に dctl / dctld を置く（要 PATH）
mise run core:build     # core/dist/dctl / core/dist/dctld に単一バイナリを作る
```

- **`mise run core:install`（普段使い）** — 置かれるのはこのチェックアウトのソースを
  `deno run` する小さなシェルスクリプトなので、ソースを保存すれば再インストール
  なしで反映される。その代わりチェックアウトを移動・削除すると動かなくなる。
  `core/deno.json` の `imports` はインストール時点のものが複製されるので、
  依存を変えたら `mise run core:install` をやり直すこと。
- **`mise run core:build`（配布用）** — Deno もチェックアウトも不要な単体の実行ファイル。
  1本あたり約100MBあり、ソースを変えるたびにビルドし直す必要がある。

```bash
dctld &     # デーモンを起動（フォアグラウンドで動く。&で背景へ）
dctl ls     # CLIから接続
```

インストールせずに `deno run -A core/src/daemon/main.ts` / `deno run -A core/src/cli/dctl.ts`
として直接動かしてもよい。

テストは `mise run core:test`、型チェックは `mise run core:check`。アプリ側は
`mise run app:test` / `mise run app:tauri`。
````

- [ ] **Step 10: `app/README.md` を直す**

3 箇所。

1. 冒頭の `リポジトリ直下の src/daemon/` → `リポジトリ直下の core/src/daemon/`
2. 15〜19 行目のコマンド列を mise に寄せる

````markdown
```bash
mise install          # Deno / Node / pnpm / Rust（リポジトリ直下の mise.toml）
mise run setup        # core と app の依存を取得
mise run core:install # dctl / dctld を deno install する（~/.deno/bin に入る）
mise run app:tauri    # ウィンドウで開く（起動時に dctld を自動で起こす）
mise run app:dev      # ブラウザで開く（http://localhost:1420。Tauri の invoke が無いのでデーモンにはつながらない）
mise run app:test     # 状態の更新と導出（src/model.ts など）の単体テスト
```
````

3. 22〜23 行目と 59 行目の `pnpm tauri dev` / `deno task install` の言及を、それぞれ
   `mise run app:tauri` / `mise run core:install` に直す。34 行目の
   `../../../src/daemon/protocol.ts` は Task 2 で直し済みなので触らない。

- [ ] **Step 11: `app/src/types.ts` の先頭コメントを直す**

```bash
cd /path/to/doctrine
sed -i '' 's|src/daemon/protocol\.ts|shared/protocol.ts|' app/src/types.ts
```

`app/src/fixtures.ts` の `src/daemon/protocol.ts` は、エージェントの会話ログを模したテスト用の
文字列（過去の発話の再現）であって実在のパス参照ではないので**直さない**。

- [ ] **Step 12: 全部通ることを確認する**

```bash
cd /path/to/doctrine
mise run setup
mise run core:check && mise run core:test
mise run app:build && mise run app:test
(cd core && deno fmt --check && deno lint)
git status --short
```

Expected: すべて PASS。`git status --short` は（この Step までの編集を除いて）新たな未追跡ファイルを
出さない。

- [ ] **Step 13: 古いパスの残骸が無いことを最終確認する**

```bash
cd /path/to/doctrine
grep -nE "deno task |deno install --frozen" README.md app/README.md
grep -rnE "(^|[^/])src/(daemon|cli|core)/" README.md app/README.md mise.toml .github/workflows/ci.yml
```

Expected: どちらも出力なし。1 つ目は README が mise のタスクに寄り切ったことの確認
（`mise.toml` の `run = "deno task test"` は委譲の実体なので対象に入れない）。2 つ目は
`core/` を頭に付け忘れた古いパスの検出で、`core/src/daemon/` のように `/` が前に付く形は
除外される。ヒットしたら Step 5〜11 のどれかが漏れている。

- [ ] **Step 14: コミット**

```bash
cd /path/to/doctrine
git add -A
git commit -m "chore: 設定と文書を新しい構成に追随させる

mise.toml に core:* / app:* の委譲タスクを置き、setup が双方の依存を取る
ようにした。.gitignore をルート 1 本に集約し、CI のパスフィルタと
working-directory を core/ 前提に直す。"
```

---

## 完了後の確認

- [ ] `git log --oneline -4` が 4 コミット（移動 3 ＋ 設定・文書 1）になっている
- [ ] `git log --follow core/src/domain/engine.ts` が改名前の履歴まで遡れる
- [ ] PR を立てて CI が緑になる。`changes` ジョブのサマリで core / app 双方が `true` になっている
  （ルートの `mise.toml` と `.github/` を触っているため）
- [ ] `mise run core:install` をやり直し、`dctl ls` が動くことを手元で確認する
  （移動前に `deno task install` していた場合、`~/.deno/bin/dctl` は壊れている）
