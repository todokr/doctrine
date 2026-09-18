# task.context と review.files 実装計画

> （#45 で `stdout` / `stderr` は `last_stdout` / `last_stderr` に改名した。本文の例は
> 現行の名前に更新してある。）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** レビュー画面が経緯（元の指示・レビュー履歴・直近のコマンド結果・エージェントの最後の発言）と、approval ステップが宣言したファイルの中身を、1回の `task.context(task_id)` で取れるようにする。

**Architecture:** データは #43 が作った `step_runs` / `step_outputs` に既にある。足すのは (1) それを組み立てて返す `src/core/taskContext.ts` とデーモンのメソッド、(2) approval ステップの `review: { files: [...] }` 宣言、(3) 宣言されたファイルを範囲検査つきで読む `src/core/reviewFiles.ts`。ステップの種別は DB に持たせず、ハンドラが引いたワークフロー定義から判定する。

**Tech Stack:** Deno / TypeScript、SQLite（`node:sqlite`）、Kysely、zod、`@std/path`、`@std/testing/bdd` + `node:assert/strict`、React（`app/`）

**参照する spec:** [`docs/superpowers/specs/2026-09-19-task-context-design.md`](../specs/2026-09-19-task-context-design.md)

## Global Constraints

- **doctrine にはまだ利用者がいない。** 破壊的変更に移行のための仕掛け（旧名のエイリアス、旧名を案内するエラー、古い状態を受け止める分岐）を作らない。名前を変えて参照を全部書き換える
- **コードコメントに一般的な実装原則を書かない。** そのコード固有の事実だけ書く。設計の理由は spec の地の文にある
- エラーメッセージ・コメントは**日本語**
- **一度コミットしたマイグレーションは書き換えない。** 変更は新しい番号で足す（`src/db/migrations.ts` 冒頭の規則）。本計画が足すのは `0004` だけ
- マイグレーションの引数 `db` は `Kysely<any>`。`src/db/schema.ts` の型を参照しない
- `deno fmt` の `lineWidth` は **100**
- コアのテストは `deno task test`、型検査は `deno task check`。**両方通ること**が各タスクの完了条件
- `app/` は pnpm。型検査とビルドは `cd app && pnpm build`（`tsc && vite build`）、テストは `pnpm test`（`vitest run`）。CI と同じコマンド
- 外部コマンドは `src/util/exec.ts` の `runCommand` を通す

## File Structure

| ファイル | 責務 | タスク |
| --- | --- | --- |
| `src/db/migrations.ts` | `0004_step_outputs_last_names`（列の改名） | 1 |
| `src/db/schema.ts` | `StepOutputsTable` の列名 | 1 |
| `src/db/boundary.ts` | `outputs` の書き込み先の列名 | 1 |
| `src/db/stepRuns.ts` | `getStepOutputs` の列名、`listStepOutputs` を新設 | 1, 4 |
| `src/workflow/template.ts` | `STEP_FIELDS` と `TemplateContext` | 1 |
| `src/core/engine.ts` | `outputs` を書く箇所と `ctx.steps` の差し込み | 1 |
| `src/workflow/schema.ts` | `review: { files: [...] }` の型と zod スキーマ | 2 |
| `src/core/reviewFiles.ts`（新規） | 宣言されたファイルの読み出しと範囲検査 | 3 |
| `src/core/taskContext.ts`（新規） | `step_runs` / `step_outputs` / ワークフロー定義から返り値を組み立てる | 4 |
| `src/daemon/handlers.ts` | `task.context` メソッド（引数の検証とワークフローの読み込みだけ） | 4 |
| `app/src/types.ts` / `mock.ts` / `components/ReviewView.tsx` | UI 側の型と表示 | 5 |

---

### Task 1: `step_outputs` の列を `last_stdout` / `last_stderr` にする

**Files:**
- Modify: `src/db/migrations.ts`（`0004_step_outputs_last_names` を追加）
- Modify: `src/db/schema.ts`（`StepOutputsTable`）
- Modify: `src/db/boundary.ts:63`（`outputs` の型）、`src/db/boundary.ts:170-185`（insert 部）
- Modify: `src/db/stepRuns.ts:38-64`（`getStepOutputs`）
- Modify: `src/workflow/template.ts:5`（`TemplateContext`）、`src/workflow/template.ts:17`（`STEP_FIELDS`）
- Modify: `src/core/engine.ts:341-342, 378-379, 428, 444-448, 454`
- Modify: `README.md`、`docs/superpowers/specs/2026-09-12-agent-orchestrator-core-design.md`、`docs/superpowers/specs/2026-09-13-step-artifacts-design.md`、`docs/superpowers/plans/2026-09-12-agent-orchestrator-core.md`
- Test: `test/db/migrate.test.ts`、`test/workflow/template.test.ts`、および `{{ steps.*.stdout }}` を使う既存テスト

**Interfaces:**
- Consumes: なし（最初のタスク）
- Produces:
  - `StepOutputsTable = { step_run_id, last_stdout, last_stderr, exit_code }`
  - `getStepOutputs(db, taskId)` の戻りは `Record<stepId, { last_stdout: string; last_stderr: string; exitCode: string }>`
  - テンプレート変数は `{{ steps.<id>.last_stdout }}` / `{{ steps.<id>.last_stderr }}` / `{{ steps.<id>.exitCode }}`

**背景（実装者向け）:** `step_outputs` は #43 でステップ実行1回ごとの記録になった。テンプレート変数が指すのは**そのステップの最新の実行**であり、その規約を名前で明示する。`exitCode` は据え置く。

移行の仕掛けは作らない。旧名は `STEP_FIELDS` から消えるので、書き残しがあれば既存の「ステップ出力のフィールドは ... のみです」というエラーで落ちる。

- [ ] **Step 1: 失敗するテストを書く**

`test/db/migrate.test.ts` の末尾に追加する。

```ts
test("0004: step_outputs の列が last_stdout / last_stderr に改名され、値は残る", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(LEGACY_DDL);
  sqlite.exec(`
    INSERT INTO projects (path, default_workflow) VALUES ('/repo', 'f');
    INSERT INTO tasks (id, project_id, title, prompt, workflow_name, state, branch,
                       created_at, updated_at)
      VALUES ('t1', 1, 'T', 'P', 'f', 'suspended', 'b', '2026-09-19', '2026-09-19');
    INSERT INTO step_runs (id, task_id, step_id, attempt, status, started_at, log_path)
      VALUES (1, 't1', 'review', 1, 'failed', '2026-09-19', '');
    INSERT INTO step_outputs (task_id, step_id, stdout, stderr, exit_code)
      VALUES ('t1', 'review', '直して', 'warn', 1);
  `);
  const d = await openDbOn(sqlite);

  const rows = await d.selectFrom("step_outputs").selectAll().execute();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].last_stdout, "直して");
  assert.equal(rows[0].last_stderr, "warn");
  assert.equal(rows[0].exit_code, 1);
});
```

`test/workflow/template.test.ts` の既存テストを新しい名前に直し、`TemplateContext` を作っている箇所の `steps` も直す。

```ts
test("ステップ出力は最新の実行を指す名前で引く", () => {
  const ctx: TemplateContext = {
    task: { id: "t1", title: "T", prompt: "P", branch: "b" },
    worktree: { path: "/w" },
    project: { path: "/p" },
    steps: { test: { last_stdout: "ok", last_stderr: "3 failing", exitCode: "1" } },
  };
  assert.equal(expand("{{ steps.test.last_stdout }}", ctx), "ok");
  assert.equal(expand("{{ steps.test.last_stderr }}", ctx), "3 failing");
  assert.equal(expand("{{ steps.test.exitCode }}", ctx), "1");
});
```

- [ ] **Step 2: テストが落ちることを確認する**

Run: `deno test --allow-all test/db/migrate.test.ts test/workflow/template.test.ts`
Expected: FAIL — `last_stdout` が `StepOutputsTable` に無く型検査で落ちる

- [ ] **Step 3: `src/db/schema.ts` を直す**

```ts
/**
 * ステップ実行1回ぶんの出力。`last_` はこの行が最後という意味ではなく、
 * テンプレート変数 `{{ steps.<id>.last_stdout }}` がステップの**最新の実行**の
 * 行を引く、という読み出し側の規約を指す。
 */
export interface StepOutputsTable {
  step_run_id: number;
  last_stdout: string;
  last_stderr: string;
  exit_code: number | null;
}
```

- [ ] **Step 4: `src/db/migrations.ts` に `0004` を足す**

`"0003_review_records"` の後ろに追加する。

```ts
  /**
   * step_outputs の stdout / stderr を last_stdout / last_stderr に改名する。
   * 制約に関わらない列なので、テーブル再構築は要らない。
   */
  "0004_step_outputs_last_names": {
    // deno-lint-ignore no-explicit-any
    async up(db: Kysely<any>) {
      await db.schema.alterTable("step_outputs")
        .renameColumn("stdout", "last_stdout").execute();
      await db.schema.alterTable("step_outputs")
        .renameColumn("stderr", "last_stderr").execute();
    },
  },
```

- [ ] **Step 5: `src/db/boundary.ts` を直す**

`StepBoundary` の `outputs` の型は**呼び出し側の言葉のまま**にせず、書き込み先に合わせる。

```ts
  outputs?: { last_stdout: string; last_stderr: string; exit_code: number | null };
```

insert 部の `.values({...})` と `doUpdateSet` を直す。

```ts
        .values({
          step_run_id: stepRunId,
          last_stdout: tail(o.last_stdout),
          last_stderr: tail(o.last_stderr),
          exit_code: o.exit_code,
        })
        .onConflict((oc) =>
          oc.column("step_run_id").doUpdateSet((eb) => ({
            last_stdout: eb.ref("excluded.last_stdout"),
            last_stderr: eb.ref("excluded.last_stderr"),
            exit_code: eb.ref("excluded.exit_code"),
          }))
        )
```

`onConflict` は `oc.column("step_run_id")` のまま（主キーが1列なので）。変えるのは列名だけ。

- [ ] **Step 6: `src/db/stepRuns.ts` の `getStepOutputs` を直す**

`select` の列名、戻り値の型、組み立て、doc コメント中の変数名をすべて新しい名前にする。

```ts
export async function getStepOutputs(
  db: Db,
  taskId: string,
): Promise<Record<string, { last_stdout: string; last_stderr: string; exitCode: string }>> {
  const rows = await db.selectFrom("step_outputs")
    .innerJoin("step_runs", "step_runs.id", "step_outputs.step_run_id")
    .select([
      "step_runs.step_id",
      "step_runs.id as step_run_id",
      "step_outputs.last_stdout",
      "step_outputs.last_stderr",
      "step_outputs.exit_code",
    ])
    .where("step_runs.task_id", "=", taskId)
    .orderBy("step_runs.id")
    .execute();
  const out: Record<string, { last_stdout: string; last_stderr: string; exitCode: string }> = {};
  // id の昇順に上書きするので、最後に残るのが最新の実行。
  for (const r of rows) {
    out[r.step_id] = {
      last_stdout: r.last_stdout,
      last_stderr: r.last_stderr,
      exitCode: String(r.exit_code ?? ""),
    };
  }
  return out;
}
```

- [ ] **Step 7: `src/workflow/template.ts` を直す**

```ts
  steps: Record<string, { last_stdout: string; last_stderr: string; exitCode: string }>;
```

```ts
const STEP_FIELDS = ["last_stdout", "last_stderr", "exitCode"] as const;
```

- [ ] **Step 8: `src/core/engine.ts` を直す**

`outputs` を書く3箇所と、`applyApproval` が展開前に差し込む1箇所。

```ts
      outputs: {
        last_stdout: outcome.stdout,
        last_stderr: outcome.stderr,
        exit_code: outcome.exitCode,
      },
```

```ts
      outputs: { last_stdout: "", last_stderr: "", exit_code: 0 },
```

```ts
  ctx.steps[stepId] = { last_stdout: verdict.comment, last_stderr: "", exitCode: "1" };
```

```ts
      outputs: { last_stdout: verdict.comment, last_stderr: "", exit_code: 1 },
```

`applyApproval` の doc コメント（`src/core/engine.ts:378-379` 付近）と、`{{ steps.review.last_stdout }}` に言及しているコメント（`:444` 付近）の変数名も直す。

> `outcome.stdout` / `outcome.stderr` は `StepOutcome`（`src/core/stepRunner.ts`）の
> フィールドであり、**改名しない**。改名するのは DB の列とテンプレート変数だけ。

- [ ] **Step 9: 残りの参照を洗い出して直す**

```bash
grep -rn 'steps\.[a-z-]*\.\(stdout\|stderr\)' README.md docs/ src/ test/
```

出たものをすべて `last_stdout` / `last_stderr` に直す。対象は `README.md`、`docs/superpowers/specs/2026-09-12-agent-orchestrator-core-design.md`、`docs/superpowers/specs/2026-09-13-step-artifacts-design.md`、`docs/superpowers/plans/2026-09-12-agent-orchestrator-core.md`、`test/core/engine.test.ts`、`test/integration/fullCycle.test.ts`、`test/daemon/handlers.test.ts`、`test/workflow/template.test.ts`。

過去の決定の記録である spec / plan は、書き換えた旨を1行添える。

```markdown
> （#45 で `stdout` / `stderr` は `last_stdout` / `last_stderr` に改名した。本文の例は
> 現行の名前に更新してある。）
```

- [ ] **Step 10: テストが通ることを確認する**

Run: `deno task check && deno task test`
Expected: PASS

- [ ] **Step 11: 洗い出しが空になったことを確認する**

Run: `grep -rn 'steps\.[a-z-]*\.\(stdout\|stderr\)' README.md docs/ src/ test/`
Expected: 何も出ない（`last_stdout` / `last_stderr` は正規表現に一致しない）

- [ ] **Step 12: コミット**

```bash
deno fmt src test
git add -A
git commit -m "refactor: step_outputs の列とテンプレート変数を last_stdout / last_stderr にする (#45)"
```

---

### Task 2: approval に `review: { files: [...] }` を足す

**Files:**
- Modify: `src/workflow/schema.ts`（`ApprovalStep` 型、zod の approval 分岐）
- Test: `test/workflow/schema.test.ts`

**Interfaces:**
- Consumes: なし
- Produces:
  - `export type ReviewDecl = { files: string[] }`
  - `ApprovalStep` に `review?: ReviewDecl`

**背景（実装者向け）:** 計画の承認のように diff ではなくファイルを読んで判断するステップがある。何を見ればよいかはワークフローの作者しか知らないので、ステップ定義に書けるようにする。

パスは worktree からの相対に限る。絶対パス・`..`・空文字・`~` 始まりをスキーマ検証で落とす。これは**人が書いた YAML** に対する検査であり、そのパスが指す先（シンボリックリンク）はエージェントが作れるので、実行時の検査は Task 3 が持つ。

`formatZodIssues` は日本語を含むメッセージをそのまま通す（`containsJapanese`）ので、`.refine` のメッセージは日本語で書けばよい。

- [ ] **Step 1: 失敗するテストを書く**

`test/workflow/schema.test.ts` に追加する。

```ts
const WITH_REVIEW = `
name: guided
steps:
  - id: plan
    type: agent
    prompt: "計画を書いて"
  - id: plan-approval
    type: approval
    title: "計画を確認してください"
    review:
      files:
        - .doctrine-out/plan.md
        - docs/adr/0001.md
`;

test("approval の review.files を読む", () => {
  const { workflow } = parseWorkflow(WITH_REVIEW);
  const step = workflow.steps[1] as ApprovalStep;
  assert.deepEqual(step.review?.files, [".doctrine-out/plan.md", "docs/adr/0001.md"]);
});

test("review を書かない approval は今までどおり通る", () => {
  const { workflow } = parseWorkflow(VALID);
  assert.equal((workflow.steps[2] as ApprovalStep).review, undefined);
});

const withFiles = (files: string) => `
name: g
steps:
  - id: a
    type: approval
    title: "見て"
    review:
      files: ${files}
`;

test("worktree の外を指せるパスは落とす", () => {
  for (const [files, pattern] of [
    ['["/etc/passwd"]', /絶対パス/],
    ['["../secrets.md"]', /\.\./],
    ['["a/../../b.md"]', /\.\./],
    ['["~/.ssh/id_rsa"]', /~/],
    ['[""]', /空/],
  ] as const) {
    assert.throws(
      () => parseWorkflow(withFiles(files)),
      (e: Error) => e instanceof WorkflowValidationError && pattern.test(e.message),
      `落ちるべき: ${files}`,
    );
  }
});

test("files が空の宣言は落とす", () => {
  assert.throws(() => parseWorkflow(withFiles("[]")), WorkflowValidationError);
});

test("review に知らないキーがあれば落とす", () => {
  const yaml = `
name: g
steps:
  - id: a
    type: approval
    title: "見て"
    review:
      files: ["a.md"]
      diff: true
`;
  assert.throws(() => parseWorkflow(yaml), WorkflowValidationError);
});
```

import に `ApprovalStep` を足す。

- [ ] **Step 2: テストが落ちることを確認する**

Run: `deno test --allow-all test/workflow/schema.test.ts`
Expected: FAIL — `review` は `.strict()` により「認識できないキー」で落ちる

- [ ] **Step 3: `src/workflow/schema.ts` に型を足す**

```ts
/** approval ステップが「これを見て判断してください」と宣言するもの。 */
export type ReviewDecl = { files: string[] };
export type ApprovalStep = {
  id: string;
  type: "approval";
  title: string;
  onReject?: Branch;
  review?: ReviewDecl;
};
```

- [ ] **Step 4: zod スキーマを足す**

`branch` の定義の近くに置く。

```ts
/**
 * review.files のパス。worktree からの相対に限る。
 * 指す先が worktree の外に出ていないかは、読み出し時に realpath で確かめる
 * （src/core/reviewFiles.ts）。ここで見るのは書かれた文字列だけ。
 */
const reviewPath = z.string()
  .min(1, "ファイルのパスが空です")
  .refine((p) => !p.startsWith("/"), "絶対パスは書けません（worktree からの相対パスを書いてください）")
  .refine((p) => !p.startsWith("~"), "~ は展開されません（worktree からの相対パスを書いてください）")
  .refine(
    (p) => !p.split("/").includes(".."),
    ".. は書けません（worktree の外のファイルは宣言できません）",
  );

const review = z.object({
  files: z.array(reviewPath).min(1, "review.files は1つ以上必要です"),
}).strict();
```

approval の分岐に足す。

```ts
  z.object({
    id: stepId,
    type: z.literal("approval"),
    title: z.string().min(1),
    onReject: branch.optional(),
    review: review.optional(),
  }).strict(),
```

- [ ] **Step 5: テストが通ることを確認する**

Run: `deno task check && deno test --allow-all test/workflow/schema.test.ts`
Expected: PASS

- [ ] **Step 6: 全体のテストを流す**

Run: `deno task test`
Expected: PASS

- [ ] **Step 7: コミット**

```bash
deno fmt src test
git add src/workflow/schema.ts test/workflow/schema.test.ts
git commit -m "feat: approval ステップに review.files を足す (#45)"
```

---

### Task 3: 宣言されたファイルを範囲検査つきで読む

**Files:**
- Create: `src/core/reviewFiles.ts`
- Test: `test/core/reviewFiles.test.ts`（新規）

**Interfaces:**
- Consumes: なし
- Produces:
  - `export const MAX_REVIEW_FILE_BYTES = 64 * 1024`
  - `export type ReviewFileStatus = "ok" | "missing" | "too_large" | "outside_worktree" | "binary"`
  - `export type ReviewFile`（status で判別するユニオン）
  - `export function readReviewFiles(worktreePath: string, paths: string[]): Promise<ReviewFile[]>`

**背景（実装者向け）:** 静的な検証（Task 2）を通るのは人が書いた YAML だが、そのパスが**指す先**を作るのはエージェントである。worktree の中に `ln -s ~/.ssh/id_rsa .doctrine-out/plan.md` があれば、規約どおりのパスが worktree の外を読み出す。`Deno.realPath` で解決してから配下かを確かめる。

worktree のパス自体も `Deno.realPath` で正規化してから比べる（macOS の `/tmp` は `/private/tmp` への symlink であり、DB に入っている表記と解決後の表記が食い違う。`src/core/worktree.ts` の `canonical` が同じ理由で同じことをしている）。

比較は**パス境界**で行う。`startsWith(root)` だけだと `/w/task` に対して `/w/task-evil/x` が通る。

- [ ] **Step 1: 失敗するテストを書く**

`test/core/reviewFiles.test.ts` を新規作成する。

```ts
import { afterEach, test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { join } from "@std/path";
import { MAX_REVIEW_FILE_BYTES, readReviewFiles } from "../../src/core/reviewFiles.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => Deno.remove(d, { recursive: true })));
});

async function worktree(files: Record<string, string> = {}): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "doctrine-reviewfiles-" });
  dirs.push(root);
  const wt = join(root, "wt");
  await Deno.mkdir(wt, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const path = join(wt, rel);
    await Deno.mkdir(join(path, ".."), { recursive: true });
    await Deno.writeTextFile(path, content);
  }
  return wt;
}

test("宣言されたファイルの本文が返る", async () => {
  const wt = await worktree({ ".doctrine-out/plan.md": "# 計画\n\n- やる\n" });
  const [file] = await readReviewFiles(wt, [".doctrine-out/plan.md"]);
  assert.equal(file.status, "ok");
  assert.equal(file.path, ".doctrine-out/plan.md", "宣言されたとおりのパスを返す");
  if (file.status !== "ok") throw new Error("unreachable");
  assert.equal(file.content, "# 計画\n\n- やる\n");
  assert.equal(file.size, new TextEncoder().encode("# 計画\n\n- やる\n").byteLength);
});

test("宣言された順に、宣言された数だけ返る", async () => {
  const wt = await worktree({ "a.md": "a", "b.md": "b" });
  const files = await readReviewFiles(wt, ["b.md", "missing.md", "a.md"]);
  assert.deepEqual(files.map((f) => f.path), ["b.md", "missing.md", "a.md"]);
  assert.deepEqual(files.map((f) => f.status), ["ok", "missing", "ok"]);
});

test("無いファイルは missing（中身も大きさも持たない）", async () => {
  const wt = await worktree();
  const [file] = await readReviewFiles(wt, [".doctrine-out/plan.md"]);
  assert.deepEqual(file, { path: ".doctrine-out/plan.md", status: "missing" });
});

test("ディレクトリを宣言しても missing", async () => {
  const wt = await worktree({ "docs/a.md": "a" });
  const [file] = await readReviewFiles(wt, ["docs"]);
  assert.equal(file.status, "missing");
});

test("64KB を超えたら中身を返さず too_large（大きさは返す）", async () => {
  const big = "あ".repeat(MAX_REVIEW_FILE_BYTES); // UTF-8 で3バイト/文字
  const wt = await worktree({ "big.md": big });
  const [file] = await readReviewFiles(wt, ["big.md"]);
  assert.equal(file.status, "too_large");
  if (file.status !== "too_large") throw new Error("unreachable");
  assert.ok(file.size > MAX_REVIEW_FILE_BYTES);
  assert.equal("content" in file, false, "中身は返さない");
});

test("ちょうど 64KB は読める", async () => {
  const wt = await worktree({ "edge.md": "a".repeat(MAX_REVIEW_FILE_BYTES) });
  const [file] = await readReviewFiles(wt, ["edge.md"]);
  assert.equal(file.status, "ok");
});

test("UTF-8 として読めなければ binary", async () => {
  const wt = await worktree();
  await Deno.writeFile(join(wt, "logo.png"), new Uint8Array([0x89, 0x50, 0x4e, 0xff, 0xfe]));
  const [file] = await readReviewFiles(wt, ["logo.png"]);
  assert.equal(file.status, "binary");
  if (file.status !== "binary") throw new Error("unreachable");
  assert.equal(file.size, 5);
});

test("worktree の外を指すシンボリックリンクは outside_worktree", async () => {
  const wt = await worktree();
  const secret = join(wt, "..", "secret.txt");
  await Deno.writeTextFile(secret, "とても秘密\n");
  await Deno.mkdir(join(wt, ".doctrine-out"), { recursive: true });
  await Deno.symlink(secret, join(wt, ".doctrine-out", "plan.md"));

  const [file] = await readReviewFiles(wt, [".doctrine-out/plan.md"]);
  assert.deepEqual(file, { path: ".doctrine-out/plan.md", status: "outside_worktree" });
});

test("worktree の中を指すシンボリックリンクは読める", async () => {
  const wt = await worktree({ "docs/plan.md": "# 計画\n" });
  await Deno.symlink(join(wt, "docs", "plan.md"), join(wt, "plan.md"));
  const [file] = await readReviewFiles(wt, ["plan.md"]);
  assert.equal(file.status, "ok");
});

test("worktree と同じ接頭辞のディレクトリは配下と誤判定しない", async () => {
  const wt = await worktree();
  // wt は <root>/wt。兄弟の <root>/wt-evil は startsWith(wt) を通ってしまう。
  const evil = `${wt}-evil`;
  await Deno.mkdir(evil, { recursive: true });
  await Deno.writeTextFile(join(evil, "x.md"), "よそのファイル\n");
  await Deno.symlink(join(evil, "x.md"), join(wt, "x.md"));

  const [file] = await readReviewFiles(wt, ["x.md"]);
  assert.equal(file.status, "outside_worktree");
});

test("worktree そのものが無ければ、宣言された全件が missing", async () => {
  const files = await readReviewFiles("/nonexistent/worktree", ["a.md", "b.md"]);
  assert.deepEqual(files, [
    { path: "a.md", status: "missing" },
    { path: "b.md", status: "missing" },
  ]);
});

test("1件の失敗が他の件を巻き込まない", async () => {
  const wt = await worktree({ "ok.md": "読める\n" });
  await Deno.mkdir(join(wt, "locked"), { recursive: true });
  await Deno.writeTextFile(join(wt, "locked", "a.md"), "x");
  await Deno.chmod(join(wt, "locked"), 0o000);
  try {
    const files = await readReviewFiles(wt, ["locked/a.md", "ok.md"]);
    assert.equal(files[0].status, "missing", "読めないものは missing に倒す");
    assert.equal(files[1].status, "ok", "他の件は読める");
  } finally {
    await Deno.chmod(join(wt, "locked"), 0o755);
  }
});
```

- [ ] **Step 2: テストが落ちることを確認する**

Run: `deno test --allow-all test/core/reviewFiles.test.ts`
Expected: FAIL — `src/core/reviewFiles.ts` が無い

- [ ] **Step 3: `src/core/reviewFiles.ts` を書く**

```ts
import { join, SEPARATOR } from "@std/path";

/** 1ファイルあたりの上限。これを超えたら中身を返さない。 */
export const MAX_REVIEW_FILE_BYTES = 64 * 1024;

export type ReviewFileStatus = "ok" | "missing" | "too_large" | "outside_worktree" | "binary";

/** 宣言されたファイル1件の読み出し結果。path は常に宣言されたとおりの worktree 相対パス。 */
export type ReviewFile =
  | { path: string; status: "ok"; content: string; size: number }
  /** そこに無い。読もうとして予期しない I/O エラーになった場合もここに倒す。 */
  | { path: string; status: "missing" }
  /** 実在するが上限を超えた。中身は返さず、大きさだけ返す。 */
  | { path: string; status: "too_large"; size: number }
  /** realpath が worktree の外を指した。中身も大きさも読まない。 */
  | { path: string; status: "outside_worktree" }
  /** 実在するが UTF-8 として読めない。 */
  | { path: string; status: "binary"; size: number };

/**
 * approval ステップが宣言したファイルを読む。doctrine は中身を理解しない —
 * 読んで、worktree の中にあることを確かめて、そのまま渡す。
 *
 * 1件ずつ独立に扱う。1つのファイルが読めないことで、他の宣言まで見えなくならない。
 */
export async function readReviewFiles(
  worktreePath: string,
  paths: string[],
): Promise<ReviewFile[]> {
  // worktree のパスも実パスに揃えてから比べる（macOS の /tmp は /private/tmp への
  // symlink なので、DB に入っている表記と realPath の結果が食い違う）。
  const root = await Deno.realPath(worktreePath).catch(() => null);
  if (root === null) return paths.map((path) => ({ path, status: "missing" }));
  return await Promise.all(paths.map((path) => readOne(root, path)));
}

async function readOne(root: string, path: string): Promise<ReviewFile> {
  let real: string;
  try {
    real = await Deno.realPath(join(root, path));
  } catch {
    return { path, status: "missing" };
  }
  // 区切り文字まで含めて比べる。startsWith(root) だけだと、/w/task に対して
  // /w/task-evil/x が配下として通る。
  if (!real.startsWith(root + SEPARATOR)) return { path, status: "outside_worktree" };

  let bytes: Uint8Array;
  try {
    const stat = await Deno.stat(real);
    if (!stat.isFile) return { path, status: "missing" };
    if (stat.size > MAX_REVIEW_FILE_BYTES) return { path, status: "too_large", size: stat.size };
    bytes = await Deno.readFile(real);
  } catch {
    return { path, status: "missing" };
  }

  try {
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { path, status: "ok", content, size: bytes.byteLength };
  } catch {
    return { path, status: "binary", size: bytes.byteLength };
  }
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `deno task check && deno test --allow-all test/core/reviewFiles.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
deno fmt src test
git add src/core/reviewFiles.ts test/core/reviewFiles.test.ts
git commit -m "feat: 宣言されたファイルを範囲検査つきで読む reviewFiles を足す (#45)"
```

---

### Task 4: `task.context(task_id)`

**Files:**
- Create: `src/core/taskContext.ts`
- Modify: `src/db/stepRuns.ts`（`listStepOutputs` を追加）
- Modify: `src/daemon/handlers.ts`（`task.context` の case を追加）
- Test: `test/core/taskContext.test.ts`（新規）、`test/daemon/handlers.test.ts`

**Interfaces:**
- Consumes:
  - Task 1 の `step_outputs.last_stdout` / `last_stderr`
  - Task 2 の `ApprovalStep["review"]`
  - Task 3 の `readReviewFiles(worktreePath, paths)`
- Produces:
  - `listStepOutputs(db, taskId): Promise<Map<number, { last_stdout: string; last_stderr: string; exit_code: number | null }>>`（キーは `step_run_id`）
  - `buildTaskContext(db, task, workflow): Promise<TaskContext>`
  - 型 `TaskContext` / `ReviewEntry` / `CommandResult`（spec 3章のとおり）
  - デーモンのメソッド `task.context`

**背景（実装者向け）:** 組み立ては `src/core/taskContext.ts` に置く。`handlers.ts` は既に大きく、ここでやるのは引数の検証とワークフローの読み込みだけにする。

ステップの種別は `step_runs` に持たせず、ワークフロー定義から引く。`withSetupStep` を通した定義を使うこと（通さないと `setup` の実行が「定義に無いステップ」になる）。

`task.context` は**失敗させない**。読み取り専用であり、ここで止めると人は経緯を読むことすらできなくなる。ワークフロー定義が引けない（承認待ちの間に YAML が消えた）場合も、`workflow: null` で組み立てる。

例外にするのは**不変条件の破れだけ**である。approval の行の `status` が想定の4つ以外だったとき、却下の行に出力が無かったときは doctrine のバグであり、形の違うレビューを返すより気づける方がよい。

- [ ] **Step 1: 失敗するテストを書く（組み立て）**

`test/core/taskContext.test.ts` を新規作成する。

```ts
import { afterEach, test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { join } from "@std/path";
import { openDb } from "../../src/db/migrate.ts";
import { getTask, insertProject, insertTask } from "../../src/db/tasks.ts";
import { commitStepBoundary } from "../../src/db/boundary.ts";
import { parseWorkflow } from "../../src/workflow/schema.ts";
import { buildTaskContext } from "../../src/core/taskContext.ts";
import type { Db } from "../../src/db/schema.ts";
import type { StepRunStatus } from "../../src/db/stepRuns.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => Deno.remove(d, { recursive: true })));
});

const WORKFLOW = parseWorkflow(`
name: f
steps:
  - id: implement
    type: agent
    prompt: "p"
  - id: test
    type: command
    run: "true"
  - id: review
    type: approval
    title: "見て"
    review:
      files:
        - .doctrine-out/plan.md
`).workflow;

async function fixture(worktree: string | null = null): Promise<Db> {
  const db = await openDb(":memory:");
  const pid = await insertProject(db, {
    path: "/repo",
    default_workflow: "f",
    max_concurrent: 1,
    base_branch: "main",
    setup: null,
  });
  await insertTask(db, {
    id: "t1",
    project_id: pid,
    title: "T",
    prompt: "在庫の引当を冪等にして",
    workflow_name: "f",
    branch: "b",
    priority: 2,
  });
  await db.updateTable("tasks").set({ worktree_path: worktree }).where("id", "=", "t1").execute();
  return db;
}

/** ステップ実行を1件書いて、その step_run_id を返す。 */
async function run(
  db: Db,
  o: {
    stepId: string;
    status: StepRunStatus;
    attempt?: number;
    startedAt?: string;
    endedAt?: string | null;
    reviewTree?: string | null;
    outputs?: { last_stdout: string; last_stderr: string; exit_code: number | null };
  },
): Promise<number> {
  const id = await commitStepBoundary(db, {
    taskId: "t1",
    taskPatch: {},
    stepRun: {
      step_id: o.stepId,
      attempt: o.attempt ?? 1,
      status: o.status,
      exit_code: o.outputs?.exit_code ?? null,
      started_at: o.startedAt ?? "2026-09-19T00:00:00.000Z",
      ended_at: o.endedAt ?? "2026-09-19T00:01:00.000Z",
      log_path: o.stepId === "review" ? "" : "/logs/x.log",
      review_tree: o.reviewTree ?? null,
    },
    outputs: o.outputs,
  });
  return id!;
}

test("元の指示をそのまま返す", async () => {
  const db = await fixture();
  const ctx = await buildTaskContext(db, (await getTask(db, "t1"))!, WORKFLOW);
  assert.equal(ctx.prompt, "在庫の引当を冪等にして");
});

test("直近の command の結果と、直近の agent の最後の発言を返す", async () => {
  const db = await fixture();
  await run(db, {
    stepId: "implement",
    status: "success",
    outputs: { last_stdout: "1回目の実装です", last_stderr: "", exit_code: 0 },
  });
  await run(db, {
    stepId: "test",
    status: "failed",
    outputs: { last_stdout: "", last_stderr: "3 failing", exit_code: 1 },
  });
  await run(db, {
    stepId: "implement",
    status: "success",
    attempt: 2,
    outputs: { last_stdout: "テストの失敗を直しました", last_stderr: "", exit_code: 0 },
  });
  await run(db, {
    stepId: "test",
    status: "success",
    attempt: 2,
    outputs: { last_stdout: "12 passed", last_stderr: "", exit_code: 0 },
  });

  const ctx = await buildTaskContext(db, (await getTask(db, "t1"))!, WORKFLOW);
  assert.deepEqual(ctx.lastCommand, {
    stepId: "test",
    exitCode: 0,
    stdout: "12 passed",
    stderr: "",
  });
  assert.equal(ctx.lastAgentMessage, "テストの失敗を直しました");
});

test("command も agent も1つも無ければ null", async () => {
  const db = await fixture();
  const ctx = await buildTaskContext(db, (await getTask(db, "t1"))!, WORKFLOW);
  assert.equal(ctx.lastCommand, null);
  assert.equal(ctx.lastAgentMessage, null);
});

test("レビューは古い順に、状態ごとに違う形で返る", async () => {
  const db = await fixture();
  await run(db, {
    stepId: "review",
    status: "failed",
    attempt: 1,
    startedAt: "2026-09-19T01:00:00.000Z",
    endedAt: "2026-09-19T02:00:00.000Z",
    reviewTree: "a".repeat(40),
    outputs: { last_stdout: "1回目の指摘", last_stderr: "", exit_code: 1 },
  });
  await run(db, {
    stepId: "review",
    status: "awaiting",
    attempt: 2,
    startedAt: "2026-09-19T03:00:00.000Z",
    endedAt: null,
    reviewTree: "b".repeat(40),
  });

  const { reviews } = await buildTaskContext(db, (await getTask(db, "t1"))!, WORKFLOW);
  assert.equal(reviews.length, 2);

  assert.deepEqual(reviews[0], {
    stepRunId: reviews[0].stepRunId,
    stepId: "review",
    attempt: 1,
    status: "rejected",
    startedAt: "2026-09-19T01:00:00.000Z",
    endedAt: "2026-09-19T02:00:00.000Z",
    reviewTree: "a".repeat(40),
    comment: "1回目の指摘",
  });

  assert.equal(reviews[1].status, "awaiting");
  assert.equal("endedAt" in reviews[1], false, "待機中の回に決定時刻のキーは無い");
  assert.equal("comment" in reviews[1], false, "待機中の回にコメントのキーは無い");
});

test("承認された回は approved で、コメントのキーを持たない", async () => {
  const db = await fixture();
  await run(db, {
    stepId: "review",
    status: "success",
    outputs: { last_stdout: "", last_stderr: "", exit_code: 0 },
  });
  const { reviews } = await buildTaskContext(db, (await getTask(db, "t1"))!, WORKFLOW);
  assert.equal(reviews[0].status, "approved");
  assert.equal("comment" in reviews[0], false);
  assert.equal(reviews[0].endedAt, "2026-09-19T00:01:00.000Z");
});

test("外から閉じられた回は interrupted", async () => {
  const db = await fixture();
  await run(db, { stepId: "review", status: "interrupted" });
  const { reviews } = await buildTaskContext(db, (await getTask(db, "t1"))!, WORKFLOW);
  assert.equal(reviews[0].status, "interrupted");
  assert.equal("comment" in reviews[0], false);
});

test("approval の行に想定外の status があれば例外にする", async () => {
  const db = await fixture();
  await run(db, { stepId: "review", status: "degraded" });
  await assert.rejects(
    () => buildTaskContext(db, (await getTask(db, "t1"))!, WORKFLOW),
    /想定外/,
  );
});

test("承認待ちで宣言があれば、宣言されたファイルの中身が返る", async () => {
  const root = await Deno.makeTempDir({ prefix: "doctrine-taskctx-" });
  dirs.push(root);
  const wt = join(root, "wt");
  await Deno.mkdir(join(wt, ".doctrine-out"), { recursive: true });
  await Deno.writeTextFile(join(wt, ".doctrine-out", "plan.md"), "# 計画\n");

  const db = await fixture(wt);
  await db.updateTable("tasks").set({ state: "suspended", current_step_id: "review" })
    .where("id", "=", "t1").execute();
  await run(db, { stepId: "review", status: "awaiting", endedAt: null });

  const { reviewFiles } = await buildTaskContext(db, (await getTask(db, "t1"))!, WORKFLOW);
  assert.equal(reviewFiles.length, 1);
  assert.equal(reviewFiles[0].status, "ok");
  if (reviewFiles[0].status !== "ok") throw new Error("unreachable");
  assert.equal(reviewFiles[0].content, "# 計画\n");
});

test("承認待ちでなければ reviewFiles は空", async () => {
  const db = await fixture("/tmp");
  const { reviewFiles } = await buildTaskContext(db, (await getTask(db, "t1"))!, WORKFLOW);
  assert.deepEqual(reviewFiles, []);
});

test("ワークフロー定義が引けなくても、経緯は返る", async () => {
  const db = await fixture();
  await db.updateTable("tasks").set({ state: "suspended", current_step_id: "review" })
    .where("id", "=", "t1").execute();
  await run(db, {
    stepId: "review",
    status: "failed",
    outputs: { last_stdout: "直して", last_stderr: "", exit_code: 1 },
  });
  await run(db, {
    stepId: "test",
    status: "success",
    outputs: { last_stdout: "ok", last_stderr: "", exit_code: 0 },
  });

  const ctx = await buildTaskContext(db, (await getTask(db, "t1"))!, null);
  assert.equal(ctx.prompt, "在庫の引当を冪等にして");
  assert.equal(ctx.reviews.length, 1, "current_step_id と同じ step_id の行を拾う");
  assert.equal(ctx.reviews[0].status, "rejected");
  assert.equal(ctx.lastCommand, null, "種別が分からないので候補にしない");
  assert.equal(ctx.lastAgentMessage, null);
  assert.deepEqual(ctx.reviewFiles, []);
});
```

- [ ] **Step 2: テストが落ちることを確認する**

Run: `deno test --allow-all test/core/taskContext.test.ts`
Expected: FAIL — `src/core/taskContext.ts` が無い

- [ ] **Step 3: `src/db/stepRuns.ts` に `listStepOutputs` を足す**

```ts
/**
 * そのタスクのステップ出力を step_run_id 引きで返す。listStepRuns と突き合わせて
 * 「どの実行の出力か」を解く側（taskContext）が使う。
 */
export async function listStepOutputs(
  db: Db,
  taskId: string,
): Promise<Map<number, { last_stdout: string; last_stderr: string; exit_code: number | null }>> {
  const rows = await db.selectFrom("step_outputs")
    .innerJoin("step_runs", "step_runs.id", "step_outputs.step_run_id")
    .select([
      "step_outputs.step_run_id",
      "step_outputs.last_stdout",
      "step_outputs.last_stderr",
      "step_outputs.exit_code",
    ])
    .where("step_runs.task_id", "=", taskId)
    .execute();
  return new Map(
    rows.map((r) => [r.step_run_id, {
      last_stdout: r.last_stdout,
      last_stderr: r.last_stderr,
      exit_code: r.exit_code,
    }]),
  );
}
```

- [ ] **Step 4: `src/core/taskContext.ts` を書く**

```ts
import type { Db, StepRunRow } from "../db/schema.ts";
import type { TaskRow } from "../db/tasks.ts";
import { listStepOutputs, listStepRuns } from "../db/stepRuns.ts";
import type { Step, Workflow } from "../workflow/schema.ts";
import { readReviewFiles, type ReviewFile } from "./reviewFiles.ts";

type StepOutputRow = { last_stdout: string; last_stderr: string; exit_code: number | null };

type ReviewBase = {
  stepRunId: number;
  stepId: string;
  attempt: number;
  startedAt: string;
  /** 記録できなかった回は null。 */
  reviewTree: string | null;
};

/** レビュー1回。 */
export type ReviewEntry =
  /** まだ人が見ていない。 */
  | (ReviewBase & { status: "awaiting" })
  /** 承認された。task.approve は comment を受けないので、承認にコメントは無い。 */
  | (ReviewBase & { status: "approved"; endedAt: string })
  /** 却下された。task.reject はコメント必須なので、必ずある。 */
  | (ReviewBase & { status: "rejected"; endedAt: string; comment: string })
  /** 人の決定を待たずに外から閉じられた（task.cancel / task.resume）。 */
  | (ReviewBase & { status: "interrupted"; endedAt: string });

export type CommandResult = {
  stepId: string;
  /** シグナルで殺された実行は null。 */
  exitCode: number | null;
  /** DB が持つのは末尾 8KB（OUTPUT_TAIL_BYTES）まで。全文はログファイルにある。 */
  stdout: string;
  stderr: string;
};

export type TaskContext = {
  prompt: string;
  reviews: ReviewEntry[];
  lastCommand: CommandResult | null;
  lastAgentMessage: string | null;
  reviewFiles: ReviewFile[];
};

/**
 * レビュー画面が要る「経緯」を1回で組み立てる。
 *
 * workflow が null なのは、承認待ちの間にワークフローYAMLが消えた・壊れた場合。
 * 読み取りをそこで止めると人は経緯を読むことすらできなくなるので、種別が要らない
 * ものだけ返す。
 */
export async function buildTaskContext(
  db: Db,
  task: TaskRow,
  workflow: Workflow | null,
): Promise<TaskContext> {
  const types = new Map<string, Step["type"]>(workflow?.steps.map((s) => [s.id, s.type]) ?? []);
  const runs = await listStepRuns(db, task.id);
  const outputs = await listStepOutputs(db, task.id);

  // 定義が引けないときは、今止まっているステップの行だけをレビューとみなす。
  const isReview = (r: StepRunRow) =>
    workflow ? types.get(r.step_id) === "approval" : r.step_id === task.current_step_id;

  return {
    prompt: task.prompt,
    reviews: runs.filter(isReview).map((r) => toReview(r, outputs)),
    lastCommand: lastCommandOf(runs, outputs, types),
    lastAgentMessage: lastOutputOf(runs, outputs, types, "agent")?.last_stdout ?? null,
    reviewFiles: await reviewFilesOf(task, workflow),
  };
}

function toReview(r: StepRunRow, outputs: Map<number, StepOutputRow>): ReviewEntry {
  const base: ReviewBase = {
    stepRunId: r.id,
    stepId: r.step_id,
    attempt: r.attempt,
    startedAt: r.started_at,
    reviewTree: r.review_tree,
  };
  switch (r.status) {
    case "awaiting":
      return { ...base, status: "awaiting" };
    case "success":
      return { ...base, status: "approved", endedAt: closedAt(r) };
    case "failed": {
      const output = outputs.get(r.id);
      if (!output) {
        throw new Error(
          `却下されたレビュー ${r.id} にコメントがありません（applyApproval が同じ境界で書くはず）`,
        );
      }
      return { ...base, status: "rejected", endedAt: closedAt(r), comment: output.last_stdout };
    }
    case "interrupted":
      return { ...base, status: "interrupted", endedAt: closedAt(r) };
    default:
      throw new Error(`レビューの記録に想定外の status があります: ${r.status}（step_run ${r.id}）`);
  }
}

function closedAt(r: StepRunRow): string {
  if (r.ended_at === null) {
    throw new Error(`閉じたはずのレビュー ${r.id} に決定の時刻がありません`);
  }
  return r.ended_at;
}

/** その種別のステップのうち、出力を持つ最後の実行。 */
function lastOutputOf(
  runs: StepRunRow[],
  outputs: Map<number, StepOutputRow>,
  types: Map<string, Step["type"]>,
  type: Step["type"],
): StepOutputRow | null {
  for (let i = runs.length - 1; i >= 0; i--) {
    if (types.get(runs[i].step_id) !== type) continue;
    const output = outputs.get(runs[i].id);
    if (output) return output;
  }
  return null;
}

function lastCommandOf(
  runs: StepRunRow[],
  outputs: Map<number, StepOutputRow>,
  types: Map<string, Step["type"]>,
): CommandResult | null {
  for (let i = runs.length - 1; i >= 0; i--) {
    if (types.get(runs[i].step_id) !== "command") continue;
    const output = outputs.get(runs[i].id);
    if (!output) continue;
    return {
      stepId: runs[i].step_id,
      exitCode: output.exit_code,
      stdout: output.last_stdout,
      stderr: output.last_stderr,
    };
  }
  return null;
}

async function reviewFilesOf(task: TaskRow, workflow: Workflow | null): Promise<ReviewFile[]> {
  if (task.state !== "suspended" || !task.current_step_id || !task.worktree_path || !workflow) {
    return [];
  }
  const step = workflow.steps.find((s) => s.id === task.current_step_id);
  if (step?.type !== "approval" || !step.review) return [];
  return await readReviewFiles(task.worktree_path, step.review.files);
}
```

- [ ] **Step 5: テストが通ることを確認する**

Run: `deno task check && deno test --allow-all test/core/taskContext.test.ts`
Expected: PASS

- [ ] **Step 6: 失敗するテストを書く（デーモン）**

`test/daemon/handlers.test.ts` に追加する。既存ヘルパ `context()`、`createHandler`、`NOOP_CONN`、`repo`、`tick`、`until` を使う。このファイルの既定ワークフローは approval ステップ `review` が1つだけ。

```ts
test("task.context は承認待ちのタスクの経緯を返す", async () => {
  const ctx = await context();
  const h = createHandler(ctx);
  await h("project.add", { path: repo }, NOOP_CONN);
  const t = await h(
    "task.create",
    { project: repo, title: "T", prompt: "在庫の引当を冪等にして" },
    NOOP_CONN,
  ) as { id: string };
  await tick(ctx);
  await until(async () => (await getTask(ctx.db, t.id))?.state === "suspended", 5000, "承認待ち");

  const got = await h("task.context", { task_id: t.id }, NOOP_CONN) as {
    prompt: string;
    reviews: { status: string }[];
    reviewFiles: unknown[];
  };
  assert.equal(got.prompt, "在庫の引当を冪等にして");
  assert.equal(got.reviews.length, 1);
  assert.equal(got.reviews[0].status, "awaiting");
  assert.deepEqual(got.reviewFiles, [], "このワークフローは review.files を宣言していない");
});

test("task.context は承認待ちでないタスクでも呼べる", async () => {
  const ctx = await context();
  const h = createHandler(ctx);
  await h("project.add", { path: repo }, NOOP_CONN);
  const t = await h(
    "task.create",
    { project: repo, title: "T", prompt: "やって" },
    NOOP_CONN,
  ) as { id: string };

  const got = await h("task.context", { task_id: t.id }, NOOP_CONN) as {
    prompt: string;
    reviews: unknown[];
    lastCommand: unknown;
    reviewFiles: unknown[];
  };
  assert.equal(got.prompt, "やって");
  assert.deepEqual(got.reviews, []);
  assert.equal(got.lastCommand, null);
  assert.deepEqual(got.reviewFiles, []);
});

test("task.context はワークフローが読めなくても経緯を返す", async () => {
  const ctx = await context();
  const h = createHandler(ctx);
  await h("project.add", { path: repo }, NOOP_CONN);
  const t = await h(
    "task.create",
    { project: repo, title: "T", prompt: "やって" },
    NOOP_CONN,
  ) as { id: string };
  await tick(ctx);
  await until(async () => (await getTask(ctx.db, t.id))?.state === "suspended", 5000, "承認待ち");

  // 承認待ちの間にワークフローが消える
  await rm(join(repo, ".doctrine", "workflows", "feature.yaml"));

  const got = await h("task.context", { task_id: t.id }, NOOP_CONN) as {
    prompt: string;
    reviews: { status: string }[];
  };
  assert.equal(got.prompt, "やって");
  assert.equal(got.reviews.length, 1, "current_step_id の行をレビューとして拾う");
});

test("task.context は無いタスクを名指しで断る", async () => {
  const ctx = await context();
  const h = createHandler(ctx);
  await assert.rejects(() => h("task.context", { task_id: "nope" }, NOOP_CONN), /タスクがありません/);
});
```

import に `rm` と `join` があることを確かめる（このファイルは `node:fs/promises` から `rm`、`node:path` から `join` を既に import している）。

- [ ] **Step 7: テストが落ちることを確認する**

Run: `deno test --allow-all test/daemon/handlers.test.ts`
Expected: FAIL — `未知のメソッドです: task.context`

- [ ] **Step 8: `src/daemon/handlers.ts` に `task.context` を足す**

`case "task.get"` の直後に置く。

```ts
      case "task.context": {
        const task = await getTask(ctx.db, req(params, "task_id"));
        if (!task) throw new Error("タスクがありません");
        const project = (await getProject(ctx.db, task.project_id))!;
        // 読み取り専用の経路なので、ワークフローが読めないことで失敗させない。
        // 定義が引けないと分かるのは種別が要るものだけ（buildTaskContext が扱う）。
        const workflow = await ctx.loadWorkflow(project.path, task.workflow_name)
          .then(({ workflow }) => withSetupStep(workflow, project.setup ?? undefined))
          .catch(() => null);
        return await buildTaskContext(ctx.db, task, workflow);
      }
```

import に足す。

```ts
import { buildTaskContext } from "../core/taskContext.ts";
```

- [ ] **Step 9: テストが通ることを確認する**

Run: `deno task check && deno task test`
Expected: PASS

- [ ] **Step 10: コミット**

```bash
deno fmt src test
git add src/core/taskContext.ts src/db/stepRuns.ts src/daemon/handlers.ts test/core/taskContext.test.ts test/daemon/handlers.test.ts
git commit -m "feat: task.context でレビュー画面に経緯を返す (#45)"
```

---

### Task 5: UI 側の型を返り値に合わせる

**Files:**
- Modify: `app/src/types.ts:49`（`reviewFiles`）
- Modify: `app/src/mock.ts:376`
- Modify: `app/src/components/ReviewView.tsx:122-127`

**Interfaces:**
- Consumes: Task 3 の `ReviewFile` ユニオン
- Produces: なし（UI 内で閉じる）

**背景（実装者向け）:** デーモンにはまだ繋がっていない（モックデータのみ）が、返り値の形が決まったので合わせる。

今の `ReviewView.tsx` は `t.reviewFiles?.[path] ?? "(ファイルがありません)"` と書いており、**無い・大きすぎる・worktree 外・バイナリ**をすべて「ありません」に潰している。status を足す意味はここにあるので、文言を出し分ける。

- [ ] **Step 1: `app/src/types.ts` を直す**

```ts
// デーモン側（src/core/reviewFiles.ts）と同じ判別ユニオン。
export type ReviewFileStatus = "ok" | "missing" | "too_large" | "outside_worktree" | "binary";
export type ReviewFile =
  | { path: string; status: "ok"; content: string; size: number }
  | { path: string; status: "missing" }
  | { path: string; status: "too_large"; size: number }
  | { path: string; status: "outside_worktree" }
  | { path: string; status: "binary"; size: number };
```

`Task` の `reviewFiles` を差し替える。

```ts
  reviewFiles?: ReviewFile[];
```

- [ ] **Step 2: `app/src/mock.ts` を直す**

`t-a1b2` のエントリ。

```ts
reviewFiles: [
  { path: ".doctrine-out/plan.md", status: "ok", content: PLAN_MD, size: PLAN_MD.length },
],
```

- [ ] **Step 3: `app/src/components/ReviewView.tsx` を直す**

`declared.map(...)` の中の1行を、status を見る関数に置き換える。

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

呼び出し側。

```tsx
        {declared.map((path) => (
          <section className="rv-files-md" key={path}>
            <header><span className="mono">{path}</span><span className="hint">このステップが見せるファイル（review.files）</span></header>
            <FileBody file={t.reviewFiles?.find((f) => f.path === path)} />
          </section>
        ))}
```

import に `ReviewFile` 型を足す。

- [ ] **Step 4: 型検査とビルドを通す**

Run: `cd app && pnpm build`
（`tsc && vite build`。CI（`.github/workflows`）が流しているのと同じコマンド）
Expected: PASS

- [ ] **Step 5: アプリのテストを流す**

Run: `cd app && pnpm test`
（`vitest run`。`app/src/model.test.ts` がある）
Expected: PASS

- [ ] **Step 6: コミット**

```bash
git add app/
git commit -m "feat(app): reviewFiles を status 付きのユニオンにし、読めない理由を出し分ける (#45)"
```

---

### Task 6: 完了条件を統合テストで確かめる

**Files:**
- Create: `test/integration/taskContext.test.ts`
- Test: 同上

**Interfaces:**
- Consumes: Task 1〜4 のすべて
- Produces: なし

**背景（実装者向け）:** issue #45 の完了条件は2つ。

1. 計画を `.doctrine-out/plan.md` に書かせるワークフローで、approval の時点で `task.context` から計画の本文が取れる
2. 2回差し戻したタスクで、両方のレビューが返る

`test/daemon/handlers.test.ts` の組み立て（`context()` / `createHandler` / `makeRepo` / `tick` / `until`）を使い、本物の git リポジトリと worktree の上で回す。

`.doctrine-out/` は `createWorktree` が `.git/info/exclude` に入れるので、計画ファイルを書いても `hasUncommittedChanges` に引っかからない。

- [ ] **Step 1: テストを書く**

`test/integration/taskContext.test.ts` を新規作成する。

```ts
import { afterEach, beforeEach, test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/db/migrate.ts";
import { getTask } from "../../src/db/tasks.ts";
import {
  createHandler,
  type DaemonContext,
  loadWorkflowFromDisk,
  tick,
} from "../../src/daemon/handlers.ts";
import { createMockAdapter } from "../../src/adapter/mock.ts";
import type { ServerEvent } from "../../src/daemon/protocol.ts";
import { makeRepo, until } from "../helpers/repo.ts";
import type { ReviewFile } from "../../src/core/reviewFiles.ts";
import type { CommandResult, ReviewEntry } from "../../src/core/taskContext.ts";

const NOOP_CONN = { follow() {}, unfollow() {}, isFollowing: () => false };
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "doctrine-taskctx-e2e-"));
  process.env.DOCTRINE_STATE_DIR = join(root, "state");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  delete process.env.DOCTRINE_STATE_DIR;
});

/** 計画を .doctrine-out/plan.md に書き、その計画を承認させるワークフロー。 */
const GUIDED = `
name: guided
steps:
  - id: plan
    type: command
    run: "mkdir -p .doctrine-out && printf '# 計画\\n\\n1. 引当をトランザクションに入れる\\n' > .doctrine-out/plan.md"
  - id: plan-approval
    type: approval
    title: "計画を確認してください"
    onReject:
      goto: plan
      maxAttempts: 5
    review:
      files:
        - .doctrine-out/plan.md
`;

async function context() {
  const db = await openDb(":memory:");
  const events: ServerEvent[] = [];
  const ctx: DaemonContext = {
    db,
    adapter: createMockAdapter({ result: { ok: true, text: "やりました" } }),
    logRoot: join(root, "logs"),
    globalLimit: 4,
    broadcast: (ev) => events.push(ev),
    loadWorkflow: loadWorkflowFromDisk,
    running: new Set(),
    warnings: [],
  };
  return { ctx, handler: createHandler(ctx) };
}

type Got = {
  prompt: string;
  reviews: ReviewEntry[];
  lastCommand: CommandResult | null;
  lastAgentMessage: string | null;
  reviewFiles: ReviewFile[];
};

test("approval の時点で task.context から計画の本文が取れる（完了条件1）", async () => {
  const repo = await makeRepo(root, {
    "README.md": "x\n",
    ".doctrine/project.yaml": "defaultWorkflow: guided\nmaxConcurrent: 1\nbaseBranch: main\n",
    ".doctrine/workflows/guided.yaml": GUIDED,
  });
  const { ctx, handler } = await context();
  await handler("project.add", { path: repo }, NOOP_CONN);
  const t = await handler(
    "task.create",
    { project: repo, title: "在庫の引当", prompt: "在庫の引当を冪等にして" },
    NOOP_CONN,
  ) as { id: string };

  await tick(ctx);
  await until(
    async () => (await getTask(ctx.db, t.id))?.state === "suspended",
    5000,
    "計画の承認待ちに到達すること",
  );

  const got = await handler("task.context", { task_id: t.id }, NOOP_CONN) as Got;

  assert.equal(got.prompt, "在庫の引当を冪等にして");
  assert.equal(got.reviewFiles.length, 1);
  const [plan] = got.reviewFiles;
  assert.equal(plan.path, ".doctrine-out/plan.md");
  assert.equal(plan.status, "ok");
  if (plan.status !== "ok") throw new Error("unreachable");
  assert.match(plan.content, /引当をトランザクションに入れる/);

  assert.equal(got.lastCommand?.stepId, "plan", "直前に走った command の結果も返る");
  assert.equal(got.lastCommand?.exitCode, 0);
});

test("2回差し戻したタスクで、両方のレビューが返る（完了条件2）", async () => {
  const repo = await makeRepo(root, {
    "README.md": "x\n",
    ".doctrine/project.yaml": "defaultWorkflow: guided\nmaxConcurrent: 1\nbaseBranch: main\n",
    ".doctrine/workflows/guided.yaml": GUIDED,
  });
  const { ctx, handler } = await context();
  await handler("project.add", { path: repo }, NOOP_CONN);
  const t = await handler(
    "task.create",
    { project: repo, title: "T", prompt: "やって" },
    NOOP_CONN,
  ) as { id: string };

  const waitSuspended = (label: string) =>
    until(async () => (await getTask(ctx.db, t.id))?.state === "suspended", 5000, label);

  await tick(ctx);
  await waitSuspended("1回目の承認待ち");
  await handler("task.reject", { task_id: t.id, comment: "手順が粗いです" }, NOOP_CONN);

  await tick(ctx);
  await waitSuspended("2回目の承認待ち");
  await handler("task.reject", { task_id: t.id, comment: "ロールバックの話がありません" }, NOOP_CONN);

  await tick(ctx);
  await waitSuspended("3回目の承認待ち");

  const { reviews } = await handler("task.context", { task_id: t.id }, NOOP_CONN) as Got;

  assert.equal(reviews.length, 3, "却下2回 + まだ決まっていない1回");
  assert.deepEqual(reviews.map((r) => r.status), ["rejected", "rejected", "awaiting"]);
  assert.deepEqual(reviews.map((r) => r.attempt), [1, 2, 3]);
  assert.deepEqual(
    reviews.filter((r) => r.status === "rejected").map((r) => r.comment),
    ["手順が粗いです", "ロールバックの話がありません"],
    "2回目の却下が1回目を上書きしていない",
  );

  for (const r of reviews) {
    if (r.status === "awaiting") {
      assert.equal("endedAt" in r, false, "待機中の回に決定時刻は無い");
      continue;
    }
    assert.ok(
      Date.parse(r.endedAt) >= Date.parse(r.startedAt),
      "待ち時間は endedAt - startedAt で出せる",
    );
  }
});
```

- [ ] **Step 2: テストを流す**

Run: `deno test --allow-all test/integration/taskContext.test.ts`
Expected: PASS

`run` は `sh -c` に渡される（`src/core/stepRunner.ts`）ので、`&&` もリダイレクトもそのまま効く。

- [ ] **Step 3: 全体を流す**

Run: `deno task check && deno task test && deno fmt --check src test && deno lint`
Expected: PASS

- [ ] **Step 4: コミット**

```bash
deno fmt src test
git add test/integration/taskContext.test.ts
git commit -m "test: issue #45 の完了条件を本物の worktree で確かめる (#45)"
```

---

## 完了の確認

- [ ] `deno task check && deno task test` が通る
- [ ] `deno fmt --check src test && deno lint` が通る
- [ ] `cd app && pnpm build && pnpm test` が通る
- [ ] **完了条件1**: 計画を `.doctrine-out/plan.md` に書かせるワークフローで、approval の時点で `task.context` から計画の本文が取れる
- [ ] **完了条件2**: 2回差し戻したタスクで、両方のレビューが返る
- [ ] `grep -rn 'steps\.[a-z-]*\.\(stdout\|stderr\)' README.md docs/ src/ test/` が何も返さない
- [ ] `task.context` が issue の挙げた5つ（元の指示・レビュー履歴・直近の command の結果・エージェントの最後の発言・宣言されたファイル）をすべて返す
