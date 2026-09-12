# doctrine コア（サブプロジェクト①）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ローカルの `dctld` デーモンが、YAMLで宣言されたワークフローに沿って Claude Code を spawn し、実行枠・worktree・承認待ちを管理しながらタスクを進行させる。UIなしで完結し、`dctl` CLI とテストから全機能を検証できる状態にする。

**Architecture:** 常駐デーモン + Unixソケットクライアント。権威ある状態はSQLite1箇所（`tasks` / `step_runs`）。ステップ境界ごとに1トランザクションで書き、落ちても失うのは最大1ステップ。Claude Code はアダプタ境界の裏に隔離し、エンジンのテストはモックアダプタで実APIを叩かずに行う。

**Tech Stack:** TypeScript + Node.js 24（ネイティブ型ストリッピングで `.ts` を直接実行）、`node:sqlite`、`node:net`（Unixドメインソケット）、ランタイム依存は `yaml` と `zod` のみ、テストは vitest、ビルドは `tsc`、パッケージマネージャは pnpm、ツールチェーンは mise。

**Spec:** `docs/superpowers/specs/2026-09-12-agent-orchestrator-core-design.md`

**関連:** `docs/overview.md`（プロダクト概要。①のスコープの外側を定義）

## Global Constraints

spec から逐語で持ってきた、全タスクに暗黙に掛かる制約。

- **ランタイム**: TypeScript + Node.js 24（`mise.toml` で `node = "24.14.1"` に固定済み）
- **依存パッケージは2つだけ**: `yaml`（パース）、`zod`（検証）。他を追加しない
- **テスト**: vitest（devDependency）。ランタイム依存は増やさない（配布物は yaml と zod のみ）
- **ビルド**: `tsc` のみ。バンドラ・トランスパイラを追加しない
- **パッケージマネージャ**: pnpm。lockfile は `pnpm-lock.yaml` をコミットし、インストールは `pnpm install --frozen-lockfile`
- **永続化**: SQLite（`node:sqlite`、WALモード）。Node 24 では experimental 警告が出るが動作する
- **IPC**: Unixドメインソケット + 改行区切りJSON。**TCPポートは開かない**
- **名前**: CLI は `dctl`、デーモンは `dctld`、プロジェクト設定は `<project>/.doctrine/`
- **パス**:
  - ログ: `~/.local/state/doctrine/logs/<task-id>/<step-id>.<attempt>.log`
  - worktree: `~/.local/state/doctrine/worktrees/<project>/<task-id>`
  - ソケット: `$XDG_RUNTIME_DIR/doctrine/dctld.sock`
  - ブランチ: `doctrine/<task-id>-<slug>`
- **Claude Code の起動フラグ**（v2.1.269 で実測確認済みの契約。1つでも欠けると実行時にしか壊れない）:
  ```
  claude -p '<prompt>' --output-format stream-json --verbose
    --session-id <UUID> --permission-mode <指定> --permission-prompts none --model <指定>
  ```
  - `--output-format stream-json` は `-p` 併用時 `--verbose` 必須
  - `--session-id` は**我々が採番する**。出力からパースしない
  - `--permission-prompts none` は headless でハングしないための必須フラグ
  - `--fork-session` は使わない
- **耐久性**: ステップ境界ごとに `tasks` の更新と `step_runs` の挿入を**1トランザクション**で書く
- **エージェントセッションはタスク単位**（`tasks.claude_session_id` が1つ）。ステップごとに役割の違うエージェントを置く設計は①のスコープ外
- **①のスコープ外**（タスクが手を伸ばし始めたら spec から逸脱している合図）: タスク間の依存関係、レート消費率による枠の自動制御、外部イベント待ちのステップ型、定期起動トリガ、UI

---

## ファイル構成

実装前にここで責務の境界を固定する。1ファイル1責務、変更が一緒に起きるものを一緒に置く。

```
package.json                  pnpm/スクリプト定義
tsconfig.json                 tsc 設定（型ストリッピング互換）
vitest.config.ts              テスト設定（forks プール）
src/
  workflow/
    schema.ts                 ワークフローYAMLの型と zod スキーマ、検証規則
    project.ts                project.yaml の型・検証・setup ステップの自動挿入
    template.ts               変数展開（4系統のみ）
  db/
    migrate.ts                DDL適用、WALモード設定
    tasks.ts                  tasks テーブルの読み書き
    stepRuns.ts               step_runs / step_outputs の読み書き
    boundary.ts               ステップ境界の1トランザクション書き込み
    rateLimits.ts             rate_limit_samples の読み書き
  core/
    states.ts                 7状態・遷移規則・枠の占有判定（純粋関数）
    scheduler.ts              2スコープの実行枠と受付順
    worktree.ts               git worktree の作成・後始末・孤児照合
    stepRunner.ts             ステップ1回の実行（command / agent / approval）
    engine.ts                 ステップ進行と onFailure / onReject の分岐
    recovery.ts               クラッシュ復帰（古い子プロセスの掃除と再開）
  adapter/
    types.ts                  AgentRun / AgentResult / AgentAdapter の契約
    ndjson.ts                 行長無制限のNDJSON読み取り
    claude.ts                 Claude Code アダプタ本体
    mock.ts                   テスト用のモックアダプタ
  daemon/
    protocol.ts               リクエスト/レスポンス/イベントの型
    server.ts                 Unixソケットサーバと改行区切りJSONの枠組み
    handlers.ts               API ハンドラ
    main.ts                   dctld エントリポイント
  cli/
    dctl.ts                   デバッグCLI
test/
  workflow/ db/ core/ adapter/ daemon/ integration/
```

---

## Task 1: プロジェクト初期化とワークフロースキーマの検証

ワークフローYAMLを型付きで読み、不正な定義を**その場で落とす**。プロジェクトの足場（package.json / tsconfig / テストの走り方）はこの成果物に必要な分としてここに畳み込む。

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`（追記）
- Create: `src/workflow/schema.ts`
- Test: `test/workflow/schema.test.ts`

**Interfaces:**
- Consumes: なし（最初のタスク）
- Produces:
  ```ts
  export type Branch = { goto: string; maxAttempts: number; feed?: string };
  export type CommandStep = { id: string; type: "command"; run: string; onFailure?: Branch };
  export type AgentStep = { id: string; type: "agent"; prompt: string; permissionMode?: string; model?: string; onFailure?: Branch };
  export type ApprovalStep = { id: string; type: "approval"; title: string; onReject?: Branch };
  export type Step = CommandStep | AgentStep | ApprovalStep;
  export type Workflow = { name: string; steps: Step[] };
  export class WorkflowValidationError extends Error { readonly issues: string[] }
  export function parseWorkflow(yamlText: string): { workflow: Workflow; warnings: string[] };
  export const RESERVED_STEP_IDS: readonly string[]; // ["setup"]
  ```

- [ ] **Step 1: 足場を作る**

`package.json`:

```json
{
  "name": "doctrine",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24" },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "build": "tsc",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "yaml": "^2.6.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "typescript": "^5.7.0",
    "vitest": "^2.1.0"
  }
}
```

`tsconfig.json`（Node 24 のネイティブ型ストリッピングで `.ts` を直接実行するため、消去可能な構文だけに制限する。`enum` と `namespace` は使えない）:

```json
{
  "compilerOptions": {
    "target": "es2023",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,
    "allowImportingTsExtensions": true,
    "rewriteRelativeImportExtensions": true,
    "outDir": "dist",
    "rootDir": ".",
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

相対importは**必ず `.ts` 拡張子つき**で書く（`tsc` のビルドと、デーモンを
`node src/daemon/main.ts` で直接起動するときのネイティブ型ストリッピングの両方が要求する）。

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // 各テストファイルが別プロセスで走る。
    // process.env を書き換えるテスト（DOCTRINE_STATE_DIR）と、
    // 子プロセス・Unixソケットを掴むテストが互いに干渉しない。
    pool: "forks",
    testTimeout: 15_000,
  },
});
```

アサーションは `node:assert/strict` をそのまま使う（vitest の `expect` は使わない）。
テストランナーを替えてもアサーションの書き方が変わらない方が、後で困らない。

```bash
pnpm install
```

- [ ] **Step 2: 失敗するテストを書く**

`test/workflow/schema.test.ts`:

```ts
import { test } from "vitest";
import assert from "node:assert/strict";
import { parseWorkflow, WorkflowValidationError } from "../../src/workflow/schema.ts";

const VALID = `
name: feature
steps:
  - id: implement
    type: agent
    prompt: "{{ task.prompt }}"
    permissionMode: acceptEdits
  - id: test
    type: command
    run: pnpm test
    onFailure:
      goto: implement
      maxAttempts: 3
      feed: "テストが失敗した"
  - id: review
    type: approval
    title: "差分を確認してください"
    onReject:
      goto: implement
      maxAttempts: 5
`;

test("3つのステップ型をパースする", () => {
  const { workflow } = parseWorkflow(VALID);
  assert.equal(workflow.name, "feature");
  assert.deepEqual(workflow.steps.map((s) => s.type), ["agent", "command", "approval"]);
  assert.equal(workflow.steps[1].onFailure?.goto, "implement");
});

test("ステップidが重複したら落とす", () => {
  const yaml = `
name: dup
steps:
  - id: a
    type: command
    run: "true"
  - id: a
    type: command
    run: "true"
`;
  assert.throws(() => parseWorkflow(yaml), (e: unknown) => {
    assert.ok(e instanceof WorkflowValidationError);
    assert.match(e.issues.join("\n"), /重複.*a/);
    return true;
  });
});

test("予約語 setup をステップidにしたら落とす", () => {
  const yaml = `
name: bad
steps:
  - id: setup
    type: command
    run: "true"
`;
  assert.throws(() => parseWorkflow(yaml), (e: unknown) => {
    assert.ok(e instanceof WorkflowValidationError);
    assert.match(e.issues.join("\n"), /setup.*予約/);
    return true;
  });
});

test("goto の飛び先が存在しなければ落とす", () => {
  const yaml = `
name: bad
steps:
  - id: a
    type: command
    run: "true"
    onFailure:
      goto: nowhere
      maxAttempts: 2
`;
  assert.throws(() => parseWorkflow(yaml), (e: unknown) => {
    assert.ok(e instanceof WorkflowValidationError);
    assert.match(e.issues.join("\n"), /nowhere/);
    return true;
  });
});

test("非冪等なコマンドは警告するが落とさない", () => {
  const yaml = `
name: pr
steps:
  - id: open-pr
    type: command
    run: gh pr create --fill
`;
  const { workflow, warnings } = parseWorkflow(yaml);
  assert.equal(workflow.steps.length, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /open-pr/);
  assert.match(warnings[0], /再実行/);
});

test("ステップが空なら落とす", () => {
  assert.throws(() => parseWorkflow("name: empty\nsteps: []\n"), WorkflowValidationError);
});
```

- [ ] **Step 3: テストが落ちることを確認する**

Run: `pnpm test test/workflow/schema.test.ts`
Expected: FAIL（`Cannot find module '../../src/workflow/schema.ts'`）

- [ ] **Step 4: 最小の実装を書く**

`src/workflow/schema.ts`:

```ts
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export type Branch = { goto: string; maxAttempts: number; feed?: string };
export type CommandStep = { id: string; type: "command"; run: string; onFailure?: Branch };
export type AgentStep = {
  id: string; type: "agent"; prompt: string;
  permissionMode?: string; model?: string; onFailure?: Branch;
};
export type ApprovalStep = { id: string; type: "approval"; title: string; onReject?: Branch };
export type Step = CommandStep | AgentStep | ApprovalStep;
export type Workflow = { name: string; steps: Step[] };

export const RESERVED_STEP_IDS = ["setup"] as const;

/** 再実行で二重に効く代表的なコマンド。完全には防げないが、黙って壊れるよりよい。 */
const NON_IDEMPOTENT = [
  /\bgh\s+pr\s+create\b/, /\bgh\s+release\s+create\b/,
  /\bgit\s+push\b/, /\bnpm\s+publish\b/, /\bpnpm\s+publish\b/,
];

export class WorkflowValidationError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`ワークフロー定義が不正です:\n- ${issues.join("\n- ")}`);
    this.name = "WorkflowValidationError";
    this.issues = issues;
  }
}

const stepId = z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/, "ステップidは英数字・ハイフン・アンダースコアのみ");
const branch = z.object({
  goto: z.string().min(1),
  maxAttempts: z.number().int().min(1),
  feed: z.string().optional(),
}).strict();

const stepSchema = z.discriminatedUnion("type", [
  z.object({ id: stepId, type: z.literal("command"), run: z.string().min(1), onFailure: branch.optional() }).strict(),
  z.object({
    id: stepId, type: z.literal("agent"), prompt: z.string().min(1),
    permissionMode: z.string().optional(), model: z.string().optional(), onFailure: branch.optional(),
  }).strict(),
  z.object({ id: stepId, type: z.literal("approval"), title: z.string().min(1), onReject: branch.optional() }).strict(),
]);

const workflowSchema = z.object({
  name: z.string().min(1),
  steps: z.array(stepSchema).min(1, "steps は1つ以上必要です"),
}).strict();

function branchOf(step: Step): Branch | undefined {
  return step.type === "approval" ? step.onReject : step.onFailure;
}

export function parseWorkflow(yamlText: string): { workflow: Workflow; warnings: string[] } {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (e) {
    throw new WorkflowValidationError([`YAMLとして読めません: ${(e as Error).message}`]);
  }

  const parsed = workflowSchema.safeParse(raw);
  if (!parsed.success) {
    throw new WorkflowValidationError(
      parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    );
  }
  const workflow = parsed.data as Workflow;

  const issues: string[] = [];
  const seen = new Set<string>();
  for (const step of workflow.steps) {
    if (seen.has(step.id)) issues.push(`ステップidが重複しています: ${step.id}`);
    seen.add(step.id);
    if ((RESERVED_STEP_IDS as readonly string[]).includes(step.id)) {
      issues.push(`ステップid "${step.id}" は予約語です（project.yaml の setup が自動挿入されます）`);
    }
  }
  for (const step of workflow.steps) {
    const b = branchOf(step);
    if (b && !seen.has(b.goto)) {
      issues.push(`ステップ "${step.id}" の goto が存在しないステップを指しています: ${b.goto}`);
    }
  }
  if (issues.length > 0) throw new WorkflowValidationError(issues);

  const warnings: string[] = [];
  for (const step of workflow.steps) {
    if (step.type !== "command") continue;
    if (NON_IDEMPOTENT.some((re) => re.test(step.run))) {
      warnings.push(
        `ステップ "${step.id}" のコマンドは再実行で二重に効く可能性があります: ${step.run}\n` +
        `  クラッシュ復帰時、command ステップは頭から再実行されます。`,
      );
    }
  }
  return { workflow, warnings };
}
```

- [ ] **Step 5: テストが通ることを確認する**

Run: `pnpm test test/workflow/schema.test.ts`
Expected: PASS（6件）

- [ ] **Step 6: 型チェック**

Run: `pnpm typecheck`
Expected: エラーなし

- [ ] **Step 7: コミット**

```bash
git add package.json pnpm-lock.yaml tsconfig.json vitest.config.ts src/workflow/schema.ts test/workflow/schema.test.ts
git commit -m "feat: ワークフローYAMLのスキーマ検証"
```

---

## Task 2: project.yaml の検証と setup ステップの自動挿入

**Files:**
- Create: `src/workflow/project.ts`
- Test: `test/workflow/project.test.ts`

**Interfaces:**
- Consumes: `Workflow`, `Step`, `WorkflowValidationError`（Task 1）
- Produces:
  ```ts
  export type ProjectConfig = {
    setup?: string; defaultWorkflow: string; maxConcurrent: number; baseBranch: string;
  };
  export function parseProjectConfig(yamlText: string): ProjectConfig;
  export function withSetupStep(workflow: Workflow, setup: string | undefined): Workflow;
  ```

- [ ] **Step 1: 失敗するテストを書く**

`test/workflow/project.test.ts`:

```ts
import { test } from "vitest";
import assert from "node:assert/strict";
import { parseProjectConfig, withSetupStep } from "../../src/workflow/project.ts";
import { parseWorkflow, WorkflowValidationError } from "../../src/workflow/schema.ts";

test("project.yaml を既定値つきで読む", () => {
  const cfg = parseProjectConfig(`
setup: pnpm install --frozen-lockfile
defaultWorkflow: feature
maxConcurrent: 1
baseBranch: main
`);
  assert.deepEqual(cfg, {
    setup: "pnpm install --frozen-lockfile",
    defaultWorkflow: "feature",
    maxConcurrent: 1,
    baseBranch: "main",
  });
});

test("maxConcurrent と baseBranch には既定値がある", () => {
  const cfg = parseProjectConfig("defaultWorkflow: feature\n");
  assert.equal(cfg.maxConcurrent, 1);
  assert.equal(cfg.baseBranch, "main");
  assert.equal(cfg.setup, undefined);
});

test("maxConcurrent が0以下なら落とす", () => {
  assert.throws(() => parseProjectConfig("defaultWorkflow: f\nmaxConcurrent: 0\n"), WorkflowValidationError);
});

test("setup があればワークフローの先頭に command ステップとして挿入する", () => {
  const { workflow } = parseWorkflow("name: f\nsteps:\n  - id: a\n    type: command\n    run: \"true\"\n");
  const out = withSetupStep(workflow, "pnpm install --frozen-lockfile");
  assert.equal(out.steps.length, 2);
  assert.equal(out.steps[0].id, "setup");
  assert.equal(out.steps[0].type, "command");
  assert.equal((out.steps[0] as { run: string }).run, "pnpm install --frozen-lockfile");
  assert.equal(out.steps[1].id, "a");
});

test("setup がなければワークフローをそのまま返す", () => {
  const { workflow } = parseWorkflow("name: f\nsteps:\n  - id: a\n    type: command\n    run: \"true\"\n");
  const out = withSetupStep(workflow, undefined);
  assert.deepEqual(out, workflow);
});

test("setup 挿入は元のワークフローを破壊しない", () => {
  const { workflow } = parseWorkflow("name: f\nsteps:\n  - id: a\n    type: command\n    run: \"true\"\n");
  withSetupStep(workflow, "echo hi");
  assert.equal(workflow.steps.length, 1);
});
```

- [ ] **Step 2: テストが落ちることを確認する**

Run: `pnpm test test/workflow/project.test.ts`
Expected: FAIL（`Cannot find module '../../src/workflow/project.ts'`）

- [ ] **Step 3: 実装を書く**

`src/workflow/project.ts`:

```ts
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { WorkflowValidationError, type CommandStep, type Workflow } from "./schema.ts";

export type ProjectConfig = {
  setup?: string;
  defaultWorkflow: string;
  maxConcurrent: number;
  baseBranch: string;
};

const schema = z.object({
  setup: z.string().min(1).optional(),
  defaultWorkflow: z.string().min(1),
  maxConcurrent: z.number().int().min(1).default(1),
  baseBranch: z.string().min(1).default("main"),
}).strict();

export function parseProjectConfig(yamlText: string): ProjectConfig {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (e) {
    throw new WorkflowValidationError([`YAMLとして読めません: ${(e as Error).message}`]);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new WorkflowValidationError(
      parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    );
  }
  return parsed.data;
}

/** setup は新しい概念ではなく、ただの command ステップに名前が付いたもの。 */
export function withSetupStep(workflow: Workflow, setup: string | undefined): Workflow {
  if (!setup) return workflow;
  const step: CommandStep = { id: "setup", type: "command", run: setup };
  return { ...workflow, steps: [step, ...workflow.steps] };
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `pnpm test test/workflow/project.test.ts`
Expected: PASS（6件）

- [ ] **Step 5: コミット**

```bash
git add src/workflow/project.ts test/workflow/project.test.ts
git commit -m "feat: project.yaml の検証と setup ステップの自動挿入"
```

---

## Task 3: 変数展開

`{{ ... }}` の展開。系統は4つだけで、未知の変数は**静かに空文字にせず落とす**（ワークフローのtypoが実行時まで潜るのを防ぐ）。

**Files:**
- Create: `src/workflow/template.ts`
- Test: `test/workflow/template.test.ts`

**Interfaces:**
- Consumes: なし
- Produces:
  ```ts
  export type TemplateContext = {
    task: { id: string; title: string; prompt: string; branch: string };
    worktree: { path: string };
    project: { path: string };
    steps: Record<string, { stdout: string; stderr: string; exitCode: string }>;
  };
  export class TemplateError extends Error {}
  export function expand(template: string, ctx: TemplateContext): string;
  ```

- [ ] **Step 1: 失敗するテストを書く**

`test/workflow/template.test.ts`:

```ts
import { test } from "vitest";
import assert from "node:assert/strict";
import { expand, TemplateError, type TemplateContext } from "../../src/workflow/template.ts";

const ctx: TemplateContext = {
  task: { id: "t1", title: "ログイン修正", prompt: "直して", branch: "doctrine/t1-login" },
  worktree: { path: "/state/wt/t1" },
  project: { path: "/repo" },
  steps: { test: { stdout: "ok", stderr: "3 failing", exitCode: "1" } },
};

test("4系統すべてを展開する", () => {
  assert.equal(expand("{{ task.prompt }}", ctx), "直して");
  assert.equal(expand("{{ task.branch }}", ctx), "doctrine/t1-login");
  assert.equal(expand("{{ worktree.path }}", ctx), "/state/wt/t1");
  assert.equal(expand("{{ project.path }}", ctx), "/repo");
  assert.equal(expand("{{ steps.test.stderr }}", ctx), "3 failing");
  assert.equal(expand("{{ steps.test.exitCode }}", ctx), "1");
});

test("空白の有無を問わない", () => {
  assert.equal(expand("{{task.id}}/{{  task.id  }}", ctx), "t1/t1");
});

test("1つの文字列に複数個埋められる", () => {
  assert.equal(expand("テストが失敗した:\n{{ steps.test.stderr }}", ctx), "テストが失敗した:\n3 failing");
});

test("未知の系統は落とす", () => {
  assert.throws(() => expand("{{ env.HOME }}", ctx), (e: unknown) => {
    assert.ok(e instanceof TemplateError);
    assert.match((e as Error).message, /env\.HOME/);
    return true;
  });
});

test("未実行のステップを参照したら落とす", () => {
  assert.throws(() => expand("{{ steps.build.stdout }}", ctx), TemplateError);
});

test("ステップの未知のフィールドは落とす", () => {
  assert.throws(() => expand("{{ steps.test.cost }}", ctx), TemplateError);
});

test("変数を含まない文字列はそのまま返す", () => {
  assert.equal(expand("pnpm test", ctx), "pnpm test");
});
```

- [ ] **Step 2: テストが落ちることを確認する**

Run: `pnpm test test/workflow/template.test.ts`
Expected: FAIL（モジュールが無い）

- [ ] **Step 3: 実装を書く**

`src/workflow/template.ts`:

```ts
export type TemplateContext = {
  task: { id: string; title: string; prompt: string; branch: string };
  worktree: { path: string };
  project: { path: string };
  steps: Record<string, { stdout: string; stderr: string; exitCode: string }>;
};

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateError";
  }
}

const PATTERN = /\{\{\s*([^}]+?)\s*\}\}/g;
const TASK_FIELDS = ["id", "title", "prompt", "branch"] as const;
const STEP_FIELDS = ["stdout", "stderr", "exitCode"] as const;

export function expand(template: string, ctx: TemplateContext): string {
  return template.replace(PATTERN, (_m, expr: string) => resolve(expr.trim(), ctx));
}

function resolve(expr: string, ctx: TemplateContext): string {
  const parts = expr.split(".");
  if (parts[0] === "task" && parts.length === 2
      && (TASK_FIELDS as readonly string[]).includes(parts[1])) {
    return ctx.task[parts[1] as (typeof TASK_FIELDS)[number]];
  }
  if (expr === "worktree.path") return ctx.worktree.path;
  if (expr === "project.path") return ctx.project.path;
  if (parts[0] === "steps" && parts.length === 3) {
    const out = ctx.steps[parts[1]];
    if (!out) {
      throw new TemplateError(
        `{{ ${expr} }}: ステップ "${parts[1]}" の出力がありません（まだ実行されていないか、idが違います）`,
      );
    }
    if (!(STEP_FIELDS as readonly string[]).includes(parts[2])) {
      throw new TemplateError(
        `{{ ${expr} }}: ステップ出力のフィールドは ${STEP_FIELDS.join(" / ")} のみです`,
      );
    }
    return out[parts[2] as (typeof STEP_FIELDS)[number]];
  }
  throw new TemplateError(
    `{{ ${expr} }}: 使える変数は task.* / worktree.path / project.path / steps.<id>.* のみです`,
  );
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `pnpm test test/workflow/template.test.ts`
Expected: PASS（7件）

- [ ] **Step 5: コミット**

```bash
git add src/workflow/template.ts test/workflow/template.test.ts
git commit -m "feat: ワークフロー変数の展開"
```

---

## Task 4: DBスキーマとステップ境界の1トランザクション書き込み

耐久性の保証がここに乗る。**`tasks` の更新と `step_runs` の挿入が1トランザクションで書かれること**が、このタスクの本当の成果物である。

`child_pid` / `child_started_at` はTask 11（クラッシュ復帰）が使う列だが、**スキーマはここで作る**。後から足すと復帰のテスト対象が存在しない。

**Files:**
- Create: `src/db/migrate.ts`, `src/db/tasks.ts`, `src/db/stepRuns.ts`, `src/db/boundary.ts`, `src/db/rateLimits.ts`
- Test: `test/db/migrate.test.ts`, `test/db/boundary.test.ts`

**Interfaces:**
- Consumes: なし
- Produces:
  ```ts
  // migrate.ts
  export function openDb(path: string): DatabaseSync;   // WAL + foreign_keys ON + migrate 済み
  // tasks.ts
  export type TaskState = "queued"|"running"|"suspended"|"paused"|"completed"|"failed"|"canceled";
  export type TaskRow = {
    id: string; project_id: number; title: string; prompt: string; workflow_name: string;
    state: TaskState; current_step_id: string | null; attempt_counts: string;
    branch: string; worktree_path: string | null; claude_session_id: string | null;
    child_pid: number | null; child_started_at: string | null;
    priority: number; resumed: number; created_at: string; updated_at: string;
  };
  export function insertProject(db: DatabaseSync, p: { path: string; default_workflow: string; max_concurrent: number; base_branch: string; setup: string | null }): number;
  export function getProject(db: DatabaseSync, id: number): ProjectRow | undefined;
  export function listProjects(db: DatabaseSync): ProjectRow[];
  export function insertTask(db: DatabaseSync, t: NewTask): TaskRow;
  export function getTask(db: DatabaseSync, id: string): TaskRow | undefined;
  export function listTasks(db: DatabaseSync, filter?: { projectId?: number; state?: TaskState }): TaskRow[];
  export function attemptCount(task: TaskRow, stepId: string): number;
  // stepRuns.ts
  export type StepRunStatus = "running"|"success"|"failed"|"degraded";
  export type StepRunRow = { id: number; task_id: string; step_id: string; attempt: number; status: StepRunStatus; exit_code: number | null; started_at: string; ended_at: string | null; log_path: string; cost_usd: number | null; num_turns: number | null; duration_ms: number | null };
  export function listStepRuns(db: DatabaseSync, taskId: string): StepRunRow[];
  export function getStepOutputs(db: DatabaseSync, taskId: string): Record<string, { stdout: string; stderr: string; exitCode: string }>;
  // boundary.ts
  export type StepBoundary = {
    taskId: string;
    taskPatch: Partial<Pick<TaskRow, "state"|"current_step_id"|"attempt_counts"|"worktree_path"|"claude_session_id"|"child_pid"|"child_started_at"|"resumed">>;
    /** ステップ開始時に status: "running" / ended_at: null で挿入する。 */
    stepRun?: { step_id: string; attempt: number; status: StepRunStatus; exit_code: number | null; started_at: string; ended_at: string | null; log_path: string; cost_usd?: number | null; num_turns?: number | null; duration_ms?: number | null };
    /** ステップ終了時に、開始時に得た id の行を同じトランザクションで更新する。 */
    stepRunUpdate?: { id: number; status: StepRunStatus; exit_code: number | null; ended_at: string; cost_usd?: number | null; num_turns?: number | null; duration_ms?: number | null };
    outputs?: { step_id: string; stdout: string; stderr: string; exit_code: number | null };
  };
  /** stepRun を挿入した場合はその step_runs.id を返す（イベントが載せる id）。無ければ null。 */
  export function commitStepBoundary(db: DatabaseSync, b: StepBoundary): number | null;
  export const OUTPUT_TAIL_BYTES: number; // 8192
  // rateLimits.ts
  export function insertRateLimitSample(db: DatabaseSync, s: { window: string; utilization: number; resets_at: string | null }): void;
  export function recentRateLimitSamples(db: DatabaseSync, limit: number): RateLimitRow[];
  ```

- [ ] **Step 1: 失敗するテストを書く**

`test/db/migrate.test.ts`:

```ts
import { test } from "vitest";
import assert from "node:assert/strict";
import { openDb } from "../../src/db/migrate.ts";
import { insertProject, insertTask, getTask, listTasks } from "../../src/db/tasks.ts";

function db() {
  return openDb(":memory:");
}

function seed(d: ReturnType<typeof db>) {
  return insertProject(d, {
    path: "/repo", default_workflow: "feature", max_concurrent: 1, base_branch: "main", setup: null,
  });
}

test("マイグレーションで5つのテーブルができる", () => {
  const d = db();
  const names = d.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all().map((r) => (r as { name: string }).name);
  for (const t of ["projects", "rate_limit_samples", "step_outputs", "step_runs", "tasks"]) {
    assert.ok(names.includes(t), `${t} が無い: ${names.join(",")}`);
  }
});

test("タスクは queued で作られる", () => {
  const d = db();
  const pid = seed(d);
  const t = insertTask(d, {
    id: "t1", project_id: pid, title: "T", prompt: "P",
    workflow_name: "feature", branch: "doctrine/t1-t", priority: 2,
  });
  assert.equal(t.state, "queued");
  assert.equal(t.worktree_path, null);
  assert.equal(t.child_pid, null);
  assert.equal(t.resumed, 0);
  assert.equal(getTask(d, "t1")?.title, "T");
});

test("state でフィルタできる", () => {
  const d = db();
  const pid = seed(d);
  insertTask(d, { id: "t1", project_id: pid, title: "a", prompt: "p", workflow_name: "f", branch: "b1", priority: 2 });
  insertTask(d, { id: "t2", project_id: pid, title: "b", prompt: "p", workflow_name: "f", branch: "b2", priority: 2 });
  d.prepare("UPDATE tasks SET state='running' WHERE id='t2'").run();
  assert.deepEqual(listTasks(d, { state: "queued" }).map((t) => t.id), ["t1"]);
});

test("同じidのタスクは作れない", () => {
  const d = db();
  const pid = seed(d);
  insertTask(d, { id: "t1", project_id: pid, title: "a", prompt: "p", workflow_name: "f", branch: "b1", priority: 2 });
  assert.throws(() => insertTask(d, { id: "t1", project_id: pid, title: "a", prompt: "p", workflow_name: "f", branch: "b1", priority: 2 }));
});
```

`test/db/boundary.test.ts`:

```ts
import { test } from "vitest";
import assert from "node:assert/strict";
import { openDb } from "../../src/db/migrate.ts";
import { insertProject, insertTask, getTask } from "../../src/db/tasks.ts";
import { listStepRuns, getStepOutputs } from "../../src/db/stepRuns.ts";
import { commitStepBoundary, OUTPUT_TAIL_BYTES } from "../../src/db/boundary.ts";

function fixture() {
  const d = openDb(":memory:");
  const pid = insertProject(d, { path: "/repo", default_workflow: "f", max_concurrent: 1, base_branch: "main", setup: null });
  insertTask(d, { id: "t1", project_id: pid, title: "T", prompt: "P", workflow_name: "f", branch: "b", priority: 2 });
  return d;
}

test("タスク更新とステップ実行記録が同時に書かれる", () => {
  const d = fixture();
  commitStepBoundary(d, {
    taskId: "t1",
    taskPatch: { state: "running", current_step_id: "test" },
    stepRun: {
      step_id: "test", attempt: 1, status: "success", exit_code: 0,
      started_at: "2026-09-12T00:00:00Z", ended_at: "2026-09-12T00:00:01Z",
      log_path: "/logs/t1/test.1.log",
    },
    outputs: { step_id: "test", stdout: "ok", stderr: "", exit_code: 0 },
  });
  assert.equal(getTask(d, "t1")?.current_step_id, "test");
  assert.equal(listStepRuns(d, "t1").length, 1);
  assert.equal(getStepOutputs(d, "t1").test.stdout, "ok");
  assert.equal(getStepOutputs(d, "t1").test.exitCode, "0");
});

test("ステップ実行の挿入が失敗したらタスク更新も巻き戻る", () => {
  const d = fixture();
  assert.throws(() => commitStepBoundary(d, {
    taskId: "t1",
    taskPatch: { state: "running" },
    // 存在しないタスクIDの step_run は外部キーで弾かれる
    stepRun: {
      step_id: "x", attempt: 1, status: "success", exit_code: 0,
      started_at: "a", ended_at: "b", log_path: "/l",
    },
    outputs: undefined,
    // @ts-expect-error テストのために不正なタスクIDを注入する
    __forceStepTaskId: "missing",
  }));
  assert.equal(getTask(d, "t1")?.state, "queued");
});

test("開始時に running で挿入し、終了時に同じ行を更新する", () => {
  const d = fixture();
  const id = commitStepBoundary(d, {
    taskId: "t1", taskPatch: { state: "running", current_step_id: "test" },
    stepRun: { step_id: "test", attempt: 1, status: "running", exit_code: null,
               started_at: "2026-09-12T00:00:00Z", ended_at: null, log_path: "/l" },
  })!;
  assert.equal(listStepRuns(d, "t1")[0].status, "running");
  commitStepBoundary(d, {
    taskId: "t1", taskPatch: {},
    stepRunUpdate: { id, status: "success", exit_code: 0, ended_at: "2026-09-12T00:00:05Z" },
    outputs: { step_id: "test", stdout: "ok", stderr: "", exit_code: 0 },
  });
  const rows = listStepRuns(d, "t1");
  assert.equal(rows.length, 1, "行は増えない");
  assert.equal(rows[0].status, "success");
  assert.equal(rows[0].ended_at, "2026-09-12T00:00:05Z");
});

test("ステップ実行のidを返す（イベントが載せる id）", () => {
  const d = fixture();
  const id = commitStepBoundary(d, {
    taskId: "t1", taskPatch: {},
    stepRun: { step_id: "test", attempt: 1, status: "success", exit_code: 0, started_at: "a", ended_at: "b", log_path: "/l" },
  });
  assert.equal(id, listStepRuns(d, "t1")[0].id);
  assert.equal(commitStepBoundary(d, { taskId: "t1", taskPatch: { state: "running" } }), null);
});

test("同じステップの2回目の出力は上書きされる", () => {
  const d = fixture();
  const base = { step_id: "test", attempt: 1, status: "failed" as const, exit_code: 1, started_at: "a", ended_at: "b", log_path: "/l" };
  commitStepBoundary(d, { taskId: "t1", taskPatch: {}, stepRun: base, outputs: { step_id: "test", stdout: "1回目", stderr: "", exit_code: 1 } });
  commitStepBoundary(d, { taskId: "t1", taskPatch: {}, stepRun: { ...base, attempt: 2, status: "success", exit_code: 0 }, outputs: { step_id: "test", stdout: "2回目", stderr: "", exit_code: 0 } });
  assert.equal(getStepOutputs(d, "t1").test.stdout, "2回目");
  assert.equal(listStepRuns(d, "t1").length, 2);
});

test("巨大な出力は末尾だけ保存する", () => {
  const d = fixture();
  const huge = "x".repeat(OUTPUT_TAIL_BYTES * 3) + "END";
  commitStepBoundary(d, {
    taskId: "t1", taskPatch: {},
    stepRun: { step_id: "test", attempt: 1, status: "success", exit_code: 0, started_at: "a", ended_at: "b", log_path: "/l" },
    outputs: { step_id: "test", stdout: huge, stderr: "", exit_code: 0 },
  });
  const saved = getStepOutputs(d, "t1").test.stdout;
  assert.ok(saved.length <= OUTPUT_TAIL_BYTES + 3);
  assert.ok(saved.endsWith("END"));
});
```

- [ ] **Step 2: テストが落ちることを確認する**

Run: `pnpm test test/db/`
Expected: FAIL（モジュールが無い）

- [ ] **Step 3: マイグレーションを書く**

`src/db/migrate.ts`:

```ts
import { DatabaseSync } from "node:sqlite";

const DDL = `
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  default_workflow TEXT NOT NULL,
  max_concurrent INTEGER NOT NULL DEFAULT 1,
  base_branch TEXT NOT NULL DEFAULT 'main',
  setup TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  workflow_name TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN
    ('queued','running','suspended','paused','completed','failed','canceled')),
  current_step_id TEXT,
  attempt_counts TEXT NOT NULL DEFAULT '{}',
  branch TEXT NOT NULL,
  worktree_path TEXT,
  claude_session_id TEXT,
  child_pid INTEGER,
  child_started_at TEXT,
  priority INTEGER NOT NULL DEFAULT 2,
  resumed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id, state);

CREATE TABLE IF NOT EXISTS step_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  step_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','success','failed','degraded')),
  exit_code INTEGER,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  log_path TEXT NOT NULL,
  cost_usd REAL,
  num_turns INTEGER,
  duration_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_step_runs_task ON step_runs(task_id, id);

CREATE TABLE IF NOT EXISTS step_outputs (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  step_id TEXT NOT NULL,
  stdout TEXT NOT NULL,
  stderr TEXT NOT NULL,
  exit_code INTEGER,
  PRIMARY KEY (task_id, step_id)
);

CREATE TABLE IF NOT EXISTS rate_limit_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  observed_at TEXT NOT NULL,
  window TEXT NOT NULL,
  utilization REAL NOT NULL,
  resets_at TEXT
);
`;

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(DDL);
  return db;
}
```

- [ ] **Step 4: テーブルアクセサを書く**

`src/db/tasks.ts`:

```ts
import type { DatabaseSync } from "node:sqlite";

export type TaskState =
  | "queued" | "running" | "suspended" | "paused" | "completed" | "failed" | "canceled";

export type ProjectRow = {
  id: number; path: string; default_workflow: string;
  max_concurrent: number; base_branch: string; setup: string | null;
};

export type TaskRow = {
  id: string; project_id: number; title: string; prompt: string; workflow_name: string;
  state: TaskState; current_step_id: string | null; attempt_counts: string;
  branch: string; worktree_path: string | null; claude_session_id: string | null;
  child_pid: number | null; child_started_at: string | null;
  priority: number; resumed: number; created_at: string; updated_at: string;
};

export type NewTask = {
  id: string; project_id: number; title: string; prompt: string;
  workflow_name: string; branch: string; priority: number;
};

export function insertProject(db: DatabaseSync, p: Omit<ProjectRow, "id">): number {
  const r = db.prepare(
    `INSERT INTO projects (path, default_workflow, max_concurrent, base_branch, setup)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(p.path, p.default_workflow, p.max_concurrent, p.base_branch, p.setup);
  return Number(r.lastInsertRowid);
}

export function getProject(db: DatabaseSync, id: number): ProjectRow | undefined {
  return db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
}

export function getProjectByPath(db: DatabaseSync, path: string): ProjectRow | undefined {
  return db.prepare("SELECT * FROM projects WHERE path = ?").get(path) as ProjectRow | undefined;
}

export function listProjects(db: DatabaseSync): ProjectRow[] {
  return db.prepare("SELECT * FROM projects ORDER BY id").all() as ProjectRow[];
}

export function insertTask(db: DatabaseSync, t: NewTask): TaskRow {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO tasks (id, project_id, title, prompt, workflow_name, state,
                        branch, priority, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
  ).run(t.id, t.project_id, t.title, t.prompt, t.workflow_name, t.branch, t.priority, now, now);
  return getTask(db, t.id)!;
}

export function getTask(db: DatabaseSync, id: string): TaskRow | undefined {
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
}

export function listTasks(
  db: DatabaseSync,
  filter: { projectId?: number; state?: TaskState } = {},
): TaskRow[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (filter.projectId !== undefined) { where.push("project_id = ?"); args.push(filter.projectId); }
  if (filter.state !== undefined) { where.push("state = ?"); args.push(filter.state); }
  const sql = `SELECT * FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""}
               ORDER BY created_at, id`;
  return db.prepare(sql).all(...args) as TaskRow[];
}

export function attemptCount(task: TaskRow, stepId: string): number {
  const counts = JSON.parse(task.attempt_counts) as Record<string, number>;
  return counts[stepId] ?? 0;
}

export function withAttempt(task: TaskRow, stepId: string): string {
  const counts = JSON.parse(task.attempt_counts) as Record<string, number>;
  counts[stepId] = (counts[stepId] ?? 0) + 1;
  return JSON.stringify(counts);
}
```

`src/db/stepRuns.ts`:

```ts
import type { DatabaseSync } from "node:sqlite";

export type StepRunStatus = "running" | "success" | "failed" | "degraded";

export type StepRunRow = {
  id: number; task_id: string; step_id: string; attempt: number;
  status: StepRunStatus; exit_code: number | null;
  started_at: string; ended_at: string | null; log_path: string;
  cost_usd: number | null; num_turns: number | null; duration_ms: number | null;
};

export function listStepRuns(db: DatabaseSync, taskId: string): StepRunRow[] {
  return db.prepare("SELECT * FROM step_runs WHERE task_id = ? ORDER BY id")
    .all(taskId) as StepRunRow[];
}

export function getStepRun(db: DatabaseSync, id: number): StepRunRow | undefined {
  return db.prepare("SELECT * FROM step_runs WHERE id = ?").get(id) as StepRunRow | undefined;
}

/** 変数展開に渡す形（exitCode は文字列。テンプレートは文字列しか返さない）。 */
export function getStepOutputs(
  db: DatabaseSync, taskId: string,
): Record<string, { stdout: string; stderr: string; exitCode: string }> {
  const rows = db.prepare("SELECT step_id, stdout, stderr, exit_code FROM step_outputs WHERE task_id = ?")
    .all(taskId) as { step_id: string; stdout: string; stderr: string; exit_code: number | null }[];
  const out: Record<string, { stdout: string; stderr: string; exitCode: string }> = {};
  for (const r of rows) {
    out[r.step_id] = { stdout: r.stdout, stderr: r.stderr, exitCode: String(r.exit_code ?? "") };
  }
  return out;
}
```

- [ ] **Step 5: ステップ境界を書く**

`src/db/boundary.ts`:

```ts
import type { DatabaseSync } from "node:sqlite";
import type { TaskRow } from "./tasks.ts";
import type { StepRunStatus } from "./stepRuns.ts";

/** DBに残す出力の上限。ログ本文はファイル、DBは末尾だけ。 */
export const OUTPUT_TAIL_BYTES = 8192;

export type StepBoundary = {
  taskId: string;
  taskPatch: Partial<Pick<TaskRow,
    "state" | "current_step_id" | "attempt_counts" | "worktree_path" |
    "claude_session_id" | "child_pid" | "child_started_at" | "resumed">>;
  /** ステップ開始時: status "running" / ended_at null で挿入し、返り値の id を持っておく。 */
  stepRun?: {
    step_id: string; attempt: number; status: StepRunStatus; exit_code: number | null;
    started_at: string; ended_at: string | null; log_path: string;
    cost_usd?: number | null; num_turns?: number | null; duration_ms?: number | null;
  };
  /** ステップ終了時: 開始時の行を同じトランザクションで更新する。 */
  stepRunUpdate?: {
    id: number; status: StepRunStatus; exit_code: number | null; ended_at: string;
    cost_usd?: number | null; num_turns?: number | null; duration_ms?: number | null;
  };
  outputs?: { step_id: string; stdout: string; stderr: string; exit_code: number | null };
};

function tail(s: string): string {
  return s.length <= OUTPUT_TAIL_BYTES ? s : s.slice(-OUTPUT_TAIL_BYTES);
}

/**
 * タスクの更新・ステップ実行記録・出力を1トランザクションで書く。
 * 落ちて失うのは最大1ステップ分、という保証がここに乗っている。
 */
export function commitStepBoundary(db: DatabaseSync, b: StepBoundary): number | null {
  db.exec("BEGIN IMMEDIATE");
  let stepRunId: number | null = null;
  try {
    const patch = { ...b.taskPatch };
    const keys = Object.keys(patch);
    const sets = [...keys.map((k) => `${k} = ?`), "updated_at = ?"];
    const values = [...keys.map((k) => (patch as Record<string, unknown>)[k]), new Date().toISOString()];
    db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`)
      .run(...(values as (string | number | null)[]), b.taskId);

    if (b.stepRun) {
      const s = b.stepRun;
      const inserted = db.prepare(
        `INSERT INTO step_runs (task_id, step_id, attempt, status, exit_code,
                                started_at, ended_at, log_path, cost_usd, num_turns, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(b.taskId, s.step_id, s.attempt, s.status, s.exit_code,
            s.started_at, s.ended_at, s.log_path,
            s.cost_usd ?? null, s.num_turns ?? null, s.duration_ms ?? null);
      stepRunId = Number(inserted.lastInsertRowid);
    }

    if (b.stepRunUpdate) {
      const u = b.stepRunUpdate;
      db.prepare(
        `UPDATE step_runs SET status = ?, exit_code = ?, ended_at = ?,
                              cost_usd = ?, num_turns = ?, duration_ms = ?
         WHERE id = ?`,
      ).run(u.status, u.exit_code, u.ended_at,
            u.cost_usd ?? null, u.num_turns ?? null, u.duration_ms ?? null, u.id);
      stepRunId = u.id;
    }

    if (b.outputs) {
      const o = b.outputs;
      db.prepare(
        `INSERT INTO step_outputs (task_id, step_id, stdout, stderr, exit_code)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (task_id, step_id) DO UPDATE SET
           stdout = excluded.stdout, stderr = excluded.stderr, exit_code = excluded.exit_code`,
      ).run(b.taskId, o.step_id, tail(o.stdout), tail(o.stderr), o.exit_code);
    }
    db.exec("COMMIT");
    return stepRunId;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
```

`src/db/rateLimits.ts`:

```ts
import type { DatabaseSync } from "node:sqlite";

export type RateLimitRow = {
  id: number; observed_at: string; window: string; utilization: number; resets_at: string | null;
};

export function insertRateLimitSample(
  db: DatabaseSync, s: { window: string; utilization: number; resets_at: string | null },
): void {
  db.prepare(
    "INSERT INTO rate_limit_samples (observed_at, window, utilization, resets_at) VALUES (?, ?, ?, ?)",
  ).run(new Date().toISOString(), s.window, s.utilization, s.resets_at);
}

export function recentRateLimitSamples(db: DatabaseSync, limit: number): RateLimitRow[] {
  return db.prepare("SELECT * FROM rate_limit_samples ORDER BY id DESC LIMIT ?")
    .all(limit) as RateLimitRow[];
}
```

- [ ] **Step 6: テストを直して通す**

`boundary.test.ts` の「巻き戻る」テストは、`__forceStepTaskId` のような裏口ではなく **存在しないタスクIDへの境界書き込み**で書き直す（外部キー違反でトランザクション全体が巻き戻ることを確認する）:

```ts
test("ステップ実行の挿入が失敗したらタスク更新も巻き戻る", () => {
  const d = fixture();
  assert.throws(() => commitStepBoundary(d, {
    taskId: "missing-task",
    taskPatch: { state: "running" },
    stepRun: {
      step_id: "x", attempt: 1, status: "success", exit_code: 0,
      started_at: "a", ended_at: "b", log_path: "/l",
    },
  }));
  assert.equal(getTask(d, "t1")?.state, "queued");
});
```

Run: `pnpm test test/db/`
Expected: PASS（8件）

- [ ] **Step 7: コミット**

```bash
git add src/db test/db
git commit -m "feat: SQLiteスキーマとステップ境界の1トランザクション書き込み"
```

---

## Task 5: 状態機械（7状態と枠の占有判定）

I/Oを持たない純粋関数。**枠の占有がスコープごとに非対称である**という中心的な判断が、ここの2つの関数に落ちる。

**Files:**
- Create: `src/core/states.ts`
- Test: `test/core/states.test.ts`

**Interfaces:**
- Consumes: `TaskState`（Task 4）
- Produces:
  ```ts
  export function canTransition(from: TaskState, to: TaskState): boolean;
  export function assertTransition(from: TaskState, to: TaskState): void; // throws InvalidTransitionError
  export function holdsGlobalSlot(s: TaskState): boolean;   // running のみ
  export function holdsProjectSlot(s: TaskState): boolean;  // running / suspended / paused
  export function isTerminal(s: TaskState): boolean;
  export class InvalidTransitionError extends Error {}
  ```

- [ ] **Step 1: 失敗するテストを書く**

`test/core/states.test.ts`:

```ts
import { test } from "vitest";
import assert from "node:assert/strict";
import {
  canTransition, assertTransition, holdsGlobalSlot, holdsProjectSlot,
  isTerminal, InvalidTransitionError,
} from "../../src/core/states.ts";

test("正常系の遷移を許す", () => {
  assert.ok(canTransition("queued", "running"));
  assert.ok(canTransition("running", "suspended"));
  assert.ok(canTransition("running", "paused"));
  assert.ok(canTransition("suspended", "queued"));
  assert.ok(canTransition("paused", "queued"));
  assert.ok(canTransition("running", "completed"));
  assert.ok(canTransition("running", "failed"));
  assert.ok(canTransition("queued", "canceled"));
  assert.ok(canTransition("suspended", "canceled"));
});

test("終端状態からは動かない", () => {
  for (const from of ["completed", "failed", "canceled"] as const) {
    for (const to of ["queued", "running", "suspended", "paused"] as const) {
      assert.equal(canTransition(from, to), false, `${from} -> ${to}`);
    }
  }
});

test("queued から直接 suspended にはならない", () => {
  assert.equal(canTransition("queued", "suspended"), false);
});

test("不正な遷移は例外を投げる", () => {
  assert.throws(() => assertTransition("completed", "running"), InvalidTransitionError);
  assert.doesNotThrow(() => assertTransition("queued", "running"));
});

test("全体枠を握るのは running だけ", () => {
  assert.ok(holdsGlobalSlot("running"));
  for (const s of ["queued", "suspended", "paused", "completed", "failed", "canceled"] as const) {
    assert.equal(holdsGlobalSlot(s), false, s);
  }
});

test("プロジェクト枠は suspended / paused でも保持される", () => {
  for (const s of ["running", "suspended", "paused"] as const) {
    assert.ok(holdsProjectSlot(s), s);
  }
  for (const s of ["queued", "completed", "failed", "canceled"] as const) {
    assert.equal(holdsProjectSlot(s), false, s);
  }
});

test("終端判定", () => {
  assert.ok(isTerminal("completed") && isTerminal("failed") && isTerminal("canceled"));
  assert.equal(isTerminal("queued"), false);
});
```

- [ ] **Step 2: テストが落ちることを確認する**

Run: `pnpm test test/core/states.test.ts`
Expected: FAIL（モジュールが無い）

- [ ] **Step 3: 実装を書く**

`src/core/states.ts`:

```ts
import type { TaskState } from "../db/tasks.ts";

const TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  queued: ["running", "paused", "canceled"],
  running: ["suspended", "paused", "completed", "failed", "canceled", "queued"],
  suspended: ["queued", "canceled", "failed"],
  paused: ["queued", "canceled"],
  completed: [],
  failed: [],
  canceled: [],
};

export class InvalidTransitionError extends Error {
  constructor(from: TaskState, to: TaskState) {
    super(`不正な状態遷移です: ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export function canTransition(from: TaskState, to: TaskState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: TaskState, to: TaskState): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

/** 全体枠の理由はマシン負荷とAPIコスト。人を待っている間は何も消費していない。 */
export function holdsGlobalSlot(s: TaskState): boolean {
  return s === "running";
}

/**
 * プロジェクト枠の理由は同一リポジトリでのマージ困難。
 * suspended / paused のタスクは worktree とブランチを生かしたままなので、理由が消えていない。
 */
export function holdsProjectSlot(s: TaskState): boolean {
  return s === "running" || s === "suspended" || s === "paused";
}

export function isTerminal(s: TaskState): boolean {
  return s === "completed" || s === "failed" || s === "canceled";
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `pnpm test test/core/states.test.ts`
Expected: PASS（7件）

- [ ] **Step 5: コミット**

```bash
git add src/core/states.ts test/core/states.test.ts
git commit -m "feat: タスク状態機械と枠占有の判定"
```

---

## Task 6: スケジューラ（2スコープの実行枠と受付順）

**枠の占有数はカウンタで持たず、`running` を数えて導出する。** 飢餓が起きないことがこのタスクの検証対象。

**Files:**
- Create: `src/core/scheduler.ts`
- Test: `test/core/scheduler.test.ts`

**Interfaces:**
- Consumes: `TaskRow`, `listTasks`（Task 4）、`holdsGlobalSlot` / `holdsProjectSlot`（Task 5）
- Produces:
  ```ts
  export const DEFAULT_GLOBAL_LIMIT: number;  // 4
  export type SlotUsage = { global: number; byProject: Map<number, number> };
  export function currentUsage(db: DatabaseSync): SlotUsage;
  export function selectAdmissible(db: DatabaseSync, globalLimit?: number): TaskRow[];
  ```

- [ ] **Step 1: 失敗するテストを書く**

`test/core/scheduler.test.ts`:

```ts
import { test } from "vitest";
import assert from "node:assert/strict";
import { openDb } from "../../src/db/migrate.ts";
import { insertProject, insertTask } from "../../src/db/tasks.ts";
import { selectAdmissible, currentUsage } from "../../src/core/scheduler.ts";
import type { DatabaseSync } from "node:sqlite";

function fixture(maxConcurrent = 1) {
  const d = openDb(":memory:");
  const p = insertProject(d, {
    path: "/repo", default_workflow: "f", max_concurrent: maxConcurrent, base_branch: "main", setup: null,
  });
  return { d, p };
}

function add(d: DatabaseSync, p: number, id: string, opts: { priority?: number; state?: string; resumed?: number; createdAt?: string } = {}) {
  insertTask(d, { id, project_id: p, title: id, prompt: "x", workflow_name: "f", branch: `b/${id}`, priority: opts.priority ?? 2 });
  if (opts.state) d.prepare("UPDATE tasks SET state = ? WHERE id = ?").run(opts.state, id);
  if (opts.resumed) d.prepare("UPDATE tasks SET resumed = 1 WHERE id = ?").run(id);
  if (opts.createdAt) d.prepare("UPDATE tasks SET created_at = ? WHERE id = ?").run(opts.createdAt, id);
}

test("枠が空いていれば queued を返す", () => {
  const { d, p } = fixture();
  add(d, p, "t1");
  assert.deepEqual(selectAdmissible(d).map((t) => t.id), ["t1"]);
});

test("プロジェクト枠が埋まっていれば返さない", () => {
  const { d, p } = fixture(1);
  add(d, p, "running1", { state: "running" });
  add(d, p, "t2");
  assert.deepEqual(selectAdmissible(d), []);
});

test("suspended はプロジェクト枠を握り続ける（飢餓が起きない）", () => {
  const { d, p } = fixture(1);
  add(d, p, "waiting", { state: "suspended" });
  add(d, p, "newcomer");
  assert.deepEqual(selectAdmissible(d), [],
    "承認待ちのタスクがいる間、同じプロジェクトの新規タスクは割り込めない");
});

test("paused もプロジェクト枠を握り続ける", () => {
  const { d, p } = fixture(1);
  add(d, p, "held", { state: "paused" });
  add(d, p, "newcomer");
  assert.deepEqual(selectAdmissible(d), []);
});

test("suspended は全体枠を握らない", () => {
  const { d, p } = fixture(1);
  const p2 = insertProject(d, { path: "/other", default_workflow: "f", max_concurrent: 1, base_branch: "main", setup: null });
  for (const id of ["a", "b", "c", "d"]) add(d, p, id, { state: "suspended" });
  add(d, p2, "other");
  assert.deepEqual(selectAdmissible(d, 4).map((t) => t.id), ["other"],
    "4本が承認待ちでも全体枠は空いている");
});

test("全体枠の上限を超えて返さない", () => {
  const d = openDb(":memory:");
  const projects = [1, 2, 3, 4, 5].map((n) =>
    insertProject(d, { path: `/p${n}`, default_workflow: "f", max_concurrent: 1, base_branch: "main", setup: null }));
  projects.forEach((p, i) => add(d, p, `t${i}`));
  assert.equal(selectAdmissible(d, 4).length, 4);
});

test("再開したタスクが行列の先頭に入る", () => {
  const d = openDb(":memory:");
  const p1 = insertProject(d, { path: "/a", default_workflow: "f", max_concurrent: 1, base_branch: "main", setup: null });
  const p2 = insertProject(d, { path: "/b", default_workflow: "f", max_concurrent: 1, base_branch: "main", setup: null });
  add(d, p1, "newer", { createdAt: "2026-01-01T00:00:00Z" });
  add(d, p2, "resumed-later", { createdAt: "2026-06-01T00:00:00Z", resumed: 1 });
  assert.deepEqual(selectAdmissible(d, 1).map((t) => t.id), ["resumed-later"],
    "進行中の仕事を新規の仕事より先に終わらせる");
});

test("優先度 → 作成時刻のFIFO", () => {
  const d = openDb(":memory:");
  const ps = ["a", "b", "c"].map((n) =>
    insertProject(d, { path: `/${n}`, default_workflow: "f", max_concurrent: 1, base_branch: "main", setup: null }));
  add(d, ps[0], "p2-old", { priority: 2, createdAt: "2026-01-01T00:00:00Z" });
  add(d, ps[1], "p0-new", { priority: 0, createdAt: "2026-09-01T00:00:00Z" });
  add(d, ps[2], "p2-new", { priority: 2, createdAt: "2026-09-02T00:00:00Z" });
  assert.deepEqual(selectAdmissible(d, 3).map((t) => t.id), ["p0-new", "p2-old", "p2-new"]);
});

test("占有数はカウンタではなく running から導出する", () => {
  const { d, p } = fixture(2);
  add(d, p, "r1", { state: "running" });
  add(d, p, "s1", { state: "suspended" });
  const usage = currentUsage(d);
  assert.equal(usage.global, 1);
  assert.equal(usage.byProject.get(p), 2);
});
```

- [ ] **Step 2: テストが落ちることを確認する**

Run: `pnpm test test/core/scheduler.test.ts`
Expected: FAIL（モジュールが無い）

- [ ] **Step 3: 実装を書く**

`src/core/scheduler.ts`:

```ts
import type { DatabaseSync } from "node:sqlite";
import { listTasks, getProject, type TaskRow } from "../db/tasks.ts";
import { holdsGlobalSlot, holdsProjectSlot } from "./states.ts";

export const DEFAULT_GLOBAL_LIMIT = 4;

export type SlotUsage = { global: number; byProject: Map<number, number> };

/** カウンタは持たない。状態から数える。持てば必ず状態とズレる。 */
export function currentUsage(db: DatabaseSync): SlotUsage {
  const rows = db.prepare(
    "SELECT project_id, state FROM tasks WHERE state IN ('running','suspended','paused')",
  ).all() as { project_id: number; state: TaskRow["state"] }[];

  const usage: SlotUsage = { global: 0, byProject: new Map() };
  for (const r of rows) {
    if (holdsGlobalSlot(r.state)) usage.global += 1;
    if (holdsProjectSlot(r.state)) {
      usage.byProject.set(r.project_id, (usage.byProject.get(r.project_id) ?? 0) + 1);
    }
  }
  return usage;
}

/**
 * 受付順: 再開したタスク → 優先度（小さいほど優先） → 作成時刻のFIFO。
 * 両スコープに空きがあるタスクだけを、上限いっぱいまで返す。
 */
export function selectAdmissible(
  db: DatabaseSync, globalLimit: number = DEFAULT_GLOBAL_LIMIT,
): TaskRow[] {
  const usage = currentUsage(db);
  let globalFree = globalLimit - usage.global;
  if (globalFree <= 0) return [];

  const queued = db.prepare(
    `SELECT * FROM tasks WHERE state = 'queued'
     ORDER BY resumed DESC, priority ASC, created_at ASC, id ASC`,
  ).all() as TaskRow[];

  const admitted: TaskRow[] = [];
  const projectUsed = new Map(usage.byProject);
  for (const task of queued) {
    if (globalFree <= 0) break;
    const project = getProject(db, task.project_id);
    if (!project) continue;
    const used = projectUsed.get(task.project_id) ?? 0;
    if (used >= project.max_concurrent) continue;
    admitted.push(task);
    projectUsed.set(task.project_id, used + 1);
    globalFree -= 1;
  }
  return admitted;
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `pnpm test test/core/scheduler.test.ts`
Expected: PASS（9件）

- [ ] **Step 5: コミット**

```bash
git add src/core/scheduler.ts test/core/scheduler.test.ts
git commit -m "feat: 2スコープの実行枠スケジューラ"
```

---

## Task 7: worktree ライフサイクル

**成功と失敗で後始末を変える**のがこのタスクの核心。テストは実際の git リポジトリを一時ディレクトリに作って回す（gitの挙動をモックしても意味がない）。

**Files:**
- Create: `src/core/worktree.ts`
- Test: `test/core/worktree.test.ts`

**Interfaces:**
- Consumes: なし
- Produces:
  ```ts
  export function stateDir(): string;         // $DOCTRINE_STATE_DIR ?? ~/.local/state/doctrine
  export function worktreePathFor(projectPath: string, taskId: string): string;
  export function branchNameFor(taskId: string, title: string): string; // doctrine/<id>-<slug>
  export function slugify(title: string): string;
  export function createWorktree(o: { repoPath: string; worktreePath: string; branch: string; baseBranch: string }): Promise<void>;
  export function hasUncommittedChanges(worktreePath: string): Promise<boolean>;
  export function removeWorktree(o: { repoPath: string; worktreePath: string; force: boolean }): Promise<void>;
  export function listWorktrees(repoPath: string): Promise<string[]>;
  export function findOrphans(repoPath: string, knownPaths: string[]): Promise<string[]>;
  export class UncommittedChangesError extends Error {}
  ```

- [ ] **Step 1: 失敗するテストを書く**

`test/core/worktree.test.ts`:

```ts
import { test, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorktree, removeWorktree, hasUncommittedChanges, findOrphans,
  branchNameFor, slugify, UncommittedChangesError,
} from "../../src/core/worktree.ts";

const run = promisify(execFile);
let repo: string;
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "doctrine-test-"));
  repo = join(root, "repo");
  await run("git", ["init", "-b", "main", repo]);
  await run("git", ["-C", repo, "config", "user.email", "t@example.com"]);
  await run("git", ["-C", repo, "config", "user.name", "t"]);
  await writeFile(join(repo, "README.md"), "hi\n");
  await run("git", ["-C", repo, "add", "."]);
  await run("git", ["-C", repo, "commit", "-m", "init"]);
});

afterEach(async () => { await rm(root, { recursive: true, force: true }); });

test("ブランチ名を作る", () => {
  assert.equal(branchNameFor("abc123", "ログイン画面を直す"), "doctrine/abc123-ログイン画面を直す");
  assert.equal(slugify("Fix the login screen!"), "fix-the-login-screen");
  assert.equal(slugify("  a///b  "), "a-b");
  assert.ok(slugify("x".repeat(100)).length <= 40);
});

test("baseBranch から worktree とブランチを生やす", async () => {
  const wt = join(root, "wt", "t1");
  await createWorktree({ repoPath: repo, worktreePath: wt, branch: "doctrine/t1-x", baseBranch: "main" });
  assert.ok((await stat(join(wt, "README.md"))).isFile());
  const { stdout } = await run("git", ["-C", wt, "rev-parse", "--abbrev-ref", "HEAD"]);
  assert.equal(stdout.trim(), "doctrine/t1-x");
});

test("worktree はリポジトリの外に作られる", async () => {
  const wt = join(root, "wt", "t1");
  await createWorktree({ repoPath: repo, worktreePath: wt, branch: "doctrine/t1-x", baseBranch: "main" });
  assert.equal(wt.startsWith(repo), false);
});

test("未コミットの変更を検出する", async () => {
  const wt = join(root, "wt", "t1");
  await createWorktree({ repoPath: repo, worktreePath: wt, branch: "doctrine/t1-x", baseBranch: "main" });
  assert.equal(await hasUncommittedChanges(wt), false);
  await writeFile(join(wt, "dirty.txt"), "x");
  assert.equal(await hasUncommittedChanges(wt), true);
});

test("未コミットの変更があるとき force なしの削除は拒否する", async () => {
  const wt = join(root, "wt", "t1");
  await createWorktree({ repoPath: repo, worktreePath: wt, branch: "doctrine/t1-x", baseBranch: "main" });
  await writeFile(join(wt, "dirty.txt"), "x");
  await assert.rejects(
    () => removeWorktree({ repoPath: repo, worktreePath: wt, force: false }),
    UncommittedChangesError,
  );
  assert.ok((await stat(wt)).isDirectory());
});

test("force なら汚れた worktree も削除する", async () => {
  const wt = join(root, "wt", "t1");
  await createWorktree({ repoPath: repo, worktreePath: wt, branch: "doctrine/t1-x", baseBranch: "main" });
  await writeFile(join(wt, "dirty.txt"), "x");
  await removeWorktree({ repoPath: repo, worktreePath: wt, force: true });
  await assert.rejects(() => stat(wt));
});

test("worktree を削除してもブランチは残る", async () => {
  const wt = join(root, "wt", "t1");
  await createWorktree({ repoPath: repo, worktreePath: wt, branch: "doctrine/t1-x", baseBranch: "main" });
  await removeWorktree({ repoPath: repo, worktreePath: wt, force: false });
  const { stdout } = await run("git", ["-C", repo, "branch", "--list", "doctrine/t1-x"]);
  assert.match(stdout, /doctrine\/t1-x/);
});

test("DBに対応のない worktree を孤児として報告する", async () => {
  const known = join(root, "wt", "known");
  const orphan = join(root, "wt", "orphan");
  await createWorktree({ repoPath: repo, worktreePath: known, branch: "doctrine/a", baseBranch: "main" });
  await createWorktree({ repoPath: repo, worktreePath: orphan, branch: "doctrine/b", baseBranch: "main" });
  const orphans = await findOrphans(repo, [known]);
  assert.deepEqual(orphans, [orphan]);
});
```

- [ ] **Step 2: テストが落ちることを確認する**

Run: `pnpm test test/core/worktree.test.ts`
Expected: FAIL（モジュールが無い）

- [ ] **Step 3: 実装を書く**

`src/core/worktree.ts`:

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

const run = promisify(execFile);

export class UncommittedChangesError extends Error {
  constructor(public readonly worktreePath: string) {
    super(`未コミットの変更が残っています: ${worktreePath}`);
    this.name = "UncommittedChangesError";
  }
}

/** テストから差し替えられるよう環境変数を見る。 */
export function stateDir(): string {
  return process.env.DOCTRINE_STATE_DIR ?? join(homedir(), ".local", "state", "doctrine");
}

export function worktreePathFor(projectPath: string, taskId: string): string {
  return join(stateDir(), "worktrees", basename(projectPath), taskId);
}

export function slugify(title: string): string {
  return title
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 40);
}

export function branchNameFor(taskId: string, title: string): string {
  const slug = slugify(title);
  return slug ? `doctrine/${taskId}-${slug}` : `doctrine/${taskId}`;
}

/** 作成は自前の git worktree add。ライフサイクルの権威を1箇所に保つ。 */
export async function createWorktree(o: {
  repoPath: string; worktreePath: string; branch: string; baseBranch: string;
}): Promise<void> {
  await run("git", ["-C", o.repoPath, "worktree", "add", "-b", o.branch, o.worktreePath, o.baseBranch]);
}

export async function hasUncommittedChanges(worktreePath: string): Promise<boolean> {
  const { stdout } = await run("git", ["-C", worktreePath, "status", "--porcelain"]);
  return stdout.trim().length > 0;
}

/**
 * completed の後始末はここを force なしで呼ぶ。未コミットの変更が残っていたら
 * 削除を拒否する — ワークフローの書き方のバグであり、黙って消してよいものではない。
 */
export async function removeWorktree(o: {
  repoPath: string; worktreePath: string; force: boolean;
}): Promise<void> {
  if (!o.force && await hasUncommittedChanges(o.worktreePath)) {
    throw new UncommittedChangesError(o.worktreePath);
  }
  const args = ["-C", o.repoPath, "worktree", "remove", o.worktreePath];
  if (o.force) args.push("--force");
  await run("git", args);
}

export async function listWorktrees(repoPath: string): Promise<string[]> {
  const { stdout } = await run("git", ["-C", repoPath, "worktree", "list", "--porcelain"]);
  const paths: string[] = [];
  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) paths.push(line.slice("worktree ".length).trim());
  }
  // 先頭はメインの作業ツリー自身なので除く
  return paths.filter((p) => resolve(p) !== resolve(repoPath));
}

/** 自動削除はしない。見つけて報告するだけ。 */
export async function findOrphans(repoPath: string, knownPaths: string[]): Promise<string[]> {
  const known = new Set(knownPaths.map((p) => resolve(p)));
  return (await listWorktrees(repoPath)).filter((p) => !known.has(resolve(p)));
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `pnpm test test/core/worktree.test.ts`
Expected: PASS（8件）

最初のテストの `branchNameFor` の期待値は実装の `slugify`（NFKC正規化・非英数をハイフン化）に合わせて素直に書き直してよい。日本語タイトルの扱いを実装で確認してから期待値を確定させること。

- [ ] **Step 5: コミット**

```bash
git add src/core/worktree.ts test/core/worktree.test.ts
git commit -m "feat: worktree の作成・後始末・孤児照合"
```

---

## Task 8: Claude Code アダプタ

spec 6章の実測契約をコードにする。**行長に上限を仮定しない読み取り**と、**`result` 行を権威とする終了判定**が核心。`permission_denials` が空でない実行は `degraded` として上に伝える（ここで止めない）。

**Files:**
- Create: `src/adapter/types.ts`, `src/adapter/ndjson.ts`, `src/adapter/claude.ts`, `src/adapter/mock.ts`
- Test: `test/adapter/ndjson.test.ts`, `test/adapter/claude.test.ts`

**Interfaces:**
- Consumes: なし
- Produces:
  ```ts
  export type AgentEvent =
    | { kind: "system"; subtype: string; raw: unknown }
    | { kind: "assistant"; text: string; raw: unknown }
    | { kind: "rateLimit"; window: string; utilization: number; resetsAt: string | null; raw: unknown }
    | { kind: "result"; raw: unknown };
  export type AgentResult = {
    ok: boolean; degraded: boolean; text: string;
    costUsd: number | null; numTurns: number | null; durationMs: number | null;
    permissionDenials: unknown[]; exitCode: number | null;
  };
  export type AgentRun = {
    sessionId: string; pid: number; startedAt: string;
    events: AsyncIterable<AgentEvent>; result: Promise<AgentResult>; kill(): void;
  };
  export type StartOptions = {
    cwd: string; sessionId: string; permissionMode?: string; model?: string;
  };
  export type AgentAdapter = {
    start(prompt: string, opts: StartOptions): AgentRun;
    resume(sessionId: string, prompt: string, opts: StartOptions): AgentRun;
  };
  export function readNdjson(stream: Readable): AsyncGenerator<unknown>;
  export function buildArgs(prompt: string, opts: StartOptions, resumeSessionId?: string): string[];
  export function normalize(line: unknown): AgentEvent | null;
  export function createClaudeAdapter(bin?: string): AgentAdapter;
  export function createMockAdapter(script: MockScript): AgentAdapter; // テスト用
  ```

- [ ] **Step 1: NDJSON読み取りの失敗するテストを書く**

`test/adapter/ndjson.test.ts`:

```ts
import { test } from "vitest";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { readNdjson } from "../../src/adapter/ndjson.ts";

async function collect(chunks: string[]): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const v of readNdjson(Readable.from(chunks))) out.push(v);
  return out;
}

test("1行1JSONを読む", async () => {
  assert.deepEqual(await collect(['{"a":1}\n{"a":2}\n']), [{ a: 1 }, { a: 2 }]);
});

test("チャンク境界が行の途中でも復元する", async () => {
  assert.deepEqual(await collect(['{"a":', '1}\n{"b"', ':2}\n']), [{ a: 1 }, { b: 2 }]);
});

test("行長に上限を仮定しない（1MB超の1行を読む）", async () => {
  const big = "y".repeat(1024 * 1024);
  const out = await collect([JSON.stringify({ text: big }) + "\n"]);
  assert.equal((out[0] as { text: string }).text.length, big.length);
});

test("最終行に改行がなくても読む", async () => {
  assert.deepEqual(await collect(['{"a":1}']), [{ a: 1 }]);
});

test("空行は飛ばす", async () => {
  assert.deepEqual(await collect(['{"a":1}\n\n\n{"a":2}\n']), [{ a: 1 }, { a: 2 }]);
});

test("壊れた行は飛ばして続きを読む", async () => {
  assert.deepEqual(await collect(['not json\n{"a":1}\n']), [{ a: 1 }]);
});
```

- [ ] **Step 2: テストが落ちることを確認する**

Run: `pnpm test test/adapter/ndjson.test.ts`
Expected: FAIL（モジュールが無い）

- [ ] **Step 3: NDJSON読み取りを実装する**

`src/adapter/ndjson.ts`:

```ts
import type { Readable } from "node:stream";

/**
 * 1行が極端に長くなる（実測では hook_response 行に skill 本文が丸ごと入っていた）。
 * バッファ長に上限を設けず、改行が来るまで貯める。
 */
export async function* readNdjson(stream: Readable): AsyncGenerator<unknown> {
  let buffer = "";
  stream.setEncoding("utf8");
  for await (const chunk of stream) {
    buffer += chunk as string;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const parsed = tryParse(line);
      if (parsed !== undefined) yield parsed;
    }
  }
  const rest = tryParse(buffer);
  if (rest !== undefined) yield rest;
}

function tryParse(line: string): unknown | undefined {
  const t = line.trim();
  if (t === "") return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined; // 壊れた行で読み取り全体を落とさない
  }
}
```

- [ ] **Step 4: 起動フラグと正規化・終了判定のテストを書く**

`test/adapter/claude.test.ts`:

```ts
import { test } from "vitest";
import assert from "node:assert/strict";
import { buildArgs, normalize, resultFrom } from "../../src/adapter/claude.ts";

test("起動フラグは実測した契約どおりに並ぶ", () => {
  const args = buildArgs("やって", {
    cwd: "/wt", sessionId: "11111111-1111-4111-8111-111111111111",
    permissionMode: "acceptEdits", model: "claude-opus-5",
  });
  assert.deepEqual(args, [
    "-p", "やって",
    "--output-format", "stream-json",
    "--verbose",
    "--session-id", "11111111-1111-4111-8111-111111111111",
    "--permission-mode", "acceptEdits",
    "--permission-prompts", "none",
    "--model", "claude-opus-5",
  ]);
});

test("stream-json には必ず --verbose が付く", () => {
  const args = buildArgs("x", { cwd: "/wt", sessionId: "s" });
  const i = args.indexOf("--output-format");
  assert.ok(i !== -1 && args.includes("--verbose"),
    "--verbose がないと 'requires --verbose' で即座に終了する");
});

test("再開は --resume を使い --fork-session を使わない", () => {
  const args = buildArgs("追加で直して", { cwd: "/wt", sessionId: "s1" }, "s1");
  assert.ok(args.includes("--resume"));
  assert.equal(args.includes("--fork-session"), false);
});

test("rate_limit_event を正規化する", () => {
  const ev = normalize({
    type: "rate_limit_event",
    rate_limit_info: {
      status: "allowed", rateLimitType: "five_hour",
      unifiedWindows: {
        five_hour: { utilization: 0.14, resetsAt: "2026-09-12T05:00:00Z" },
        seven_day: { utilization: 0.04, resetsAt: "2026-09-19T00:00:00Z" },
      },
    },
  });
  assert.deepEqual(ev, [
    { kind: "rateLimit", window: "five_hour", utilization: 0.14, resetsAt: "2026-09-12T05:00:00Z" },
    { kind: "rateLimit", window: "seven_day", utilization: 0.04, resetsAt: "2026-09-19T00:00:00Z" },
  ]);
});

test("result 行から成否・テキスト・コストを取る", () => {
  const r = resultFrom({
    type: "result", subtype: "success", is_error: false,
    result: "できました", total_cost_usd: 0.42, num_turns: 7, duration_ms: 12000,
    permission_denials: [], terminal_reason: "completed",
  }, 0);
  assert.equal(r.ok, true);
  assert.equal(r.degraded, false);
  assert.equal(r.text, "できました");
  assert.equal(r.costUsd, 0.42);
  assert.equal(r.numTurns, 7);
  assert.equal(r.durationMs, 12000);
});

test("permission_denials が空でなければ degraded", () => {
  const r = resultFrom({
    type: "result", subtype: "success", is_error: false, result: "やれませんでした",
    permission_denials: [{ tool_name: "Bash" }],
  }, 0);
  assert.equal(r.ok, true, "ワークフローは止めない");
  assert.equal(r.degraded, true, "成功に見えるが何もできていない実行を区別する");
});

test("result 行が来なければ失敗とみなす", () => {
  const r = resultFrom(undefined, 1);
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 1);
});

test("is_error が true なら失敗", () => {
  const r = resultFrom({ type: "result", subtype: "error", is_error: true, result: "だめ" }, 0);
  assert.equal(r.ok, false);
});
```

- [ ] **Step 5: テストが落ちることを確認する**

Run: `pnpm test test/adapter/claude.test.ts`
Expected: FAIL（モジュールが無い）

- [ ] **Step 6: アダプタを実装する**

`src/adapter/types.ts`:

```ts
export type AgentEvent =
  | { kind: "system"; subtype: string }
  | { kind: "assistant"; text: string }
  | { kind: "rateLimit"; window: string; utilization: number; resetsAt: string | null }
  | { kind: "result" };

export type AgentResult = {
  ok: boolean;
  degraded: boolean;
  text: string;
  costUsd: number | null;
  numTurns: number | null;
  durationMs: number | null;
  permissionDenials: unknown[];
  exitCode: number | null;
};

export type StartOptions = {
  cwd: string;
  sessionId: string;
  permissionMode?: string;
  model?: string;
};

export type AgentRun = {
  sessionId: string;
  pid: number;
  startedAt: string;
  events: AsyncIterable<AgentEvent>;
  result: Promise<AgentResult>;
  kill(): void;
};

export type AgentAdapter = {
  start(prompt: string, opts: StartOptions): AgentRun;
  resume(sessionId: string, prompt: string, opts: StartOptions): AgentRun;
};
```

`src/adapter/claude.ts`:

```ts
import { spawn } from "node:child_process";
import { readNdjson } from "./ndjson.ts";
import type { AgentAdapter, AgentEvent, AgentResult, AgentRun, StartOptions } from "./types.ts";

/** spec 6章の実測契約。1つでも欠けると実行時にしか壊れない。 */
export function buildArgs(prompt: string, opts: StartOptions, resumeSessionId?: string): string[] {
  const args = ["-p"];
  if (resumeSessionId) args.push("--resume", resumeSessionId);
  args.push(prompt, "--output-format", "stream-json", "--verbose");
  if (!resumeSessionId) args.push("--session-id", opts.sessionId);
  if (opts.permissionMode) args.push("--permission-mode", opts.permissionMode);
  args.push("--permission-prompts", "none");
  if (opts.model) args.push("--model", opts.model);
  return args;
}

export function normalize(line: unknown): AgentEvent[] {
  if (typeof line !== "object" || line === null) return [];
  const o = line as Record<string, unknown>;
  switch (o.type) {
    case "system":
      return [{ kind: "system", subtype: String(o.subtype ?? "") }];
    case "assistant":
      return [{ kind: "assistant", text: extractText(o) }];
    case "result":
      return [{ kind: "result" }];
    case "rate_limit_event": {
      const info = (o.rate_limit_info ?? {}) as Record<string, unknown>;
      const windows = (info.unifiedWindows ?? {}) as Record<string, { utilization?: number; resetsAt?: string }>;
      return Object.entries(windows).map(([window, w]) => ({
        kind: "rateLimit" as const,
        window,
        utilization: Number(w.utilization ?? 0),
        resetsAt: w.resetsAt ?? null,
      }));
    }
    default:
      return [];
  }
}

function extractText(o: Record<string, unknown>): string {
  const msg = o.message as { content?: { type: string; text?: string }[] } | undefined;
  if (!msg?.content) return "";
  return msg.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
}

/**
 * result 行が権威。終了コードは補助。
 * --permission-prompts none の下では、権限で弾かれた実行も is_error: false で帰ってくる。
 */
export function resultFrom(resultLine: unknown, exitCode: number | null): AgentResult {
  if (typeof resultLine !== "object" || resultLine === null) {
    return {
      ok: false, degraded: false, text: "", costUsd: null, numTurns: null,
      durationMs: null, permissionDenials: [], exitCode,
    };
  }
  const o = resultLine as Record<string, unknown>;
  const denials = Array.isArray(o.permission_denials) ? o.permission_denials : [];
  return {
    ok: o.is_error !== true,
    degraded: denials.length > 0,
    text: typeof o.result === "string" ? o.result : "",
    costUsd: typeof o.total_cost_usd === "number" ? o.total_cost_usd : null,
    numTurns: typeof o.num_turns === "number" ? o.num_turns : null,
    durationMs: typeof o.duration_ms === "number" ? o.duration_ms : null,
    permissionDenials: denials,
    exitCode,
  };
}

export function createClaudeAdapter(bin = "claude"): AgentAdapter {
  function launch(args: string[], opts: StartOptions): AgentRun {
    const child = spawn(bin, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    const startedAt = new Date().toISOString();

    let resultLine: unknown;
    const queue: AgentEvent[] = [];
    let notify: (() => void) | null = null;
    let done = false;

    const pump = (async () => {
      for await (const line of readNdjson(child.stdout)) {
        if ((line as { type?: string }).type === "result") resultLine = line;
        for (const ev of normalize(line)) queue.push(ev);
        notify?.();
      }
      done = true;
      notify?.();
    })();

    const events: AsyncIterable<AgentEvent> = {
      async *[Symbol.asyncIterator]() {
        while (true) {
          while (queue.length > 0) yield queue.shift()!;
          if (done) return;
          await new Promise<void>((r) => { notify = r; });
          notify = null;
        }
      },
    };

    const result = new Promise<AgentResult>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => {
        pump.then(() => resolve(resultFrom(resultLine, code)), reject);
      });
    });

    return {
      sessionId: opts.sessionId,
      pid: child.pid ?? -1,
      startedAt,
      events,
      result,
      kill: () => { child.kill("SIGTERM"); },
    };
  }

  return {
    start: (prompt, opts) => launch(buildArgs(prompt, opts), opts),
    resume: (sessionId, prompt, opts) => launch(buildArgs(prompt, opts, sessionId), opts),
  };
}
```

- [ ] **Step 7: モックアダプタを書く**

エンジンのテストが実APIを叩いたらテストとして成立しない。**この境界の存在理由がこのファイル**である。

`src/adapter/mock.ts`:

```ts
import type { AgentAdapter, AgentEvent, AgentResult, AgentRun, StartOptions } from "./types.ts";

export type MockScript = {
  events?: AgentEvent[];
  result: Partial<AgentResult>;
  /** 呼び出しごとに結果を変えたいとき。start/resume の通算回数で引く。 */
  sequence?: Partial<AgentResult>[];
  delayMs?: number;
};

export type MockAdapter = AgentAdapter & {
  calls: { kind: "start" | "resume"; prompt: string; sessionId: string; opts: StartOptions }[];
};

const DEFAULT: AgentResult = {
  ok: true, degraded: false, text: "", costUsd: 0, numTurns: 1,
  durationMs: 1, permissionDenials: [], exitCode: 0,
};

export function createMockAdapter(script: MockScript): MockAdapter {
  const calls: MockAdapter["calls"] = [];

  function make(kind: "start" | "resume", prompt: string, sessionId: string, opts: StartOptions): AgentRun {
    const n = calls.length;
    calls.push({ kind, prompt, sessionId, opts });
    const partial = script.sequence?.[n] ?? script.result;
    const events = script.events ?? [];
    return {
      sessionId,
      pid: 424242,
      startedAt: new Date().toISOString(),
      events: (async function* () { for (const e of events) yield e; })(),
      result: new Promise((resolve) =>
        setTimeout(() => resolve({ ...DEFAULT, ...partial }), script.delayMs ?? 0)),
      kill: () => {},
    };
  }

  return {
    calls,
    start: (prompt, opts) => make("start", prompt, opts.sessionId, opts),
    resume: (sessionId, prompt, opts) => make("resume", prompt, sessionId, opts),
  };
}
```

- [ ] **Step 8: テストが通ることを確認する**

Run: `pnpm test test/adapter/`
Expected: PASS（14件）

`normalize` は配列を返すので、`claude.test.ts` の `rate_limit_event` のテストは `assert.deepEqual(ev, [...])` のまま通る。他のテストで `normalize` を単体で見る場合も配列で比較すること。

- [ ] **Step 9: 終了コードと `is_error` の対応を実測して spec に追記する**

spec 373-375行に**未確認**として残っている項目。ここで潰す。

```bash
# 成功する実行
claude -p 'say hi' --output-format stream-json --verbose \
  --session-id "$(uuidgen)" --permission-prompts none > /tmp/ok.ndjson; echo "exit=$?"
tail -1 /tmp/ok.ndjson | head -c 400

# 権限で弾かれる実行（permission-prompts none で拒否される操作をさせる）
claude -p 'run `rm -rf /tmp/doctrine-probe` using Bash' --output-format stream-json --verbose \
  --session-id "$(uuidgen)" --permission-mode default --permission-prompts none > /tmp/denied.ndjson; echo "exit=$?"
tail -1 /tmp/denied.ndjson | head -c 800
```

確認できた対応表を spec の該当節に書き戻し、「未確認」の見出しを実測結果に置き換える。
`resultFrom` の扱い（result 行が権威、終了コードは補助）が実測と食い違った場合は、
**spec を直してから実装を直す**こと。

- [ ] **Step 10: コミット**

```bash
git add src/adapter test/adapter docs/superpowers/specs/2026-09-12-agent-orchestrator-core-design.md
git commit -m "feat: Claude Code アダプタとモック、終了コードの実測結果をspecに反映"
```

---

## Task 9: ステップ実行器

ステップ1回を実行し、**ログ本文はファイルに、末尾だけDBに**書く。`degraded` を DB の `step_runs.status` まで運ぶのはこのタスクの責務。子プロセスの pid と開始時刻を `tasks` に記録するのもここ（Task 11 がそれを使う）。

**Files:**
- Create: `src/core/stepRunner.ts`
- Test: `test/core/stepRunner.test.ts`

**Interfaces:**
- Consumes: `Step`（Task 1）、`expand` / `TemplateContext`（Task 3）、`commitStepBoundary`（Task 4）、`AgentAdapter`（Task 8）
- Produces:
  ```ts
  export type StepOutcome = {
    status: "success" | "failed" | "degraded" | "suspended";
    exitCode: number | null; stdout: string; stderr: string;
    costUsd: number | null; numTurns: number | null; durationMs: number | null;
    startedAt: string; endedAt: string; logPath: string;
  };
  export type RunnerDeps = {
    db: DatabaseSync; adapter: AgentAdapter; logRoot: string;
    onChildSpawned?(pid: number, startedAt: string): void;
    onRateLimit?(s: { window: string; utilization: number; resetsAt: string | null }): void;
    onLogLine?(line: string): void;
  };
  export function logPathFor(logRoot: string, taskId: string, stepId: string, attempt: number): string;
  export function runCommandStep(step: CommandStep, ctx: TemplateContext, o: { cwd: string; taskId: string; attempt: number; deps: RunnerDeps }): Promise<StepOutcome>;
  export function runAgentStep(step: AgentStep, ctx: TemplateContext, o: { cwd: string; taskId: string; attempt: number; sessionId: string; resume: boolean; deps: RunnerDeps }): Promise<StepOutcome>;
  ```

- [ ] **Step 1: 失敗するテストを書く**

`test/core/stepRunner.test.ts`:

```ts
import { test, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/db/migrate.ts";
import { runCommandStep, runAgentStep, logPathFor, type RunnerDeps } from "../../src/core/stepRunner.ts";
import { createMockAdapter } from "../../src/adapter/mock.ts";
import type { TemplateContext } from "../../src/workflow/template.ts";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "doctrine-run-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const ctx: TemplateContext = {
  task: { id: "t1", title: "T", prompt: "直して", branch: "doctrine/t1-t" },
  worktree: { path: "/wt" }, project: { path: "/repo" }, steps: {},
};

function deps(over: Partial<RunnerDeps> = {}): RunnerDeps {
  return {
    db: openDb(":memory:"),
    adapter: createMockAdapter({ result: { ok: true, text: "やりました" } }),
    logRoot: join(root, "logs"),
    ...over,
  };
}

test("成功した command は success", async () => {
  const out = await runCommandStep(
    { id: "s", type: "command", run: "echo hello" }, ctx,
    { cwd: root, taskId: "t1", attempt: 1, deps: deps() });
  assert.equal(out.status, "success");
  assert.equal(out.exitCode, 0);
  assert.match(out.stdout, /hello/);
});

test("非0終了でステップ失敗", async () => {
  const out = await runCommandStep(
    { id: "s", type: "command", run: "exit 3" }, ctx,
    { cwd: root, taskId: "t1", attempt: 1, deps: deps() });
  assert.equal(out.status, "failed");
  assert.equal(out.exitCode, 3);
});

test("コマンドの変数は実行前に展開される", async () => {
  const out = await runCommandStep(
    { id: "s", type: "command", run: "echo {{ task.branch }}" }, ctx,
    { cwd: root, taskId: "t1", attempt: 1, deps: deps() });
  assert.match(out.stdout, /doctrine\/t1-t/);
});

test("ログ本文はファイルに書かれる", async () => {
  const d = deps();
  const out = await runCommandStep(
    { id: "s", type: "command", run: "echo ログ行" }, ctx,
    { cwd: root, taskId: "t1", attempt: 2, deps: d });
  assert.equal(out.logPath, logPathFor(d.logRoot, "t1", "s", 2));
  assert.match(await readFile(out.logPath, "utf8"), /ログ行/);
});

test("agent ステップは最終テキストを stdout にする", async () => {
  const adapter = createMockAdapter({ result: { ok: true, text: "できました", costUsd: 0.3, numTurns: 4 } });
  const out = await runAgentStep(
    { id: "a", type: "agent", prompt: "{{ task.prompt }}" }, ctx,
    { cwd: root, taskId: "t1", attempt: 1, sessionId: "s1", resume: false, deps: deps({ adapter }) });
  assert.equal(out.status, "success");
  assert.equal(out.stdout, "できました");
  assert.equal(out.costUsd, 0.3);
  assert.equal(adapter.calls[0].kind, "start");
  assert.equal(adapter.calls[0].prompt, "直して", "プロンプトの変数が展開されている");
});

test("resume: true なら resume が呼ばれる", async () => {
  const adapter = createMockAdapter({ result: { ok: true, text: "続きです" } });
  await runAgentStep(
    { id: "a", type: "agent", prompt: "追加指示" }, ctx,
    { cwd: root, taskId: "t1", attempt: 2, sessionId: "s1", resume: true, deps: deps({ adapter }) });
  assert.equal(adapter.calls[0].kind, "resume");
  assert.equal(adapter.calls[0].sessionId, "s1");
});

test("permission_denials があれば degraded として返る", async () => {
  const adapter = createMockAdapter({ result: { ok: true, degraded: true, text: "何もできず" } });
  const out = await runAgentStep(
    { id: "a", type: "agent", prompt: "p" }, ctx,
    { cwd: root, taskId: "t1", attempt: 1, sessionId: "s1", resume: false, deps: deps({ adapter }) });
  assert.equal(out.status, "degraded", "成功に見えるが何もできていない実行を区別する");
});

test("子プロセスのpidと開始時刻が通知される", async () => {
  const seen: { pid: number; startedAt: string }[] = [];
  const d = deps({ onChildSpawned: (pid, startedAt) => seen.push({ pid, startedAt }) });
  await runAgentStep(
    { id: "a", type: "agent", prompt: "p" }, ctx,
    { cwd: root, taskId: "t1", attempt: 1, sessionId: "s1", resume: false, deps: d });
  assert.equal(seen.length, 1);
  assert.ok(seen[0].pid > 0);
  assert.ok(Date.parse(seen[0].startedAt) > 0);
});

test("rate_limit イベントが通知される", async () => {
  const samples: { window: string; utilization: number }[] = [];
  const adapter = createMockAdapter({
    events: [{ kind: "rateLimit", window: "five_hour", utilization: 0.14, resetsAt: null }],
    result: { ok: true, text: "" },
  });
  await runAgentStep(
    { id: "a", type: "agent", prompt: "p" }, ctx,
    { cwd: root, taskId: "t1", attempt: 1, sessionId: "s1", resume: false,
      deps: deps({ adapter, onRateLimit: (s) => samples.push(s) }) });
  assert.deepEqual(samples, [{ window: "five_hour", utilization: 0.14, resetsAt: null }]);
});
```

- [ ] **Step 2: テストが落ちることを確認する**

Run: `pnpm test test/core/stepRunner.test.ts`
Expected: FAIL（モジュールが無い）

- [ ] **Step 3: 実装を書く**

`src/core/stepRunner.ts`:

```ts
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { AgentStep, CommandStep } from "../workflow/schema.ts";
import { expand, type TemplateContext } from "../workflow/template.ts";
import type { AgentAdapter } from "../adapter/types.ts";

export type StepOutcome = {
  status: "success" | "failed" | "degraded" | "suspended";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  costUsd: number | null;
  numTurns: number | null;
  durationMs: number | null;
  startedAt: string;
  endedAt: string;
  logPath: string;
};

export type RunnerDeps = {
  db: DatabaseSync;
  adapter: AgentAdapter;
  logRoot: string;
  onChildSpawned?(pid: number, startedAt: string): void;
  onRateLimit?(s: { window: string; utilization: number; resetsAt: string | null }): void;
  onLogLine?(line: string): void;
};

export function logPathFor(logRoot: string, taskId: string, stepId: string, attempt: number): string {
  return join(logRoot, taskId, `${stepId}.${attempt}.log`);
}

async function openLog(path: string) {
  await mkdir(dirname(path), { recursive: true });
  return createWriteStream(path, { flags: "a" });
}

export async function runCommandStep(
  step: CommandStep,
  ctx: TemplateContext,
  o: { cwd: string; taskId: string; attempt: number; deps: RunnerDeps },
): Promise<StepOutcome> {
  const command = expand(step.run, ctx);
  const logPath = logPathFor(o.deps.logRoot, o.taskId, step.id, o.attempt);
  const log = await openLog(logPath);
  const startedAt = new Date().toISOString();

  const child = spawn("sh", ["-c", command], { cwd: o.cwd, stdio: ["ignore", "pipe", "pipe"] });
  o.deps.onChildSpawned?.(child.pid ?? -1, startedAt);

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (c: string) => { stdout += c; log.write(c); o.deps.onLogLine?.(c); });
  child.stderr.on("data", (c: string) => { stderr += c; log.write(c); o.deps.onLogLine?.(c); });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  log.end();

  return {
    status: exitCode === 0 ? "success" : "failed",
    exitCode, stdout, stderr,
    costUsd: null, numTurns: null, durationMs: null,
    startedAt, endedAt: new Date().toISOString(), logPath,
  };
}

export async function runAgentStep(
  step: AgentStep,
  ctx: TemplateContext,
  o: {
    cwd: string; taskId: string; attempt: number;
    sessionId: string; resume: boolean; deps: RunnerDeps;
  },
): Promise<StepOutcome> {
  const prompt = expand(step.prompt, ctx);
  const logPath = logPathFor(o.deps.logRoot, o.taskId, step.id, o.attempt);
  const log = await openLog(logPath);
  const opts = {
    cwd: o.cwd, sessionId: o.sessionId,
    permissionMode: step.permissionMode, model: step.model,
  };

  const run = o.resume
    ? o.deps.adapter.resume(o.sessionId, prompt, opts)
    : o.deps.adapter.start(prompt, opts);
  o.deps.onChildSpawned?.(run.pid, run.startedAt);

  for await (const ev of run.events) {
    log.write(JSON.stringify(ev) + "\n");
    if (ev.kind === "rateLimit") {
      o.deps.onRateLimit?.({ window: ev.window, utilization: ev.utilization, resetsAt: ev.resetsAt });
    }
    if (ev.kind === "assistant" && ev.text) o.deps.onLogLine?.(ev.text);
  }

  const result = await run.result;
  log.end();

  // ワークフローは止めない。判断材料を出すところまでが①の責務。
  const status: StepOutcome["status"] = !result.ok ? "failed" : result.degraded ? "degraded" : "success";
  return {
    status,
    exitCode: result.exitCode,
    stdout: result.text,
    stderr: "",
    costUsd: result.costUsd,
    numTurns: result.numTurns,
    durationMs: result.durationMs,
    startedAt: run.startedAt,
    endedAt: new Date().toISOString(),
    logPath,
  };
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `pnpm test test/core/stepRunner.test.ts`
Expected: PASS（9件）

- [ ] **Step 5: コミット**

```bash
git add src/core/stepRunner.ts test/core/stepRunner.test.ts
git commit -m "feat: ステップ実行器（command / agent）とログのファイル出力"
```

---

## Task 10: ワークフローエンジン

**`onFailure.goto` で実装ステップへ戻る**、これがシェルスクリプトとの唯一の本質的な差。`degraded` はここで**止めない**。

**Files:**
- Create: `src/core/engine.ts`
- Test: `test/core/engine.test.ts`

**Interfaces:**
- Consumes: Task 1/3/4/5/9 のすべて
- Produces:
  ```ts
  export type EngineDeps = RunnerDeps & {
    globalLimit: number;
    onStateChanged?(taskId: string, from: TaskState, to: TaskState): void;
    onStepRunStarted?(taskId: string, stepRunId: number, stepId: string, attempt: number): void;
    onStepRunFinished?(taskId: string, stepRunId: number, stepId: string, status: StepRunStatus): void;
  };
  export type Decision =
    | { kind: "next"; stepId: string }
    | { kind: "goto"; stepId: string; feed: string | null }
    | { kind: "suspend" }
    | { kind: "complete" }
    | { kind: "fail"; reason: string };
  export function decide(o: { workflow: Workflow; currentStepId: string; outcome: StepOutcome["status"]; attempts: number }): Decision;
  export function runTask(db: DatabaseSync, taskId: string, workflow: Workflow, deps: EngineDeps): Promise<void>;
  export function applyApproval(db: DatabaseSync, taskId: string, verdict: { approved: boolean; comment: string }, workflow: Workflow): void;
  ```

- [ ] **Step 1: 分岐判断の失敗するテストを書く**

`decide` は I/O を持たない純粋関数として切り出す。ワークフローの意味論はここに全部集まる。

`test/core/engine.test.ts`（前半）:

```ts
import { test } from "vitest";
import assert from "node:assert/strict";
import { decide } from "../../src/core/engine.ts";
import { parseWorkflow } from "../../src/workflow/schema.ts";

const wf = parseWorkflow(`
name: feature
steps:
  - id: implement
    type: agent
    prompt: "{{ task.prompt }}"
  - id: test
    type: command
    run: pnpm test
    onFailure:
      goto: implement
      maxAttempts: 3
      feed: "テストが失敗した:\\n{{ steps.test.stderr }}"
  - id: review
    type: approval
    title: "確認してください"
    onReject:
      goto: implement
      maxAttempts: 5
  - id: open-pr
    type: command
    run: gh pr create --fill
`).workflow;

test("成功したら次のステップへ", () => {
  assert.deepEqual(decide({ workflow: wf, currentStepId: "implement", outcome: "success", attempts: 1 }),
    { kind: "next", stepId: "test" });
});

test("最後のステップが成功したら completed", () => {
  assert.deepEqual(decide({ workflow: wf, currentStepId: "open-pr", outcome: "success", attempts: 1 }),
    { kind: "complete" });
});

test("degraded でもワークフローは止まらない", () => {
  assert.deepEqual(decide({ workflow: wf, currentStepId: "implement", outcome: "degraded", attempts: 1 }),
    { kind: "next", stepId: "test" });
});

test("失敗したら onFailure.goto へ戻り、feed を渡す", () => {
  const d = decide({ workflow: wf, currentStepId: "test", outcome: "failed", attempts: 1 });
  assert.equal(d.kind, "goto");
  assert.equal((d as { stepId: string }).stepId, "implement");
  assert.match((d as { feed: string }).feed, /テストが失敗した/);
});

test("maxAttempts を超えたら failed", () => {
  const d = decide({ workflow: wf, currentStepId: "test", outcome: "failed", attempts: 3 });
  assert.equal(d.kind, "fail");
  assert.match((d as { reason: string }).reason, /maxAttempts/);
});

test("onFailure が無いステップの失敗は即 failed", () => {
  const d = decide({ workflow: wf, currentStepId: "open-pr", outcome: "failed", attempts: 1 });
  assert.equal(d.kind, "fail");
});

test("approval ステップに来たら suspend", () => {
  assert.deepEqual(decide({ workflow: wf, currentStepId: "review", outcome: "suspended", attempts: 1 }),
    { kind: "suspend" });
});
```

- [ ] **Step 2: テストが落ちることを確認する**

Run: `pnpm test test/core/engine.test.ts`
Expected: FAIL（モジュールが無い）

**`maxAttempts` は分岐元のステップで数える。** `test` が `onFailure.goto: implement` で
失敗を繰り返すとき、上限を見るのは `test` の試行回数であって `implement` のそれではない。
`review` の `onReject.goto: implement` も同じで、上限は `review` 側で数える。
飛び先（`implement`）の試行回数は増え続けるが、**どこでも上限判定には使わない**。
飛び先のカウントをリセットしたり再チェックしたりしないこと。

- [ ] **Step 3: `decide` を実装する**

`src/core/engine.ts`（前半）:

```ts
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { Branch, Step, Workflow } from "../workflow/schema.ts";
import { expand, type TemplateContext } from "../workflow/template.ts";
import { commitStepBoundary } from "../db/boundary.ts";
import { getStepOutputs, type StepRunStatus } from "../db/stepRuns.ts";
import { attemptCount, getProject, getTask, withAttempt, type TaskRow, type TaskState } from "../db/tasks.ts";
import { insertRateLimitSample } from "../db/rateLimits.ts";
import { assertTransition } from "./states.ts";
import { logPathFor, runAgentStep, runCommandStep, type RunnerDeps, type StepOutcome } from "./stepRunner.ts";

export type Decision =
  | { kind: "next"; stepId: string }
  | { kind: "goto"; stepId: string; feed: string | null }
  | { kind: "suspend" }
  | { kind: "complete" }
  | { kind: "fail"; reason: string };

function branchOf(step: Step): Branch | undefined {
  return step.type === "approval" ? step.onReject : step.onFailure;
}

/**
 * ワークフローの意味論。I/Oを持たないので、ここだけを読めば進行規則が分かる。
 * degraded は success と同じ扱い（判断材料は step_runs に残るが、流れは止めない）。
 */
export function decide(o: {
  workflow: Workflow; currentStepId: string;
  outcome: StepOutcome["status"]; attempts: number;
}): Decision {
  const index = o.workflow.steps.findIndex((s) => s.id === o.currentStepId);
  if (index === -1) return { kind: "fail", reason: `ステップが見つかりません: ${o.currentStepId}` };
  const step = o.workflow.steps[index];

  if (o.outcome === "suspended") return { kind: "suspend" };

  if (o.outcome === "success" || o.outcome === "degraded") {
    const next = o.workflow.steps[index + 1];
    return next ? { kind: "next", stepId: next.id } : { kind: "complete" };
  }

  const branch = branchOf(step);
  if (!branch) return { kind: "fail", reason: `ステップ "${step.id}" が失敗し、onFailure がありません` };
  if (o.attempts >= branch.maxAttempts) {
    return { kind: "fail", reason: `ステップ "${step.id}" が maxAttempts (${branch.maxAttempts}) を超えました` };
  }
  return { kind: "goto", stepId: branch.goto, feed: branch.feed ?? null };
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `pnpm test test/core/engine.test.ts`
Expected: PASS（7件）

- [ ] **Step 5: 進行ループのテストを追記する**

`test/core/engine.test.ts`（後半を追記）:

```ts
import { openDb } from "../../src/db/migrate.ts";
import { insertProject, insertTask, getTask } from "../../src/db/tasks.ts";
import { listStepRuns } from "../../src/db/stepRuns.ts";
import { runTask, applyApproval } from "../../src/core/engine.ts";
import { createMockAdapter } from "../../src/adapter/mock.ts";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function taskFixture(workflowYaml: string) {
  const root = await mkdtemp(join(tmpdir(), "doctrine-engine-"));
  const db = openDb(":memory:");
  const pid = insertProject(db, { path: root, default_workflow: "f", max_concurrent: 1, base_branch: "main", setup: null });
  insertTask(db, { id: "t1", project_id: pid, title: "T", prompt: "直して", workflow_name: "f", branch: "doctrine/t1-t", priority: 2 });
  db.prepare("UPDATE tasks SET state='running', worktree_path=? WHERE id='t1'").run(root);
  return { db, root, workflow: parseWorkflow(workflowYaml).workflow };
}

test("成功する2ステップを通して completed になる", async () => {
  const { db, root, workflow } = await taskFixture(`
name: f
steps:
  - id: a
    type: command
    run: "true"
  - id: b
    type: command
    run: "true"
`);
  await runTask(db, "t1", workflow, {
    db, adapter: createMockAdapter({ result: {} }), logRoot: join(root, "logs"), globalLimit: 4,
  });
  assert.equal(getTask(db, "t1")?.state, "completed");
  assert.deepEqual(listStepRuns(db, "t1").map((r) => [r.step_id, r.status]), [["a", "success"], ["b", "success"]]);
});

test("テスト失敗でエージェントに差し戻し、2周目で通る", async () => {
  const { db, root, workflow } = await taskFixture(`
name: f
steps:
  - id: implement
    type: agent
    prompt: "{{ task.prompt }}"
  - id: test
    type: command
    run: "test -f ${"${WT}"}/done"
    onFailure:
      goto: implement
      maxAttempts: 3
      feed: "テストが失敗した:\\n{{ steps.test.stderr }}"
`);
  // 1回目の agent は何もせず、2回目で done を作る
  let call = 0;
  const adapter = createMockAdapter({ result: { ok: true, text: "やった" } });
  const origStart = adapter.start;
  adapter.start = (p, o) => { call++; return origStart(p, o); };

  await runTask(db, "t1", workflow, {
    db, adapter, logRoot: join(root, "logs"), globalLimit: 4,
  });
  const runs = listStepRuns(db, "t1");
  assert.ok(runs.filter((r) => r.step_id === "implement").length >= 2, "実装ステップへ戻っている");
  assert.equal(getTask(db, "t1")?.state, "failed", "3回試して直らなければ failed");
});

test("差し戻しでは resume が使われる（会話が継続する）", async () => {
  const { db, root, workflow } = await taskFixture(`
name: f
steps:
  - id: implement
    type: agent
    prompt: "{{ task.prompt }}"
  - id: test
    type: command
    run: "false"
    onFailure:
      goto: implement
      maxAttempts: 2
      feed: "落ちた"
`);
  const adapter = createMockAdapter({ result: { ok: true, text: "やった" } });
  await runTask(db, "t1", workflow, { db, adapter, logRoot: join(root, "logs"), globalLimit: 4 });
  assert.equal(adapter.calls[0].kind, "start");
  assert.equal(adapter.calls[1].kind, "resume", "やり直しではなく会話の継続");
  assert.equal(adapter.calls[1].prompt, "落ちた");
});

test("approval に来たら suspended で止まる", async () => {
  const { db, root, workflow } = await taskFixture(`
name: f
steps:
  - id: review
    type: approval
    title: "見て"
  - id: after
    type: command
    run: "true"
`);
  await runTask(db, "t1", workflow, {
    db, adapter: createMockAdapter({ result: {} }), logRoot: join(root, "logs"), globalLimit: 4,
  });
  const t = getTask(db, "t1")!;
  assert.equal(t.state, "suspended");
  assert.equal(t.current_step_id, "review");
});

test("承認すると queued に戻り、行列の先頭に入る", async () => {
  const { db, root, workflow } = await taskFixture(`
name: f
steps:
  - id: review
    type: approval
    title: "見て"
  - id: after
    type: command
    run: "true"
`);
  await runTask(db, "t1", workflow, { db, adapter: createMockAdapter({ result: {} }), logRoot: join(root, "logs"), globalLimit: 4 });
  applyApproval(db, "t1", { approved: true, comment: "" }, workflow);
  const t = getTask(db, "t1")!;
  assert.equal(t.state, "queued");
  assert.equal(t.resumed, 1);
  assert.equal(t.current_step_id, "after");
});

test("却下コメントが approval ステップの stdout として保存される", async () => {
  const { db, root, workflow } = await taskFixture(`
name: f
steps:
  - id: implement
    type: agent
    prompt: "p"
  - id: review
    type: approval
    title: "見て"
    onReject:
      goto: implement
      maxAttempts: 3
      feed: "レビューで却下された:\\n{{ steps.review.stdout }}"
`);
  await runTask(db, "t1", workflow, { db, adapter: createMockAdapter({ result: {} }), logRoot: join(root, "logs"), globalLimit: 4 });
  applyApproval(db, "t1", { approved: false, comment: "命名が変です" }, workflow);
  const t = getTask(db, "t1")!;
  assert.equal(t.state, "queued");
  assert.equal(t.current_step_id, "implement");
  assert.equal(getStepOutputs(db, "t1").review.stdout, "命名が変です");
});

test("onReject が無い却下は failed", async () => {
  const { db, root, workflow } = await taskFixture(`
name: f
steps:
  - id: review
    type: approval
    title: "見て"
`);
  await runTask(db, "t1", workflow, { db, adapter: createMockAdapter({ result: {} }), logRoot: join(root, "logs"), globalLimit: 4 });
  applyApproval(db, "t1", { approved: false, comment: "だめ" }, workflow);
  assert.equal(getTask(db, "t1")?.state, "failed");
});
```

2番目のテストの `run:` は環境変数を使わず、`worktree.path` 配下のファイルを見る形に直してよい
（例: `run: "test -f {{ worktree.path }}/done"`）。テスト側の意図は「同じステップへ戻る回数が増える」ことの確認。

- [ ] **Step 6: 進行ループを実装する**

`src/core/engine.ts`（後半を追記）:

```ts
export type EngineDeps = RunnerDeps & {
  globalLimit: number;
  onStateChanged?(taskId: string, from: TaskState, to: TaskState): void;
  onStepRunStarted?(taskId: string, stepRunId: number, stepId: string, attempt: number): void;
  /** stepRunId は commitStepBoundary が返した step_runs.id。イベントがこれを載せる。 */
  onStepRunFinished?(taskId: string, stepRunId: number, stepId: string, status: StepRunStatus): void;
};

function contextFor(db: DatabaseSync, task: TaskRow): TemplateContext {
  const project = getProject(db, task.project_id)!;
  return {
    task: { id: task.id, title: task.title, prompt: task.prompt, branch: task.branch },
    worktree: { path: task.worktree_path ?? "" },
    project: { path: project.path },
    steps: getStepOutputs(db, task.id),
  };
}

function setState(db: DatabaseSync, task: TaskRow, to: TaskState, deps: EngineDeps,
                  extra: Record<string, unknown> = {}): void {
  assertTransition(task.state, to);
  commitStepBoundary(db, { taskId: task.id, taskPatch: { state: to, ...extra } as never });
  deps.onStateChanged?.(task.id, task.state, to);
}

/**
 * running のタスクを、次に人を待つ地点（approval / 終端）まで進める。
 * ステップ境界ごとに1トランザクションで書く。落ちて失うのは最大1ステップ分。
 */
export async function runTask(
  db: DatabaseSync, taskId: string, workflow: Workflow, deps: EngineDeps,
): Promise<void> {
  let task = getTask(db, taskId);
  if (!task) throw new Error(`タスクがありません: ${taskId}`);

  let stepId = task.current_step_id ?? workflow.steps[0].id;
  let pendingFeed: string | null = null;

  while (true) {
    task = getTask(db, taskId)!;
    const step = workflow.steps.find((s) => s.id === stepId);
    if (!step) {
      setState(db, task, "failed", deps);
      return;
    }

    if (step.type === "approval") {
      commitStepBoundary(db, {
        taskId, taskPatch: { state: "suspended", current_step_id: step.id, child_pid: null, child_started_at: null },
      });
      deps.onStateChanged?.(taskId, task.state, "suspended");
      return;
    }

    const attempt = attemptCount(task, step.id) + 1;
    const ctx = contextFor(db, task);
    const sessionId = task.claude_session_id ?? randomUUID();

    const logPath = logPathFor(deps.logRoot, taskId, step.id, attempt);
    // 開始時に running の行を立てる。クラッシュ復帰はこの行を見て、
    // どのステップの途中で落ちたかを知る（Task 11）。
    const stepRunId = commitStepBoundary(db, {
      taskId,
      taskPatch: { current_step_id: step.id, attempt_counts: withAttempt(task, step.id), claude_session_id: sessionId },
      stepRun: {
        step_id: step.id, attempt, status: "running", exit_code: null,
        started_at: new Date().toISOString(), ended_at: null, log_path: logPath,
      },
    })!;
    deps.onStepRunStarted?.(taskId, stepRunId, step.id, attempt);

    const runnerDeps: RunnerDeps = {
      ...deps,
      onChildSpawned: (pid, startedAt) => {
        commitStepBoundary(db, { taskId, taskPatch: { child_pid: pid, child_started_at: startedAt } });
        deps.onChildSpawned?.(pid, startedAt);
      },
      onRateLimit: (s) => {
        insertRateLimitSample(db, { window: s.window, utilization: s.utilization, resets_at: s.resetsAt });
        deps.onRateLimit?.(s);
      },
    };

    const outcome: StepOutcome = step.type === "command"
      ? await runCommandStep(step, ctx, { cwd: task.worktree_path!, taskId, attempt, deps: runnerDeps })
      : await runAgentStep(
          { ...step, prompt: pendingFeed ?? step.prompt }, ctx,
          { cwd: task.worktree_path!, taskId, attempt, sessionId,
            resume: pendingFeed !== null || attempt > 1, deps: runnerDeps });
    pendingFeed = null;

    commitStepBoundary(db, {
      taskId,
      taskPatch: { child_pid: null, child_started_at: null },
      stepRunUpdate: {
        id: stepRunId, status: outcome.status as StepRunStatus, exit_code: outcome.exitCode,
        ended_at: outcome.endedAt, cost_usd: outcome.costUsd,
        num_turns: outcome.numTurns, duration_ms: outcome.durationMs,
      },
      outputs: { step_id: step.id, stdout: outcome.stdout, stderr: outcome.stderr, exit_code: outcome.exitCode },
    });
    deps.onStepRunFinished?.(taskId, stepRunId, step.id, outcome.status as StepRunStatus);

    task = getTask(db, taskId)!;
    const decision = decide({
      workflow, currentStepId: step.id, outcome: outcome.status,
      attempts: attemptCount(task, step.id),
    });

    switch (decision.kind) {
      case "next":
        stepId = decision.stepId;
        break;
      case "goto":
        stepId = decision.stepId;
        pendingFeed = decision.feed ? expand(decision.feed, contextFor(db, task)) : null;
        break;
      case "complete":
        setState(db, task, "completed", deps);
        return;
      case "fail":
        setState(db, task, "failed", deps);
        return;
      case "suspend":
        setState(db, task, "suspended", deps);
        return;
    }
  }
}

/**
 * approval の結果を適用する。却下コメントは approval ステップの stdout として保存する
 * （agent ステップの stdout を最終結果テキストとしたのと同じ扱い。変数の系統を増やさない）。
 */
export function applyApproval(
  db: DatabaseSync, taskId: string,
  verdict: { approved: boolean; comment: string },
  workflow: Workflow,
): void {
  const task = getTask(db, taskId);
  if (!task) throw new Error(`タスクがありません: ${taskId}`);
  if (task.state !== "suspended") throw new Error(`承認待ちではありません: ${task.state}`);

  const stepId = task.current_step_id!;
  const index = workflow.steps.findIndex((s) => s.id === stepId);
  const step = workflow.steps[index];
  const now = new Date().toISOString();

  if (verdict.approved) {
    const next = workflow.steps[index + 1];
    commitStepBoundary(db, {
      taskId,
      taskPatch: next
        ? { state: "queued", current_step_id: next.id, resumed: 1 }
        : { state: "completed" },
      stepRun: { step_id: stepId, attempt: attemptCount(task, stepId) + 1, status: "success",
                 exit_code: 0, started_at: now, ended_at: now, log_path: "" },
      outputs: { step_id: stepId, stdout: "", stderr: "", exit_code: 0 },
    });
    return;
  }

  const branch = step.type === "approval" ? step.onReject : undefined;
  commitStepBoundary(db, {
    taskId,
    taskPatch: branch
      ? { state: "queued", current_step_id: branch.goto, resumed: 1 }
      : { state: "failed" },
    stepRun: { step_id: stepId, attempt: attemptCount(task, stepId) + 1, status: "failed",
               exit_code: 1, started_at: now, ended_at: now, log_path: "" },
    outputs: { step_id: stepId, stdout: verdict.comment, stderr: "", exit_code: 1 },
  });
}
```

- [ ] **Step 7: テストが通ることを確認する**

Run: `pnpm test test/core/engine.test.ts`
Expected: PASS（14件）

- [ ] **Step 8: コミット**

```bash
git add src/core/engine.ts test/core/engine.test.ts
git commit -m "feat: ワークフローエンジン（ステップ進行と差し戻し）"
```

---

## Task 11: クラッシュ復帰

**復帰の前に必ず古い子プロセスを殺す。** pid単独では誤って無関係のプロセスを殺し得るので、**pidと開始時刻の両方**で同一性を確認する。

**Files:**
- Create: `src/core/recovery.ts`
- Test: `test/core/recovery.test.ts`

**Interfaces:**
- Consumes: `TaskRow`（Task 4）、`listStepRuns`（Task 4）
- Produces:
  ```ts
  export type ProcessProbe = {
    startTimeOf(pid: number): Promise<string | null>;  // 該当pidの開始時刻（存在しなければ null）
    kill(pid: number, signal: NodeJS.Signals): void;
  };
  export function defaultProbe(): ProcessProbe;
  export function isSameChild(recorded: { pid: number; startedAt: string }, actualStartTime: string | null, toleranceMs?: number): boolean;
  export function killStaleChild(task: TaskRow, probe: ProcessProbe): Promise<"killed" | "gone" | "mismatch" | "none">;
  export function recoverOnStartup(db: DatabaseSync, probe: ProcessProbe): Promise<{ taskId: string; action: "resume-agent" | "rerun-command" }[]>;
  ```

- [ ] **Step 1: 失敗するテストを書く**

`test/core/recovery.test.ts`:

```ts
import { test } from "vitest";
import assert from "node:assert/strict";
import { openDb } from "../../src/db/migrate.ts";
import { insertProject, insertTask, getTask } from "../../src/db/tasks.ts";
import { commitStepBoundary } from "../../src/db/boundary.ts";
import { isSameChild, killStaleChild, recoverOnStartup, type ProcessProbe } from "../../src/core/recovery.ts";

function fixture() {
  const db = openDb(":memory:");
  const p = insertProject(db, { path: "/repo", default_workflow: "f", max_concurrent: 1, base_branch: "main", setup: null });
  insertTask(db, { id: "t1", project_id: p, title: "T", prompt: "P", workflow_name: "f", branch: "b", priority: 2 });
  return db;
}

function probe(map: Record<number, string | null>, killed: number[] = []): ProcessProbe {
  return {
    startTimeOf: async (pid) => map[pid] ?? null,
    kill: (pid) => { killed.push(pid); },
  };
}

test("pidと開始時刻が一致すれば同一のプロセス", () => {
  assert.ok(isSameChild({ pid: 100, startedAt: "2026-09-12T00:00:00.000Z" }, "2026-09-12T00:00:00.000Z"));
});

test("開始時刻が違えば別プロセス（pidの再利用）", () => {
  assert.equal(isSameChild({ pid: 100, startedAt: "2026-09-12T00:00:00.000Z" }, "2026-09-12T09:00:00.000Z"), false);
});

test("プロセスが存在しなければ同一ではない", () => {
  assert.equal(isSameChild({ pid: 100, startedAt: "2026-09-12T00:00:00.000Z" }, null), false);
});

test("秒未満のずれは許容する", () => {
  assert.ok(isSameChild({ pid: 1, startedAt: "2026-09-12T00:00:00.000Z" }, "2026-09-12T00:00:01.500Z", 2000));
});

test("生き残った子プロセスを殺す", async () => {
  const db = fixture();
  commitStepBoundary(db, { taskId: "t1", taskPatch: { state: "running", child_pid: 4242, child_started_at: "2026-09-12T00:00:00.000Z" } });
  const killed: number[] = [];
  const r = await killStaleChild(getTask(db, "t1")!, probe({ 4242: "2026-09-12T00:00:00.000Z" }, killed));
  assert.equal(r, "killed");
  assert.deepEqual(killed, [4242]);
});

test("pidが再利用されていたら殺さない", async () => {
  const db = fixture();
  commitStepBoundary(db, { taskId: "t1", taskPatch: { state: "running", child_pid: 4242, child_started_at: "2026-09-12T00:00:00.000Z" } });
  const killed: number[] = [];
  const r = await killStaleChild(getTask(db, "t1")!, probe({ 4242: "2026-09-12T12:00:00.000Z" }, killed));
  assert.equal(r, "mismatch");
  assert.deepEqual(killed, [], "無関係のプロセスを殺してはならない");
});

test("pidの記録がなければ何もしない", async () => {
  const db = fixture();
  const r = await killStaleChild(getTask(db, "t1")!, probe({}));
  assert.equal(r, "none");
});

test("起動時、running のタスクは全部古いものとして扱う", async () => {
  const db = fixture();
  commitStepBoundary(db, {
    taskId: "t1",
    taskPatch: { state: "running", current_step_id: "implement", child_pid: 4242, child_started_at: "2026-09-12T00:00:00.000Z" },
    stepRun: { step_id: "implement", attempt: 1, status: "running", exit_code: null, started_at: "a", ended_at: "b", log_path: "/l" },
  });
  const actions = await recoverOnStartup(db, probe({ 4242: "2026-09-12T00:00:00.000Z" }));
  assert.deepEqual(actions, [{ taskId: "t1", action: "resume-agent" }]);
  const t = getTask(db, "t1")!;
  assert.equal(t.state, "queued", "枠を取り直してから再開する");
  assert.equal(t.resumed, 1, "再開は行列の先頭");
  assert.equal(t.child_pid, null);
});

test("command ステップで落ちていたら頭から再実行する", async () => {
  const db = fixture();
  commitStepBoundary(db, {
    taskId: "t1",
    taskPatch: { state: "running", current_step_id: "test", claude_session_id: null },
    stepRun: { step_id: "test", attempt: 1, status: "running", exit_code: null, started_at: "a", ended_at: "b", log_path: "/l" },
  });
  const actions = await recoverOnStartup(db, probe({}));
  assert.deepEqual(actions, [{ taskId: "t1", action: "rerun-command" }]);
});

test("running でないタスクには触らない", async () => {
  const db = fixture();
  commitStepBoundary(db, { taskId: "t1", taskPatch: { state: "suspended" } });
  assert.deepEqual(await recoverOnStartup(db, probe({})), []);
  assert.equal(getTask(db, "t1")?.state, "suspended");
});
```

- [ ] **Step 2: テストが落ちることを確認する**

Run: `pnpm test test/core/recovery.test.ts`
Expected: FAIL（モジュールが無い）

- [ ] **Step 3: 実装を書く**

`src/core/recovery.ts`:

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import { commitStepBoundary } from "../db/boundary.ts";
import { listTasks, type TaskRow } from "../db/tasks.ts";
import { listStepRuns } from "../db/stepRuns.ts";

const run = promisify(execFile);

export type ProcessProbe = {
  startTimeOf(pid: number): Promise<string | null>;
  kill(pid: number, signal: NodeJS.Signals): void;
};

/** ps の lstart は秒精度なので、既定の許容は2秒。 */
export function isSameChild(
  recorded: { pid: number; startedAt: string },
  actualStartTime: string | null,
  toleranceMs = 2000,
): boolean {
  if (actualStartTime === null) return false;
  const a = Date.parse(recorded.startedAt);
  const b = Date.parse(actualStartTime);
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  return Math.abs(a - b) <= toleranceMs;
}

export function defaultProbe(): ProcessProbe {
  return {
    async startTimeOf(pid) {
      try {
        const { stdout } = await run("ps", ["-o", "lstart=", "-p", String(pid)]);
        const t = stdout.trim();
        if (!t) return null;
        const parsed = new Date(t);
        return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
      } catch {
        return null; // プロセスが存在しない
      }
    },
    kill(pid, signal) {
      try { process.kill(pid, signal); } catch { /* 既に消えている */ }
    },
  };
}

/**
 * デーモンが SIGKILL された場合、子の claude は生き残ったまま同じ worktree に
 * 書き続けていることがある。--resume で2本目を起動する前に必ず殺す。
 */
export async function killStaleChild(
  task: TaskRow, probe: ProcessProbe,
): Promise<"killed" | "gone" | "mismatch" | "none"> {
  if (task.child_pid === null || task.child_started_at === null) return "none";
  const actual = await probe.startTimeOf(task.child_pid);
  if (actual === null) return "gone";
  if (!isSameChild({ pid: task.child_pid, startedAt: task.child_started_at }, actual)) {
    return "mismatch"; // pidが再利用されている。無関係のプロセスを殺さない
  }
  probe.kill(task.child_pid, "SIGKILL");
  return "killed";
}

/**
 * デーモンが死ねば子プロセスの stdout は誰も読んでいない。
 * よって起動時に running のタスクはすべて古い。
 */
export async function recoverOnStartup(
  db: DatabaseSync, probe: ProcessProbe,
): Promise<{ taskId: string; action: "resume-agent" | "rerun-command" }[]> {
  const actions: { taskId: string; action: "resume-agent" | "rerun-command" }[] = [];

  for (const task of listTasks(db, { state: "running" })) {
    await killStaleChild(task, probe);

    const runs = listStepRuns(db, task.id);
    const last = runs.at(-1);
    const wasAgent = task.claude_session_id !== null && last?.status === "running";
    const action = wasAgent ? "resume-agent" : "rerun-command";

    commitStepBoundary(db, {
      taskId: task.id,
      taskPatch: { state: "queued", resumed: 1, child_pid: null, child_started_at: null },
    });
    actions.push({ taskId: task.id, action });
  }
  return actions;
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `pnpm test test/core/recovery.test.ts`
Expected: PASS（10件）

`recoverOnStartup` が `agent` / `command` を判別する条件は、`step_runs` の最後のレコードが
`running` のまま残っているかと `claude_session_id` の有無で決める。テストの期待値と実装が
食い違ったら、**ワークフロー定義からステップ型を引く**形（`current_step_id` でワークフローを引く）に
変えてよい。判別の正しさが本質で、判別方法は実装の都合である。

- [ ] **Step 5: コミット**

```bash
git add src/core/recovery.ts test/core/recovery.test.ts
git commit -m "feat: クラッシュ復帰（古い子プロセスの掃除と再開）"
```

---

## Task 12: Unixソケットサーバと改行区切りJSON

リクエスト/レスポンスと**サーバ→クライアントのイベントプッシュ**が同じ接続に流れる。UIはポーリングしない。TCPポートは開かない。

**Files:**
- Create: `src/daemon/protocol.ts`, `src/daemon/server.ts`
- Test: `test/daemon/server.test.ts`

**Interfaces:**
- Consumes: なし
- Produces:
  ```ts
  export type Request = { id: number; method: string; params?: Record<string, unknown> };
  export type Response = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };
  export type ServerEvent =
    | { event: "task.stateChanged"; task_id: string; from: string; to: string }
    | { event: "stepRun.started"; task_id: string; step_run_id: number; step_id: string }
    | { event: "stepRun.finished"; task_id: string; step_run_id: number; step_id: string; status: string }
    | { event: "log.line"; task_id: string; step_run_id: number; line: string }
    | { event: "ratelimit.sample"; window: string; utilization: number; resets_at: string | null };
  export type Handler = (method: string, params: Record<string, unknown>, conn: Connection) => Promise<unknown>;
  export type Connection = { follow(taskId: string): void; unfollow(taskId: string): void; isFollowing(taskId: string): boolean };
  export function socketPath(): string;   // $XDG_RUNTIME_DIR/doctrine/dctld.sock
  export function createServer(handler: Handler): { listen(path: string): Promise<void>; broadcast(ev: ServerEvent, opts?: { taskId?: string; followersOnly?: boolean }): void; close(): Promise<void>; };
  ```

- [ ] **Step 1: 失敗するテストを書く**

`test/daemon/server.test.ts`:

```ts
import { test, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../src/daemon/server.ts";

let root: string;
let sock: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "doctrine-sock-"));
  sock = join(root, "dctld.sock");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function client(path: string) {
  const socket = connect(path);
  const lines: string[] = [];
  let buf = "";
  socket.setEncoding("utf8");
  socket.on("data", (c: string) => {
    buf += c;
    let i: number;
    while ((i = buf.indexOf("\n")) !== -1) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 1); }
  });
  return {
    socket, lines,
    send: (o: unknown) => socket.write(JSON.stringify(o) + "\n"),
    async next(pred: (o: Record<string, unknown>) => boolean, timeoutMs = 2000) {
      const until = Date.now() + timeoutMs;
      while (Date.now() < until) {
        for (const l of lines.splice(0)) {
          const o = JSON.parse(l) as Record<string, unknown>;
          if (pred(o)) return o;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error("タイムアウト");
    },
  };
}

test("リクエストにレスポンスを返す", async () => {
  const s = createServer(async (method, params) => ({ echoed: method, params }));
  await s.listen(sock);
  const c = client(sock);
  c.send({ id: 1, method: "ping", params: { a: 1 } });
  const res = await c.next((o) => o.id === 1);
  assert.equal(res.ok, true);
  assert.deepEqual((res.result as { echoed: string }).echoed, "ping");
  c.socket.end();
  await s.close();
});

test("ハンドラの例外はエラーレスポンスになり、接続は切れない", async () => {
  const s = createServer(async (method) => {
    if (method === "boom") throw new Error("こわれた");
    return "ok";
  });
  await s.listen(sock);
  const c = client(sock);
  c.send({ id: 1, method: "boom" });
  const err = await c.next((o) => o.id === 1);
  assert.equal(err.ok, false);
  assert.match(String(err.error), /こわれた/);
  c.send({ id: 2, method: "fine" });
  assert.equal((await c.next((o) => o.id === 2)).ok, true);
  c.socket.end();
  await s.close();
});

test("イベントを全クライアントにプッシュする", async () => {
  const s = createServer(async () => "ok");
  await s.listen(sock);
  const a = client(sock);
  const b = client(sock);
  await new Promise((r) => setTimeout(r, 50));
  s.broadcast({ event: "task.stateChanged", task_id: "t1", from: "queued", to: "running" });
  for (const c of [a, b]) {
    const ev = await c.next((o) => o.event === "task.stateChanged");
    assert.equal(ev.to, "running");
  }
  a.socket.end(); b.socket.end();
  await s.close();
});

test("log.line は follow 中のクライアントにだけ流れる", async () => {
  const s = createServer(async (method, params, conn) => {
    if (method === "task.logs" && params.follow) conn.follow(String(params.task_id));
    return "ok";
  });
  await s.listen(sock);
  const follower = client(sock);
  const idle = client(sock);
  follower.send({ id: 1, method: "task.logs", params: { task_id: "t1", follow: true } });
  await follower.next((o) => o.id === 1);
  s.broadcast({ event: "log.line", task_id: "t1", step_run_id: 1, line: "hello" },
    { taskId: "t1", followersOnly: true });
  await follower.next((o) => o.event === "log.line");
  await assert.rejects(() => idle.next((o) => o.event === "log.line", 200));
  follower.socket.end(); idle.socket.end();
  await s.close();
});

test("既存のソケットファイルがあっても listen できる", async () => {
  const s1 = createServer(async () => "ok");
  await s1.listen(sock);
  await s1.close();
  const s2 = createServer(async () => "ok");
  await s2.listen(sock);
  await s2.close();
});
```

- [ ] **Step 2: テストが落ちることを確認する**

Run: `pnpm test test/daemon/server.test.ts`
Expected: FAIL（モジュールが無い）

- [ ] **Step 3: プロトコルの型を書く**

`src/daemon/protocol.ts`:

```ts
export type Request = { id: number; method: string; params?: Record<string, unknown> };

export type Response =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

export type ServerEvent =
  | { event: "task.stateChanged"; task_id: string; from: string; to: string }
  | { event: "stepRun.started"; task_id: string; step_run_id: number; step_id: string }
  | { event: "stepRun.finished"; task_id: string; step_run_id: number; step_id: string; status: string }
  | { event: "log.line"; task_id: string; step_run_id: number; line: string }
  | { event: "ratelimit.sample"; window: string; utilization: number; resets_at: string | null };
```

- [ ] **Step 4: サーバを実装する**

`src/daemon/server.ts`:

```ts
import { createServer as createNetServer, type Socket } from "node:net";
import { mkdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Request, Response, ServerEvent } from "./protocol.ts";

export type Connection = {
  follow(taskId: string): void;
  unfollow(taskId: string): void;
  isFollowing(taskId: string): boolean;
};

export type Handler = (
  method: string, params: Record<string, unknown>, conn: Connection,
) => Promise<unknown>;

/** TCPポートは開かない。ファイルパーミッションがそのまま認可になる。 */
export function socketPath(): string {
  const base = process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}`;
  return join(base, "doctrine", "dctld.sock");
}

export function createServer(handler: Handler) {
  const conns = new Map<Socket, Set<string>>();

  const server = createNetServer((socket) => {
    const following = new Set<string>();
    conns.set(socket, following);
    const conn: Connection = {
      follow: (id) => following.add(id),
      unfollow: (id) => following.delete(id),
      isFollowing: (id) => following.has(id),
    };

    let buf = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim() === "") continue;
        void dispatch(line, socket, conn);
      }
    });
    socket.on("close", () => conns.delete(socket));
    socket.on("error", () => conns.delete(socket));
  });

  async function dispatch(line: string, socket: Socket, conn: Connection) {
    let req: Request;
    try {
      req = JSON.parse(line) as Request;
    } catch {
      write(socket, { id: 0, ok: false, error: "JSONとして読めません" });
      return;
    }
    try {
      const result = await handler(req.method, req.params ?? {}, conn);
      write(socket, { id: req.id, ok: true, result });
    } catch (e) {
      write(socket, { id: req.id, ok: false, error: (e as Error).message });
    }
  }

  function write(socket: Socket, payload: Response | ServerEvent) {
    if (socket.writable) socket.write(JSON.stringify(payload) + "\n");
  }

  return {
    async listen(path: string): Promise<void> {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await unlink(path).catch(() => {});
      await new Promise<void>((resolve) => server.listen(path, resolve));
    },
    broadcast(ev: ServerEvent, opts: { taskId?: string; followersOnly?: boolean } = {}): void {
      for (const [socket, following] of conns) {
        if (opts.followersOnly && opts.taskId && !following.has(opts.taskId)) continue;
        write(socket, ev);
      }
    },
    async close(): Promise<void> {
      for (const socket of conns.keys()) socket.destroy();
      conns.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
```

- [ ] **Step 5: テストが通ることを確認する**

Run: `pnpm test test/daemon/server.test.ts`
Expected: PASS（5件）

- [ ] **Step 6: コミット**

```bash
git add src/daemon/protocol.ts src/daemon/server.ts test/daemon/server.test.ts
git commit -m "feat: Unixソケットサーバとイベントプッシュ"
```

---

## Task 13: デーモンAPI ハンドラとスケジューリングループ

spec 8章のリクエストを実装し、デーモン本体（tick ループ）を組む。**`task.resume` は行列の先頭に入れる**（Task 6 の `resumed` を立てる）。

**Files:**
- Create: `src/daemon/handlers.ts`, `src/daemon/main.ts`
- Test: `test/daemon/handlers.test.ts`

**Interfaces:**
- Consumes: Task 1〜12 のすべて
- Produces:
  ```ts
  export type DaemonContext = {
    db: DatabaseSync; adapter: AgentAdapter; logRoot: string; globalLimit: number;
    broadcast(ev: ServerEvent, opts?: { taskId?: string; followersOnly?: boolean }): void;
    loadWorkflow(projectPath: string, name: string): Promise<Workflow>;
    running: Set<string>;
    warnings: string[];
  };
  export function createHandler(ctx: DaemonContext): Handler;
  export function cleanupAfterRun(ctx: DaemonContext, taskId: string): Promise<void>;
  export function tick(ctx: DaemonContext): Promise<void>;
  export function startDaemon(o: { dbPath: string; socketPath: string; logRoot: string; globalLimit?: number; tickMs?: number }): Promise<{ stop(): Promise<void> }>;
  ```

- [ ] **Step 1: 失敗するテストを書く**

`test/daemon/handlers.test.ts`:

```ts
import { test, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/db/migrate.ts";
import { getTask, listTasks } from "../../src/db/tasks.ts";
import { createHandler, tick, type DaemonContext } from "../../src/daemon/handlers.ts";
import { createMockAdapter } from "../../src/adapter/mock.ts";
import type { ServerEvent } from "../../src/daemon/protocol.ts";

const run = promisify(execFile);
let root: string;
let repo: string;

const NOOP_CONN = { follow() {}, unfollow() {}, isFollowing: () => false };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "doctrine-daemon-"));
  repo = join(root, "repo");
  await run("git", ["init", "-b", "main", repo]);
  await run("git", ["-C", repo, "config", "user.email", "t@e.com"]);
  await run("git", ["-C", repo, "config", "user.name", "t"]);
  await writeFile(join(repo, "README.md"), "x\n");
  await run("git", ["-C", repo, "add", "."]);
  await run("git", ["-C", repo, "commit", "-m", "init"]);
  await mkdir(join(repo, ".doctrine", "workflows"), { recursive: true });
  await writeFile(join(repo, ".doctrine", "project.yaml"), "defaultWorkflow: feature\nmaxConcurrent: 1\nbaseBranch: main\n");
  await writeFile(join(repo, ".doctrine", "workflows", "feature.yaml"),
    "name: feature\nsteps:\n  - id: review\n    type: approval\n    title: 見て\n");
  process.env.DOCTRINE_STATE_DIR = join(root, "state");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); delete process.env.DOCTRINE_STATE_DIR; });

function context(events: ServerEvent[] = []): DaemonContext {
  const db = openDb(":memory:");
  return {
    db,
    adapter: createMockAdapter({ result: { ok: true, text: "done" } }),
    logRoot: join(root, "logs"),
    globalLimit: 4,
    broadcast: (ev) => events.push(ev),
    warnings: [],
    loadWorkflow: async (projectPath, name) => {
      const { parseWorkflow } = await import("../../src/workflow/schema.ts");
      const { readFile } = await import("node:fs/promises");
      return parseWorkflow(await readFile(join(projectPath, ".doctrine", "workflows", `${name}.yaml`), "utf8")).workflow;
    },
    running: new Set(),
  };
}

test("project.add でプロジェクトを登録し、設定を読む", async () => {
  const ctx = context();
  const h = createHandler(ctx);
  const p = await h("project.add", { path: repo }, NOOP_CONN) as { id: number; default_workflow: string };
  assert.equal(p.default_workflow, "feature");
  const list = await h("project.list", {}, NOOP_CONN) as unknown[];
  assert.equal(list.length, 1);
});

test("task.create は queued のタスクを作り、worktree はまだ作らない", async () => {
  const ctx = context();
  const h = createHandler(ctx);
  await h("project.add", { path: repo }, NOOP_CONN);
  const t = await h("task.create", { project: repo, title: "T", prompt: "直して" }, NOOP_CONN) as { id: string };
  const row = getTask(ctx.db, t.id)!;
  assert.equal(row.state, "queued");
  assert.equal(row.worktree_path, null, "枠が取れた瞬間に作る");
  assert.match(row.branch, /^doctrine\//);
});

test("不正なワークフロー名はタスク作成時に落とす", async () => {
  const ctx = context();
  const h = createHandler(ctx);
  await h("project.add", { path: repo }, NOOP_CONN);
  await assert.rejects(() => h("task.create", { project: repo, title: "T", prompt: "p", workflow: "nonexistent" }, NOOP_CONN));
});

test("tick で枠を取り、worktree を作って approval まで進む", async () => {
  const events: ServerEvent[] = [];
  const ctx = context(events);
  const h = createHandler(ctx);
  await h("project.add", { path: repo }, NOOP_CONN);
  const t = await h("task.create", { project: repo, title: "T", prompt: "p" }, NOOP_CONN) as { id: string };
  await tick(ctx);
  const row = getTask(ctx.db, t.id)!;
  assert.equal(row.state, "suspended");
  assert.ok(row.worktree_path, "枠が取れた瞬間に worktree ができている");
  assert.ok(events.some((e) => e.event === "task.stateChanged"));
});

test("task.approve で queued に戻り、行列の先頭に入る", async () => {
  const ctx = context();
  const h = createHandler(ctx);
  await h("project.add", { path: repo }, NOOP_CONN);
  const t = await h("task.create", { project: repo, title: "T", prompt: "p" }, NOOP_CONN) as { id: string };
  await tick(ctx);
  await h("task.approve", { task_id: t.id }, NOOP_CONN);
  const row = getTask(ctx.db, t.id)!;
  assert.equal(row.state, "queued");
  assert.equal(row.resumed, 1);
});

test("task.reject はコメントを必須にする", async () => {
  const ctx = context();
  const h = createHandler(ctx);
  await h("project.add", { path: repo }, NOOP_CONN);
  const t = await h("task.create", { project: repo, title: "T", prompt: "p" }, NOOP_CONN) as { id: string };
  await tick(ctx);
  await assert.rejects(() => h("task.reject", { task_id: t.id }, NOOP_CONN));
});

test("task.cancel は canceled にして worktree を残す", async () => {
  const ctx = context();
  const h = createHandler(ctx);
  await h("project.add", { path: repo }, NOOP_CONN);
  const t = await h("task.create", { project: repo, title: "T", prompt: "p" }, NOOP_CONN) as { id: string };
  await tick(ctx);
  const before = getTask(ctx.db, t.id)!.worktree_path;
  await h("task.cancel", { task_id: t.id }, NOOP_CONN);
  const row = getTask(ctx.db, t.id)!;
  assert.equal(row.state, "canceled");
  assert.equal(row.worktree_path, before, "失敗・中止の worktree は残す");
});

test("task.list は state でフィルタできる", async () => {
  const ctx = context();
  const h = createHandler(ctx);
  await h("project.add", { path: repo }, NOOP_CONN);
  await h("task.create", { project: repo, title: "A", prompt: "p" }, NOOP_CONN);
  await h("task.create", { project: repo, title: "B", prompt: "p" }, NOOP_CONN);
  const queued = await h("task.list", { state: "queued" }, NOOP_CONN) as unknown[];
  assert.equal(queued.length, 2);
});

test("worktree.list は孤児を報告する", async () => {
  const ctx = context();
  const h = createHandler(ctx);
  await h("project.add", { path: repo }, NOOP_CONN);
  const res = await h("worktree.list", {}, NOOP_CONN) as { orphans: string[] }[];
  assert.ok(Array.isArray(res));
});

test("未知のメソッドはエラーになる", async () => {
  const ctx = context();
  await assert.rejects(() => createHandler(ctx)("task.nope", {}, NOOP_CONN));
});
```

- [ ] **Step 2: テストが落ちることを確認する**

Run: `pnpm test test/daemon/handlers.test.ts`
Expected: FAIL（モジュールが無い）

- [ ] **Step 3: ハンドラを実装する**

`src/daemon/handlers.ts`:

```ts
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { parseWorkflow, type Workflow } from "../workflow/schema.ts";
import { parseProjectConfig, withSetupStep } from "../workflow/project.ts";
import {
  getProject, getProjectByPath, getTask, insertProject, insertTask, listProjects, listTasks,
  type TaskState,
} from "../db/tasks.ts";
import { getStepRun, listStepRuns } from "../db/stepRuns.ts";
import { commitStepBoundary } from "../db/boundary.ts";
import { recentRateLimitSamples } from "../db/rateLimits.ts";
import { selectAdmissible } from "../core/scheduler.ts";
import { applyApproval, runTask } from "../core/engine.ts";
import {
  branchNameFor, createWorktree, findOrphans, removeWorktree, worktreePathFor,
} from "../core/worktree.ts";
import { killStaleChild, defaultProbe } from "../core/recovery.ts";
import type { AgentAdapter } from "../adapter/types.ts";
import type { Handler } from "./server.ts";
import type { ServerEvent } from "./protocol.ts";

export type DaemonContext = {
  db: DatabaseSync;
  adapter: AgentAdapter;
  logRoot: string;
  globalLimit: number;
  broadcast(ev: ServerEvent, opts?: { taskId?: string; followersOnly?: boolean }): void;
  loadWorkflow(projectPath: string, name: string): Promise<Workflow>;
  running: Set<string>;
  /** 後始末を拒否したときなど、人に見せる必要のある警告 */
  warnings: string[];
};

function req(params: Record<string, unknown>, key: string): string {
  const v = params[key];
  if (typeof v !== "string" || v === "") throw new Error(`${key} は必須です`);
  return v;
}

export async function loadWorkflowFromDisk(projectPath: string, name: string): Promise<Workflow> {
  const path = join(projectPath, ".doctrine", "workflows", `${name}.yaml`);
  const text = await readFile(path, "utf8").catch(() => {
    throw new Error(`ワークフローがありません: ${path}`);
  });
  return parseWorkflow(text).workflow;
}

export function createHandler(ctx: DaemonContext): Handler {
  return async (method, params, conn) => {
    switch (method) {
      case "project.add": {
        const path = req(params, "path");
        const cfgText = await readFile(join(path, ".doctrine", "project.yaml"), "utf8");
        const cfg = parseProjectConfig(cfgText);
        const id = insertProject(ctx.db, {
          path, default_workflow: cfg.defaultWorkflow, max_concurrent: cfg.maxConcurrent,
          base_branch: cfg.baseBranch, setup: cfg.setup ?? null,
        });
        return getProject(ctx.db, id);
      }
      case "project.list":
        return listProjects(ctx.db);
      case "project.update": {
        const path = req(params, "path");
        const project = getProjectByPath(ctx.db, path);
        if (!project) throw new Error(`未登録のプロジェクトです: ${path}`);
        const cfg = parseProjectConfig(await readFile(join(path, ".doctrine", "project.yaml"), "utf8"));
        ctx.db.prepare(
          `UPDATE projects SET default_workflow=?, max_concurrent=?, base_branch=?, setup=? WHERE id=?`,
        ).run(cfg.defaultWorkflow, cfg.maxConcurrent, cfg.baseBranch, cfg.setup ?? null, project.id);
        return getProject(ctx.db, project.id);
      }

      case "task.create": {
        const projectPath = req(params, "project");
        const project = getProjectByPath(ctx.db, projectPath);
        if (!project) throw new Error(`未登録のプロジェクトです: ${projectPath}`);
        const title = req(params, "title");
        const prompt = req(params, "prompt");
        const workflowName = typeof params.workflow === "string" ? params.workflow : project.default_workflow;
        // 不正な定義はタスク作成時に落とす
        await ctx.loadWorkflow(projectPath, workflowName);
        const id = randomUUID();
        return insertTask(ctx.db, {
          id, project_id: project.id, title, prompt, workflow_name: workflowName,
          branch: branchNameFor(id, title),
          priority: typeof params.priority === "number" ? params.priority : 2,
        });
      }
      case "task.list": {
        const filter: { projectId?: number; state?: TaskState } = {};
        if (typeof params.project === "string") {
          filter.projectId = getProjectByPath(ctx.db, params.project)?.id;
        }
        if (typeof params.state === "string") filter.state = params.state as TaskState;
        return listTasks(ctx.db, filter);
      }
      case "task.get": {
        const task = getTask(ctx.db, req(params, "task_id"));
        if (!task) throw new Error("タスクがありません");
        return { task, stepRuns: listStepRuns(ctx.db, task.id) };
      }

      case "task.approve":
      case "task.reject": {
        const taskId = req(params, "task_id");
        const task = getTask(ctx.db, taskId);
        if (!task) throw new Error("タスクがありません");
        const approved = method === "task.approve";
        const comment = approved ? "" : req(params, "comment");
        const project = getProject(ctx.db, task.project_id)!;
        const workflow = withSetupStep(
          await ctx.loadWorkflow(project.path, task.workflow_name), project.setup ?? undefined);
        applyApproval(ctx.db, taskId, { approved, comment }, workflow);
        const after = getTask(ctx.db, taskId)!;
        ctx.broadcast({ event: "task.stateChanged", task_id: taskId, from: "suspended", to: after.state });
        return after;
      }

      case "task.pause": {
        const taskId = req(params, "task_id");
        const task = getTask(ctx.db, taskId);
        if (!task) throw new Error("タスクがありません");
        await killStaleChild(task, defaultProbe());
        commitStepBoundary(ctx.db, {
          taskId, taskPatch: { state: "paused", child_pid: null, child_started_at: null },
        });
        ctx.broadcast({ event: "task.stateChanged", task_id: taskId, from: task.state, to: "paused" });
        return getTask(ctx.db, taskId);
      }
      case "task.resume": {
        const taskId = req(params, "task_id");
        const task = getTask(ctx.db, taskId);
        if (!task) throw new Error("タスクがありません");
        if (task.state !== "paused" && task.state !== "suspended") {
          throw new Error(`再開できる状態ではありません: ${task.state}`);
        }
        // 行列の先頭に入る。進行中の仕事を新規の仕事より先に終わらせる。
        commitStepBoundary(ctx.db, { taskId, taskPatch: { state: "queued", resumed: 1 } });
        ctx.broadcast({ event: "task.stateChanged", task_id: taskId, from: task.state, to: "queued" });
        return getTask(ctx.db, taskId);
      }
      case "task.cancel": {
        const taskId = req(params, "task_id");
        const task = getTask(ctx.db, taskId);
        if (!task) throw new Error("タスクがありません");
        await killStaleChild(task, defaultProbe());
        // worktree は残す。失敗した実行こそ中を見たい。
        commitStepBoundary(ctx.db, {
          taskId, taskPatch: { state: "canceled", child_pid: null, child_started_at: null },
        });
        ctx.broadcast({ event: "task.stateChanged", task_id: taskId, from: task.state, to: "canceled" });
        return getTask(ctx.db, taskId);
      }
      case "task.logs": {
        const taskId = req(params, "task_id");
        if (params.follow) conn.follow(taskId);
        const stepRunId = Number(params.step_run_id);
        const run = getStepRun(ctx.db, stepRunId);
        if (!run) throw new Error("ステップ実行がありません");
        const text = await readFile(run.log_path, "utf8").catch(() => "");
        const tailLines = typeof params.tail === "number" ? params.tail : 200;
        return { log_path: run.log_path, lines: text.split("\n").slice(-tailLines) };
      }

      case "worktree.list": {
        const out: { project: string; orphans: string[] }[] = [];
        for (const project of listProjects(ctx.db)) {
          const known = listTasks(ctx.db, { projectId: project.id })
            .map((t) => t.worktree_path).filter((p): p is string => p !== null);
          out.push({ project: project.path, orphans: await findOrphans(project.path, known) });
        }
        return out;
      }
      case "worktree.remove": {
        const taskId = req(params, "task_id");
        const task = getTask(ctx.db, taskId);
        if (!task?.worktree_path) throw new Error("worktree がありません");
        const project = getProject(ctx.db, task.project_id)!;
        // 失敗したタスクの worktree は汚れているのが通常。未コミットの作業は失われる。
        await removeWorktree({
          repoPath: project.path, worktreePath: task.worktree_path, force: params.force === true,
        });
        commitStepBoundary(ctx.db, { taskId, taskPatch: { worktree_path: null } });
        return { removed: task.worktree_path };
      }

      case "ratelimit.recent":
        return recentRateLimitSamples(ctx.db, typeof params.limit === "number" ? params.limit : 50);

      default:
        throw new Error(`未知のメソッドです: ${method}`);
    }
  };
}

/** 実行中のステップの step_runs.id。まだ1件も無ければ 0。 */
function latestStepRunId(db: DatabaseSync, taskId: string): number {
  return listStepRuns(db, taskId).at(-1)?.id ?? 0;
}

/** 1周: 枠の空きを見て queued を running にし、次に人を待つ地点まで進める。 */
export async function tick(ctx: DaemonContext): Promise<void> {
  for (const task of selectAdmissible(ctx.db, ctx.globalLimit)) {
    if (ctx.running.has(task.id)) continue;
    ctx.running.add(task.id);

    const project = getProject(ctx.db, task.project_id)!;
    const workflow = withSetupStep(
      await ctx.loadWorkflow(project.path, task.workflow_name), project.setup ?? undefined);

    // worktree はタスク作成時ではなく、実行枠が取れた瞬間に作る
    let worktreePath = task.worktree_path;
    if (!worktreePath) {
      worktreePath = worktreePathFor(project.path, task.id);
      await createWorktree({
        repoPath: project.path, worktreePath, branch: task.branch, baseBranch: project.base_branch,
      });
    }

    commitStepBoundary(ctx.db, {
      taskId: task.id,
      taskPatch: { state: "running", worktree_path: worktreePath, resumed: 0 },
    });
    ctx.broadcast({ event: "task.stateChanged", task_id: task.id, from: task.state, to: "running" });

    void runTask(ctx.db, task.id, workflow, {
      db: ctx.db, adapter: ctx.adapter, logRoot: ctx.logRoot, globalLimit: ctx.globalLimit,
      onStateChanged: (id, from, to) =>
        ctx.broadcast({ event: "task.stateChanged", task_id: id, from, to }),
      onStepRunStarted: (id, stepRunId, stepId) =>
        ctx.broadcast({ event: "stepRun.started", task_id: id, step_run_id: stepRunId, step_id: stepId }),
      onStepRunFinished: (id, stepRunId, stepId, status) =>
        ctx.broadcast({ event: "stepRun.finished", task_id: id, step_run_id: stepRunId, step_id: stepId, status }),
      onRateLimit: (s) =>
        ctx.broadcast({ event: "ratelimit.sample", window: s.window, utilization: s.utilization, resets_at: s.resetsAt }),
      onLogLine: (line) =>
        ctx.broadcast(
          { event: "log.line", task_id: task.id, step_run_id: latestStepRunId(ctx.db, task.id), line },
          { taskId: task.id, followersOnly: true }),
    }).finally(() => ctx.running.delete(task.id));
  }
}
```

`tick` のテストでは `runTask` の完了を待つ必要がある。テスト側は `await tick(ctx)` の後に
`ctx.running` が空になるまで待つ小さなヘルパ（`await until(() => ctx.running.size === 0)`）を置くこと。

- [ ] **Step 3.5: 完了時の worktree 後始末を足す**

spec 5章「後始末 — 成功と失敗で変える」がどこからも呼ばれていない状態なので、`tick` の
`runTask` 完了後に繋ぐ。**completed だけ削除し、failed / canceled は残す。**
未コミットの変更が残っていたら削除を拒否して警告する（黙って消してよいものではない）。

テストを `test/daemon/handlers.test.ts` に追記:

```ts
test("完了したタスクの worktree は削除され、ブランチは残る", async () => {
  const ctx = context();
  const h = createHandler(ctx);
  await h("project.add", { path: repo }, NOOP_CONN);
  // approval を含まない、すぐ終わるワークフローに差し替える
  await writeFile(join(repo, ".doctrine", "workflows", "quick.yaml"),
    "name: quick\nsteps:\n  - id: a\n    type: command\n    run: \"true\"\n");
  const t = await h("task.create", { project: repo, title: "T", prompt: "p", workflow: "quick" }, NOOP_CONN) as { id: string };
  await tick(ctx);
  await until(() => getTask(ctx.db, t.id)?.state === "completed");
  assert.equal(getTask(ctx.db, t.id)?.worktree_path, null);
  const { stdout } = await run("git", ["-C", repo, "branch", "--list", getTask(ctx.db, t.id)!.branch]);
  assert.match(stdout, /doctrine\//, "完了後の扱いは最終ステップが決めている。ブランチは残す");
});

test("未コミットの変更が残っていたら削除せず警告する", async () => {
  const ctx = context();
  const h = createHandler(ctx);
  await h("project.add", { path: repo }, NOOP_CONN);
  await writeFile(join(repo, ".doctrine", "workflows", "dirty.yaml"),
    "name: dirty\nsteps:\n  - id: a\n    type: command\n    run: \"touch leftover.txt\"\n");
  const t = await h("task.create", { project: repo, title: "T", prompt: "p", workflow: "dirty" }, NOOP_CONN) as { id: string };
  await tick(ctx);
  await until(() => getTask(ctx.db, t.id)?.state === "completed");
  assert.ok(getTask(ctx.db, t.id)?.worktree_path, "削除を拒否して残す");
  assert.ok(ctx.warnings.some((w) => /未コミット/.test(w)), "警告として出す");
});

test("失敗したタスクの worktree は削除しない", async () => {
  const ctx = context();
  const h = createHandler(ctx);
  await h("project.add", { path: repo }, NOOP_CONN);
  await writeFile(join(repo, ".doctrine", "workflows", "boom.yaml"),
    "name: boom\nsteps:\n  - id: a\n    type: command\n    run: \"exit 1\"\n");
  const t = await h("task.create", { project: repo, title: "T", prompt: "p", workflow: "boom" }, NOOP_CONN) as { id: string };
  await tick(ctx);
  await until(() => getTask(ctx.db, t.id)?.state === "failed");
  assert.ok(getTask(ctx.db, t.id)?.worktree_path);
});
```

`DaemonContext` に警告の受け口を足す:

```ts
export type DaemonContext = {
  // ...既存のフィールド
  warnings: string[];   // 後始末を拒否したときなど、人に見せる必要のある警告
};
```

`src/daemon/handlers.ts` に後始末を実装し、`tick` の `runTask` 完了後に呼ぶ:

```ts
/** completed のみ worktree を削除する。failed / canceled は証拠として残す。 */
export async function cleanupAfterRun(ctx: DaemonContext, taskId: string): Promise<void> {
  const task = getTask(ctx.db, taskId);
  if (!task || task.state !== "completed" || !task.worktree_path) return;
  const project = getProject(ctx.db, task.project_id)!;
  try {
    await removeWorktree({ repoPath: project.path, worktreePath: task.worktree_path, force: false });
    commitStepBoundary(ctx.db, { taskId, taskPatch: { worktree_path: null } });
  } catch (e) {
    // ワークフローの書き方のバグ。黙って消してよいものではない。
    ctx.warnings.push(
      `タスク ${taskId}: 完了時に未コミットの変更が残っているため worktree を削除しませんでした ` +
      `(${task.worktree_path}): ${(e as Error).message}`,
    );
  }
}
```

`tick` の中の `void runTask(...)` の `.finally()` を差し替える:

```ts
    void runTask(ctx.db, task.id, workflow, { /* ...既存のdeps... */ })
      .then(() => cleanupAfterRun(ctx, task.id))
      .finally(() => ctx.running.delete(task.id));
```

Run: `pnpm test test/daemon/handlers.test.ts`
Expected: PASS（13件）

- [ ] **Step 4: デーモン本体を書く**

`src/daemon/main.ts`:

```ts
import { join } from "node:path";
import { homedir } from "node:os";
import { openDb } from "../db/migrate.ts";
import { createClaudeAdapter } from "../adapter/claude.ts";
import { recoverOnStartup, defaultProbe } from "../core/recovery.ts";
import { findOrphans } from "../core/worktree.ts";
import { listProjects, listTasks } from "../db/tasks.ts";
import { DEFAULT_GLOBAL_LIMIT } from "../core/scheduler.ts";
import { createServer, socketPath } from "./server.ts";
import { createHandler, loadWorkflowFromDisk, tick, type DaemonContext } from "./handlers.ts";

export function stateRoot(): string {
  return process.env.DOCTRINE_STATE_DIR ?? join(homedir(), ".local", "state", "doctrine");
}

export async function startDaemon(o: {
  dbPath?: string; socketPath?: string; logRoot?: string; globalLimit?: number; tickMs?: number;
} = {}): Promise<{ stop(): Promise<void> }> {
  const db = openDb(o.dbPath ?? join(stateRoot(), "doctrine.db"));

  const ctx: DaemonContext = {
    db,
    adapter: createClaudeAdapter(),
    logRoot: o.logRoot ?? join(stateRoot(), "logs"),
    globalLimit: o.globalLimit ?? DEFAULT_GLOBAL_LIMIT,
    broadcast: () => {},
    loadWorkflow: loadWorkflowFromDisk,
    running: new Set(),
    warnings: [],
  };

  const server = createServer(createHandler(ctx));
  ctx.broadcast = (ev, opts) => server.broadcast(ev, opts);
  await server.listen(o.socketPath ?? socketPath());

  // 起動時: running のタスクはすべて古い。子を殺してから queued に戻す。
  const recovered = await recoverOnStartup(db, defaultProbe());
  for (const r of recovered) console.error(`[recovery] ${r.taskId}: ${r.action}`);

  // 孤児の照合（自動削除はしない）
  for (const project of listProjects(db)) {
    const known = listTasks(db, { projectId: project.id })
      .map((t) => t.worktree_path).filter((p): p is string => p !== null);
    for (const orphan of await findOrphans(project.path, known)) {
      console.error(`[orphan] 対応するタスクのない worktree: ${orphan}`);
    }
  }

  const timer = setInterval(() => {
    void tick(ctx);
    // 警告は溜めっぱなしにしない。見えていれば直せる。
    for (const w of ctx.warnings.splice(0)) console.error(`[warn] ${w}`);
  }, o.tickMs ?? 1000);
  timer.unref();

  return {
    async stop() {
      clearInterval(timer);
      await server.close();
      db.close();
    },
  };
}

if (import.meta.filename === process.argv[1]) {
  await startDaemon();
}
```

- [ ] **Step 5: テストが通ることを確認する**

Run: `pnpm test test/daemon/handlers.test.ts`
Expected: PASS（10件）

- [ ] **Step 6: コミット**

```bash
git add src/daemon/handlers.ts src/daemon/main.ts test/daemon/handlers.test.ts
git commit -m "feat: デーモンAPI ハンドラとスケジューリングループ"
```

---

## Task 14: `dctl` CLI

テスト・デバッグのための表面であって製品UIではない。**薄く保つ**。

**Files:**
- Create: `src/cli/dctl.ts`
- Modify: `package.json`（`bin` を追加）
- Test: `test/daemon/cli.test.ts`

**Interfaces:**
- Consumes: `socketPath`（Task 12）、デーモンAPI（Task 13）
- Produces:
  ```ts
  export function parseArgv(argv: string[]): { method: string; params: Record<string, unknown> };
  export function call(socketPath: string, method: string, params: Record<string, unknown>): Promise<unknown>;
  export function main(argv: string[]): Promise<number>;
  ```

- [ ] **Step 1: 失敗するテストを書く**

`test/daemon/cli.test.ts`:

```ts
import { test } from "vitest";
import assert from "node:assert/strict";
import { parseArgv } from "../../src/cli/dctl.ts";

test("dctl add", () => {
  assert.deepEqual(parseArgv(["add", "--project", "/repo", "--title", "T", "--prompt", "直して"]),
    { method: "task.create", params: { project: "/repo", title: "T", prompt: "直して" } });
});

test("dctl ls", () => {
  assert.deepEqual(parseArgv(["ls"]), { method: "task.list", params: {} });
  assert.deepEqual(parseArgv(["ls", "--state", "queued"]), { method: "task.list", params: { state: "queued" } });
});

test("dctl approve / reject", () => {
  assert.deepEqual(parseArgv(["approve", "t1"]), { method: "task.approve", params: { task_id: "t1" } });
  assert.deepEqual(parseArgv(["reject", "t1", "--comment", "命名が変"]),
    { method: "task.reject", params: { task_id: "t1", comment: "命名が変" } });
});

test("dctl gc は worktree.remove", () => {
  assert.deepEqual(parseArgv(["gc", "t1", "--force"]),
    { method: "worktree.remove", params: { task_id: "t1", force: true } });
});

test("priority は数値になる", () => {
  const { params } = parseArgv(["add", "--project", "/r", "--title", "T", "--prompt", "p", "--priority", "0"]);
  assert.equal(params.priority, 0);
});

test("未知のサブコマンドは落ちる", () => {
  assert.throws(() => parseArgv(["frobnicate"]), /未知のコマンド/);
});
```

- [ ] **Step 2: テストが落ちることを確認する**

Run: `pnpm test test/daemon/cli.test.ts`
Expected: FAIL（モジュールが無い）

- [ ] **Step 3: 実装を書く**

`src/cli/dctl.ts`:

```ts
import { connect } from "node:net";
import { socketPath } from "../daemon/server.ts";

const NUMERIC = new Set(["priority", "limit", "tail", "step_run_id"]);
const BOOLEAN = new Set(["force", "follow"]);

function flags(argv: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    if (BOOLEAN.has(key)) { out[key] = true; continue; }
    const value = argv[++i];
    out[key] = NUMERIC.has(key) ? Number(value) : value;
  }
  return out;
}

export function parseArgv(argv: string[]): { method: string; params: Record<string, unknown> } {
  const [cmd, ...rest] = argv;
  const positional = rest.filter((a) => !a.startsWith("--") && rest[rest.indexOf(a) - 1]?.startsWith("--") !== true);
  const f = flags(rest);
  switch (cmd) {
    case "add": return { method: "task.create", params: f };
    case "ls": return { method: "task.list", params: f };
    case "get": return { method: "task.get", params: { task_id: positional[0], ...f } };
    case "approve": return { method: "task.approve", params: { task_id: positional[0] } };
    case "reject": return { method: "task.reject", params: { task_id: positional[0], ...f } };
    case "pause": return { method: "task.pause", params: { task_id: positional[0] } };
    case "resume": return { method: "task.resume", params: { task_id: positional[0] } };
    case "cancel": return { method: "task.cancel", params: { task_id: positional[0] } };
    case "logs": return { method: "task.logs", params: { task_id: positional[0], ...f } };
    case "projects": return { method: "project.list", params: {} };
    case "project-add": return { method: "project.add", params: f };
    case "worktrees": return { method: "worktree.list", params: {} };
    case "gc": return { method: "worktree.remove", params: { task_id: positional[0], ...f } };
    case "ratelimit": return { method: "ratelimit.recent", params: f };
    default: throw new Error(`未知のコマンドです: ${cmd}`);
  }
}

export function call(path: string, method: string, params: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    let buf = "";
    socket.setEncoding("utf8");
    socket.on("error", reject);
    socket.on("connect", () => socket.write(JSON.stringify({ id: 1, method, params }) + "\n"));
    socket.on("data", (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const msg = JSON.parse(line) as { id?: number; ok?: boolean; result?: unknown; error?: string };
        if (msg.id !== 1) continue; // イベントは無視
        socket.end();
        msg.ok ? resolve(msg.result) : reject(new Error(msg.error));
      }
    });
  });
}

export async function main(argv: string[]): Promise<number> {
  try {
    const { method, params } = parseArgv(argv);
    const result = await call(process.env.DOCTRINE_SOCKET ?? socketPath(), method, params);
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }
}

if (import.meta.filename === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
```

`package.json` に追記:

```json
  "bin": { "dctl": "./src/cli/dctl.ts", "dctld": "./src/daemon/main.ts" }
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `pnpm test test/daemon/cli.test.ts`
Expected: PASS（6件）

`parseArgv` の positional 抽出はテストが要求する形（`approve t1` / `reject t1 --comment x`）を満たせば
実装を単純化してよい。フラグの前後関係を舐める現在の書き方が読みにくければ、
`--` で始まる引数とその値をまず取り除き、残りを positional とする形に書き直すこと。

- [ ] **Step 5: コミット**

```bash
git add src/cli/dctl.ts package.json test/daemon/cli.test.ts
git commit -m "feat: デバッグCLI dctl"
```

---

## Task 15: 通しの統合テスト

モックアダプタで**本物のgitリポジトリを相手に**ワークフローを一周させる。ここまでの部品が実際につながっていることの確認。

**Files:**
- Create: `test/integration/fullCycle.test.ts`
- Create: `test/helpers/repo.ts`

**Interfaces:**
- Consumes: Task 1〜14 のすべて
- Produces: `export async function makeRepo(root: string, files: Record<string, string>): Promise<string>;`

- [ ] **Step 1: ヘルパを書く**

`test/helpers/repo.ts`:

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const run = promisify(execFile);

export async function makeRepo(root: string, files: Record<string, string>): Promise<string> {
  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  await run("git", ["init", "-b", "main", repo]);
  await run("git", ["-C", repo, "config", "user.email", "t@e.com"]);
  await run("git", ["-C", repo, "config", "user.name", "t"]);
  for (const [path, content] of Object.entries(files)) {
    const full = join(repo, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  await run("git", ["-C", repo, "add", "."]);
  await run("git", ["-C", repo, "commit", "-m", "init"]);
  return repo;
}

export async function until(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("条件が満たされませんでした");
}
```

- [ ] **Step 2: 通しのテストを書く**

`test/integration/fullCycle.test.ts`:

```ts
import { test, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/db/migrate.ts";
import { getTask } from "../../src/db/tasks.ts";
import { listStepRuns } from "../../src/db/stepRuns.ts";
import { createHandler, tick, type DaemonContext } from "../../src/daemon/handlers.ts";
import { loadWorkflowFromDisk } from "../../src/daemon/handlers.ts";
import { createMockAdapter } from "../../src/adapter/mock.ts";
import { makeRepo, until } from "../helpers/repo.ts";

const NOOP_CONN = { follow() {}, unfollow() {}, isFollowing: () => false };
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "doctrine-e2e-"));
  process.env.DOCTRINE_STATE_DIR = join(root, "state");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); delete process.env.DOCTRINE_STATE_DIR; });

const WORKFLOW = `
name: feature
steps:
  - id: implement
    type: agent
    prompt: "{{ task.prompt }}"
    permissionMode: acceptEdits
  - id: verify
    type: command
    run: "test -f marker.txt"
    onFailure:
      goto: implement
      maxAttempts: 3
      feed: "marker.txt がない:\\n{{ steps.verify.stderr }}"
  - id: review
    type: approval
    title: "差分を確認してください"
    onReject:
      goto: implement
      maxAttempts: 5
      feed: "レビューで却下された:\\n{{ steps.review.stdout }}"
  - id: record
    type: command
    run: "echo done > result.txt"
`;

async function context(repo: string, adapter = createMockAdapter({ result: { ok: true, text: "やりました" } })) {
  const db = openDb(":memory:");
  const events: unknown[] = [];
  const ctx: DaemonContext = {
    db, adapter, logRoot: join(root, "logs"), globalLimit: 4,
    broadcast: (ev) => events.push(ev),
    loadWorkflow: loadWorkflowFromDisk,
    running: new Set(),
    warnings: [],
  };
  return { ctx, events, handler: createHandler(ctx) };
}

test("setup → agent → command → approval → 承認 → 完了まで通る", async () => {
  const repo = await makeRepo(root, {
    ".doctrine/project.yaml": "setup: touch marker.txt\ndefaultWorkflow: feature\nmaxConcurrent: 1\nbaseBranch: main\n",
    ".doctrine/workflows/feature.yaml": WORKFLOW,
  });
  const { ctx, handler } = await context(repo);
  await handler("project.add", { path: repo }, NOOP_CONN);
  const t = await handler("task.create", { project: repo, title: "マーカーを作る", prompt: "作って" }, NOOP_CONN) as { id: string };

  await tick(ctx);
  await until(() => getTask(ctx.db, t.id)?.state === "suspended");

  const runs = listStepRuns(ctx.db, t.id).map((r) => r.step_id);
  assert.deepEqual(runs, ["setup", "implement", "verify"], "setup が先頭に自動挿入されている");

  await handler("task.approve", { task_id: t.id }, NOOP_CONN);
  assert.equal(getTask(ctx.db, t.id)?.state, "queued");

  await tick(ctx);
  await until(() => getTask(ctx.db, t.id)?.state === "completed");

  const wt = getTask(ctx.db, t.id)!.worktree_path!;
  assert.match(await readFile(join(wt, "result.txt"), "utf8"), /done/);
});

test("却下すると実装ステップへ戻り、コメントがエージェントに渡る", async () => {
  const repo = await makeRepo(root, {
    ".doctrine/project.yaml": "setup: touch marker.txt\ndefaultWorkflow: feature\nmaxConcurrent: 1\nbaseBranch: main\n",
    ".doctrine/workflows/feature.yaml": WORKFLOW,
  });
  const adapter = createMockAdapter({ result: { ok: true, text: "やりました" } });
  const { ctx, handler } = await context(repo, adapter);
  await handler("project.add", { path: repo }, NOOP_CONN);
  const t = await handler("task.create", { project: repo, title: "T", prompt: "作って" }, NOOP_CONN) as { id: string };

  await tick(ctx);
  await until(() => getTask(ctx.db, t.id)?.state === "suspended");
  await handler("task.reject", { task_id: t.id, comment: "命名が変です" }, NOOP_CONN);
  assert.equal(getTask(ctx.db, t.id)?.current_step_id, "implement");

  await tick(ctx);
  await until(() => getTask(ctx.db, t.id)?.state === "suspended");

  const resumeCall = adapter.calls.find((c) => c.kind === "resume");
  assert.ok(resumeCall, "却下後は resume で会話が継続する");
  assert.match(resumeCall!.prompt, /命名が変です/, "却下コメントがエージェントに渡っている");
});

test("プロジェクト枠1のとき、承認待ちのタスクが次のタスクを止める", async () => {
  const repo = await makeRepo(root, {
    ".doctrine/project.yaml": "setup: touch marker.txt\ndefaultWorkflow: feature\nmaxConcurrent: 1\nbaseBranch: main\n",
    ".doctrine/workflows/feature.yaml": WORKFLOW,
  });
  const { ctx, handler } = await context(repo);
  await handler("project.add", { path: repo }, NOOP_CONN);
  const a = await handler("task.create", { project: repo, title: "A", prompt: "p" }, NOOP_CONN) as { id: string };
  const b = await handler("task.create", { project: repo, title: "B", prompt: "p" }, NOOP_CONN) as { id: string };

  await tick(ctx);
  await until(() => getTask(ctx.db, a.id)?.state === "suspended");
  await tick(ctx);
  assert.equal(getTask(ctx.db, b.id)?.state, "queued", "承認待ちの間、同じプロジェクトの次のタスクは走らない");
});

test("失敗したタスクの worktree は残る", async () => {
  const repo = await makeRepo(root, {
    ".doctrine/project.yaml": "defaultWorkflow: fail\nmaxConcurrent: 1\nbaseBranch: main\n",
    ".doctrine/workflows/fail.yaml": "name: fail\nsteps:\n  - id: boom\n    type: command\n    run: \"exit 9\"\n",
  });
  const { ctx, handler } = await context(repo);
  await handler("project.add", { path: repo }, NOOP_CONN);
  const t = await handler("task.create", { project: repo, title: "T", prompt: "p" }, NOOP_CONN) as { id: string };
  await tick(ctx);
  await until(() => getTask(ctx.db, t.id)?.state === "failed");

  const row = getTask(ctx.db, t.id)!;
  assert.ok(row.worktree_path, "失敗した実行こそ中を見たい");
  assert.equal(listStepRuns(ctx.db, t.id).at(-1)?.exit_code, 9);
});
```

- [ ] **Step 3: テストを走らせて落ちるところを直す**

Run: `pnpm test`
Expected: 最初は FAIL。部品のつなぎ目（`setup` の自動挿入位置、`tick` の待ち合わせ、worktree のパス）で
落ちるはずなので、**エンジン側を直す**。統合テストを緩めて通すのは本末転倒。

- [ ] **Step 4: 全テストが通ることを確認する**

Run: `pnpm test`
Expected: PASS（全タスク合計 90件前後）

- [ ] **Step 5: 型チェックとビルド**

Run: `pnpm typecheck && pnpm build`
Expected: エラーなし

- [ ] **Step 6: コミット**

```bash
git add test/integration test/helpers
git commit -m "test: ワークフロー一周の統合テスト"
```

---

## Task 16: 制約のドキュメント化

spec が「ドキュメントに明記する」と指定している制約を、実際に読む場所に置く。

**Files:**
- Create: `README.md`
- Modify: `docs/superpowers/specs/2026-09-12-agent-orchestrator-core-design.md`（Task 8 の実測結果が未反映なら反映）

- [ ] **Step 1: README を書く**

最低限、以下を含めること。

1. **doctrine とは**（`docs/overview.md` へのリンク。1段落で要約）
2. **起動方法**: `dctld` の起動、`dctl project-add --path <repo>`、`dctl add`
3. **`.doctrine/project.yaml` と `.doctrine/workflows/*.yaml` の書き方**（spec 3章の例をそのまま）
4. **`command` ステップは再実行安全でなければならない**（spec 225-228行が明記を要求している制約）:
   - クラッシュ復帰時・`task.pause` からの再開時、`command` ステップは頭から再実行される
   - `pnpm install --frozen-lockfile` や `pnpm test` は問題ない
   - `gh pr create` / `git push` / `npm publish` は二重実行になり得る
   - 検証時に警告は出すが、完全には防げない
5. **worktree は失敗・中止時に残る**こと、`dctl gc` で消すこと、`--force` で未コミットの作業が失われること
6. **`degraded` の意味**: 権限で弾かれたまま「成功」した実行。`dctl get <id>` の `step_runs` で見分ける

- [ ] **Step 2: コミット**

```bash
git add README.md docs/superpowers/specs/2026-09-12-agent-orchestrator-core-design.md
git commit -m "docs: 再実行安全性の制約と運用手順"
```

---

## 実装順序と依存

```
1 schema ──┬─> 2 project ──┐
           └─> 3 template ─┤
                           ├─> 9 stepRunner ──> 10 engine ──┐
4 db ──┬─> 5 states ─> 6 scheduler ─────────────────────────┤
       └─> 11 recovery <─────────────────────────────────── │
7 worktree ────────────────────────────────────────────────┤
8 adapter ──────────────> 9 stepRunner                      │
                                                            ├─> 13 handlers ─> 14 dctl ─> 15 integration ─> 16 docs
12 server ──────────────────────────────────────────────────┘
```

Task 1〜8 は互いに独立に進められる（1→2,3 と 4→5,6,11 の依存だけ守ればよい）。
Task 9 以降は直列。

## 検証のチェックポイント

各タスクのコミット前に必ず:

```bash
pnpm test        # 全テスト
pnpm typecheck   # tsc --noEmit
```

「通ったはず」ではなく、**出力を見てから**完了を報告すること。
