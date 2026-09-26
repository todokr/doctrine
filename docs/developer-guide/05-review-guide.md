# 5. diff と Review Guide

approval で止まったタスクを人がレビューするための材料を扱う。材料は 3 つある。

1. **diff** — worktree の「今あるもの全部」と baseBranch の差分。未コミットと未追跡も入る
2. **経緯** — 元の指示、過去の差し戻しコメント、直近の command の結果、`review.files` で宣言したファイル
3. **Review Guide** — guide ステップのエージェントが書いた構造化 JSON。hunk を読む順に並べてグループにし、Why / What / How / Decisions / Risks / Tests / 図を添える

## 5.1 コアとアプリの分担

| 仕事 | 担当 | 実体 |
| --- | --- | --- |
| diff の計算 | コア | `core/src/domain/diff.ts:computeDiff`、`core/src/domain/reviewTree.ts:captureTree` |
| hunk id の計算 | 共有 | `shared/guide/hunkId.ts:listHunks` |
| 移動の検出 | 共有（呼ぶのはアプリだけ） | `shared/diff/moves.ts:detectMoves` |
| ガイドを作るプロンプトとエージェントの起動 | コア | `core/src/domain/guidePrompt.ts`、`core/src/domain/stepRunner.ts:runGuideStep` |
| ガイドの形と id の整合の検証 | 共有（コアとアプリの両方が呼ぶ） | `shared/guide/validate.ts:validateGuide` |
| ガイドが指す箇所が diff に実在するかの検証 | コア（生成時だけ） | `core/src/domain/guideFile.ts:checkGuideLocations` |
| `guide.json` の保存・読み出し・古さの判定 | コア | `guideFile.ts:writeGuideFile` / `readGuideFile`、`task.guide` |
| diff をガイドの順に組み直す | アプリ | `app/src/flow.ts:readingFlow` |
| 図の配置と描画 | アプリ | `app/src/diagram.ts`、`app/src/components/Diagrams.tsx` |
| 行コメントを差し戻しの文にする | アプリ | `app/src/model.ts:composeRejection` |

コアはガイドの**形**を知っていて検証もするが、並べ替え・描画・飛び先の解決はしない。
また、箇所を今の diff と照合するのは生成時の 1 回だけで、後で worktree が変わったかは `stale` フラグで伝えるだけである。

## 5.2 diff の取り方

### `computeDiff`（`domain/diff.ts`）

ref を 2 つ受け取って比べるだけの、DB を知らない層である。git を 3 回並列に呼ぶ。

- `git diff --name-status -z -M -C <from> <to> -- . ':(exclude).doctrine-out/'`
- `git diff --numstat -z -M -C ...`
- `git diff -M -C ...`（patch 本体）

- コピー（C）はリネーム（R）と別の status のまま返す。コピーを「移動」と表示すると元のファイルが消えたように読めるため
- name-status に出たパスが numstat に無ければ例外にする。黙って 0 行で埋めると、パースの取りこぼしが「変更なし」に化けるため
- patch は 2 MiB（`PATCH_LIMIT_BYTES`）で、最後の改行の直後で切る（`truncated: true`）。`files` は常に全件返す
- `mergeBase` は `git merge-base <base> HEAD` を毎回取り直す。worktree を作った後に baseBranch が進んでも正しい共通祖先になる

### 未コミット・未追跡を含むツリー（`reviewTree.ts:captureTree`）

1. 一時ディレクトリに一時インデックスを作る（`GIT_INDEX_FILE=<tmp>/index`）
2. HEAD があれば `read-tree HEAD`（空のインデックスに `add -A` すると、`add -f` で追跡した ignore 対象や sparse-checkout の外のファイルが落ちるため）
3. `add -A` → `write-tree`

worktree の本物の `.git/index` には触らない（エージェントのステージング状態を変えないため）。
環境変数から `GIT_DIR` / `GIT_WORK_TREE` を落として呼ぶ（残っていると別のリポジトリのツリーを記録してしまう）。

### `task.diff`

```
merge_base = mergeBase(worktree, project.base_branch)
toRef      = captureTree(worktree)
fromRef    = since === "last_review" ? 直近に却下したレビューの review_tree ?? merge_base : merge_base
→ { base: { branch, merge_base }, since_step_run_id, files, patch, truncated }
```

- `since` は未指定か `"last_review"` だけを受ける。知らない値はエラー（黙って全体を返すと、画面が範囲を取り違えたまま承認に進むため）
- worktree が無ければエラー（空の diff を返すと「変更なし」と区別できないため）
- `since_step_run_id` が null なら「前回が無いので全体を返した」。画面はこれを見て「前回レビュー以降」と名乗らない

### レビュー時点のツリーを残す

approval に着いたとき（[3.7](03-workflow-engine.md)）、エンジンは `captureTree` の結果を `awaiting` 行の `review_tree` に記録し、
`retainTree` が親を持たないコミット（作者 `doctrine <doctrine@localhost>`）を作って `refs/doctrine/reviews/<taskId>/<stepRunId>` を張る。
これで差し戻しの後にエージェントが作業を続けても、前回レビューした時点のツリーが `git gc` で消えない。

「前回レビュー以降」の基準（`db/stepRuns.ts:lastRejectedReview`）は、`status IN ('bounced', 'failed') AND review_tree IS NOT NULL` の最新の行である。
承認した回は基準にしない（その後のステップの成果がレビュー対象から消えてしまうため）。

参照は worktree を消すときに `releaseTrees` で消す。worktree の削除が拒否されたら参照も残す。

## 5.3 hunk id

ガイドは変更箇所を行番号ではなく hunk id で指す。行番号は diff の並べ替えや後の変更でずれるため。

- `listHunks` が patch を先頭から読み、`^diff --git` で区画を、`^@@ ... @@` で hunk を切る
- id は `"h_" + cyrb53(UTF-8(path + "\0" + 本文))` を 16 進 14 桁にしたもの。本文は先頭が空白・`+`・`-` の行で、**hunk の見出し行（`@@ ... @@ 関数名`）は含めない**
- パスと本文が同じ hunk が複数あれば、2 件目以降に `_2`、`_3` を付ける
- パスは `shared/diff/patchPath.ts:headerPath` で決める（削除なら `---` 側、それ以外は `+++` 側。C クォートを復号し、`a/` `b/` を外す）。`task.diff` の `files[].path` と同じ形になる
- ハッシュに cyrb53 を使うのは、`crypto.subtle` が非同期で画面の純関数から呼べないため

**安定するもの**: 行番号のずれ、見出しの関数名の変化。**変わるもの**: 本文（前後 3 行の文脈を含む）、パス、diff の起点。
`since: last_review` の diff は起点が違うので hunk の切れ方も id も別物になる。そのためアプリは「前回レビュー以降」ではガイドの順に並べない。

アプリ（`app/src/patch.ts:buildDiff`）は自分でも patch を区画と hunk に切り、`listHunks` の id を出現順に割り当てる。件数が合わなければ例外にする。

## 5.4 Review Guide のスキーマ

`shared/guide/schema.ts:guideSchema`。すべて `z.strictObject`。各フィールドの `describe` がそのまま JSON Schema に載り、書き手への指示になる。

| フィールド | 形 |
| --- | --- |
| `version` | `1` |
| `why` | 文字列 |
| `what[]` | `{ name, summary, paths[] }` — 概念単位の変更 |
| `how[]` | `{ body, diagram? }` |
| `readingOrder[]` | `{ title, body, locations[], refs: { decisions[], risks[], tests[], diagrams[] } }` |
| `decisions[]` | `{ id, decision, reason, source?: { kind: "step" \| "file", value } }` |
| `risks[]` | `{ id, kind, impact, body, locations[] }` |
| `tests[]` | `{ id, behavior, path, name }` |
| `diagrams[]` | `{ id, title, body }` |

`Location = { path, hunk? }`。hunk を省くとファイル全体を指す。

**図**は 2 つの形で 4 種類を表す。描き方やアニメーションはデータに持たせない。

- `{ shape: "sequence", actors[], messages: { from, to, label, change? }[] }` — シーケンス図
- `{ shape: "graph", kind: "relation" | "dependency" | "state", nodes[], edges[] }` — 関係図・依存図・状態遷移図
- `change` は `"added" | "changed" | "removed"`

**Risks** の `kind` と `impact` は独立に選ぶ。

| kind | 意味 |
| --- | --- |
| `breaks` | この変更で壊しうるもの |
| `assumption` | この変更が置いた前提 |
| `unknown` | 分かっていないこと |
| `considered` | 検討して問題ないと判断したこと |

| impact | 基準 |
| --- | --- |
| `high` | データの消失・破損、権限や秘密の露出、またはコードを戻すだけでは元に戻らない |
| `medium` | 既存の動作が変わるか、誤った結果を返す。コードを戻せば元に戻る |
| `low` | 利用者から見える動作は変わらない |

### 検証の 3 段

1. **形**（`validateGuide` の zod）。エラーは zod の日本語ロケールで出す
2. **id の整合**（`validateGuide` の `checkIntegrity`）。節ごとの id の重複、`readingOrder[].refs` と `how[].diagram` の参照先の実在。図の辺が実在するノードを指すかは見ない（描けない辺は画面が数えて警告する）
3. **箇所の実在**（`guideFile.ts:checkGuideLocations`、生成時だけ）。hunk を指す箇所は id とパスの**組**で照合する。hunk を省いた箇所は、そのパスが変更ファイルにあるかを見る。全件の違反を返す

### JSON Schema への変換

`shared/guide/jsonSchema.ts:guideJsonSchema` が `z.toJSONSchema(guideSchema, { target: "draft-7" })` を作り、`claude -p --json-schema` に渡す。
CLI が受け付ける範囲に収めるため、`core/test/guide/jsonSchema.test.ts` が次の制約を固定している。
スキーマを変えるときはこれを破らないこと。

- すべての object が `additionalProperties: false`
- `minLength` / `maxLength` / `minimum` / `maximum` / `pattern` / `format` / `$ref` / `$defs` を使わない
- `minItems` は 0 か 1、optional なプロパティは全体で 24 個以下、`anyOf` と `oneOf` は合わせて 16 個以下
- 出力はスナップショット（`core/test/guide/__snapshots__/jsonSchema.test.ts.snap`）と一致する

## 5.5 guide ステップ

```yaml
- id: guide
  type: guide
  session: guide                     # 必須。実装の会話を継がせるなら implementer
  allowedTools: ["Bash(git diff:*)"] # diff を読むのに Bash が要る
```

`prompt` は書けない。プロンプトは doctrine が組み立てる。`onFailure` を書かなければ「自分に戻る・最大 3 回・`last_stderr` を feed」が効き、
3 回続けて検証に落ちるとタスクは `failed` になる（人に委ねたいなら `onFailure` を明示して `onExhausted: suspend` を書く）。

実行の流れ（`engine.ts:runTask` の guide の分岐と `stepRunner.ts:runGuideStep`）:

1. エンジンが DB にしかない入力を集める。`buildTaskContext` から直近の command の結果と、却下コメント（古い順）
2. `guideInputs.ts:collectGuideInputs` が `mergeBase` → `captureTree` → `computeDiff` → `listHunks` を順に行い、hunk の一覧を
   `.doctrine-out/guide-hunks.json` に書く（hunk が多いとプロンプトに載りきらないので、エージェントは Read でこのファイルを引く）
3. `guidePrompt.ts:buildGuidePrompt` がプロンプトを組む。元のタスクの指示、テスト結果、差し戻し、`.doctrine-out/` の探し先、diff の読み方、
   hunk 一覧の場所、Risks の書き方、図の形、出力の形。前回の feed があれば末尾に「前回の出力が受け付けられなかった理由」を足す
4. `jsonSchema: guideJsonSchema()` を付けて agent と同じ `driveAgent` で起動する
5. 構造化出力を `checkOutput`（null か → `validateGuide` → `checkGuideLocations`）で検証する。通ったときだけ `writeGuideFile` し、落ちたら理由を stderr にして `failed`

### `guide.json` の封筒

`.doctrine-out/guide.json` に `{ tree, createdAt, guide }` の形で書く。`tree` と `createdAt` は doctrine が書き、エージェントには書かせない。
`tree` は hunk 一覧を作った時点のツリーで、検証の後に取り直さない（取り直すと一覧とずれる）。

`task.guide` の応答は `none`（ワークフローに guide ステップが無い）/ `missing` / `too_large`（256 KiB 超）/ `broken`（JSON でない・封筒や検証に落ちる）/
`ok` のどれかで、`ok` のときは今のツリーと比べた `stale` を付ける。アプリは `ok` でも `validateGuide` を通し直す（デーモンとアプリの版がずれうるため）。

## 5.6 経緯（`task.context`）

`core/src/domain/taskContext.ts:buildTaskContext` が組み立てる。ワークフロー定義が読めなくても失敗させない。

| 欄 | 中身 |
| --- | --- |
| `prompt` | 元の指示 |
| `reviews[]` | approval の実行を古い順に。`awaiting` / `approved` / `rejected`（bounced と failed）/ `interrupted`。rejected にはコメント |
| `lastCommand` | 出力を持つ最後の command ステップの結果（テスト結果として画面とガイドの両方が使う） |
| `lastAgentMessage` | 出力を持つ最後の agent ステップの最終応答 |
| `reviewFiles[]` | `suspended` で今のステップが approval で `review.files` を宣言しているときだけ読む。`ok` / `missing` / `too_large`（64 KiB 超）/ `outside_worktree` / `binary` |
| `escalation` | `onExhausted: suspend` で止まっているときだけ `{ stepId, goto, maxAttempts }` |

`review.files` の読み出しは、realpath で worktree の配下かを区切り文字まで含めて確かめ、open の前に通常ファイルかを確かめる（FIFO で固まらないため）。

## 5.7 移動・コピー・改名

- **ファイル単位**は git に任せる。`-M -C` で R と C が付く。画面は R を「移動」、C を「コピー」と表示する
- **コード片の移動**は `shared/diff/moves.ts:detectMoves` が patch のテキストだけから探す
  1. 削除行と追加行を集め、前後の空白を落とした本文で索引する
  2. 一致する行の対を起点に、両側で行番号が連続して一致する限り伸ばして run にする。括弧や区切り記号だけの行は実質の行数に数えない
  3. 実質の行数が多い run から貪欲に採る（前から採ると短い共通行が長い run を切ってしまうため）
  4. 間の隔たりが 3 行以内の run を 1 つのブロックにまとめ、実質 3 行以上のものだけを残す
  5. 間に一致しない行を挟むブロックは `edited`、インデントだけ違う行を含むブロックは `indentOnly`
- アプリはブロックを移動元・移動先の両方の hunk で畳み、相手側へのリンクを付ける。diff の中身は減らさない

## 5.8 アプリ側

- レビュー中のタスク（`suspended`）について `task.diff` / `task.context` / `task.guide` を別々に取る。15 秒ごとの取り直しには乗せない（承認待ちの間 worktree は凍っている）。
  `task.stateChanged` を受けたとき、承認・差し戻しの後に捨てて取り直す
- **並べ方**（`model.ts:layoutOf`）: ガイドが `ok` で古くなければ既定で**ガイドの順**、それ以外はファイル順。「前回レビュー以降」ではガイドの順に並べない
- **ガイドの順に組み直す**（`flow.ts:readingFlow`）: `readingOrder` の箇所に従って hunk を置く。同じ hunk が 2 度指されたら先に置いた方が勝つ。
  どこにも置かれなかった hunk は末尾の「ガイドが触れていない変更」に集める。**diff のすべての hunk がちょうど 1 回ずつ出る**ことを `app/src/flow.test.ts` が固定している
- Risks は該当する hunk の真上とファイルの見出しの下に出し、impact の強い順に並べる。`considered` と `low` は畳む
- **差し戻し**: 行コメントは `{ path, line, quote, text }` として下書きに入り、`composeRejection` が次の形の文字列にして `task.reject` に送る

```
<path>:<line>
  > <quote>
  <text>

全体: <overall>
```

下書きはアプリのデータディレクトリの `drafts.json` に保存し、送信が受理されたときだけ消す（[7 章](07-app.md)）。
