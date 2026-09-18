# doctrine task.diff（worktree の今の状態の diff）設計

- 日付: 2026-09-18
- 状態: 承認済み、実装計画の作成待ち
- issue: [#44](https://github.com/todokr/doctrine/issues/44)
- 依存: [#43](https://github.com/todokr/doctrine/issues/43)（レビュー1回=1件の記録。実装中）
- 前提: [overview](../../overview.md)、[② レビューアプリ spec](2026-09-13-review-app-design.md) 9章、
  [ステップ間の成果物受け渡し spec](2026-09-13-step-artifacts-design.md) 4章

## 1. 位置づけ

レビュー画面に本物の diff を出す。②spec 9章が API の形だけを決めて実装を先送りにした
`task.diff` を、ここで実装できる粒度まで確定させる。

**守りたいのは「承認したものと worktree にあるものが一致すること」**である。承認とは
「この worktree の今の状態でよい」という判断であって、「コミット済みの分でよい」ではない。
コミットが権限で拒否された degraded な実行では、エージェントの成果はコミットされずに
worktree に残る。コミット済みの分だけを見せると、人は空の diff を見て「何もしていない」と
判断し、実際には未コミットで存在する変更を承認してしまう。**未コミットと未追跡を必ず含める**
のはこのためであり、実装上の都合ではない。

## 2. 決定の要約

| 項目 | 決定 | 章 |
| --- | --- | --- |
| 計算する場所 | デーモン（worktree の場所とレビューの記録を知るのはデーモンだけ） | 3 |
| モジュール | `src/core/diff.ts` を新設。git だけを触り DB を知らない | 3 |
| 「今の状態」の作り方 | 本物の index をコピーした一時 index に `add -A` → `write-tree` | 4 |
| 比較の基準点 | 既定は base ブランチとの merge-base、`since: "last_review"` は直近の差し戻しの `review_tree` | 5 |
| ファイル一覧 | `--name-status` と `--numstat`（どちらも `-z -M`）を突き合わせる | 6 |
| `.doctrine-out/` | `info/exclude` に加えて pathspec でも外す（二重） | 6 |
| 打ち切り | `patch` が 2 MiB を超えたら改行境界で切って `truncated: true`。`files` は常に全件 | 7 |
| CLI | `dctl diff <task-id> [--since last_review]` を足す | 9 |

## 3. 置き場所とモジュール境界

`src/core/diff.ts` を新設する。`worktree.ts` に足さないのは、あちらが worktree の
ライフサイクル（作る・消す・孤児を探す）を持つのに対し、diff は「既にある worktree を
読むだけ」の別の責務だからである。既に肥大の兆しがある `handlers.ts` に git のコマンド列を
直接書くのも避ける。

```
daemon/handlers.ts   task.diff — DB から worktree_path / base_branch / review_tree を解決する薄い口
  └ core/diff.ts     git だけを触る層（DB を知らない。テストは使い捨ての git リポジトリだけで書ける）
       ├ writeWorktreeTree(worktreePath): Promise<string>
       └ computeDiff({ worktreePath, fromRef, toRef, patchLimitBytes }): Promise<DiffResult>
```

`diff.ts` が DB を知らないことには実利がある。#43 が `review_tree` をどう保存するかが
変わっても、`computeDiff` は「2つの ref を比べる」ままで影響を受けない。

### 返す形（②spec 9章のとおり）

```ts
export type DiffFile = {
  path: string;
  old_path?: string;              // R のときだけ
  status: "A" | "M" | "D" | "R";
  additions: number;              // バイナリなら 0
  deletions: number;              // バイナリなら 0
  binary: boolean;
};

export type TaskDiff = {
  base: { branch: string; merge_base: string };
  since_step_run_id: number | null;
  files: DiffFile[];
  patch: string;
  truncated: boolean;
};
```

`base` は `since` の有無にかかわらず常に merge-base を返す。画面が「ブランチ全体のうち
どの範囲を今見ているか」を示せるようにするため。

## 4. 「今の状態」をツリーにする

未追跡のファイルは commit にも index にも無いので、`git diff` の相手にできる形が無い。
worktree 全体を一度ツリーにしてから比べる（②spec 9章）。

```
cp "$(git -C <worktree> rev-parse --git-path index)" $TMP   # あれば
GIT_INDEX_FILE=$TMP git -C <worktree> add -A
GIT_INDEX_FILE=$TMP git -C <worktree> write-tree
```

- **本物の `.git/index` には書かない。** エージェントが同時に走っている worktree に対して
  レビュー画面が diff を要求するのは普通に起きる。本物の index に `add -A` すると、
  エージェントが次に打つ `git commit` の中身を doctrine が黙って変えてしまう
- **一時 index は本物のコピーから始める。** 空から始めると毎回すべてのファイルを
  再ハッシュすることになり、大きなリポジトリではレビューのたびに数秒かかる。コピーすれば
  git の stat キャッシュが効く（`git stash create` が使うのと同じ手）。リンクされた
  worktree では index は共通ディレクトリではなく worktree 側にあるので、パスは
  `git rev-parse --git-path index` で引く
- 一時 index は `Deno.makeTempFile()` で作り、`finally` で必ず消す
- `git add -A` は `.gitignore` と `.git/info/exclude` を尊重する。`createWorktree` が
  呼ぶ `ensureDoctrineOutExcluded` で `.doctrine-out/` は exclude 済みなので、
  中間成果物はツリーに入らない（成果物 spec 4章）
- `write-tree` は blob と tree をオブジェクトDBに書く。どの ref からも参照されない
  loose object であり、`git gc` の既定 (`gc.pruneExpire`) では**作成から2週間**は
  刈られない。呼び出しごとに変更・未追跡ファイルの分だけ書くので、1回あたりは
  小さく、レビューをたまに叩く程度では実害は出ない。ただしレビューアプリが
  `task.diff` をポーリングするようになると、この「2週間分溜まる」が効いてくる
  可能性がある。`refs` で保護するのは #43 の `review_tree` だけでよい

## 5. 比較の基準点

| `since` | from | `since_step_run_id` |
| --- | --- | --- |
| 指定なし | `git merge-base <base_branch> HEAD` | `null` |
| `"last_review"` | 直近の**差し戻された** approval の `step_runs.review_tree` | その `step_run_id` |
| `"last_review"` だが差し戻しの記録が無い | merge-base（全体へフォールバック） | `null` |

- merge-base は**毎回取り直す**。worktree を作った後に base ブランチが進んでいても、
  正しい共通祖先になる
- 承認された approval は基準点にしない。「前回レビュー以降」が意味を持つのは差し戻して
  やり直させたときだけであり、承認済みのレビューを基準にすると次のステップの成果が
  レビュー対象から消える
- `since: "last_review"` を未知の値（`"yesterday"` など）で呼ばれたら、黙って全体に
  倒さずエラーにする。画面が範囲を取り違えたまま承認に進むのが一番まずい

**#43 との境界**: `diff.ts` は ref 文字列を2つ受け取るだけで、`review_tree` の取り出しは
`handlers.ts` が行う。#43 がマージされるまでこの経路は書けないので、実装は #43 の後に着手する。

**現状（#43 が入るまで）**: 上の表は実装の終着点であり、今はまだそこにいない。
`since: "last_review"` は受け付けず、明示的にエラーで拒否する。黙って merge-base の
全体 diff にフォールバックすると、そのレスポンスは「差し戻しの記録がまだ無いので
全体を返した」という正当なケースと区別が付かない。前者は「実装が無いので拒否された」、
後者は「前回レビュー以降＝今回が初めてのレビュー」であり、意味がまったく違うのに
レスポンスの形は同じになってしまう。区別が付かない以上、レビュー画面の実装者に
どちらなのか判断させるのは無理なので、実装が入るまでは拒否する。

## 6. ファイル一覧と patch

3回 git を叩く。いずれも `<from> <to> -- . ':(exclude).doctrine-out/'` を付ける。

| コマンド | 取るもの |
| --- | --- |
| `git diff --name-status -z -M <from> <to> -- …` | `status` と `old_path` |
| `git diff --numstat -z -M <from> <to> -- …` | `additions` / `deletions` / `binary` |
| `git diff -M <from> <to> -- …` | `patch` |

`-z` の出力形式は次のとおり（NUL 区切り）。

```
name-status:  M\0b.bin\0R075\0old.txt\0new.txt\0A\0untracked.txt\0
numstat:      -\t-\tb.bin\0  1\t0\t\0old.txt\0new.txt\0  1\t0\tuntracked.txt\0
```

- `name-status` は状態の文字に続けてパスが来る。`R` / `C` だけスコアが付き（`R075`）、
  パスが2つ（旧・新）来る。`C`（コピー）は `-C` を渡さない限り出ないが、来ても `R` として
  扱う（レビューする人にとって「別の場所から来た」以上の区別に意味が無い）
- `numstat` は追加・削除・パスのタブ区切り。**リネームのときだけ3つ目が空になり**、
  その後に NUL 区切りで旧・新が続く。バイナリは追加・削除が `-` で来るので、これが
  `binary` の判定になる（`additions` / `deletions` は 0 にする）
- 2つの出力は**新しいパスをキーに突き合わせる**。出力順は一致するが、順序に頼らない
- リネーム検出は `-M` の既定（類似度 50%）に任せる。閾値を動かす理由が今は無い

`.doctrine-out/` は `info/exclude` により未追跡としてツリーに入らないが、過去に誤って
コミットされたリポジトリでも diff に出さないよう pathspec でも外す。issue の「`.doctrine-out/`
は diff に出さない」を、exclude の設定が正しいことに依存させないための二重化である。

## 7. 打ち切り

**`patch` のバイト数だけで打ち切る。上限は 2 MiB（2 × 1024 × 1024）。**

- ファイル数では打ち切らない。1個の巨大な生成ファイルという一番効く形を守れない。
  守りたいのはデーモンのメモリと画面の描画であり、それを直接測っているのはバイト数である
- **`files` は常に全件返す。** `--numstat` のメタデータは patch に比べて桁違いに軽い。
  打ち切られても画面は「何が変わったか」の一覧を必ず出せて、本文だけが欠けた状態になる
- 切る位置は**上限以内の最後の改行の直後**。行の途中で切ると unified diff のパーサが壊れ、
  画面が「壊れた diff」ではなく「間違った diff」を描きかねない。上限以内に改行が1つも
  無い場合（極端に長い1行）だけ、上限でそのまま切る
- 上限はモジュールの定数 `PATCH_LIMIT_BYTES` とし、`computeDiff` の引数で上書きできる
  ようにする（テストが 2 MiB のデータを作らずに済むため）
- 2 MiB は普通のタスクなら絶対に当たらない大きさ（40バイト/行として約5万行）。
  当たったときは人が worktree を直接見に行けばよい、という割り切りで置く

## 8. エラーと縁

- **`worktree_path` が null**（完了して削除済み、またはまだ実行枠が取れていない）→
  `worktree がありません` で失敗する。空の diff を返すと「変更なし」と区別がつかない
- **`worktree_path` はあるがディスク上に無い** → git のエラーをそのまま上げる。
  doctrine が独自に言い換えても原因の情報が減るだけ
- **base ブランチが worktree から見えない**（リモート追跡が消えた等）→ `merge-base` の
  失敗がそのまま上がる
- **タスクがない** → 既存の各ハンドラと同じく `タスクがありません`
- **エージェントが動いている最中に呼ばれる** → `writeWorktreeTree` の `git add -A` は
  スキャン中にファイルが消えると失敗しうる（`Command failed: git … add -A`）。
  エージェントが同時にファイルを書き換え・削除している間に `task.diff` を呼ぶのが
  この機能の主目的である普通の使い方なので、この失敗は稀な例外ではなく、日常的に
  起こりうるものとして扱う。ある時点 T の worktree を切り出すというセマンティクス
  自体は正しく、他に取りようがない。ここで大事なのは失敗を隠して空の diff を
  返したりせず、素直に落として「今は取れなかった、もう一度呼べばよい」と
  分かる形で伝えることである

## 9. CLI

```
dctl diff <task-id> [--since last_review]
```

`dctl` は「デーモンに繋ぐだけの薄い CLI、デバッグ・テスト用の表面」（README）という
位置づけのままで、`task.diff` を素通しする。レビュー画面（②）はまだ無いので、
これがこの API を実データに当てる唯一の手段になる。`--since` は既存の `splitArgs` が
そのまま値付きフラグとして扱うので、`NUMERIC` / `BOOLEAN` への追加は要らない。

## 10. テスト方針

既存の流儀（`test/helpers/repo.ts` の使い捨てリポジトリ）に従う。`diff.ts` が DB を
知らないので、大半は `test/core/diff.test.ts` に git だけで書ける。

**`test/core/diff.test.ts`**

- **未コミットの変更が出る** — コミット済みファイルを書き換え、`M` と行数が返る
- **未追跡のファイルが出る** — 新規ファイルが `A` で返る（issue の完了条件）
- **本物の index を汚さない** — diff を取った後に `git status --porcelain` が
  取る前と同じであること（4章の「同時に走るエージェントを壊さない」を守る）
- **削除とリネーム** — `D`、および `R` と `old_path`
- **バイナリ** — `binary: true` で `additions` / `deletions` が 0
- **`.doctrine-out/` が出ない** — exclude 済みの worktree で中間成果物を書いても
  `files` に現れない
- **打ち切り** — `patchLimitBytes` を小さくして `truncated: true` になり、
  `patch` が改行で終わること
- **base ブランチが進んでいても merge-base で比べる** — worktree 作成後に base に
  別のコミットを積んでも、そのコミットの変更が diff に混ざらないこと

**`test/daemon/handlers.test.ts`**

- `worktree_path` が null のタスクで失敗すること
- `since: "last_review"` が直近の差し戻しの `step_run_id` を返すこと（#43 依存）
- 差し戻し後、`since` 付きで前回レビュー以降の差分だけが返ること（issue の完了条件）

**`test/daemon/cli.test.ts`**

- `parseArgv(["diff", "<id>", "--since", "last_review"])` が `task.diff` に写ること

## 11. 範囲外

- **レビュー画面での表示**（行コメント、split 表示、前後の行の展開）— ②の第1段階
- **`task.context`** — 同じ②spec 9章だが別の API。経緯と `review.files` を返すもので、
  diff とは独立に作れる
- **`worktree.list` / `worktree.remove` の変更** — ②spec 9章だが #3・#4 の側
- **`refs/doctrine/reviews/` の作成と削除** — #43 の範囲。本specは読むだけ
