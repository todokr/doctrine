# doctrine レビュー1回を1件の記録として残す設計

- 日付: 2026-09-18
- 状態: 承認済み、実装計画の作成待ち
- issue: [#43](https://github.com/todokr/doctrine/issues/43)
- 前提: [overview](../../overview.md)、[コア設計spec](2026-09-12-agent-orchestrator-core-design.md)、[レビュー画面spec](2026-09-13-review-app-design.md)

## 1. 位置づけ

レビュー画面spec 9章「DB」が決めた形を実装する。あちらは画面と RPC を含む全体を
描いた spec であり、本specはそのうち**記録そのもの**だけを切り出して、実装に必要な
粒度まで落とす。読み出す RPC（`task.diff` は [#44](https://github.com/todokr/doctrine/issues/44)、
`task.context` と `review.files` は [#45](https://github.com/todokr/doctrine/issues/45)）は
本specの範囲外で、ここでは**記録を作るところまで**を扱う。

今の approval ステップの記録は、レビュー画面に必要な経緯を支えられない。

- **待ち始めた時刻が残らない。** `suspended` に入るときは状態を書くだけで、
  `step_runs` の行は承認・却下が決まった瞬間に `started_at = ended_at = now` で作られる。
  待ち時間は常に 0 として記録される
- **差し戻しコメントの履歴が残らない。** 却下コメントは `step_outputs` に入るが、
  主キーが `(task_id, step_id)` なので2回目の却下が1回目を上書きする
- **「前回レビュー以降」の基準点が無い。** 差し戻すたびに全体を読み直すことになり、
  overview 2.1 の「理解のコスト」をそのまま払わせる

先にやる理由は issue が書いたとおりで、**記録は後から取り戻せない**から。Review Guide
（M2）の効果を自分の読み比べで確かめるには、ガイドが無い状態の待ち時間と差し戻し回数が
先に残っている必要がある。

## 2. 決定の要約

貫く考えは1つ、**「approval ステップの step_run 1件 = レビュー1回」**。待ち始めた時刻・
決まった時刻・そのときのコメント・そのときのツリーは、別々の保存の仕組みではなく
同じ1行の列である。

| 項目 | 決定 | 章 |
| --- | --- | --- |
| 承認待ちの表現 | `step_runs.status` に `awaiting` を足し、`suspended` に入る時点で行を立てる | 3 |
| 中断された実行 | 同じマイグレーションで `interrupted` も足し、復帰処理はこれで閉じる | 3, 6 |
| コメントの履歴 | `step_outputs` の主キーを `step_run_id` に変え、`task_id` / `step_id` 列は落とす | 4 |
| `{{ steps.<id>.stdout }}` | 今までどおりそのステップの**最新の実行**を指す（`step_id` ごとに最大 `step_run_id`） | 4 |
| 基準点 | `step_runs.review_tree` に `suspended` 突入時の worktree 全体のツリーを記録し、`refs/doctrine/reviews/<task_id>/<step_run_id>` で参照を保つ | 5 |
| ツリー記録の失敗 | `suspended` は止めない。`review_tree` を null にして警告を出す | 5 |
| `attempt` の確定 | 決定時から**待ち始めた時点**へ移す（他のステップと同じ「開始時に進める」形） | 3 |
| マイグレーション | 1本（`0003`）。`step_runs` と `step_outputs` の再構築、既存 `suspended` タスクへの `awaiting` 行の生成 | 6 |
| イベント | 増やさない。`stepRun.started` / `stepRun.finished` の発火箇所は変えない | 8 |

## 3. 承認待ちを状態として持つ

### 3.1 `awaiting` を足す

`step_runs.status` に `awaiting` を足す。意味は「approval ステップが `suspended` に
入ってから、承認・却下が決まるまで」。

```
runTask が approval に到達
  ├ ツリーを作る（5章。失敗したら null + 警告。suspend は止めない）
  └ 1トランザクション:
       tasks.state = suspended, current_step_id = <step>, child_* = null
       tasks.attempt_counts を進める
       step_runs に1行 (status=awaiting, started_at=now, ended_at=null,
                        review_tree=<sha|null>, log_path="")
  └ 返った step_run_id で refs/doctrine/reviews/<task_id>/<step_run_id> を張る

applyApproval（承認 / 却下）
  └ 1トランザクション:
       その awaiting 行を stepRunUpdate で閉じる
         承認 → success / exit_code 0、却下 → failed / exit_code 1、ended_at = now
       step_outputs にその step_run_id で却下コメントを書く
       tasks の遷移（queued / completed / failed）
```

`log_path` が空文字なのは今の approval の行と同じ（人の判断にログファイルは無い）。

### 3.2 採らなかった案 — 復帰側で approval を除外する

`status` は `running` のまま立てて、復帰処理（`recoverOnStartup`）が「タスクが
`suspended` なら閉じない」と除外する案。テーブル再構築が要らないのが利点だが、

- `step_runs` を単体で見たとき、承認待ちと実行中が見分けられない。`tasks.state` と
  突き合わせて初めて分かる状態は、記録として弱い（レビュー画面は step_runs を読む）
- 除外条件を書き忘れた経路が将来できると、**黙って**承認待ちの行が failed で閉じられる。
  値として持てば、条件の書き忘れではなく型と CHECK 制約の問題になる

記録の正直さを買うために、再構築のコストを一度だけ払う。

### 3.3 `interrupted` を相乗りさせる

README「既知の制約」の1項目。デーモンのクラッシュで `running` のまま残った行を、
復帰処理は `failed` として閉じている（本来欲しい値は「中断された」）。CHECK 制約の
変更＝テーブル再構築が要るために先送りされていたが、3.1 でその再構築はどのみち一度
行われる。同じマイグレーションに乗せ、2度目の再構築を将来に残さない。

```
今:   status IN ('running','success','failed','degraded')
後:   status IN ('running','awaiting','success','failed','degraded','interrupted')
```

`closeDanglingStepRun` が書く値を `failed` → `interrupted` に変え、README の該当項目を
消す。**探索条件（`status === "running"` の行を探す）は変えない** — `awaiting` は
`running` ではないので、承認待ちの行は自然に対象外になる。これが 3.2 ではなく 3.1 を
選んだことの実利で、復帰処理に approval を知らせる必要がない。

### 3.4 `attempt` の確定を待ち始めた時点へ移す

今は approval の `attempt` と `attempt_counts` を `applyApproval`（決定時）で進めて
いる。行を早く立てる以上、`attempt` もその時点で決める必要がある。

これは他のステップと同じ形になる。`runTask` は非 approval のステップ開始コミットで
`withAttempt` を書いており、approval も「開始 = `suspended` に入った時点」で進める。

結果、`applyApproval` 側は `attemptCount(task, stepId)` をそのまま `decide` に渡すだけに
なる（今の `attemptCount(task, stepId) + 1` と `withAttempt` が消える）。`maxAttempts` と
比較される数は変わらないので、**差し戻しの上限の効き方は変わらない**。

### 3.5 `awaiting` 行が無いときは例外にする

`applyApproval` は「`suspended` なら対応する `awaiting` 行がちょうど1件ある」を前提に
できる。6章のマイグレーションが移行時点の `suspended` タスクにも行を立てるので、この
不変条件は移行直後から成り立つ。行が見つからなければ例外を投げる。

その場で行を捏造しない理由は、`started_at = now` で作れば「待ち時間 0」という嘘を
記録に残すことになるため。記録が壊れているなら、壊れていると言う方がよい。

## 4. コメントの履歴

`step_outputs` の主キーを `step_run_id` に変え、`task_id` / `step_id` 列は落とす。

```sql
CREATE TABLE step_outputs (
  step_run_id INTEGER PRIMARY KEY REFERENCES step_runs(id),
  stdout      TEXT NOT NULL,
  stderr      TEXT NOT NULL,
  exit_code   INTEGER
);
```

`task_id` / `step_id` は `step_runs` に JOIN すれば引ける。同じ事実を2箇所に持たない
（持てば、片方だけ書き換わった行が作れてしまう）。

- 出力は常に「同じステップ境界の step_run」に属する。`commitStepBoundary` は
  トランザクション内で立てた（あるいは更新した）`step_run_id` をそのまま使うので、
  `StepBoundary.outputs` から `step_id` を落とす。`step_run` も `stepRunUpdate` も無いのに
  `outputs` だけ渡すのは呼び出し側のバグであり、例外を投げる
- 末尾 8KB（`OUTPUT_TAIL_BYTES`）の制限は変えない
- `getStepOutputs` は `step_id` ごとに最大 `step_run_id` の行を返す。テンプレートから
  見た `{{ steps.<id>.stdout }}` の意味は変わらない

これで「同じタスクを2回差し戻した」とき、`step_outputs` に2行・`step_runs` に
`awaiting` → `failed` が2行残り、どちらの回のコメントも待ち時間も読める。

## 5. 基準点 — レビュー時点のツリー

### 5.1 記録するもの

`step_runs` に `review_tree TEXT NULL` を足す。`suspended` に入る時点の worktree
**全体**のツリーの SHA で、**未コミットの変更と未追跡のファイルを含む**。承認するのは
worktree に実際にあるものであって、コミットされたものではない。

新しいモジュール `src/core/reviewTree.ts` に置く。#44 の `task.diff` が同じ方法で
「今のツリー」を作るので、最初から共有できる形にする。

- `captureTree(worktreePath)` — 一時インデックスでツリーを作る
  （`GIT_INDEX_FILE=<tmp> git add -A` → `git write-tree`）。worktree の
  `.git/index` には触らない。`.doctrine-out/` は `.git/info/exclude` によって
  最初から入らない
- `retainTree(...)` — そのツリーを指す parent なしの commit を作り
  （`git commit-tree`）、`refs/doctrine/reviews/<task_id>/<step_run_id>` に置く
  （`git update-ref`）。**`git gc` に消させないため**の参照であり、これが無いと
  到達不能なオブジェクトとして刈られる
- `releaseTrees(repoPath, taskId)` — そのタスクの参照をまとめて消す

commit を1つ挟むのは、ref が commit を指していれば `git diff <ref>` や `git log` が
そのまま使え、#44 が特別扱いを持たずに済むため。parent は持たせない（比較に要らず、
持たせると worktree の履歴に依存した意味が生まれる）。

### 5.2 書く順序と、その隙間

ref 名に `step_run_id` が要るので、順序は「ツリーを作る → コミット → ref を張る」に
なる。コミットと ref の間でデーモンが落ちると、`review_tree` は SHA を指しているのに
オブジェクトが `git gc` で消え得る、という穴が残る。

これを塞ぐには ref 名から `step_run_id` を外す（ツリーの SHA を名前にする）ことになるが、
レビュー画面spec が決めた「レビュー1件に参照1つ」という対応が崩れ、参照の掃除も
タスク単位で切れなくなる。**穴は許容する** — そのとき欠けるのは「前回レビュー以降」の
基準点だけで、レビューそのものは回る（5.3 と同じ扱い）。

### 5.3 ツリー記録が失敗したとき

ディスク満杯・`index.lock` の競合・巨大ファイルなどで git 操作は失敗し得る。その場合
**`suspended` への遷移は止めず**、`review_tree` を null にして警告を出す
（`ctx.warnings` と同じ出口を使う）。

ツリーは判断材料であって承認そのものではない。人が待っているレビューを、基準点が
取れなかったという理由で失わせない。失った場合も全体の diff は出せる（#44 は
`since: "last_review"` が引けないだけ）。`review_tree` が null で残るので、後から
「このレビューは基準点を持たない」と分かる。

### 5.4 参照の掃除

worktree を消すときに、そのタスクの `refs/doctrine/reviews/<task_id>/` も消す。
呼ぶのは worktree を消す2箇所、`worktree.remove` ハンドラと `cleanupAfterRun`。

参照の削除に失敗しても worktree の削除は成功しているので、警告に倒して要求は失敗
させない（`cleanupAfterRun` が既に持っている方針と同じ）。

## 6. マイグレーション

`0003` 1本にまとめる。SQLite で CHECK 制約を変えるにはテーブル再構築が要り、
`step_outputs` は `step_runs` を参照するので、順序が要る。

1. **`step_runs` の再構築** — 新しい CHECK（`awaiting` / `interrupted` を含む）と
   `review_tree` を持つ表を作り、`id` を含む全列をコピーして差し替え、
   `idx_step_runs_task` を張り直す
2. **`step_outputs` の再構築** — `step_run_id` を主キーにした表を作り、既存行を
   同じ `(task_id, step_id)` の**最新の step_run**（最大 `id`）に割り当てて移す。
   対応する step_run が無い行は捨てる（どの実行の出力か決められないため）
3. **移行時点で `suspended` のタスクに `awaiting` 行を立てる** —
   `started_at = tasks.updated_at`（`suspended` へ遷移した時刻そのもの）、
   `ended_at = null`、`review_tree = null`（過去には遡れない）、`log_path = ""`。
   `attempt` は同じ `(task_id, step_id)` の既存 step_run 数 + 1。
   `suspended` は approval でしか起こらないので、`current_step_id` がそのまま
   approval ステップの id である

   **あわせて、そのタスクの `attempt_counts` もこの回のぶん進める。** 3.4 で
   `attempt` の確定を待ち始めた時点へ移したので、移行前に `suspended` へ入った
   タスク（＝旧コードで進めていない）をそのままにすると、移行後の
   `applyApproval` が1つ小さい数を `decide` に渡し、差し戻しの上限が1回ぶん
   甘くなる。`attempt_counts` は JSON 文字列でステップ id がそのままキーになる。
   この手順だけは SQL 1文ではなく TypeScript で行を読んで書き戻す（JSON を
   SQLite の関数で触るより、読んで `JSON.parse` する方が意図が見える）。
   ただし `withAttempt` は呼ばず、計算はマイグレーション内に書く —
   マイグレーションは「そのときの形」に対する操作であり、最新の形を前提とする
   `src/db/` のヘルパに依存させない（`migrations.ts` 冒頭の規則）

`PRAGMA foreign_keys` はマイグレーションのトランザクション内では切り替えられない
（`openDbOn` が `ON` にしている）。上の順序なら切る必要がない — 1 の時点で
`step_runs` を参照する表はまだ無く、2 で入れる行は `EXISTS` で親の存在を絞ってある。
最後に `PRAGMA foreign_key_check` で整合を確かめる。

`src/db/schema.ts` の `StepRunStatus` に `awaiting` / `interrupted` を足し、
`StepRunsTable` に `review_tree`、`StepOutputsTable` を新しい形に変える。実DBの列集合との
突き合わせは `test/db/migrate.test.ts` が持つ。

## 7. テスト

完了条件をそのままテストにする。

- **同じタスクを2回差し戻す** → `step_outputs` に2行（両方のコメント）、`step_runs` に
  `awaiting` → `failed` が2行、それぞれ別の `started_at` / `ended_at` を持つ。
  ここから各回の待ち時間が引ける
- **差し戻し後の再レビューで、前回レビュー時点のツリーを引ける** —
  `git gc --prune=now` の後でも `refs/doctrine/reviews/<task_id>/<step_run_id>` から
  取り出せる。未追跡ファイルがツリーに入っていること、`.doctrine-out/` が入って
  いないこと
- `{{ steps.<id>.stdout }}` が最新の却下コメントを指す（履歴が増えても意味が変わらない）
- 復帰処理が `awaiting` 行を閉じない。`running` 行は `interrupted` で閉じる
- ツリー記録が失敗しても `suspended` に入り、`review_tree` が null で警告が出る
- worktree を消すと、そのタスクの参照が消える
- マイグレーション: 列集合、既存 `step_outputs` 行の割り当て（最新の step_run に付く・
  親の無い行は捨てる）、移行時点で `suspended` のタスクへの `awaiting` 行の生成と
  `attempt_counts` の繰り上げ（移行前に待ち始めたタスクを承認・却下しても、
  差し戻しの上限が1回ぶん甘くならない）

## 8. 範囲外

- **読み出しの RPC** — `task.diff`（#44）、`task.context` と `review.files`（#45）。
  本specは記録を作るところまで
- **イベントを増やさない** — `stepRun.started` / `stepRun.finished` の発火箇所は
  変えない。承認待ちの行が立ったことを画面へどう届けるかは、画面が何を要るかを
  決める #46 / #47 の領分であり、消費者がいないイベントを先に足さない
- **`attempt_counts` の表現** — JSON 文字列のまま。今回触るのは書く時点だけ
