# workspace 第 1 段（設定・登録・マイグレーション・トラッカーの引き直し）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** workspace（1〜N 個のプロジェクトの束）を設定・DB・登録・トラッカーに入れ、プロジェクト 1 つの workspace ではいまと同じに動かす。

**Architecture:** `<root>/.doctrine/workspace.yaml` を新しい設定の正本にし、DB に `workspaces` を足してプロジェクトと Intake をそこに属させる。
トラッカーは `project.yaml` から `workspace.yaml` へ移し、workspace を単位に引く。Intake の調査・投入は第 2 段まで
「workspace のただ 1 つのプロジェクト」で動かし、プロジェクトが 2 つ以上の workspace では Intake を始めさせない。

**Tech Stack:** Deno（core）、Kysely + SQLite、zod、yaml、React + Vite（app）、`@std/testing/bdd` と `node:assert/strict`

**Spec:** `docs/superpowers/specs/2026-09-26-workspace-design.md`（この計画は 3・4・8・9 章のうち第 1 段の分を実装する）

## doctrine で流すときの前提

- 各 Task は doctrine のタスク 1 つ（PR 1 本）として流す。上から順に、前の PR がマージされてから次を投入する。
- 各 Task の終わりで既定ワークフローの verify
  （`mise run core:check && mise run core:test && mise run app:deps && mise run app:test && mise run app:build && mise run pfd:check && mise run pfd:test`）
  が通ること。途中の Task でも app の型検査が通るよう、RPC の形を変えた Task は app 側の最小の追従まで含める（画面の作り直しは第 3 段）。
- planner はこの計画の該当 Task と spec を読んで細部を詰める。ここに書いたコードは形と名前の約束で、周りのコードに合わせて直してよい。名前と型は変えないこと（後の Task が使う）。
- デーモンは doctrine 自身を動かしている。Task 2 と Task 4 はマイグレーションを足すので、マージ後にデーモンを再起動すると手元の DB に流れる。

## Global Constraints

- 後方互換の仕掛けを作らない。`project-add` / `project-update`、`project.yaml` の `tracker` は消して、参照をすべて書き換える。
- 一度コミットしたマイグレーションは書き換えない。新しい番号（`0015_…`, `0016_…`）で足す。マイグレーションから `src/db/schema.ts` の型を参照しない。
- プロジェクトの名前は `[a-z0-9-]+`。workspace の中で重ならない。
- `workspace.yaml` の `projects` の値は root からの相対パスで、git リポジトリのルートを指す。`../` を許す。
- `tracker` を省略したら `{ kind: github }`。`name` を省略したら root のディレクトリ名。
- プロジェクトはちょうど 1 つの workspace に属する（`projects.path` は UNIQUE のまま）。
- コードのコメントにはそのコード固有の事実だけを書き、一般論は spec に書く。

## Review Focus

1. **既存の DB のマイグレーション。** プロジェクトと Intake（終わったものも含む）が入った DB に 0015・0016 を流すと、各プロジェクトが 1 つずつの workspace になり、Intake はその workspace に付き、`PRAGMA foreign_key_check` が空であること。→ Task 2・Task 4 のテスト。
2. **マイグレーションの後に `~/work/tp` を束ね直す。** 1 つずつの workspace になった assured-terraform / assured-tp / assured-kubernetes を `workspace-add ~/work/tp` で吸収できること。終わっていない Intake を持つ workspace は吸収せず断ること。→ Task 3 のテスト。
3. **`tracker` が残った `project.yaml`。** Linear を使っていたリポジトリの `project.yaml` に `tracker:` が残っていると、読むところで「`tracker` は `.doctrine/workspace.yaml` に移りました」と分かる言葉で落ちること（zod の「未知のキー」のままにしない）。→ Task 5 のテスト。
4. **GitHub のリポジトリの一部だけが失敗する。** 3 つのうち 1 つで `gh` が落ちても、Issue の一覧は残り 2 つの分を返し、`tracker.status` にその 1 つの失敗が出ること。→ Task 5 のテスト。
5. **パスの表記ゆれ。** `workspace-add` に末尾の `/` 付き・シンボリックリンク経由・macOS の `/var` と `/private/var` のパスを渡しても、同じ workspace・同じプロジェクトとして扱うこと（実パスに直して比べる）。→ Task 3 のテスト。

---

### Task 1: `workspace.yaml` を読む

**Files:**
- Create: `core/src/workflow/workspace.ts`
- Test: `core/test/workflow/workspace.test.ts`

**Interfaces:**
- Consumes: `TrackerConfig`・`trackerSchema` の形（いまは `core/src/workflow/project.ts:14-47`）。この Task では `project.ts` から **写さず import して使う**。移すのは Task 5。
- Produces:
  ```ts
  export type WorkspaceProjectEntry = { name: string; path: string }; // path は root からの相対パス（書かれたまま）
  export type WorkspaceConfig = { name: string; projects: WorkspaceProjectEntry[]; tracker: TrackerConfig };
  export const WORKSPACE_YAML = join(".doctrine", "workspace.yaml");
  /** rootDirName は name を省略したときの既定値。projects は書かれた順を保つ。形が違えば WorkflowValidationError。 */
  export function parseWorkspaceConfig(yamlText: string, rootDirName: string): WorkspaceConfig;
  /** 雛形。projects の順に書き、tracker は書かない（既定の github）。 */
  export function workspaceYamlFor(projects: WorkspaceProjectEntry[]): string;
  ```

- [ ] **Step 1: 失敗するテストを書く**

```ts
import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { parseWorkspaceConfig, workspaceYamlFor } from "../../src/workflow/workspace.ts";
import { WorkflowValidationError } from "../../src/workflow/schema.ts";

test("workspace.yaml を書かれた順で読む", () => {
  const cfg = parseWorkspaceConfig(
    `
name: tp
projects:
  terraform: assured-terraform
  tp: assured-tp
  kubernetes: ../elsewhere/assured-kubernetes
tracker:
  kind: linear
  team: ENG
`,
    "tp-root",
  );
  assert.deepEqual(cfg, {
    name: "tp",
    projects: [
      { name: "terraform", path: "assured-terraform" },
      { name: "tp", path: "assured-tp" },
      { name: "kubernetes", path: "../elsewhere/assured-kubernetes" },
    ],
    tracker: { kind: "linear", team: "ENG" },
  });
});

test("name と tracker を省略すると root のディレクトリ名と github になる", () => {
  const cfg = parseWorkspaceConfig("projects:\n  doctrine: .\n", "doctrine");
  assert.equal(cfg.name, "doctrine");
  assert.deepEqual(cfg.tracker, { kind: "github" });
});

test("プロジェクトの名前は [a-z0-9-]+ でなければ落ちる", () => {
  assert.throws(
    () => parseWorkspaceConfig("projects:\n  Assured_TP: assured-tp\n", "tp"),
    WorkflowValidationError,
  );
});

test("projects が空なら落ちる", () => {
  assert.throws(() => parseWorkspaceConfig("projects: {}\n", "tp"), WorkflowValidationError);
});

test("同じパスを 2 つの名前で指すと落ちる", () => {
  assert.throws(
    () => parseWorkspaceConfig("projects:\n  a: repo\n  b: ./repo\n", "tp"),
    WorkflowValidationError,
  );
});

test("雛形は読み直すと同じ projects になる", () => {
  const projects = [{ name: "doctrine", path: "." }];
  assert.deepEqual(parseWorkspaceConfig(workspaceYamlFor(projects), "doctrine").projects, projects);
});
```

- [ ] **Step 2: 落ちることを確かめる**

Run: `cd core && deno test --allow-all test/workflow/workspace.test.ts`
Expected: FAIL（モジュールが無い）

- [ ] **Step 3: 実装する**

```ts
import { normalize, join } from "@std/path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { formatZodIssues, WorkflowValidationError } from "./schema.ts";
import { type TrackerConfig, trackerSchema } from "./project.ts";

export const WORKSPACE_YAML = join(".doctrine", "workspace.yaml");
const PROJECT_NAME = /^[a-z0-9-]+$/;

const schema = z.object({
  name: z.string().min(1).optional(),
  projects: z.record(
    z.string().regex(PROJECT_NAME, "プロジェクトの名前は [a-z0-9-]+ で書いてください"),
    z.string().min(1),
  ).refine((p) => Object.keys(p).length > 0, "projects に 1 つ以上書いてください"),
  tracker: trackerSchema.default({ kind: "github" }),
}).strict();
```

`parseWorkspaceConfig` は `parseProjectConfig` と同じ手順（YAML として読めなければ `WorkflowValidationError`、
zod の失敗は `formatZodIssues`）で読み、`Object.entries` の順で `projects` を配列にする。`normalize` したパスが重なれば
`WorkflowValidationError([\`projects の ${a} と ${b} が同じパス ${path} を指しています\`])` を投げる。
`trackerSchema` が `project.ts` で export されていなければ export を足す。

`workspaceYamlFor` は先頭に `# doctrine の workspace 設定（dctl workspace-add が雛形として作成）` の 1 行を置き、
`projects:` の下に `  <name>: <path>` を並べる。

- [ ] **Step 4: 通ることを確かめる**

Run: `cd core && deno test --allow-all test/workflow/workspace.test.ts && deno task check`
Expected: PASS

- [ ] **Step 5: コミットする**

```bash
git add core/src/workflow/workspace.ts core/src/workflow/project.ts core/test/workflow/workspace.test.ts
git commit -m "workspace.yaml を読む"
```

---

### Task 2: DB に workspaces を足し、プロジェクトを属させる

**Files:**
- Modify: `core/src/db/migrations.ts`（`0015_workspace` を足す）
- Modify: `core/src/db/schema.ts`（`WorkspacesTable`、`ProjectsTable.workspace_id`・`name`）
- Create: `core/src/db/workspaces.ts`
- Modify: `core/src/db/tasks.ts`（`insertProject` の引数）
- Modify: `core/src/daemon/handlers.ts:319-337`（`project.add` がプロジェクト 1 つの workspace を作る。Task 3 で `workspace.add` に置き換えるまでのつなぎ）
- Modify: `shared/protocol.ts:293`（`ProjectSummary` に `workspace_id`・`name`）
- Create: `core/test/helpers/project.ts`（`seedProject`）
- Modify: `insertProject(` を直接呼ぶテスト（`grep -rln "insertProject(" core/test` で 20 前後）を `seedProject` に置き換える
- Test: `core/test/db/migrate.test.ts`、`core/test/db/workspaces.test.ts`

**Interfaces:**
- Consumes: Task 1 の `parseWorkspaceConfig`（この Task では使わない。名前の丸めだけ同じ規則にする）
- Produces:
  ```ts
  // schema.ts
  export interface WorkspacesTable { id: Generated<number>; path: string; name: string }
  export type WorkspaceRow = Selectable<WorkspacesTable>;
  // ProjectsTable に足す列
  workspace_id: number; name: string;

  // core/src/db/workspaces.ts
  export function insertWorkspace(db: Db, w: { path: string; name: string }): Promise<number>;
  export function getWorkspace(db: Db, id: number): Promise<WorkspaceRow | undefined>;
  export function getWorkspaceByPath(db: Db, path: string): Promise<WorkspaceRow | undefined>;
  export function listWorkspaces(db: Db): Promise<WorkspaceRow[]>;        // id 順
  export function listProjectsOf(db: Db, workspaceId: number): Promise<ProjectRow[]>; // id 順
  /** 名前を [a-z0-9-]+ に丸める。空になれば "project"。 */
  export function projectNameFrom(dirName: string): string;

  // core/test/helpers/project.ts
  /** workspace（root = path）とプロジェクト 1 つを入れ、プロジェクトの行を返す。 */
  export function seedProject(db: Db, p: { path: string; name?: string; default_workflow?: string;
    max_concurrent?: number; base_branch?: string; setup?: string | null }): Promise<ProjectRow>;
  ```

- [ ] **Step 1: マイグレーションのテストを書く**

`core/test/db/migrate.test.ts` の既存の「古い形の DB に流す」テストの流儀（`0014` まで流した DB に行を入れてから最新まで流す）で足す:

```ts
test("0015 は既存のプロジェクトを 1 つずつの workspace に移す", async () => {
  // 0014 まで流した DB に projects を 2 行（path: /w/assured-tp, /w/My_Repo）入れる
  // 最新まで流す
  // workspaces が 2 行で、path はプロジェクトの path、name は basename
  // projects.workspace_id がそれぞれを指し、projects.name は "assured-tp" と "my-repo"
  // PRAGMA foreign_key_check が空
});
```

`core/test/db/workspaces.test.ts` に `projectNameFrom("My_Repo") === "my-repo"`、`projectNameFrom("___") === "project"`、
`listProjectsOf` が他の workspace のプロジェクトを返さないこと、を書く。

- [ ] **Step 2: 落ちることを確かめる**

Run: `cd core && deno test --allow-all test/db/`
Expected: FAIL

- [ ] **Step 3: マイグレーションを書く**

```ts
"0015_workspace": {
  // deno-lint-ignore no-explicit-any
  async up(db: Kysely<any>) {
    await db.schema.createTable("workspaces")
      .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
      .addColumn("path", "text", (c) => c.notNull().unique())
      .addColumn("name", "text", (c) => c.notNull())
      .execute();
    // SQLite の ALTER TABLE ADD COLUMN は NOT NULL に既定値が要るので、NULL 可で足して埋めてから表を作り直す
    await db.schema.alterTable("projects").addColumn("workspace_id", "integer").execute();
    await db.schema.alterTable("projects").addColumn("name", "text").execute();
    const projects = await db.selectFrom("projects").select(["id", "path"]).execute();
    for (const p of projects) {
      const dir = p.path.replace(/\/+$/, "").split("/").at(-1) ?? "project";
      const r = await db.insertInto("workspaces").values({ path: p.path, name: dir }).executeTakeFirstOrThrow();
      await db.updateTable("projects")
        .set({ workspace_id: Number(r.insertId), name: nameFrom(dir) })
        .where("id", "=", p.id).execute();
    }
    // ここで projects を作り直し、workspace_id を NOT NULL REFERENCES workspaces(id)、name を NOT NULL にし、
    // UNIQUE(workspace_id, name) を足す。手順は 0005 の再構築（外部キーの検査を止める → 新表 → コピー →
    // DROP → RENAME → PRAGMA foreign_key_check）に合わせる
  },
},
```

`nameFrom` はマイグレーションの中に書く（`db/workspaces.ts` の `projectNameFrom` を import しない。マイグレーションは
その時点の規則で固定する）。中身は `projectNameFrom` と同じ規則: 小文字にし、`[^a-z0-9-]+` を `-` にし、両端の `-` を落とし、空なら `"project"`。

- [ ] **Step 4: 型・行の関数・つなぎの `project.add` を書く**

`project.add` は `insertWorkspace({ path, name: basename(path) })` のあと `insertProject({ ..., workspace_id, name: projectNameFrom(basename(path)) })` を
1 トランザクションで行う。`ProjectSummary` に `workspace_id: number; name: string` を足す（app は読むだけなので型だけ追従する）。

- [ ] **Step 5: テストの `insertProject` を `seedProject` に置き換える**

Run: `grep -rln "insertProject(" core/test` の各ファイルで置き換える。`project_id` を渡している箇所は `seedProject` の戻り値の `id` を使う。

- [ ] **Step 6: verify を通す**

Run: `mise run core:check && mise run core:test && mise run app:test && mise run app:build`
Expected: PASS

- [ ] **Step 7: コミットする**

```bash
git add core shared app
git commit -m "DB に workspaces を足し、プロジェクトを属させる"
```

---

### Task 3: workspace を登録する（`workspace-add` / `workspace-update` / `workspace.list`）

**Files:**
- Modify: `core/src/workflow/scaffold.ts`（`ensureWorkspaceScaffold` を足す）
- Create: `core/src/daemon/workspaceRegistry.ts`（登録と更新の本体）
- Modify: `core/src/daemon/handlers.ts:319-349`（`project.add` / `project.update` を消し、`workspace.add` / `workspace.update` / `workspace.list` を足す）
- Modify: `core/src/cli/dctl.ts:64-66,112-115`（`project-add` / `project-update` を消し、`workspace-add --path` / `workspace-update --path` / `workspaces` を足す）
- Modify: `shared/protocol.ts`（`WorkspaceSummary`・`workspace.*` を `Methods` に足す）
- Create: `.doctrine/workspace.yaml`（doctrine 自身: `projects: { doctrine: . }`）
- Modify: `site/src/content/docs/ja/guide/writing-workflows.mdx`、`site/src/content/docs/ja/guide/intake.mdx`、`docs/overview.md`（`project-add` の説明を `workspace-add` に）
- Test: `core/test/daemon/workspaceRegistry.test.ts`、`core/test/daemon/cli.test.ts`、`core/test/workflow/scaffold.test.ts`

**Interfaces:**
- Consumes: Task 1 の `parseWorkspaceConfig` / `workspaceYamlFor` / `WORKSPACE_YAML`、Task 2 の `insertWorkspace` / `getWorkspaceByPath` / `listProjectsOf` / `projectNameFrom`、既存の `ensureProjectScaffold`・`parseProjectConfig`・`syncProjectRow` 相当
- Produces:
  ```ts
  // shared/protocol.ts
  export type WorkspaceSummary = { id: number; path: string; name: string; projects: ProjectSummary[] };
  "workspace.list": { params: Record<string, never>; result: WorkspaceSummary[] };
  "workspace.add": { params: { path: string }; result: WorkspaceSummary & { created: string[]; alreadyRegistered: boolean } };
  "workspace.update": { params: { path: string }; result: WorkspaceSummary };

  // core/src/workflow/scaffold.ts
  /** <root>/.doctrine/workspace.yaml が無ければ、root が git リポジトリのルートなら projects: { <丸めた名前>: . } で書く。
   *  root が git リポジトリでなく workspace.yaml も無ければ投げる（何を束ねるかは人が書く）。 */
  export function ensureWorkspaceScaffold(root: string): Promise<{ created: string[] }>;

  // core/src/daemon/workspaceRegistry.ts
  export function addWorkspace(db: Db, rootPath: string): Promise<{ workspaceId: number; created: string[]; alreadyRegistered: boolean }>;
  export function updateWorkspace(db: Db, rootPath: string): Promise<{ workspaceId: number }>;
  export function toWorkspaceSummary(db: Db, workspaceId: number): Promise<WorkspaceSummary>;
  ```

振る舞い（spec 4.1）:

- 入口で `Deno.realPath` により root と各プロジェクトのパスを実パスに直す。DB にはこの実パスを入れる。
- `addWorkspace`: 同じ root の workspace があれば `alreadyRegistered: true` で何もしない。無ければ `ensureWorkspaceScaffold` → 読む →
  各プロジェクトに `ensureProjectScaffold` → 検証 → 1 トランザクションで workspace とプロジェクトを入れる。
- 検証: 各パスが git リポジトリのルート（`assertRepoRoot`）。そのパスのプロジェクトがほかの workspace にあれば、
  **その workspace がそのプロジェクト 1 つだけで、`completed`・`canceled` 以外の Intake を持たないときだけ**吸収する
  （プロジェクトの `workspace_id` と `name` を付け替え、その workspace の Intake を付け替え、空の workspace の行を消す）。
  それ以外は `このリポジトリは workspace <name>（<path>）に登録済みです: <project path>` で投げ、何も書かない。
  Intake の付け替えは Task 4 で `intakes.workspace_id` ができてからの話なので、この Task では「そのプロジェクトに Intake が 1 件でもあれば（`intakes.project_id` で引く）投げる」にしておき、Task 4 で上の規則に広げる。
- `updateWorkspace`: 読み直して、足されたプロジェクトは登録（吸収の規則も同じ）、消されたプロジェクトは登録を外す。
  外すプロジェクトに `queued`・`running`・`suspended`・`paused`・`rate_limited`・`waiting` のタスクがあれば何も変えずに投げる。
  残るプロジェクトは `project.yaml` を読み直して行を合わせ（いまの `project.update` と同じ）、名前が変わっていれば `name` を更新する。
- 登録を外すとプロジェクトの行を消す。`tasks.project_id` が外部キーで参照しているので、終わったタスクしか無くても行は消せない。
  第 1 段では、タスクが 1 件でもあるプロジェクトは `<name> にはタスクの記録があるので外せません` で投げ、何も変えない
  （動いているタスクがあるときに投げるのは spec 4.1 のとおり。終わったタスクだけのときも投げるのは第 1 段の制限で、外す操作を実際に使う場面が出たら `projects.retired_at` を足して解く）。

- [ ] **Step 1: 失敗するテストを書く**

`core/test/daemon/workspaceRegistry.test.ts`（`makeRepo` で一時リポジトリを作る）:

```ts
test("git 管理外の root に 3 つのリポジトリを束ねて登録する", async () => { /* workspace.yaml を書き、addWorkspace、listProjectsOf が 3 行・名前が yaml のキー */ });
test("root 自身がリポジトリなら workspace.yaml の雛形を書く", async () => { /* created に .doctrine/workspace.yaml、projects は { <name>: . } */ });
test("git 管理外の root に workspace.yaml が無ければ投げる", async () => {});
test("2 回目の addWorkspace は alreadyRegistered", async () => {});
test("末尾の / やシンボリックリンク経由のパスでも同じ workspace になる", async () => {});
test("1 つずつの workspace になっていたリポジトリを吸収する", async () => { /* seedProject で先に入れておき、root で addWorkspace。元の workspace の行が消える */ });
test("Intake を持つ workspace のリポジトリは吸収せず、何も書かずに投げる", async () => {});
test("updateWorkspace は足されたプロジェクトを登録し、消されたプロジェクトを外す", async () => {});
test("動いているタスクがあるプロジェクトは外さずに投げる", async () => {});
test("終わったタスクだけがあるプロジェクトも外さずに投げる", async () => {});
```

`core/test/daemon/cli.test.ts` に `workspace-add --path x` → `{ method: "workspace.add", params: { path: "x" } }`、`project-add` が未知のコマンドになること。

- [ ] **Step 2: 落ちることを確かめる**

Run: `cd core && deno test --allow-all test/daemon/workspaceRegistry.test.ts test/daemon/cli.test.ts`
Expected: FAIL

- [ ] **Step 3: 実装する**（上の振る舞いのとおり。`project.add` を使っていたテストは `workspace.add` に書き換える）

- [ ] **Step 4: doctrine 自身の `.doctrine/workspace.yaml` を足し、サイトの Guide / overview を書き換える**

```yaml
# doctrine の workspace 設定（dctl workspace-add が雛形として作成）
projects:
  doctrine: .
```

- [ ] **Step 5: verify を通す**

Run: `mise run core:check && mise run core:test && mise run app:test && mise run app:build`
Expected: PASS

- [ ] **Step 6: コミットする**

```bash
git add core shared app .doctrine/workspace.yaml site/src/content/docs/ja/guide/writing-workflows.mdx site/src/content/docs/ja/guide/intake.mdx docs/overview.md
git commit -m "workspace を登録する dctl workspace-add / workspace-update を足す"
```

---

### Task 4: Intake を workspace に属させる

**Files:**
- Modify: `core/src/db/migrations.ts`（`0016_intake_workspace`）
- Modify: `core/src/db/schema.ts`（`IntakesTable.project_id` → `workspace_id`）
- Modify: `core/src/db/intakes.ts:43,76-79`（`NewIntake.workspace_id`、`listIntakes` の `workspaceId` 絞り込み）
- Modify: `core/src/db/workspaces.ts`（`soleProjectOf` を足す）
- Modify: `core/src/intake/commands.ts:58-84,380,420`、`core/src/intake/runner.ts:296`、`core/src/intake/dispatch.ts:80,156`、`core/src/intake/view.ts:76,100`
- Modify: `core/src/intake/watch.ts`（`watchProject` → `watchWorkspace`、見張りのキーを workspace id に。`observePullRequests` の `.where("i.project_id", …)` を `i.workspace_id` に）
- Modify: `core/src/daemon/handlers.ts`（`intake.start` / `intake.list`、`intakeWatcher.health/request` の引数、`worktreeEntries`・worktree 削除の引き当て、`intakeBase` の呼び出し元）
- Modify: `core/src/daemon/workspaceRegistry.ts`（吸収の規則を spec どおりに広げる）
- Modify: `shared/protocol.ts`（`IntakeSummary.workspace_id`、`intake.list` の `{ workspace?: string }`）
- Modify: `core/src/cli/dctl.ts:69,121`（`intake ls --project` を `--workspace` に）
- Modify: app の `i.project_id` を読む箇所（`app/src/intake.ts:164-182,504`、`app/src/components/Sidebar.tsx:92-94,119-131`、`app/src/components/IntakeView.tsx:29-38`）
- Test: `core/test/db/migrate.test.ts`、`core/test/intake/*.test.ts`、`core/test/daemon/intakeHandlers.test.ts`、`core/test/daemon/workspaceRegistry.test.ts`、`app/src/intake.test.ts`

**Interfaces:**
- Consumes: Task 2 の `WorkspaceRow` / `listProjectsOf`、Task 3 の `workspace.list`
- Produces:
  ```ts
  // core/src/db/workspaces.ts
  /** 第 1 段の Intake が使うプロジェクト。workspace のプロジェクトがちょうど 1 つでなければ投げる（第 2 段で消す）。 */
  export function soleProjectOf(db: Db, workspaceId: number): Promise<ProjectRow>;

  // core/src/intake/watch.ts
  export function watchWorkspace(db: Db, deps: WatchDeps, workspaceId: number): Promise<WorkspaceWatchReport>;
  // IntakeWatcher.request / health の引数は workspaceId
  ```

振る舞い:

- `0016`: `intakes` に `workspace_id` を足し、`project_id` の指すプロジェクトの `workspace_id` で埋め、表を作り直して
  `workspace_id INTEGER NOT NULL REFERENCES workspaces(id)` にし `project_id` を落とす。`uq_intakes_open_issue` のインデックスは作り直す。
- Intake の調査・投入・見張りは、いま `getProject(db, intake.project_id)` としているところを `soleProjectOf(db, intake.workspace_id)` にする。
  それ以外の振る舞いは変えない。
- `intake.start` の引数は、この Task ではまだ `{ project, issue_url }`（Task 5 で `{ workspace }` にする）。プロジェクトの workspace を引き、
  **その workspace のプロジェクトが 2 つ以上なら** `プロジェクトが複数ある workspace の Intake はまだ扱えません` で断る。
- `intake.list` は `{ workspace?: string }`（root のパス）で絞る。未登録の workspace なら `[]`。
- `worktreeEntries` と worktree 削除の引き当ては、Intake を `listIntakes(db, { workspaceId: project.workspace_id, includeClosed: true })` から引く。
- app: Intake の行からプロジェクトを引いていた箇所は、`workspace_id` が一致し、かつその workspace のただ 1 つのプロジェクトを使う
  （`s.projects` に Task 2 で足した `workspace_id` がある）。サイドバーの絞り込みは今のままプロジェクトで選び、そのプロジェクトの `workspace_id` で絞る。

- [ ] **Step 1: 失敗するテストを書く**

```ts
// migrate.test.ts
test("0016 は Intake をプロジェクトの workspace に付け替える", async () => {
  // 0015 まで流した DB に projects 1 行と intakes 2 行（1 つは completed）を入れ、最新まで流す
  // intakes.workspace_id がプロジェクトの workspace を指し、project_id 列が無く、foreign_key_check が空
  // 同じ issue_url で開いた Intake を 2 つ入れようとすると uq_intakes_open_issue で落ちる
});

// intakeHandlers.test.ts
test("プロジェクトが 2 つの workspace では intake.start を断る", async () => {});
test("intake.list は workspace で絞る", async () => {});

// workspaceRegistry.test.ts
test("終わった Intake だけを持つ 1 つずつの workspace は吸収し、Intake を付け替える", async () => {});
test("終わっていない Intake を持つ workspace は吸収しない", async () => {});
```

既存の Intake のテスト（`core/test/intake/`）は `project_id` を `workspace_id` に置き換えるだけで通ること。

- [ ] **Step 2: 落ちることを確かめる**

Run: `cd core && deno test --allow-all test/db/migrate.test.ts test/daemon/`
Expected: FAIL

- [ ] **Step 3: マイグレーション・行の関数・Intake のコード・見張り・ハンドラを書き換える**

- [ ] **Step 4: app を追従させる**

Run: `mise run app:test && mise run app:build`
Expected: PASS

- [ ] **Step 5: verify を通す**

Run: `mise run core:check && mise run core:test && mise run app:deps && mise run app:test && mise run app:build && mise run pfd:check && mise run pfd:test`
Expected: PASS

- [ ] **Step 6: コミットする**

```bash
git add core shared app
git commit -m "Intake を workspace に属させる"
```

---

### Task 5: トラッカーを workspace で引く

**Files:**
- Modify: `core/src/workflow/project.ts`（`tracker` を外す。`TrackerConfig`・`LinearStateNames`・`trackerSchema` を `workspace.ts` へ移す）
- Modify: `core/src/workflow/workspace.ts`
- Create: `core/src/tracker/workspaceTracker.ts`
- Modify: `core/src/daemon/tracker.ts`（`trackerFor` が `workspace.yaml` を読む）
- Modify: `core/src/tracker/tracker.ts:44`（`TrackerOf` の型）
- Modify: `core/src/intake/runner.ts:70,321`、`core/src/intake/commands.ts:381`、`core/src/intake/watch.ts:191`、`core/src/daemon/handlers.ts:739-788,940`
- Modify: `shared/intake/tracker.ts`（`WorkspaceTrackerStatus`）、`shared/protocol.ts:550-560`
- Modify: app `app/src/store.tsx:443-463`、`app/src/components/IssuePicker.tsx:128-176`、`app/src/trackerCache.ts:74-78`、`app/src/intake.ts:375-`（`trackerGuidance`）
- Test: `core/test/workflow/project.test.ts`、`core/test/workflow/workspace.test.ts`、`core/test/tracker/workspaceTracker.test.ts`、`core/test/daemon/tracker.test.ts`、`core/test/daemon/intakeHandlers.test.ts`、`app/src/trackerCache.test.ts`、`app/src/intake.test.ts`

**Interfaces:**
- Consumes: Task 1〜4 のすべて。`Tracker` の各メソッドの `projectPath` はそのまま使う
- Produces:
  ```ts
  // shared/intake/tracker.ts（ProjectTrackerStatus を置き換える）
  export type WorkspaceTrackerStatus =
    | { ok: false; reason: "workspace_config_missing" | "workspace_config_invalid"; message: string }
    | { ok: true; kind: TrackerKind; targets: (TrackerStatus & { project: string })[] }; // project はプロジェクトの名前。Linear は先頭のプロジェクト 1 つ

  // core/src/tracker/workspaceTracker.ts
  export type WorkspaceRef = { path: string; projects: { name: string; path: string }[] };
  export interface WorkspaceTracker {
    readonly kind: TrackerKind;
    readonly tracker: Tracker;
    status(): Promise<(TrackerStatus & { project: string })[]>;
    /** GitHub は全プロジェクトを合わせて updatedAt の降順。一部が落ちても残りを返し、全部落ちたら投げる。
     *  プロジェクトが 2 つ以上なら identifier に "<name>#<n>" を使う。 */
    listIssues(o: { assignee: "me" | "any"; search?: string }): Promise<IssueSummary[]>;
    /** Issue を読み書きするときに gh を実行するプロジェクトのパス。GitHub は URL の owner/name が一致するプロジェクト、
     *  無ければ null。Linear は先頭のプロジェクト。 */
    projectPathFor(issueUrl: string): Promise<string | null>;
  }
  export function workspaceTracker(ws: WorkspaceRef, tracker: Tracker): WorkspaceTracker;

  // core/src/db/workspaces.ts（WorkspaceRef を DB の行から作る。runner・commands・watch・handlers はすべてこれを使う）
  export function workspaceRefOf(db: Db, workspaceId: number): Promise<WorkspaceRef>;

  // core/src/github/ghTracker.ts（いまの repoIds のキャッシュを { id, nameWithOwner } に広げて出す）
  repoOf(projectPath: string): Promise<{ id: string; nameWithOwner: string }>;

  // core/src/tracker/tracker.ts
  /** workspace.yaml を読んで作る。無い・読めないときは WorkspaceConfigError を投げる。 */
  export type TrackerOf = (ws: WorkspaceRef) => Promise<WorkspaceTracker>;
  export class WorkspaceConfigError extends Error { reason: "workspace_config_missing" | "workspace_config_invalid" }

  // shared/protocol.ts
  "tracker.status": { params: { workspace: string }; result: WorkspaceTrackerStatus };
  "tracker.issues": { params: { workspace: string; assignee?: "me" | "any"; search?: string }; result: TrackerIssue[] };
  "tracker.issue": { params: { workspace: string; url: string }; result: IssueDetail };
  "intake.start": { params: { workspace: string; issue_url: string }; result: IntakeSummary & { alreadyActive: boolean } };
  ```

振る舞い:

- `parseProjectConfig` は `tracker` キーがあれば `tracker は .doctrine/workspace.yaml に移りました。project.yaml から消して workspace.yaml に書いてください` で落とす（zod の strict の「未知のキー」より先に見る）。
- `trackerFor` は `join(ws.path, WORKSPACE_YAML)` を呼ぶたびに読む（いまと同じく再起動なしで効く）。無ければ `WorkspaceConfigError("workspace_config_missing")`、形が違えば `workspace_config_invalid`。
  `ws.projects` は DB の行から作る（名前と実パス）。
- GitHub の `projectPathFor` は、各プロジェクトの `repoOf(path).nameWithOwner` を URL `https://github.com/<owner>/<name>/issues/<n>` と比べる。
  `WorkspaceTracker` は `trackerOf` のたびに作り直されるので、`status` を呼んで調べると見張りの 1 周ごとに `gh auth status` と `gh repo view` がプロジェクトの数だけ走る。
  `repoOf` は `ghTracker` の中（デーモンの生きている間ずっと残る）でパスごとに覚える。
- `intake.start` は `projectPathFor` が null なら `この Issue は workspace のどのリポジトリにもありません: <url>` で断る。プロジェクトが 2 つ以上の workspace を断るのは Task 4 のまま。
- Intake のコード（runner・commands・watch）は `trackerOf(ws)` で `WorkspaceTracker` を得て、`tracker.readIssue(await wt.projectPathFor(url) ?? soleProject.path, url)` のように `projectPath` を渡す。sub-issue の作成は第 1 段ではただ 1 つのプロジェクトのパスのまま。
- app: `IssuePicker` はいまのプロジェクト選択のまま、選んだプロジェクトの workspace の root パスを `{ workspace }` に渡す（`workspace.list` から引く）。
  `trackerCacheKey` のキーを workspace のパスにし、IndexedDB の版を 1 つ上げる。`trackerGuidance` は `targets` のうち失敗したものごとに案内を出し、`workspace_config_missing` では `<root>/.doctrine/workspace.yaml` を書くよう案内する。

- [ ] **Step 1: 失敗するテストを書く**

```ts
// project.test.ts
test("tracker が残った project.yaml は移し先を示して落ちる", () => {
  assert.throws(
    () => parseProjectConfig("defaultWorkflow: default\ntracker:\n  kind: linear\n  team: ENG\n"),
    (e: unknown) => e instanceof WorkflowValidationError && e.message.includes("workspace.yaml"),
  );
});

// workspaceTracker.test.ts（core/test/helpers/fakeTracker.ts の偽物を使う）
test("GitHub の一覧は全プロジェクトを updatedAt の降順で合わせ、識別子に名前を付ける", async () => {});
test("1 つのリポジトリが落ちても残りを返す", async () => {});
test("すべてのリポジトリが落ちたら投げる", async () => {});
test("projectPathFor は URL の owner/name でプロジェクトを選び、無ければ null", async () => {});
test("プロジェクト 1 つの workspace では識別子がいまと同じ #<n>", async () => {});

// daemon/tracker.test.ts
test("workspace.yaml が無ければ workspace_config_missing", async () => {});
test("workspace.yaml の書き換えは再起動なしで効く", async () => {});

// intakeHandlers.test.ts
test("workspace のどのリポジトリにも無い Issue の intake.start を断る", async () => {});
```

- [ ] **Step 2: 落ちることを確かめる**

Run: `cd core && deno test --allow-all test/workflow test/tracker test/daemon`
Expected: FAIL

- [ ] **Step 3: core を実装する**

- [ ] **Step 4: app を追従させる**

Run: `mise run app:test && mise run app:build`
Expected: PASS

- [ ] **Step 5: verify を通す**

Run: `mise run core:check && mise run core:test && mise run app:deps && mise run app:test && mise run app:build && mise run pfd:check && mise run pfd:test`
Expected: PASS

- [ ] **Step 6: コミットする**

```bash
git add core shared app
git commit -m "トラッカーを workspace.yaml から引く"
```

---

## マージ後に人が行うこと

- デーモンを再起動する（0015・0016 が流れる）。
- Linear を使っていたリポジトリは、`project.yaml` の `tracker` を消し、root に `.doctrine/workspace.yaml` を書いて `dctl workspace-update --path <root>`（root が新しければ `workspace-add`）。
- `~/work/tp` を束ねるなら `~/work/tp/.doctrine/workspace.yaml` を書いて `dctl workspace-add --path ~/work/tp`。Intake がリポジトリをまたいで動くのは第 2 段から。
