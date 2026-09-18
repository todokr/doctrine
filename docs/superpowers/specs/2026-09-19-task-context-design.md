# doctrine task.context と review.files 設計

- 日付: 2026-09-19
- 状態: 承認待ち
- issue: [#45](https://github.com/todokr/doctrine/issues/45)
- 前提: [overview](../../overview.md)、[レビュー記録spec](2026-09-18-review-record-design.md)（#43、実装済み）、[ステップ間の成果物受け渡しspec](2026-09-13-step-artifacts-design.md)

## 1. 位置づけ

overview 1章の「止まった作業は、指示・差し戻し・テスト結果といった**経緯と一緒に**
レビュー画面に届く」を支えるデータを作る。

レビュー画面が必要とするものは既にほぼ DB にある（#43 が作った）。足りないのは
**それを1回で取り出す口**と、**diff 以外を見て判断するステップのための宣言**である。

- エージェントが何をしたつもりか（最後の発言）と実際の diff を並べて見られることが、
  もっともらしい説明を鵜呑みにしないための一番安い材料になる
- 計画の承認のように、そもそも diff が無い（`.doctrine-out/plan.md` を読んで判断する）
  ステップがある。何を見ればよいかはワークフローの作者しか知らないので、
  ステップ定義に書けるようにする

**doctrine は宣言されたファイルの中身を理解しない。** 読んで、範囲を検査して、
そのまま渡す。解釈は人と UI の仕事である。

## 2. 決定の要約

| 項目 | 決定 | 章 |
| --- | --- | --- |
| 新しいデーモンのメソッド | `task.context(task_id)` | 3 |
| 呼べる状態 | **どの状態でも呼べる**。`reviewFiles` は承認待ちのときだけ中身を持つ | 3 |
| ステップ種別の判定 | **ワークフロー定義から引く**（DB に種別を持たせない） | 3 |
| approval の宣言 | `review: { files: [...] }` を `src/workflow/schema.ts` に足す | 4 |
| パスの検証（静的） | worktree からの相対パスのみ。絶対パスと `..` はスキーマ検証で落とす | 4 |
| パスの検証（実行時） | **realpath が worktree 配下かを確認**する。worktree 内のシンボリックリンク経由で外を読ませない | 5 |
| 1ファイルの上限 | **64KB**。超過は中身を返さず `too_large` | 5 |
| ファイル1件の返し方 | status で判別するユニオン。`ok` / `missing` / `too_large` / `outside_worktree` / `binary` | 5 |
| 「無いもの」の表し方 | `ReviewEntry` も `ReviewFile` も**判別ユニオン**にし、状態ごとに持つものだけを持たせる（null や空文字で埋めない） | 3, 5 |
| 「エージェントの最後の発言」 | 直近の `agent` ステップの `step_outputs.last_stdout` | 6 |
| `step_outputs` の列名 | `stdout` → **`last_stdout`**、`stderr` → **`last_stderr`**（テンプレート変数も改名） | 7 |

## 3. `task.context(task_id)`

`src/daemon/handlers.ts` に1メソッド足す。返すものは issue が挙げた5つ。

```ts
type TaskContext = {
  /** 元の指示（tasks.prompt）。 */
  prompt: string;
  /** レビューの履歴。古い順。今まさに待っている回も含む。 */
  reviews: ReviewEntry[];
  /** 直近に終わった command ステップの結果。1つも無ければ null。 */
  lastCommand: CommandResult | null;
  /** 直近に終わった agent ステップの最後の発言。1つも無ければ null。 */
  lastAgentMessage: string | null;
  /** 今の approval ステップが宣言したファイル。宣言が無ければ空配列。 */
  reviewFiles: ReviewFile[];
};

type ReviewBase = {
  stepRunId: number;
  stepId: string;
  /** 何回目のレビューか。 */
  attempt: number;
  /** 待ち始めた時刻。 */
  startedAt: string;
  /** その時点のツリー。記録できなかった回は null（#43 spec 5.3）。 */
  reviewTree: string | null;
};

/** レビュー1回。 */
type ReviewEntry =
  /** まだ人が見ていない。 */
  | (ReviewBase & { status: "awaiting" })
  /** 承認された。`task.approve` は comment を受けないので、承認にコメントは無い。 */
  | (ReviewBase & { status: "approved"; endedAt: string })
  /** 却下された。`task.reject` はコメント必須なので、必ずある。 */
  | (ReviewBase & { status: "rejected"; endedAt: string; comment: string })
  /** 人の決定を待たずに外から閉じられた（`task.cancel` / `task.resume`）。 */
  | (ReviewBase & { status: "interrupted"; endedAt: string });

type CommandResult = {
  stepId: string;
  /** シグナルで殺された実行は null（`exitCodeOf` の約束）。 */
  exitCode: number | null;
  /** DB が持つのは末尾 8KB（OUTPUT_TAIL_BYTES）まで。全文はログファイルにある。 */
  stdout: string;
  stderr: string;
};
```

### `step_runs.status` からの対応

DB の `status` はステップ実行の語彙（`success` / `failed`）で、レビューの語彙
（承認 / 却下）ではない。境界で言い換える。

| `step_runs.status` | `ReviewEntry["status"]` |
| --- | --- |
| `awaiting` | `awaiting` |
| `success` | `approved` |
| `failed` | `rejected` |
| `interrupted` | `interrupted` |

approval の行にこの4つ以外は現れない（`engine.ts` と `handlers.ts` がこの4つしか
書かない）。他の値が来たらそれは doctrine のバグであり、ユニオンのどの枝にも
当てはまらない。**黙ってどれかに倒さず例外にする** — 形の違うレビューを返すより、
バグとして気づける方がよい。

なお `comment` は `step_outputs.last_stdout` から取る。`rejected` の行には必ず
行があり（`applyApproval` が却下コメントを同じトランザクションで書く）、
それが無ければやはり不変条件の破れなので例外にする。

### 呼べる状態

**どの状態でも呼べる。** `prompt` / `reviews` / `lastCommand` / `lastAgentMessage` は
承認待ちでなくても意味がある（失敗したタスクの経緯を見る、完了したタスクを後から
読み返す）。承認待ち専用にすると、レビュー画面が「まだ承認待ちではないタスク」を
選んだ瞬間に何も出せなくなる。

`reviewFiles` が中身を持つのは、タスクが `suspended` で、今の approval ステップが
`review.files` を宣言しているときだけである。それ以外は空配列を返す。

### ステップ種別の判定

「直近の command」「直近の agent」を選ぶには、`step_runs` の各行がどの種別の
ステップだったかが要る。**`step_runs` に種別の列は足さない。** ハンドラは既に
`ctx.loadWorkflow(project.path, task.workflow_name)` でワークフロー定義を引ける
（`task.approve` / `task.reject` が同じことをしている）。定義から
`Map<stepId, Step["type"]>` を作り、`step_runs` を新しい順に見て最初に一致した
ものを採る。

`withSetupStep`（`project.setup` が先頭に挿入する `setup` ステップ）を通した後の
定義を使うこと。通さないと `setup` の実行が「定義に無いステップ」として落ちる。

### 承認待ちの間に定義が変わっていたら

`applyApproval` は、承認待ちの間に YAML が編集されてステップが消えている場合に
名指しで失敗する。`task.context` は**失敗させない** — 読み取り専用であり、
ここで止めると人は経緯を読むことすらできなくなる。定義から引けない `step_runs` の
行は種別不明として `lastCommand` / `lastAgentMessage` の候補から外し、
`reviews` は「今の `current_step_id` と同じ `step_id` の行」で拾う。

## 4. `review: { files: [...] }`（`src/workflow/schema.ts`）

```yaml
  - id: plan-approval
    type: approval
    title: "計画を確認してください"
    onReject: { goto: plan, maxAttempts: 3 }
    review:
      files:
        - .doctrine-out/plan.md
```

型と zod スキーマの両方に足す。

```ts
export type ReviewDecl = { files: string[] };
export type ApprovalStep = {
  id: string;
  type: "approval";
  title: string;
  onReject?: Branch;
  review?: ReviewDecl;
};
```

### パスの静的な検証

worktree からの相対パスに限る。次をスキーマ検証で落とす。

| 落とすもの | 理由 |
| --- | --- |
| 絶対パス（`/` 始まり） | worktree の外を指す |
| `..` を含む | 正規化すると worktree の外に出られる |
| 空文字 | 指すものが無い |
| `~` 始まり | ホームディレクトリ。展開しない以上、意味のないパスを黙って受けない |

メッセージは既存の日本語のスタイルに揃える（`formatZodIssues` が通す形で
カスタムメッセージを書く）。

`files` が空配列の宣言（`review: { files: [] }`）は**書けなくする**（`min(1)`）。
「何も見ない」を明示的に宣言する意味は無く、書き間違いの方が疑わしい。

## 5. ファイルの読み出し

`src/core/reviewFiles.ts`（新規）に置く。デーモンのハンドラから I/O を分けて
テストしやすくするため。

```ts
export const MAX_REVIEW_FILE_BYTES = 64 * 1024;

export type ReviewFileStatus = "ok" | "missing" | "too_large" | "outside_worktree" | "binary";

/** 宣言されたファイル1件の読み出し結果。`path` は常に宣言されたとおりの worktree 相対パス。 */
export type ReviewFile =
  | { path: string; status: "ok"; content: string; size: number }
  /** そこに無い。読もうとして予期しない I/O エラーになった場合もここに倒す。 */
  | { path: string; status: "missing" }
  /** 実在するが 64KB を超えた。中身は返さず、大きさだけ返す。 */
  | { path: string; status: "too_large"; size: number }
  /** realpath が worktree の外を指した。中身も大きさも読まない。 */
  | { path: string; status: "outside_worktree" }
  /** 実在するが UTF-8 として読めない。 */
  | { path: string; status: "binary"; size: number };

export function readReviewFiles(worktreePath: string, paths: string[]): Promise<ReviewFile[]>;
```

### 検査の順序

1. **realpath が worktree 配下か。** 違えば `outside_worktree`（中身は返さない）
2. **存在するか。** 無ければ `missing`
3. **64KB 以下か。** 超えていれば `too_large`（`size` は入れる、中身は返さない）
4. **UTF-8 として読めるか。** 読めなければ `binary`（`size` は入れる）
5. すべて通れば `ok`

### なぜ realpath まで見るか

静的な検証を通すのは**人が書いた YAML** だが、そのパスが指す先を作るのは
**エージェント**である。

```
# ワークフローの宣言は規約どおり
review: { files: [".doctrine-out/plan.md"] }

# だがエージェントが worktree の中でこうしていたら
$ ln -s ~/.ssh/id_rsa .doctrine-out/plan.md
```

`Deno.realPath` で解決してから worktree のパスの配下かを確かめる。worktree のパス
自体も `Deno.realPath` で正規化してから比べる（macOS の `/tmp` → `/private/tmp` の
ように、DB に入っているパスと解決後の表記が食い違うため。`src/core/worktree.ts` の
`canonical` が同じ理由で同じことをしている）。

比較は**パス境界を見て**行う。`startsWith(worktree)` だけだと `/w/task` に対して
`/w/task-evil/x` が通る。`worktree + SEPARATOR` で始まるかを見る。

### なぜ切り詰めた本文を返さないか

64KB を超えたファイルの中身を途中まで返すと、人はそれを全文だと思って読む。
「大きすぎて表示していない」と言える方が、静かに欠けた本文より安全である。
`.doctrine-out/plan.md` のような人向けの文書に 64KB（日本語で2〜3万字）は十分すぎ、
上限に当たること自体が「宣言の仕方が違う」という信号になる。

### 失敗しない

1件の読み出しの失敗（権限が無い、途中で消えた）が他の件を巻き込まないよう、
各ファイルを独立に扱う。予期しない I/O エラーは `missing` に倒す — 人から見て
「今そこに読めるものは無い」という点で同じであり、`task.context` 全体を
失敗させてレビューを止める理由にはならない。

## 6. 「エージェントの最後の発言」

issue の但し書きは「ログの NDJSON を UI に解釈させない。アダプタの境界の内側で
取り出す」。**これは既に満たされている。**

`src/adapter/claude.ts` が NDJSON を `AgentResult` に畳み、`src/core/stepRunner.ts` が
その `result.text`（アダプタが取り出した最終テキスト）をそのまま `step_outputs` に
書いている。`task.context` は直近の agent ステップのその値を返すだけでよく、
新しい抽出も新しい置き場も要らない。

## 7. `step_outputs` の列名を `last_stdout` / `last_stderr` にする

`step_outputs` は #43 でステップ実行1回ごとの記録になった。テンプレート変数
`{{ steps.<id>.stdout }}` が指すのは**そのステップの最新の実行**であり、
その規約を名前で明示する。

- マイグレーション `0004_step_outputs_last_names` で `stdout` → `last_stdout`、
  `stderr` → `last_stderr` に改名する（`ALTER TABLE ... RENAME COLUMN`。
  制約に関わらない列なのでテーブル再構築は要らない）
- テンプレート変数も `{{ steps.<id>.last_stdout }}` / `{{ steps.<id>.last_stderr }}` に
  改名する。`exitCode` は据え置く（終了コードに「最新」という含みを持たせる対象ではない）
- `last_` が指すのは**読み出し側**の性質である。行そのものは「その回の出力」であって
  最後ではない。`src/db/schema.ts` にこの旨のコメントを置く

### 互換性

これは利用者が書いたワークフロー YAML を壊す変更である。`{{ steps.review.stdout }}` は
README のサンプルにも書かれている。

**黙って空文字を渡すのではなく、旧名を名指しして落とす。**

```
{{ steps.review.stdout }}: stdout は last_stdout に変わりました（stderr も last_stderr です）
```

`expand` はステップ実行の前に走り、`TemplateError` はワークフロー作者に見せる失敗
として既に扱われている（`runTask` が伝播させ、`tick` が failed に倒して警告に残す）。
新しい配線は要らない。

書き換えが要る箇所: `README.md`、`docs/superpowers/specs/2026-09-12-agent-orchestrator-core-design.md`、
既存のテスト。

#### 採らなかった案

- **旧名を別名として残す**: 移行は楽だが、「最新を指す」ことを名前で明示するという
  改名の目的がそのまま失われる。2つの名前が同じものを指す状態が恒久的に残る

## 8. UI 側の型（`app/src/types.ts`）

デーモンにはまだ繋がっていない（モックデータのみ）が、返り値の形が決まったので
合わせて直す。画面は壊れない。

```ts
export type StepDef = {
  id: string;
  type: "command" | "agent" | "approval";
  title?: string;
  onReject?: string;
  review?: { files: string[] };   // 既にある
};

// デーモン側（src/core/reviewFiles.ts）と同じ判別ユニオンを置く。
export type ReviewFileStatus = "ok" | "missing" | "too_large" | "outside_worktree" | "binary";
export type ReviewFile =
  | { path: string; status: "ok"; content: string; size: number }
  | { path: string; status: "missing" }
  | { path: string; status: "too_large"; size: number }
  | { path: string; status: "outside_worktree" }
  | { path: string; status: "binary"; size: number };

export type Task = {
  // ...
  reviewFiles?: ReviewFile[];     // Record<string, string> から変える
};
```

`app/src/mock.ts` の `reviewFiles: { ".doctrine-out/plan.md": PLAN_MD }` を
`[{ path: ".doctrine-out/plan.md", status: "ok", content: PLAN_MD, size: PLAN_MD.length }]` に直す。

`app/src/components/ReviewView.tsx:125` は今こうなっている。

```tsx
<div className="md"><Markdown src={t.reviewFiles?.[path] ?? "(ファイルがありません)"} /></div>
```

`?? "(ファイルがありません)"` は、**無い・大きすぎる・worktree 外・バイナリ**を
すべて「ありません」に潰している。これを直すのが status を足す意味なので、
status ごとの文言を出し分ける。

doctrine はファイルの中身を理解しないが、「なぜ出せないか」は知っている。それは
人に伝える価値がある。

```tsx
function FileBody({ file }: { file: ReviewFile | undefined }) {
  if (!file) return <p className="hint">(このステップは宣言していますが、まだ読めていません)</p>;
  switch (file.status) {
    case "ok":
      return <div className="md"><Markdown src={file.content} /></div>;
    case "missing":
      return <p className="hint">(ファイルがありません)</p>;
    case "too_large":
      return <p className="hint">(大きすぎるため表示していません · {file.size} バイト)</p>;
    case "outside_worktree":
      return <p className="hint">(worktree の外を指しているため読みませんでした)</p>;
    case "binary":
      return <p className="hint">(テキストとして読めないため表示していません · {file.size} バイト)</p>;
  }
}
```

ユニオンを `switch` で網羅するので、後から status を足したときに書き忘れると型検査が
落ちる。また `size` を持つ枝でだけ大きさを併記でき、`missing` に「0 バイト」と
書いてしまう余地が無い。

## 9. テスト

| 対象 | 確かめること |
| --- | --- |
| `test/workflow/schema.test.ts` | `review.files` が読める / 絶対パス・`..`・空文字・`~` が日本語のメッセージで落ちる / `files: []` が落ちる |
| `test/core/reviewFiles.test.ts`（新規） | 本文が返る / 無いファイルが `missing` / 64KB 超が `too_large` で中身を返さない / **worktree 外を指すシンボリックリンクが `outside_worktree`** / 非 UTF-8 が `binary` / `/w/task-evil` が `/w/task` の配下と誤判定されない / 1件の失敗が他を巻き込まない |
| `test/daemon/handlers.test.ts` | `task.context` が5つとも返す / 承認待ちでないタスクでも呼べて `reviewFiles` が空 / 定義から消えたステップがあっても失敗しない / 待機中の回に `endedAt` の**キーが存在しない**（null が入っているのではない） / 却下の回に `comment` がある / 想定外の `step_runs.status` が来たら例外になる |
| `test/db/migrate.test.ts` | `0004` で列が改名され、既存の値が残る |
| `test/workflow/template.test.ts` | 新しい名前が展開される / 旧名が名指しのエラーで落ちる |
| `test/integration/` | 計画を `.doctrine-out/plan.md` に書かせるワークフローで、approval の時点で `task.context` から計画の本文が取れる（**完了条件1**） / 2回差し戻したタスクで両方のレビューが返る（**完了条件2**） |
| `app/` （`deno task check` 相当の型検査） | `reviewFiles` の型を変えた後も `ReviewView.tsx` と `mock.ts` が通る |

## 10. この spec の範囲外

- **`dctl` のサブコマンド。** `task.context` の消費者はレビューアプリであり、
  CLI から叩く用途が先に要るわけではない
- **レビューアプリとデーモンの接続。** UI の型は合わせるが、実際に繋ぐのは別の変更
- **`task.diff`。** `review_tree` を使った「前回レビュー以降」の差分は #43 が
  データを用意した段階で、取り出す口は本specの対象外
