# doctrine

ローカルマシンで複数の Claude Code を同時に走らせ、決められた手順で最後まで
走らせきるためのデスクトップツール。全体像・原則・用語は
[`docs/overview.md`](docs/overview.md) を参照。このREADMEは実際に手を動かす人向けの
使い方と、使う前に知っておくべき制約だけを書く。

常駐デーモン `dctld` がワークフローを進行させ、`dctl` はそれに繋ぐだけの薄いCLI
（製品UIではなく、デバッグ・テスト用の表面）。

## 目次

- [1. セットアップ](#1-セットアップ)
  - [プロジェクトを登録し、タスクを作る](#プロジェクトを登録しタスクを作る)
- [2. ワークフローを書く](#2-ワークフローを書く)
  - [ステップは4種類だけ](#ステップは4種類だけ)
  - [role ごとの会話（`session`）](#role-ごとの会話session)
  - [`approval` ステップに読ませるファイル（`review.files`）](#approval-ステップに読ませるファイルreviewfiles)
  - [変数は5系統だけ](#変数は5系統だけ)
  - [`setup` は予約されたステップid](#setup-は予約されたステップid)
- [3. `command` ステップは再実行安全でなければならない](#3-command-ステップは再実行安全でなければならない)
- [4. worktree は失敗・中止時に残る](#4-worktree-は失敗中止時に残る)
- [5. 権限で拒否された操作を読む](#5-権限で拒否された操作を読む)
  - [ステップ実行の状態](#ステップ実行の状態)
- [6. ステップ間で成果物を渡す](#6-ステップ間で成果物を渡す)
- [7. 大きな Issue を PFD で分解してから流す](#7-大きな-issue-を-pfd-で分解してから流す)
- [既知の制約](#既知の制約)

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

### プロジェクトを登録し、タスクを作る

```bash
dctl project-add --path /path/to/your/repo
dctl add --project /path/to/your/repo --title "ログイン画面を実装" --prompt "..."
dctl ls
dctl get <task-id>
dctl diff <task-id>                 # worktree の今の状態の diff（未コミット・未追跡を含む）
dctl diff <task-id> --since last_review  # 直近の差し戻し以降だけの diff
```

`dctl diff` は JSON を返すので、patch をテキストとして読むには
`dctl diff <task-id> | jq -r .patch` のように取り出す。レビュー画面（②）はまだ無いので、
今のところこれが diff を実際に目で見る手段になる。

`project-add` は最初に叩くコマンドで、`.doctrine/` が無ければ雛形を作る。

- `.doctrine/project.yaml` と `.doctrine/workflows/default.yaml`（計画 → 計画レビュー → 実装 → 検証 → コードレビュー → ガイド → 人のレビュー）を作り、
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
defaultWorkflow: default
maxConcurrent: 1
baseBranch: main
```

雛形の `default.yaml` は、計画 → 計画レビュー → 実装 → 検証 → コードレビュー → ガイド → 人のレビュー
の順に並んでいる。役割ごとに `session` を分け（`planner` / `plan-reviewer` / `implementer` /
`code-reviewer` / `guide`）、役割の間は `.doctrine-out/` の下のファイル
（`plan.md` / `plan-review.md` / `implement-notes.md` / `review.md`）で受け渡す。
プロンプトや `allowedTools` の全文は雛形を見る。骨格だけ書くと次のとおり。

```yaml
# .doctrine/workflows/default.yaml（骨格。プロンプトと allowedTools は省略）
name: default
steps:
  - id: plan                # 計画 → .doctrine-out/plan.md
    type: agent
    session: planner
  - id: plan-review         # 計画のレビュー。1行目に verdict: approve / reject を書く
    type: agent
    session: plan-reviewer
  - id: plan-gate           # verdict を grep で見る。通らなければ計画へ差し戻す
    type: command
    run: "grep -q '^verdict: approve' .doctrine-out/plan-review.md || { cat .doctrine-out/plan-review.md; exit 1; }"
    onFailure: { goto: plan, maxAttempts: 3, feed: "{{ steps.plan-gate.last_stdout }}" }
  - id: implement
    type: agent
    session: implementer
  - id: verify              # 型検査・テスト。落ちたら実装へ戻る
    type: command
    run: "true"             # ← 自分のプロジェクトのテストコマンドに書き換える
    onFailure: { goto: implement, maxAttempts: 3, feed: "{{ steps.verify.last_stderr }}" }
  - id: agent-review        # コードレビュー。1行目に verdict: approve / reject / escalate
    type: agent
    session: code-reviewer
  - id: review-gate         # 通らなければ実装へ差し戻す
    type: command
    run: "grep -qE '^verdict: (approve|escalate)' .doctrine-out/review.md || { cat .doctrine-out/review.md; exit 1; }"
    onFailure: { goto: implement, maxAttempts: 3, feed: "{{ steps.review-gate.last_stdout }}" }
  - id: guide               # Review Guide。prompt は書けない
    type: guide
    session: guide
  - id: review              # 人のレビュー。却下されたら実装へ戻る
    type: approval
    title: "変更を確認してください"
    onReject: { goto: implement, maxAttempts: 5, feed: "{{ steps.review.last_stdout }}" }
    review:
      files: [.doctrine-out/review.md, .doctrine-out/implement-notes.md, .doctrine-out/plan.md]
```

雛形のままでも検証は通るが、プロジェクトに合わせて書き換える場所が2つある。

- **`verify` の `run`** — 雛形は何も検証しない `"true"`。型検査やテストのコマンドに書き換える
- **`implement` の `allowedTools`** — `acceptEdits` では Bash がすべて拒否されるので、
  実装中に流させたいコマンド（テストや lint）をここへ足す

エージェントによるレビューの差し戻しは、専用の分岐ではなく `command` ステップの `grep` で表す。
審査役が書いたファイルの1行目の `verdict:` をゲートが見て、通らなければファイルの中身を
標準出力に出して非0で終わり、`onFailure` が前の工程へ戻す（`feed` にはその中身が渡る）。
`verdict: escalate` は実装者には直せない指摘で、`review-gate` を通して人のレビューへ進める。

`agent-review` が読む `git diff <baseBranch>...HEAD` の `<baseBranch>` は、雛形を作った時点の
`project.yaml` の `baseBranch` が文字列で埋め込まれる（テンプレート変数に `baseBranch` が無いため）。
後から `baseBranch` を変えたら、`default.yaml` の `agent-review` のプロンプトも直す。
PR の作成（`open-pr`）は雛形に入っていない。

### ステップは4種類だけ

- **`command`** — worktree内でシェルコマンドを実行する。非0終了でステップ失敗。
- **`agent`** — Claude Code を headless 実行する。会話を role 単位（`session: <role>`）で
  記録し再開可能。`allowedTools:` に文字列のリストを書くと、そのツールを個別に許可できる
  （`- "Bash(git diff:*)"` のように1要素1パターンで書く）。`permissionMode: acceptEdits`
  のままでは Bash はすべて拒否されるので、使わせたいコマンドはここに書く。
  doctrine はすべての `agent` ステップに、組み込みのシステムプロンプト（Bash を1回1コマンドに
  保ち、`git -C` を使わない指示。`;` `&&` `|` で繋いだ形や `git -C` 始まりは先頭一致の許可に
  合わず拒否されるため）を `--append-system-prompt` で常に付ける。
  ワークフロー側から書き換えたり足したりはできない。
- **`approval`** — ワークフローを `suspended` にし、人の承認・却下・追加コメントを待つ。
- **`guide`** — Review Guide を作る。置くだけでガイドが worktree に置かれる。
  プロンプトは doctrine が持つので `prompt` は書けない。`session` は必須で、ガイドを別の役割に
  書かせるか（`session: guide`）、実装の会話を継がせるか（`session: implementer`）を毎回決める。
  `model` / `permissionMode` / `allowedTools` は `agent` と同じ書き方で任意。エージェントが
  diff を読むには Bash が要るので、`allowedTools: ["Bash(git diff:*)"]` などを書く。
  出力は `.doctrine-out/guide.json` に `{ tree, createdAt, guide }` の封筒で置かれる
  （`tree` は説明している時点のツリー。`tree` と `createdAt` は doctrine が書く）。
  形・id の整合・指す hunk とパスの実在のどれかに落ちるとステップは失敗し、`guide.json` は
  書かれない。`onFailure` を書かなければ「自分に戻る・3回・失敗理由を feed」が既定で効き、
  同じ会話に理由が戻る。

失敗時の分岐は `onFailure`（`command` / `agent` / `guide`）と `onReject`（`approval`）のみで、
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

### `approval` ステップに読ませるファイル（`review.files`）

`approval` ステップは差分（diff）を見て判断されるのが基本だが、計画の承認のように
そもそも diff が無い（`.doctrine-out/plan.md` を読んで判断する）ステップもある。
何を見ればよいかはワークフローの作者しか知らないので、`review.files` に列挙する。

```yaml
  - id: plan-approval
    type: approval
    title: "計画を確認してください"
    onReject: { goto: plan, maxAttempts: 3 }
    review:
      files:
        - .doctrine-out/plan.md
```

パスは worktree からの相対パスのみ。絶対パス（`/` 始まり）・`..` を含むパス・
`~` 始まりのパス・空文字は、ワークフローの読み込み時（スキーマ検証）で日本語の
エラーメッセージとともに落ちる。`review.files` を書くなら1件以上必要で、
空配列（`review: { files: [] }`）は書けない。

doctrine は宣言されたファイルの中身を理解しない。読んで、worktree の中にあることを
確かめて、そのまま渡すだけである。実行時にも `realpath` で worktree 配下かを
再確認しており（worktree 内のシンボリックリンクが外を指すケースに備えるため）、
配下を指していなければ中身を読まずに `outside_worktree` として返す。ファイルごとに
起こりうる結果は次のとおり:

- 無ければ `missing`
- 64KB（`MAX_REVIEW_FILE_BYTES`）を超えていれば `too_large`（中身は返さず大きさだけ返す）
- worktree の外を指していれば `outside_worktree`
- UTF-8 のテキストとして読めなければ `binary`
- ここまでを通れば `ok`（中身と大きさを返す）

### 変数は5系統だけ

- `{{ task.id }}` `{{ task.title }}` `{{ task.prompt }}` `{{ task.branch }}`
- `{{ issue.url }}` `{{ issue.parent_url }}` `{{ issue.closes }}`
  — Intake から投入されたタスクの sub-issue の URL、親 Issue の URL、`Closes <sub-issue の URL>`。
  Intake 由来でないタスクではどれも空文字。
- `{{ worktree.path }}`
- `{{ project.path }}`
- `{{ steps.<id>.last_stdout }}` `{{ steps.<id>.last_stderr }}` `{{ steps.<id>.exitCode }}`
  — `agent` ステップの `last_stdout` は最終応答テキスト、`approval` ステップの
  `last_stdout` は却下コメントそのもの。

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
dctl gc <task-id>                   # そのタスクのworktreeを削除する
dctl gc <task-id> --force           # 削除が拒否される場合（未コミットの変更がある）
dctl gc --path <path>               # dctl worktrees が出した孤児を消す
```

**`--force` を付けると、worktree内の未コミットの作業は失われる。** 確認してから使うこと。
終わっていないタスク・Intake の worktree は `--force` を付けても消せない。消すのは worktree だけで、ブランチは残る。

worktree を消すと、そのタスクのレビュー参照（`refs/doctrine/reviews/<task-id>/`）も
一緒に消える。この参照は「レビュー時点の worktree の中身」を `git gc` から守るために
doctrine が張っているもので、worktree が無くなれば使う相手もいない。

なお `dctl worktrees` が一覧するのは「対応するタスクが見つからない孤立
worktree」だけであり、`failed` タスクの（対応するタスクが存在する）worktreeは
ここには出てこない。上記のとおり `dctl ls --state failed` → `dctl get` の経路で探す。

## 5. 権限で拒否された操作を読む

Claude Code は `--permission-prompts none` で headless 実行するため、
権限で操作を拒否されても**プロセスとしては正常終了する**（終了コード0、
`is_error: false`）。拒否があっても実行の成否は変わらないので、
ステップ実行の状態は `success` のままで、ワークフローも止まらない。

何が拒否されたかは、その行の `permission_denials` に入る。ツール名と入力
（Bash ならコマンド）が読める。

```bash
dctl get <task-id> | jq '.stepRuns[] | select(.permission_denials) | .permission_denials.denials[] | {tool_name, input}'
# => {"tool_name":"Bash","input":{"command":"git push origin main"}}
```

残すのは1回の実行につき先頭20件で、実際の件数は `permission_denials.total` に入る。
入力のトップレベルの文字列は各2000字までで切る。拒否が無かった実行では `null`。

同じ `dctl get` で、非0終了が**失敗**だったのか**差し戻し**だったのかも読める。
`onFailure` / `onReject` の `goto` が発火した実行は `status` が `bounced` になり、
戻り先が `goto_step_id` に入る（`status` が `failed` の行に戻り先は無い）。

```bash
dctl get <task-id> | jq '.stepRuns[] | {step_id, attempt, status, goto_step_id}'
# => {"step_id":"plan-gate","attempt":1,"status":"bounced","goto_step_id":"plan"}
#    plan-gate が通らず plan へ差し戻した。タスクは失敗していない
```

### ステップ実行の状態

`dctl get <task-id>` の `.stepRuns[].status` が取る値。

- `running` — 実行中
- `awaiting` — `approval` ステップが人の承認・却下を待っている（1行＝レビュー1回）
- `success` — 終わった。権限で拒否された操作があっても成功は成功で、
  拒否の中身は同じ行の `permission_denials` に入る（5章）
- `bounced` — 非0で終わった（または却下された）が、`onFailure` / `onReject` の `goto` で
  前のステップへ戻った。タスクは失敗していない。戻り先は同じ行の `goto_step_id`、
  差し戻しが何回目かは同じ行の `attempt`
- `failed` — 分岐先が無い、または `maxAttempts` を使い切って、そこでタスクが止まった
- `interrupted` — デーモンのクラッシュで中断され、復帰時に閉じられた
- `rate_limited` — Claude の利用上限で打ち切られた。枠が明けたら同じ会話で再開されるので失敗ではない

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

## 7. 大きな Issue を PFD で分解してから流す

1 つのタスクにするには大きい GitHub Issue は、PFD（成果物とプロセスの図）に分解し、
入力が揃ったプロセスから順に doctrine のタスクにする。設計は
[`docs/superpowers/specs/2026-09-20-pfd-decomposition-design.md`](docs/superpowers/specs/2026-09-20-pfd-decomposition-design.md) を参照。

この仕組みは doctrine の外にある。`dctld` は PFD を知らず、`pfd` コマンドが `dctl ls` と
`dctl add` を呼ぶだけである。`gh` CLI が要る。

```bash
mise run pfd:install                                                  # ~/.deno/bin に pfd を置く
ln -s "$PWD/pfd/skill/pfd-decompose" ~/.claude/skills/pfd-decompose   # スキルを Claude Code に見せる
```

流れ:

```bash
# 1. 分解する — 対象リポジトリで Claude Code を開き、「Issue 123 を PFD で分解して」と頼む。
#    スキルが pfd.yaml を書き、検証を通し、図をブラウザに開く

# 2. 承認する — 図と内容を確かめ、端末から自分で実行する
pfd approve /path/to/your/repo 123

# 3. 投入する — 入力が揃ったプロセスだけが doctrine のタスクになる
pfd dispatch /path/to/your/repo 123

# 4. 進み具合を見る
pfd status /path/to/your/repo 123

# 5. PR をマージしたら、もう一度投入する — 下流のプロセスがタスクになる
pfd dispatch /path/to/your/repo 123
```

- **成果物は baseBranch へのマージで下流に渡る。** 下流のプロセスは、上流のタスクのブランチから
  作られた PR がマージされるまで始まらない。doctrine は PR を作ることを保証しないので、ワークフローの
  最後で PR を作るか、タスクが `completed` になった後に残ったブランチから自分で作ること。
  `pfd status` は、`completed` なのに PR が無いプロセスを「PR がありません」と示す
- **`pfd dispatch` は何度叩いてもよい。** 同じプロセスを 2 回タスクにしない。タスクのタイトルの先頭の
  `[pfd:123/2]` がその目印なので、このタイトルを書き換えないこと
- **人の判断が要るプロセス**（`actor: human`）はタスクにならない。`pfd status` に「あなたの番」と出たら、
  決めた内容を渡して完了にする（端末から自分で実行する）: `pfd done /path/to/your/repo 123 3 --note "..."`。
  その内容は、下流のタスクの prompt にそのまま載る
- **承認の後に `pfd.yaml` を書き換えると、`pfd dispatch` は失敗する。** 内容を確かめて承認し直す
- PFD の正本は `~/.local/state/doctrine/pfd/` 配下にあり、リポジトリにはコミットされない。
  `pfd path /path/to/your/repo 123` で場所が分かる
- **タスクが `failed` / `canceled` で止まったプロセス**は、`pfd dispatch` が投入し直さない。`pfd.yaml` でそのプロセスの id を変え（例: `2` → `2b`）、承認し直してから投入する

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
