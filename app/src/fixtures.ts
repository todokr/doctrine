// テスト用の標本。画面はこれを使わない（画面のデータはデーモンから来る）
import type { Project, Task, TaskDiff } from "./types";
import type { ServerEvent } from "../../shared/protocol.ts";
import examplePatch from "../../shared/guide/examples/step-artifacts.patch?raw";

export const NOW = Date.parse("2026-09-15T15:00:00+09:00");
export const MIN = 60000;
export const PROJECTS: Project[] = [
  { id: "doctrine", color: "#2E6CA4", path: "~/git/doctrine", def: "feature" },
  { id: "shop-api", color: "#AA3A2C", path: "~/work/shop-api", def: "feature" },
  { id: "blog", color: "#296B49", path: "~/git/blog", def: "feature" },
];

// 状態は doctrine の7状態。refused はフラグ。
// worktree は seedTasks が state から決めるので、dctl gc で消した後の姿は gced で指定する
type Seed = Omit<Task, "project" | "prompt" | "branch" | "worktree"> & { gced?: true };

const SEEDS: Seed[] = [
  { id: "t-9f21", wf: "doctrine/guided", title: "ステップの再開をロール単位のセッションに切り替える", state: "suspended", step: "human-review", attempt: 1, prio: 1, since: NOW - 8 * MIN },
  { id: "t-2b91", wf: "doctrine/feature", title: "worktree.list をディスク上の全件にする", state: "suspended", step: "review", attempt: 1, prio: 2, since: NOW - 42 * MIN },
  { id: "s-1103", wf: "shop-api/feature", title: "在庫引当のリトライを冪等にする", state: "suspended", step: "review", attempt: 2, prio: 1, since: NOW - 15 * MIN },
  { id: "t-a1b2", wf: "doctrine/guided", title: "Review Guide の保存形式を試す", state: "suspended", step: "plan-approval", attempt: 1, prio: 2, since: NOW - 130 * MIN },
  { id: "b-204", wf: "blog/feature", title: "記事一覧にページネーションを付ける", state: "suspended", step: "review", attempt: 1, prio: 3, since: NOW - 60 * 26 * MIN },
  { id: "t-e812", wf: "doctrine/feature", title: "daemon.warning イベントを追加する", state: "failed", step: "test", attempt: 3, prio: 2, since: NOW - 60 * 26 * MIN, dirty: true },
  { id: "t-6ba3", wf: "doctrine/feature", title: "ratelimit のサンプルを日次で丸める", state: "failed", step: "test", attempt: 1, prio: 2, since: NOW - 60 * 24 * 12 * MIN, gced: true },
  { id: "t-3cd2", wf: "doctrine/feature", title: "gc の確認文言を直す", state: "completed", step: "open-pr", attempt: 1, prio: 2, since: NOW - 95 * MIN, refused: true, dirty: true },
  { id: "s-1202", wf: "shop-api/hotfix", title: "注文日時のタイムゾーンずれ", state: "running", step: "test", attempt: 1, prio: 0, since: NOW - 23 * MIN },

  { id: "t-7f3a", wf: "doctrine/feature", title: "task.cleanedUp イベントを追加する", state: "running", step: "implement", attempt: 1, prio: 1, since: NOW - 11 * MIN },
  // test が1回差し戻した結果、implement が2周目に入っている
  { id: "t-c04d", wf: "doctrine/feature", title: "workflow.list にステップを載せる", state: "running", step: "implement", attempt: 2, prio: 2, since: NOW - 134 * MIN, bounce: { step: "test", goto: "implement", attempt: 1 } },
  { id: "s-1102", wf: "shop-api/feature", title: "注文 API にカーソルページングを入れる", state: "running", step: "lint", attempt: 1, prio: 2, since: NOW - 48 * MIN },

  { id: "s-1104", wf: "shop-api/feature", title: "価格改定バッチの分割実行", state: "queued", step: null, attempt: 0, prio: 0, since: NOW - 4 * MIN },
  { id: "t-91e0", wf: "doctrine/feature", title: "ログ追従を1接続1タスクに上書きする", state: "queued", step: null, attempt: 0, prio: 2, since: NOW - 25 * MIN },

  { id: "t-f22b", wf: "doctrine/feature", title: "ratelimit の待機と再開を入れる", state: "rate_limited", step: "agent-review", attempt: 1, prio: 2, since: NOW - 12 * MIN, resumeAt: NOW + 68 * MIN },

  { id: "t-d5e6", wf: "doctrine/guided", title: "step_outputs の全文保持を検討する", state: "paused", step: "plan", attempt: 1, prio: 2, since: NOW - 60 * 5 * MIN },

  { id: "t-0a77", wf: "doctrine/feature", title: "README にデーモン起動手順を書く", state: "completed", step: "open-pr", attempt: 1, prio: 2, since: NOW - 60 * 3 * MIN },
  { id: "s-1105", wf: "shop-api/feature", title: "決済 Webhook の署名検証", state: "canceled", step: "implement", attempt: 1, prio: 2, since: NOW - 60 * 24 * 9 * MIN, dirty: true },
  { id: "b-198", wf: "blog/feature", title: "OGP 画像を記事ごとに生成する", state: "completed", step: "deploy-preview", attempt: 1, prio: 2, since: NOW - 60 * 24 * 2 * MIN },
];

export function seedTasks(): Task[] {
  return SEEDS.map(({ gced, ...t }) => {
    const project = t.wf.split("/")[0];
    const keepWorktree = !gced && t.state !== "queued" && (t.state !== "completed" || t.refused);
    return {
      ...t,
      project,
      prompt: `${t.title}。詳細は issue を参照してください。`,
      branch: `doctrine/${t.id}-${t.title.length}`,
      worktree: keepWorktree ? `~/.local/state/doctrine/worktrees/${project}/${t.id}` : null,
    };
  });
}

const rateLimit = (window: string, utilization: number, resetsInMin: number): ServerEvent => ({
  event: "ratelimit.sample",
  window,
  utilization,
  // デーモンが正規化した後の形（ISO 8601）
  resets_at: new Date(NOW + resetsInMin * MIN).toISOString(),
});

/** 通常の状態。7日枠は上がってきているが、まだ警告ではない。 */
export const RATELIMIT_NORMAL: ServerEvent[] = [
  rateLimit("five_hour", 0.22, 185),
  rateLimit("seven_day", 0.66, 60 * 24 * 4 - 360),
];

/** 飽和が近い状態。どちらも danger の色になり、説明文は7日枠にだけ付く。 */
export const RATELIMIT_NEAR_SATURATION: ServerEvent[] = [
  rateLimit("five_hour", 0.8, 185),
  rateLimit("seven_day", 0.86, 60 * 24 * 4 - 360),
];

/**
 * 本物の `git diff` から起こした task.diff の応答。
 * 変更・追加・削除・リネーム・バイナリが1件ずつ入っていて、
 * リネームは中身が変わっていないので patch に hunk を持たない。
 */
export const SAMPLE_DIFF: TaskDiff = {
  base: { branch: "develop", merge_base: "3efbc75f70aeae7989a3dc4db95bdfc52b6c504a" },
  since_step_run_id: null,
  files: [
    { path: "logo.png", status: "M", binary: true },
    { path: "src/added.ts", status: "A", binary: false, additions: 1, deletions: 0 },
    { path: "src/gone.ts", status: "D", binary: false, additions: 0, deletions: 1 },
    { path: "src/keep.ts", status: "M", binary: false, additions: 2, deletions: 2 },
    { path: "src/renamed.ts", status: "R", old_path: "src/moved.ts", binary: false, additions: 0, deletions: 0 },
  ],
  patch: `diff --git a/logo.png b/logo.png
index 742c16a..674f206 100644
Binary files a/logo.png and b/logo.png differ
diff --git a/src/added.ts b/src/added.ts
new file mode 100644
index 0000000..fa49b07
--- /dev/null
+++ b/src/added.ts
@@ -0,0 +1 @@
+new file
diff --git a/src/gone.ts b/src/gone.ts
deleted file mode 100644
index 3367afd..0000000
--- a/src/gone.ts
+++ /dev/null
@@ -1 +0,0 @@
-old
diff --git a/src/keep.ts b/src/keep.ts
index 104f954..967f419 100644
--- a/src/keep.ts
+++ b/src/keep.ts
@@ -1,4 +1,4 @@
 /* 先頭の
    ブロックコメント */
-export const greet = (name: string) => \`hello \${name}\`;
-const n = 1;
+export const greet = (name: string) => \`hi \${name}!\`;
+const n = 2;
diff --git a/src/moved.ts b/src/renamed.ts
similarity index 100%
rename from src/moved.ts
rename to src/renamed.ts
`,
  truncated: false,
};

/**
 * ガイドの見本（shared/guide/examples/step-artifacts.guide.json）と対になる patch から作った task.diff の応答。
 * buildDiff も照合も行数を見ないので additions / deletions は 0 にしてある。
 */
const exampleFile = (path: string, status: "A" | "M" = "M") =>
  ({ path, status, binary: false, additions: 0, deletions: 0 }) as const;

export const EXAMPLE_DIFF: TaskDiff = {
  base: { branch: "develop", merge_base: "3efbc75f70aeae7989a3dc4db95bdfc52b6c504a" },
  since_step_run_id: null,
  files: [
    exampleFile("src/core/engine.ts"),
    exampleFile("src/core/worktree.ts"),
    exampleFile("src/db/boundary.ts"),
    exampleFile("src/db/migrations.ts"),
    exampleFile("src/db/schema.ts"),
    exampleFile("src/db/sessions.ts", "A"),
    exampleFile("src/workflow/schema.ts"),
    exampleFile("test/core/engine.test.ts"),
    exampleFile("test/core/worktree.test.ts"),
    exampleFile("test/db/migrate.test.ts"),
    exampleFile("test/db/sessions.test.ts", "A"),
    exampleFile("test/workflow/schema.test.ts"),
  ],
  patch: examplePatch,
  truncated: false,
};

/**
 * 関数を src/a.ts から src/b.ts へ移しただけの task.diff の応答。
 * files[] の並びと patch の区画の並びは揃えてあり、additions / deletions も patch の中身と合っている。
 */
export const SAMPLE_MOVE_DIFF: TaskDiff = {
  base: { branch: "develop", merge_base: "3efbc75f70aeae7989a3dc4db95bdfc52b6c504a" },
  since_step_run_id: null,
  files: [
    { path: "src/a.ts", status: "M", binary: false, additions: 0, deletions: 5 },
    { path: "src/b.ts", status: "A", binary: false, additions: 5, deletions: 0 },
  ],
  patch: `diff --git a/src/a.ts b/src/a.ts
index 104f954..967f419 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,7 +1,2 @@
 import { Item } from "./item";
-export function total(items: Item[]) {
-  let sum = 0;
-  for (const i of items) sum += i.price;
-  return sum;
-}
 export {};
diff --git a/src/b.ts b/src/b.ts
new file mode 100644
index 0000000..fa49b07
--- /dev/null
+++ b/src/b.ts
@@ -0,0 +1,5 @@
+export function total(items: Item[]) {
+  let sum = 0;
+  for (const i of items) sum += i.price;
+  return sum;
+}
`,
  truncated: false,
};
