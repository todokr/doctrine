# Quick Start（初回ウィザードとワークフローを作るタスク）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** アプリの初回起動で開くウィザードで workspace を登録し、ワークフローの方針を聞き、各プロジェクトの default.yaml を doctrine のタスクとして作らせる。

**Architecture:** core に `dctl workflow-check`、同梱のワークフロー（draft → validate → review → apply）とそれを pin したタスクを作る `workspace.setup`、
ウィザード用の `workspace.detect` と `workspace.add` の拡張を足す。app はそれらを呼ぶウィザード画面を持つ。Intake には触らない。

**Tech Stack:** Deno（core）、Kysely + SQLite、zod、yaml、React + Vite + Tauri 2（app）、`@std/testing/bdd` と `node:assert/strict`（core）、vitest（app）

**Spec:** `docs/superpowers/specs/2026-09-27-quick-start-design.md`

## doctrine で流すときの前提

- 各 Task は doctrine のタスク 1 つ（PR 1 本）として流す。Task 1 → Task 2 と Task 3（並列でよい）→ Task 4 の順に、前の PR がマージされてから次を投入する。
- 各 Task の終わりで既定ワークフローの verify
  （`mise run core:check && mise run core:test && mise run app:deps && mise run app:test && mise run app:build && mise run pfd:check && mise run pfd:test`）
  が通ること。RPC の形を変えた Task は、app の型検査が通るところまで追従させる。
- planner はこの計画の該当 Task と spec を読んで細部を詰める。ここに書いたコードは形と名前の約束で、周りのコードに合わせて直してよい。名前と型は変えないこと（後の Task が使う）。

## Global Constraints

- 後方互換の仕掛けを作らない。
- 既存のファイル（workspace.yaml・project.yaml・workflows/*.yaml）を上書きしない。例外は setup のタスクの `apply` ステップだけで、承認の後に `.doctrine/workflows/default.yaml` を上書きする。
- 同梱ワークフローは利用者のリポジトリに置かない。コードの中の文字列として持ち、タスクの `workflow_yaml` に直接 pin する。`workflow_name` は `setup`、`workflow_setup` は NULL。
- setup のタスクはトラッカー（gh・Linear）を一切使わない。
- 元のリポジトリへの反映は未コミット。doctrine はコミットしない。
- プロジェクトの名前は `[a-z0-9-]+`。workspace の中で重ならない。
- コードのコメントにはそのコード固有の事実だけを書き、一般論は spec に書く。

## Review Focus

1. **既に `.doctrine/` があるリポジトリを選ぶ。** 利用者が書いた `workflows/default.yaml` は setup の対象にならず、上書きされないこと（`workspace.add` の `created` に default.yaml が入らない → ウィザードが `workspace.setup` の対象から外す）。→ Task 3・Task 4 のテスト。
2. **draft のエージェントが `.doctrine-out/` の外を書き換える。** validate が落ちて draft に戻り、何を書き換えたかが feed に出ること。そのまま承認まで進んで worktree が片付かずに残る、にならないこと。→ Task 2 の結合テスト。
3. **プロジェクトのパスに空白が入っている**（`~/work/my repo`）。apply が正しい場所に書くこと。→ Task 2 の結合テスト。
4. **`dctl` が PATH に無い。** validate が「command not found」で 3 回落ちて failed になるのではなく、何をすればよいか（`deno task install`）が feed と stderr に出ること。→ Task 2 のテスト。
5. **git 管理外のディレクトリの直下にリポジトリが 1 つも無い / 選んだディレクトリがリポジトリのサブディレクトリ。** ウィザードが先に進まず、理由を出すこと。→ Task 3・Task 4 のテスト。

---

### Task 1: `dctl workflow-check`

**Files:**
- Modify: `core/src/cli/dctl.ts`（`USAGE` に足し、`main` でデーモンを呼ぶ前に `workflow-check` を処理する）
- Test: `core/test/daemon/cli.test.ts`
- Modify: `docs/developer-guide/03-workflow-engine.md`（検証の手段として 1 段落）

**Interfaces:**
- Consumes: 既存の `parseWorkflow(yamlText: string): { workflow: Workflow; warnings: string[] }`（`core/src/workflow/schema.ts:280`）。不正なら投げる
- Produces:
  ```ts
  // core/src/cli/dctl.ts
  /** デーモンを介さずにファイルを parseWorkflow に通す。戻り値は終了コード。 */
  export async function workflowCheck(
    file: string,
    out: { error: (s: string) => void },
  ): Promise<number>;
  ```

振る舞い（spec 5.3）:

- `dctl workflow-check <file>`。ソケットに繋がない（デーモンが止まっていても動く）。
- 通れば 0。警告は 1 行ずつ stderr に出す。
- 落ちれば 1 で、エラーの文言を stderr に出す。ファイルが無ければ 1 で `ファイルがありません: <file>`。
- 引数が無ければ 1 で使い方を出す。

- [ ] **Step 1: 失敗するテストを書く**

`core/test/daemon/cli.test.ts`:

```ts
test("workflow-check は正しい定義で 0 を返す", async () => { /* 一時ファイルに最小の定義（agent 1 つ）を書き、workflowCheck が 0、error は呼ばれない */ });
test("workflow-check は不正な定義で 1 を返し、理由を出す", async () => { /* goto が存在しない step を指す定義。error に step id が含まれる */ });
test("workflow-check はファイルが無ければ 1 を返す", async () => {});
test("workflow-check は警告を出しても 0 を返す", async () => { /* command に git push を含む定義 */ });
```

- [ ] **Step 2: 落ちることを確かめる**

Run: `cd core && deno test --allow-all test/daemon/cli.test.ts`
Expected: FAIL（`workflowCheck` が無い）

- [ ] **Step 3: 実装する**

`main` の先頭で `argv[0] === "workflow-check"` を見て `workflowCheck(argv[1], { error: console.error })` を返す。`parseArgv` には入れない（RPC ではないため）。
`USAGE` の「その他」に `workflow-check <file>          ワークフローの定義を検証する（デーモン不要）` を足す。

- [ ] **Step 4: verify を通す**

Run: `mise run core:check && mise run core:test`
Expected: PASS

- [ ] **Step 5: コミットする**

```bash
git add core/src/cli/dctl.ts core/test/daemon/cli.test.ts docs/developer-guide/03-workflow-engine.md
git commit -m "ワークフローの定義を検証する dctl workflow-check を足す"
```

---

### Task 2: setup のタスクを作る（同梱ワークフローと `workspace.setup`）

**Files:**
- Create: `core/src/workflow/setupWorkflow.ts`（同梱ワークフローの本文と、方針から prompt を作る関数）
- Modify: `core/src/daemon/handlers.ts`（`workspace.setup` を足す。タスクを作る処理は `task.create` と共通の関数に切り出す）
- Modify: `shared/protocol.ts`（`SetupPolicy`・`workspace.setup` を `Methods` に）
- Test: `core/test/workflow/setupWorkflow.test.ts`、`core/test/daemon/workspaceSetup.test.ts`、`core/test/integration/setupTask.test.ts`

**Interfaces:**
- Consumes: Task 1 の `dctl workflow-check`（validate の run が呼ぶ）、既存の `defaultWorkflowYamlFor`・`READ_ONLY_TOOLS`（`core/src/workflow/scaffold.ts`）、`parseWorkflow`、`insertTask`・`branchNameFor`、`listProjectsOf`
- Produces:
  ```ts
  // shared/protocol.ts
  export type SetupPolicy = {
    plan: boolean;
    agentReview: boolean;
    guide: boolean;
    approval: "after_implement" | "after_plan_and_implement";
    pr: "open_and_wait" | "branch_only";
    sync: boolean; // pr が branch_only なら false
    models: { plan: string; implement: string; review: string; guide: string };
  };
  "workspace.setup": {
    params: { workspace: number; projects: string[]; policy: SetupPolicy };
    result: TaskSummary[];
  };

  // core/src/workflow/setupWorkflow.ts
  export const SETUP_WORKFLOW_NAME = "setup";
  /** 同梱ワークフローの本文。baseBranch は雛形を埋め込むために使う。 */
  export function setupWorkflowYaml(baseBranch: string): string;
  /** 方針を draft のエージェントが読む文章にする。タスクの prompt になる。 */
  export function setupPrompt(policy: SetupPolicy): string;
  ```

同梱ワークフローの形（spec 5.2）:

```yaml
name: setup
steps:
  - id: draft
    type: agent
    session: drafter
    permissionMode: acceptEdits
    allowedTools: [READ_ONLY_TOOLS の各要素]
    prompt: |
      # 役目・出発点の雛形（defaultWorkflowYamlFor(baseBranch) の出力をそのまま埋め込む）・
      # 方針（{{ task.prompt }}）・リポジトリから決めること（verify の run、implement の allowedTools、baseBranch）・
      # 食い違いと決めたことを .doctrine-out/setup-notes.md に書くこと・.doctrine-out/ の外を書き換えないこと・
      # PR を開く方針なら足すステップの例（open-pr / wait-merge / sync。doctrine 自身の .doctrine/workflows/default.yaml から要点を写す）
  - id: validate
    type: command
    run: >-
      command -v dctl >/dev/null || { echo "dctl が PATH にありません（doctrine の core で deno task install を実行してください）" >&2; exit 1; };
      dctl workflow-check .doctrine-out/default.yaml &&
      { test -z "$(git status --porcelain)" || { echo "worktree の .doctrine-out/ の外が書き換えられています:" >&2; git status --porcelain >&2; exit 1; }; }
    onFailure:
      goto: draft
      maxAttempts: 3
      feed: "{{ steps.validate.last_stderr }}"
  - id: review
    type: approval
    review:
      files: [.doctrine-out/default.yaml, .doctrine-out/setup-notes.md]
    onReject:
      goto: draft
      maxAttempts: 5
  - id: apply
    type: command
    run: "mkdir -p '{{ project.path }}/.doctrine/workflows' && cp .doctrine-out/default.yaml '{{ project.path }}/.doctrine/workflows/default.yaml'"
```

`workspace.setup` の振る舞い（spec 5.1）:

- `projects` の各名前を `listProjectsOf(workspace)` から引く。1 つでも無ければ、何も作らずに `workspace <id> にプロジェクト <name> はありません` で投げる。
- 各プロジェクトに、タイトル `<name> のワークフローを作る`、`prompt: setupPrompt(policy)`、`workflow_name: "setup"`、
  `workflow_yaml: setupWorkflowYaml(project.base_branch)`、`workflow_setup: null` でタスクを作る。1 つのトランザクションで入れる。
- `pr === "branch_only"` で `sync === true` なら投げる（方針の組み合わせとして成り立たない）。

- [ ] **Step 1: 失敗するテストを書く**

`core/test/workflow/setupWorkflow.test.ts`:

```ts
test("同梱ワークフローは parseWorkflow を通り、draft → validate → review → apply の順", () => {});
test("draft の allowedTools は読み取り系だけ", () => { /* READ_ONLY_TOOLS と一致。git add / git commit を含まない */ });
test("draft のプロンプトに雛形の default.yaml が入る", () => { /* setupWorkflowYaml("main") に defaultWorkflowYamlFor("main") の name 行と steps が含まれる */ });
test("setupPrompt は方針を文章にする", () => { /* plan: false なら「計画を入れない」旨、pr: branch_only なら「PR を開かない」旨、models の各値が入る */ });
```

`core/test/daemon/workspaceSetup.test.ts`（`makeRepo` と `workspace.add` で workspace を作ってから）:

```ts
test("対象プロジェクトごとにタスクを 1 つ作る", async () => { /* 2 つのプロジェクト → 2 タスク。タイトル・workflow_name が setup */ });
test("タスクは同梱ワークフローを pin し、setup を差し込まない", async () => { /* project.yaml に setup: を書いておいても workflow_setup が null */ });
test("workspace に無いプロジェクト名なら何も作らずに投げる", async () => {});
test("branch_only で sync: true なら投げる", async () => {});
```

`core/test/integration/setupTask.test.ts`（`fullCycle.test.ts` と同じく `createMockAdapter` でエージェントを差し替える。PATH の先頭に一時ディレクトリを置き、そこに `exec deno run -A <repo>/core/src/cli/dctl.ts "$@"` を書いた `dctl` を置く）:

```ts
test("draft → validate → review（承認）→ apply で元リポジトリの default.yaml が置き換わり、worktree が消える", async () => {});
test("draft が不正な YAML を書くと validate が落ちて draft に戻り、feed にエラーが入る", async () => {});
test("draft が .doctrine-out/ の外を書き換えると validate が落ち、feed に書き換えたパスが入る", async () => {});
test("プロジェクトのパスに空白があっても apply が正しい場所に書く", async () => { /* makeRepo のディレクトリ名に空白を入れる */ });
test("dctl が PATH に無ければ、validate の feed に deno task install の案内が入る", async () => {});
```

- [ ] **Step 2: 落ちることを確かめる**

Run: `cd core && deno test --allow-all test/workflow/setupWorkflow.test.ts test/daemon/workspaceSetup.test.ts test/integration/setupTask.test.ts`
Expected: FAIL（`setupWorkflow.ts` が無い）

- [ ] **Step 3: `setupWorkflow.ts` を実装する**（上の形のとおり。YAML は文字列の組み立てで作り、`parseWorkflow` を通ることをテストで守る）

- [ ] **Step 4: `workspace.setup` を実装する**

`task.create` のうち「プロジェクト・タイトル・prompt・ワークフローの本文から行を入れる」部分を `createTaskRow(ctx, project, { title, prompt, workflowName, pin })` に切り出し、`task.create` と `workspace.setup` の両方から使う。

- [ ] **Step 5: verify を通す**

Run: `mise run core:check && mise run core:test && mise run app:test && mise run app:build`
Expected: PASS

- [ ] **Step 6: コミットする**

```bash
git add core shared
git commit -m "同梱ワークフローで default.yaml を作る setup のタスクを足す"
```

---

### Task 3: ウィザード用に workspace を調べる・書く（`workspace.detect` と `workspace.add` の拡張）

**Files:**
- Create: `core/src/daemon/workspaceDetect.ts`
- Modify: `core/src/daemon/workspaceRegistry.ts`（`addWorkspace` に `projects` / `tracker` を足す）
- Modify: `core/src/workflow/scaffold.ts`（`ensureWorkspaceScaffold` が渡された projects / tracker で書けるように）
- Modify: `core/src/workflow/workspace.ts`（`workspaceYamlFor` に任意の `tracker`）
- Modify: `core/src/daemon/handlers.ts`、`shared/protocol.ts`
- Test: `core/test/daemon/workspaceDetect.test.ts`、`core/test/daemon/workspaceRegistry.test.ts`、`core/test/workflow/workspace.test.ts`

**Interfaces:**
- Consumes: 既存の `parseWorkspaceConfig`・`WORKSPACE_YAML`・`projectNameFrom`・`getWorkspaceByPath`・`TrackerConfig`（`core/src/workflow/project.ts:17`）
- Produces:
  ```ts
  // shared/protocol.ts
  export type WorkspaceDetection = {
    isRepoRoot: boolean;
    repositories: { dir: string; suggestedName: string }[];
    existing: { name?: string; projects: Record<string, string>; tracker: TrackerConfig } | null;
    alreadyRegistered: boolean;
  };
  "workspace.detect": { params: { path: string }; result: WorkspaceDetection };
  "workspace.add": {
    params: { path: string; projects?: Record<string, string>; tracker?: TrackerConfig };
    result: WorkspaceSummary & { created: string[]; alreadyRegistered: boolean };
  };

  // core/src/daemon/workspaceDetect.ts
  export function detectWorkspace(db: Db, path: string): Promise<WorkspaceDetection>;

  // core/src/daemon/workspaceRegistry.ts
  export function addWorkspace(
    db: Db,
    rootPath: string,
    init?: { projects: Record<string, string>; tracker?: TrackerConfig },
  ): Promise<{ workspaceId: number; created: string[]; alreadyRegistered: boolean }>;

  // core/src/workflow/workspace.ts
  export function workspaceYamlFor(projects: WorkspaceProjectEntry[], tracker?: TrackerConfig): string;
  ```

振る舞い（spec 4.2・4.7）:

- `detectWorkspace`: path を実パスに直す。git リポジトリのサブディレクトリなら `ensureWorkspaceScaffold` と同じ文言で投げる。
  `isRepoRoot` なら `repositories` は空。そうでなければ直下のディレクトリのうち git リポジトリのルートを名前順に返す（`.` で始まるディレクトリは見ない）。
  workspace.yaml があれば `parseWorkspaceConfig` で読み、読めなければそのエラーを投げる。
- `addWorkspace(db, root, init)`: workspace.yaml が無く `init` があれば、`init.projects` と `init.tracker` で書く（root が git リポジトリでなくても書く）。
  workspace.yaml があれば `init` は使わない。`init` の projects の名前とパスの検証は、書いた後に読む `parseWorkspaceConfig` に任せ、落ちたら書いたファイルを消して投げる。
- `created` には、workspace.yaml と、各プロジェクトで新しく作った project.yaml / workflows/default.yaml の絶対パスが入る（いまのとおり）。ウィザードはこれで setup の対象を決める。

- [ ] **Step 1: 失敗するテストを書く**

`core/test/daemon/workspaceDetect.test.ts`:

```ts
test("リポジトリのルートを選ぶと isRepoRoot で repositories は空", async () => {});
test("git 管理外のディレクトリなら直下のリポジトリを名前順に返し、suggestedName を丸める", async () => { /* My_Repo → my-repo */ });
test("直下にリポジトリが無ければ repositories は空", async () => {});
test("リポジトリのサブディレクトリなら投げる", async () => {});
test("workspace.yaml があれば existing に中身が入る", async () => {});
test("workspace.yaml が読めなければ投げる", async () => {});
test("登録済みなら alreadyRegistered", async () => {});
```

`core/test/daemon/workspaceRegistry.test.ts` に:

```ts
test("git 管理外の root に workspace.yaml が無くても、projects を渡せば書いて登録する", async () => {});
test("tracker を渡すと workspace.yaml に書く", async () => {});
test("workspace.yaml があれば projects と tracker を使わない", async () => {});
test("既に .doctrine/ があるプロジェクトの default.yaml は created に入らない", async () => {});
test("不正な projects（名前の形が違う）なら workspace.yaml を残さずに投げる", async () => {});
```

`core/test/workflow/workspace.test.ts` に `workspaceYamlFor` が tracker を書き、`parseWorkspaceConfig` で読み戻せること。

- [ ] **Step 2: 落ちることを確かめる**

Run: `cd core && deno test --allow-all test/daemon/workspaceDetect.test.ts test/daemon/workspaceRegistry.test.ts test/workflow/workspace.test.ts`
Expected: FAIL

- [ ] **Step 3: 実装する**（上の振る舞いのとおり。`dctl workspace-add` は `init` を渡さない）

- [ ] **Step 4: verify を通す**

Run: `mise run core:check && mise run core:test && mise run app:test && mise run app:build`
Expected: PASS

- [ ] **Step 5: コミットする**

```bash
git add core shared
git commit -m "ウィザードのために workspace を調べる workspace.detect と、構成を渡せる workspace.add を足す"
```

---

### Task 4: 初回ウィザード

**Files:**
- Modify: `app/src-tauri/Cargo.toml`、`app/src-tauri/src/lib.rs:108`（`tauri::Builder`）、`app/src-tauri/capabilities/default.json`、`app/package.json`（`tauri-plugin-dialog` / `@tauri-apps/plugin-dialog`）
- Create: `app/src/wizard.ts`（ウィザードの状態と遷移。画面に依存しない）
- Create: `app/src/components/SetupWizard.tsx`
- Modify: `app/src/model.ts`、`app/src/store.tsx`（`workspace.list` を読み、0 件ならウィザードを出す。サイドバーから開く action）
- Modify: `app/src/App.tsx`、`app/src/components/Sidebar.tsx`（「workspace を追加」）
- Modify: `app/src/components/TaskView.tsx`（setup のタスクが completed のときの案内）
- Modify: `app/src/fixtures.ts`
- Modify: `site/src/content/docs/ja/quick-start/index.md`、`site/src/content/docs/ja/guide/writing-workflows.mdx`、`docs/overview.md`
- Test: `app/src/wizard.test.ts`、`app/src/SetupWizard.test.tsx`、`app/src/TaskView.test.tsx`

**Interfaces:**
- Consumes: Task 2 の `SetupPolicy`・`workspace.setup`、Task 3 の `WorkspaceDetection`・`workspace.detect`・`workspace.add` の `projects` / `tracker`、既存の `workspace.list`、`trackerGuidance`（`app/src/intake.ts:375`）の Linear の文言
- Produces:
  ```ts
  // app/src/wizard.ts
  export type WizardStep = "welcome" | "directory" | "projects" | "tracker" | "policy" | "confirm";
  export type WizardState = {
    step: WizardStep;
    path: string | null;
    detection: WorkspaceDetection | null;
    projects: { dir: string; name: string; selected: boolean }[];
    tracker: TrackerConfig;
    policy: SetupPolicy;
    error: string | null;
  };
  export const DEFAULT_POLICY: SetupPolicy; // spec 4.5 の既定
  export function initialWizard(): WizardState;
  /** 次へ進めるか。進めないときは理由の文言 */
  export function blocker(s: WizardState): string | null;
  export function next(s: WizardState): WizardStep;
  /** setup の対象: created に <project>/.doctrine/workflows/default.yaml が入っているプロジェクトの名前 */
  export function setupTargets(summary: WorkspaceSummary, created: string[]): string[];
  /** 確認画面の確定。workspace.add → （対象があれば）workspace.setup */
  export function submitWizard(s: WizardState): Promise<{ tasks: TaskSummary[] }>;
  ```

振る舞い（spec 4 章・5.4）:

- 起動時の読み込みで `workspace.list` が空ならウィザードを全画面で出す。サイドバーの「workspace を追加」で同じウィザードを開く（閉じられる）。
- `next` の分岐:
  - `existing` があれば projects は表示だけ、tracker は飛ばす。
  - `isRepoRoot` なら projects はそのリポジトリ 1 つで確認だけ。
  - policy で `pr === "branch_only"` なら追従の問を出さず、`sync` を false にする。
- `blocker`: ディレクトリ未選択、`alreadyRegistered`、git 管理外で直下にリポジトリが無い、選んだプロジェクトが 0 件、名前が `[a-z0-9-]+` でない・重なる、linear で team が空。
- `submitWizard`: `workspace.add` が失敗したら投げる（画面は確認に留まり `error` を出す）。`setupTargets` が空なら `workspace.setup` を呼ばず `tasks: []`。
  `workspace.setup` が失敗したら、workspace は登録済みである旨とエラーを出してウィザードを閉じる。
- 終わったらタスク一覧に移り、最初の setup のタスクを選ぶ。対象が無ければ「ワークフローは既存のものを使う」を toast で出す。
- linear を選んだら、API キーを config.json に書いて dctld を起動し直す手順を画面に出す（`trackerGuidance` の文言を使う。ウィザードはキーを扱わない）。
- TaskView: `workflow_name === "setup"` で `state === "completed"` のタスクに
  「`.doctrine/workflows/default.yaml` を書き換えました（未コミット）。コミットしてから、Issue を取り込むかタスクを作ってください。」を出す。

- [ ] **Step 1: 失敗するテストを書く**

`app/src/wizard.test.ts`:

```ts
test("リポジトリのルートなら projects を確認だけにして tracker へ進む", () => {});
test("workspace.yaml があれば tracker を飛ばして policy へ進む", () => {});
test("git 管理外で直下にリポジトリが無ければ先へ進めない", () => { /* blocker が文言を返す */ });
test("登録済みのディレクトリなら先へ進めない", () => {});
test("名前が重なる・形が違うなら先へ進めない", () => {});
test("PR を開かない方針なら sync は false になり、追従の問を出さない", () => {});
test("setupTargets は created に default.yaml が入っているプロジェクトだけを返す", () => {});
test("submitWizard は workspace.add → workspace.setup の順に呼ぶ", async () => { /* invoke をモックし、呼び出しの順と params を確かめる */ });
test("setup の対象が無ければ workspace.setup を呼ばない", async () => {});
test("workspace.add が失敗したら投げ、workspace.setup を呼ばない", async () => {});
```

`app/src/SetupWizard.test.tsx`（`renderToStaticMarkup` で各画面）:

```ts
test("policy の画面に 7 問が既定値つきで出る", () => {});
test("linear を選ぶと config.json の手順が出る", () => {});
test("blocker があると次へのボタンが無効で理由が出る", () => {});
```

`app/src/TaskView.test.tsx` に「setup のタスクが completed ならコミットの案内を出す」「ほかのワークフローのタスクには出さない」。

- [ ] **Step 2: 落ちることを確かめる**

Run: `cd app && npx vitest run src/wizard.test.ts src/SetupWizard.test.tsx src/TaskView.test.tsx`
Expected: FAIL

- [ ] **Step 3: ディレクトリ選択のプラグインを入れる**

`tauri-plugin-dialog`（Cargo）と `@tauri-apps/plugin-dialog`（npm）を足し、ビルダーに `.plugin(tauri_plugin_dialog::init())`、capabilities に `dialog:allow-open` を足す。画面からは `open({ directory: true })` で選ばせる。

- [ ] **Step 4: `wizard.ts` と `SetupWizard.tsx` を実装し、store・App・Sidebar・TaskView に繋ぐ**

- [ ] **Step 5: ドキュメントを書く**

- `site/src/content/docs/ja/quick-start/index.md`: 準備中の 1 行を、ウィザードの各画面 → setup のタスクの承認画面で読むもの（default.yaml と setup-notes.md）→ 承認 → コミット、の手順に書き換える。
- `site/src/content/docs/ja/guide/writing-workflows.mdx`: 冒頭の前提を「Quick Start で作った default.yaml を直す」に変える。
- `docs/overview.md` 4.1: 利用の流れの最初に初回ウィザードを足す。

- [ ] **Step 6: verify を通す**

Run: `mise run core:check && mise run core:test && mise run app:deps && mise run app:test && mise run app:build`
Expected: PASS

- [ ] **Step 7: コミットする**

```bash
git add app site/src/content/docs/ja/quick-start/index.md site/src/content/docs/ja/guide/writing-workflows.mdx docs/overview.md
git commit -m "初回起動のウィザードで workspace を登録し、setup のタスクを作る"
```

## マージ後に人が行うこと

- `deno task install` をやり直す（Task 1 の `dctl workflow-check` を PATH に入れる）。
- アプリを作り直す（Task 4 で Tauri のプラグインが増える）。
- 空の状態ディレクトリ（`DOCTRINE_STATE_DIR` を一時ディレクトリに向ける）でアプリを起動し、ウィザードから setup のタスクの承認・コミットまでを一度通す。
