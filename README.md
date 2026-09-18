# doctrine

ローカルマシンで複数の Claude Code を同時に走らせ、決められた手順で最後まで
走らせきるためのデスクトップツール。全体像・原則・用語は
[`docs/overview.md`](docs/overview.md) を参照。このREADMEは実際に手を動かす人向けの
使い方と、使う前に知っておくべき制約だけを書く。

常駐デーモン `dctld` がワークフローを進行させ、`dctl` はそれに繋ぐだけの薄いCLI
（製品UIではなく、デバッグ・テスト用の表面）。

## 1. セットアップ

```bash
mise install                        # Deno のバージョンをリポジトリに固定
deno install --frozen               # 依存（deno.lock 固定）を取得
```

`dctl` / `dctld` をコマンドとして使うには、次のどちらかを行う。

```bash
deno task install   # ~/.deno/bin に dctl / dctld を置く（要 PATH）
deno task build     # dist/dctl / dist/dctld に単一バイナリを作る
```

- **`deno task install`（普段使い）** — 置かれるのはこのチェックアウトのソースを
  `deno run` する小さなシェルスクリプトなので、ソースを保存すれば再インストール
  なしで反映される。その代わりチェックアウトを移動・削除すると動かなくなる。
  `deno.json` の `imports` はインストール時点のものが複製されるので、
  依存を変えたら `deno task install` をやり直すこと。
- **`deno task build`（配布用）** — Deno もチェックアウトも不要な単体の実行ファイル。
  1本あたり約100MBあり、ソースを変えるたびにビルドし直す必要がある。

```bash
dctld &     # デーモンを起動（フォアグラウンドで動く。&で背景へ）
dctl ls     # CLIから接続
```

インストールせずに `deno run -A src/daemon/main.ts` / `deno run -A src/cli/dctl.ts`
として直接動かしてもよい。

テストは `deno task test`、型チェックは `deno task check`。

### プロジェクトを登録し、タスクを作る

```bash
dctl project-add --path /path/to/your/repo
dctl add --project /path/to/your/repo --title "ログイン画面を実装" --prompt "..."
dctl ls
dctl get <task-id>
```

`project-add` は最初に叩くコマンドで、`.doctrine/` が無ければ雛形を作る。

- `.doctrine/project.yaml` と `.doctrine/workflows/default.yaml`（agent → approval の最小構成）を作り、
  作ったファイルのパスを `created` に出す。**コミットはしない。** 何をコミットするかは自分で決める
- `baseBranch` は git から取る（リモートの既定ブランチ、無ければ現在のブランチ）。`setup` は書かない
  — doctrine はパッケージマネージャを決めないので、必要なら自分で足す
- **既存のファイルは上書きしない。** `project.yaml` が既にあれば読むだけで、それが指す
  ワークフローが無ければ何も作らずに失敗する（書いていない手順を勝手に作らない）
- `--path` には **git リポジトリのルート**を指定する。git リポジトリでない、またはサブディレクトリを
  指した場合は何も作らずに失敗する（doctrine はタスクごとに git worktree を作るため）
- 同じパスで2回実行しても失敗しない。登録済み（`alreadyRegistered: true`）と返すだけ

`--workflow <name>` で `project.yaml` の `defaultWorkflow` を上書きできる。
`--priority 0`（既定は2、P0〜P3）で優先度を指定できる。

承認待ち（`suspended`）のタスクには `dctl approve <task-id>` /
`dctl reject <task-id> --comment "..."` で応答する。却下は理由のコメントが必須
（コメント無しの却下はエージェントが次にどう動けばいいか分からないため）。
`dctl pause <task-id>` / `dctl resume <task-id>` / `dctl cancel <task-id>` で
中断・再開・中止する。

## 2. ワークフローを書く

`dctl project-add` が作った雛形を、プロジェクトに合わせて編集する。配置場所は2つ。

- `<project>/.doctrine/project.yaml` — プロジェクト全体の設定
- `<project>/.doctrine/workflows/<name>.yaml` — 手順そのもの

```yaml
# .doctrine/project.yaml
setup: pnpm install --frozen-lockfile   # 全ワークフローの先頭に自動挿入される
defaultWorkflow: feature
maxConcurrent: 1
baseBranch: main
```

```yaml
# .doctrine/workflows/feature.yaml
name: feature
steps:
  - id: implement
    type: agent
    prompt: "{{ task.prompt }}"
    permissionMode: acceptEdits

  - id: verify
    type: command
    run: "pnpm test"
    onFailure:
      goto: implement
      maxAttempts: 3
      feed: "テストが失敗した:\n{{ steps.verify.stderr }}"

  - id: review
    type: approval
    title: "差分を確認してください"
    onReject:
      goto: implement
      maxAttempts: 5
      feed: "レビューで却下された:\n{{ steps.review.stdout }}"

  - id: record
    type: command
    run: "echo done > result.txt"
```

### ステップは3種類だけ

- **`command`** — worktree内でシェルコマンドを実行する。非0終了でステップ失敗。
- **`agent`** — Claude Code を headless 実行する。会話を role 単位（`session: <role>`）で
  記録し再開可能。
- **`approval`** — ワークフローを `suspended` にし、人の承認・却下・追加コメントを待つ。

失敗時の分岐は `onFailure`（`command` / `agent`）と `onReject`（`approval`）のみで、
どちらも同じ形（`goto` / `maxAttempts` / `feed`）を持つ。分岐先へ戻った `agent` は
同じ role のセッションIDで `--resume` されるので、会話は継続する（やり直しではない）。

### role ごとの会話（`session`）

`agent` ステップに `session: <role>` を書くと、同じ role を持つステップ同士が1本の会話を
共有する。差し戻しで同じ role の `agent` ステップへ戻ると、その会話が `--resume` される。

```yaml
  - id: plan
    type: agent
    session: planner
    prompt: "計画を .doctrine-out/plan.md に書いてください"

  - id: implement
    type: agent
    session: implementer
    prompt: "{{ worktree.path }}/.doctrine-out/plan.md を実装してください"
```

`session` を省略すると、すべての `agent` ステップが暗黙の既定ロールを共有する
（今までどおり「タスクに会話は1本」）。役割を分けたときの詳しい設計は
[`docs/superpowers/specs/2026-09-13-step-artifacts-design.md`](docs/superpowers/specs/2026-09-13-step-artifacts-design.md) を参照。

### 変数は4系統だけ

- `{{ task.id }}` `{{ task.title }}` `{{ task.prompt }}` `{{ task.branch }}`
- `{{ worktree.path }}`
- `{{ project.path }}`
- `{{ steps.<id>.stdout }}` `{{ steps.<id>.stderr }}` `{{ steps.<id>.exitCode }}`
  — `agent` ステップの `stdout` は最終応答テキスト、`approval` ステップの
  `stdout` は却下コメントそのもの。

### `setup` は予約されたステップid

`project.yaml` の `setup` は特別な機構ではなく、ただの `command` ステップに
名前を付けて全ワークフローの先頭に自動挿入しているだけ（新品 worktree に
`node_modules` が無い問題への対処）。そのぶん、ユーザー定義のワークフローで
ステップid `setup` を使うと自動挿入された方と衝突するため、検証時にエラーになる。

## 3. `command` ステップは再実行安全でなければならない

doctrine はステップ境界ごとに状態を1トランザクションで書く。これにより
デーモンが落ちても失うのは進行中の1ステップ分だけで済むが、**代償として**
クラッシュ復帰時・`dctl pause` からの `dctl resume` 時、中断されていた
`command` ステップは頭から再実行される（`agent` ステップは
`claude_session_id` で `--resume` されるので、こちらは再実行されない）。

つまり **`command` ステップに書くコマンドは、二回実行されても安全でなければ
ならない。**

- 問題ない例: `pnpm install --frozen-lockfile`、`pnpm test`
- **問題になり得る例: `gh pr create`、`git push`、`npm publish`**
  （復帰のたびに二重にPRが立つ・二重にpushされる・二重に公開される）

ワークフローのパーサ（`parseWorkflow`）は `gh pr create` / `gh release create` /
`git push` / `npm publish` / `pnpm publish` のような既知の非冪等コマンドを検出する
チェックを持っており、`dctl add`（`task.create`）の応答に警告として乗る
（あわせてデーモンの標準エラー出力にも記録される）。

```bash
$ dctl add --project /path/to/repo --title "PRを作る" --prompt "..." --workflow release
{
  "id": "...",
  ...,
  "warnings": [
    "ステップ \"open-pr\" のコマンドは再実行で二重に効く可能性があります: gh pr create --fill\n  クラッシュ復帰時、command ステップは頭から再実行されます。"
  ]
}
```

この警告は**正規表現による既知パターンの検出であり、完全には防げない。**
また `task.create` の1回だけに出る（同じワークフローを `task.approve` /
`task.reject` / 通常の `tick` が読み直すたびには再表示しない。作成時に
一度伝われば十分であり、同じ警告が延々流れ続けるのを避けるため）。したがって、
**`command` ステップが再実行安全かどうかの最終的な担保は、常にワークフローの
書き手の責任である。**

## 4. worktree は失敗・中止時に残る

- `completed` → worktree は削除される（ブランチは残る）。ただし完了時に
  **未コミットの変更が残っていれば削除は拒否され**、デーモンの標準エラー出力に
  警告が出る（この警告はまだクライアントには届かない。後述の「既知の制約」参照）。
- `failed` / `canceled` → worktree は**意図的に残される**。失敗した実行こそ
  中を見たい瞬間であり、そこで証拠を消すのは最悪の設計であるため。

残ったworktreeは溜まる。見つけて消すには:

```bash
dctl ls --state failed              # 失敗したタスクを探す
dctl get <task-id>                  # worktree_path を確認する
dctl diff <task-id>                 # worktree の今の状態の diff（未コミット・未追跡を含む）
dctl gc <task-id>                   # そのタスクのworktreeを削除する
dctl gc <task-id> --force           # 削除が拒否される場合（未コミットの変更がある）
```

**`--force` を付けると、worktree内の未コミットの作業は失われる。** 確認してから使うこと。

worktree を消すと、そのタスクのレビュー参照（`refs/doctrine/reviews/<task-id>/`）も
一緒に消える。この参照は「レビュー時点の worktree の中身」を `git gc` から守るために
doctrine が張っているもので、worktree が無くなれば使う相手もいない。

なお `dctl worktrees` が一覧するのは「対応するタスクが見つからない孤立
worktree」だけであり、`failed` タスクの（対応するタスクが存在する）worktreeは
ここには出てこない。上記のとおり `dctl ls --state failed` → `dctl get` の経路で探す。

## 5. `degraded` の意味

Claude Code は `--permission-prompts none` で headless 実行するため、
権限で操作を拒否されても**プロセスとしては正常終了する**（終了コード0、
`is_error: false`）。つまり「エージェントが何もできないまま終わった」ケースが、
何もしなければ「成功」に見えてしまう。

エージェントの応答に権限拒否（`permission_denials`）が含まれていた場合、
そのステップ実行の状態は `success` ではなく `degraded` として記録される。
ワークフロー自体は止まらない（判断材料を出すところまでがdoctrineの責務）。

確認するには:

```bash
dctl get <task-id>
# => .stepRuns[].status が "degraded" になっている実行を探す
```

`degraded` を見逃すと、「成功した」と思って進めたタスクが実質何も達成していない、
という気づきにくい失敗を踏む。

### ステップ実行の状態

`dctl get <task-id>` の `.stepRuns[].status` が取る値。

- `running` — 実行中
- `awaiting` — `approval` ステップが人の承認・却下を待っている（1行＝レビュー1回）
- `success` / `failed` — 終わった
- `degraded` — 成功扱いだが権限拒否があった（5章）
- `interrupted` — デーモンのクラッシュで中断され、復帰時に閉じられた

## 6. ステップ間で成果物を渡す

前段の `agent` ステップが後段へ計画やレビュー結果を渡したいときは、worktree 内の
ファイルに書かせ、後段は `{{ worktree.path }}` でパスを組み立てて読ませる。

```yaml
  - id: plan
    type: agent
    session: planner
    prompt: "計画を .doctrine-out/plan.md に書いてください"

  - id: review
    type: agent
    session: reviewer
    prompt: "{{ worktree.path }}/.doctrine-out/plan.md の内容をレビューしてください"
```

`.doctrine-out/` という名前は規約であり、doctrine が強制するものではない
（プロンプトで指示する自由な文字列）。ただし doctrine は worktree 作成時に、
この名前を `.git/info/exclude` へ自動で追記する。これにより:

- `completed` の後始末（4章）が、この中間ファイルを「未コミットの変更」として
  誤って削除拒否しない
- レビュー画面の diff にも混ざらない

対象を別の名前にしたい場合でも、この自動追記の対象は `.doctrine-out/` に固定されている
点に注意する（変えたい場合は自分で `.git/info/exclude` に追記する）。

## 既知の制約

実装の過程で判明した、まだ直していない・あえて直さないと決めた制約。

- **完了イベントとworktree後始末の間に競合がある**（[#3](https://github.com/todokr/doctrine/issues/3)）。
  `task.stateChanged`（`completed`）を受け取った直後にクライアントがworktreeを
  見に行くと、まだ削除されずに存在していることがある。また、完了時の
  「未コミットの変更が残っているため削除を拒否した」警告は、今のところ
  デーモンの標準エラー出力にしか出ず、クライアントには届かない。
- **一時的なsetup失敗はタスクを恒久的に失敗させる。** worktreeの作成が
  ディスク満杯やロックなどで一時的に失敗した場合、そのタスクは（リトライされず）
  `failed` になる。`queued` のままにすると、スケジューラが毎周期リトライし続け、
  他タスクの進行を巻き込みかねないため。取り直すにはタスクを作り直すこと。
