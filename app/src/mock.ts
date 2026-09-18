// プロトタイプ（prototype/review-app-mvp.html）のモックデータ。デーモンにつなぐまでの仮の中身
import type { DiffFile, Guide, Project, StepDef, Task } from "./types";

export const NOW = Date.parse("2026-09-15T15:00:00+09:00");
export const MIN = 60000;
export const PROJECTS: Project[] = [
  { id: "doctrine", color: "#2E6CA4", path: "~/git/doctrine", def: "feature" },
  { id: "shop-api", color: "#AA3A2C", path: "~/work/shop-api", def: "feature" },
  { id: "blog", color: "#296B49", path: "~/git/blog", def: "feature" },
];
const st = (id: string, type: StepDef["type"], extra: Partial<StepDef> = {}): StepDef => ({ id, type, ...extra });
export const WORKFLOWS: Record<string, StepDef[]> = {
  "doctrine/feature": [st("setup","command"), st("implement","agent"), st("test","command"), st("review","approval",{ title: "差分を確認してください", onReject: "implement" }), st("open-pr","command")],
  "doctrine/guided": [st("setup","command"), st("plan","agent"), st("plan-approval","approval",{ title: "計画を確認してください", onReject: "plan", review: { files: [".doctrine-out/plan.md"] } }), st("implement","agent"), st("code-review","agent"), st("human-review","approval",{ title: "変更を確認してください", onReject: "implement" }), st("open-pr","command")],
  "shop-api/feature": [st("setup","command"), st("implement","agent"), st("lint","command"), st("test","command"), st("review","approval",{ title: "差分を確認してください", onReject: "implement" }), st("open-pr","command")],
  "shop-api/hotfix": [st("setup","command"), st("fix","agent"), st("test","command"), st("confirm","approval",{ title: "本番反映前に確認してください", onReject: "fix" })],
  "blog/feature": [st("setup","command"), st("implement","agent"), st("build","command"), st("review","approval",{ title: "差分を確認してください", onReject: "implement" }), st("deploy-preview","command")],
};

const DIFF_2B91: DiffFile[] = [
  { path: "src/daemon/handlers.ts", hunks: [
    { old: 219, new: 219, body:
`       case "worktree.list": {
-        const out: { project: string; orphans: string[] }[] = [];
+        const out: WorktreeEntry[] = [];
         for (const project of await listProjects(ctx.db)) {
-          const known = (await listTasks(ctx.db, { projectId: project.id }))
-            .map((t) => t.worktree_path).filter((p): p is string => p !== null);
-          out.push({ project: project.path, orphans: await findOrphans(project.path, known) });
+          const tasks = await listTasks(ctx.db, { projectId: project.id });
+          for (const wt of await listDoctrineWorktrees(project.path)) {
+            const task = tasks.find((t) => t.worktree_path === wt.path) ?? null;
+            out.push({
+              project: project.path, path: wt.path, branch: wt.branch,
+              task_id: task?.id ?? null, task_state: task?.state ?? null,
+              dirty: await isDirty(wt.path),
+              age_basis: task ? task.updated_at : wt.mtime,
+            });
+          }
         }
         return out;
       }` },
    { old: 228, new: 236, body:
`       case "worktree.remove": {
-        const taskId = req(params, "task_id");
-        const task = await getTask(ctx.db, taskId);
-        if (!task?.worktree_path) throw new Error("worktree がありません");
+        const target = await resolveRemoveTarget(ctx, params);
+        if (target.task && !isTerminal(target.task.state)) {
+          throw new Error("実行中のタスクの worktree は削除できません");
+        }` },
  ] },
  { path: "src/core/worktree.ts", hunks: [
    { old: 88, new: 88, body:
` export async function findOrphans(repoPath: string, known: string[]) {
   const all = await listDoctrineWorktrees(repoPath);
   return all.filter((w) => !known.includes(w.path)).map((w) => w.path);
 }
+
+export function isUnderStateDir(path: string, stateDir: string): boolean {
+  const rel = relative(join(stateDir, "worktrees"), resolve(path));
+  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
+}` },
  ] },
  { path: "test/daemon/handlers.test.ts", hunks: [
    { old: 402, new: 402, body:
`+test("worktree.remove は state 配下にないパスを拒否する", async () => {
+  const { handle } = await setup();
+  await assert.rejects(
+    handle("worktree.remove", { path: "/tmp/elsewhere" }),
+    /state ディレクトリ配下ではありません/,
+  );
+});
+
+test("worktree.remove は実行中のタスクの worktree を force でも拒否する", async () => {
+  const { handle, running } = await setupRunningTask();
+  await assert.rejects(handle("worktree.remove", { task_id: running.id, force: true }));
+});` },
  ] },
];

const DIFF_1103: DiffFile[] = [
  { path: "src/stock/reserve.ts", hunks: [
    { old: 30, new: 30, body:
` export async function reserve(db: Db, orderId: string, items: Item[]) {
-  for (const item of items) {
-    await db.insert("reservations", { orderId, sku: item.sku, qty: item.qty });
-  }
+  const key = idempotencyKey(orderId, items);
+  return await withRetry(async () => {
+    return await db.transaction(async (tx) => {
+      const existing = await tx.find("reservations", { key });
+      if (existing) return existing;
+      try {
+        return await tx.insert("reservations", { key, orderId, items });
+      } catch (e) {
+        if (isUniqueViolation(e)) return await tx.find("reservations", { key });
+        throw e;
+      }
+    });
+  }, { attempts: 3, backoffMs: 200, jitter: true });
 }` },
  ], since: [
    { old: 35, new: 35, body:
`       if (existing) return existing;
-      return await tx.insert("reservations", { key, orderId, items });
+      try {
+        return await tx.insert("reservations", { key, orderId, items });
+      } catch (e) {
+        if (isUniqueViolation(e)) return await tx.find("reservations", { key });
+        throw e;
+      }
     });
-  }, { attempts: 3, backoffMs: 200 });
+  }, { attempts: 3, backoffMs: 200, jitter: true });` },
  ] },
  { path: "test/stock/reserve.test.ts", hunks: [
    { old: 0, new: 1, body:
`+import { assert } from "../helpers.ts";
+
+test("同じ注文の再試行は引当を二重に作らない", async () => {
+  const db = await freshDb();
+  await reserve(db, "o-1", [{ sku: "A", qty: 1 }]);
+  await reserve(db, "o-1", [{ sku: "A", qty: 1 }]);
+  assert.equal(await db.count("reservations"), 1);
+});
+
+test("同時に走った引当は一意制約違反を既存の行として扱う", async () => {
+  const db = await freshDb();
+  await Promise.all([reserve(db, "o-2", items), reserve(db, "o-2", items)]);
+  assert.equal(await db.count("reservations"), 1);
+});` },
  ], since: [
    { old: 7, new: 7, body:
` });
+
+test("同時に走った引当は一意制約違反を既存の行として扱う", async () => {
+  const db = await freshDb();
+  await Promise.all([reserve(db, "o-2", items), reserve(db, "o-2", items)]);
+  assert.equal(await db.count("reservations"), 1);
+});` },
  ] },
  { path: "src/stock/idempotency.ts", hunks: [
    { old: 0, new: 1, body:
`+import { createHash } from "node:crypto";
+
+export function idempotencyKey(orderId: string, items: Item[]): string {
+  const canonical = items.map((i) => i.sku + ":" + i.qty).sort().join(",");
+  return createHash("sha256").update(orderId + "|" + canonical).digest("hex");
+}` },
  ] },
];

const DIFF_B204: DiffFile[] = [
  { path: "src/pages/index.astro", hunks: [
    { old: 12, new: 12, body:
` const posts = (await getCollection("blog")).sort(byDate);
+const PAGE_SIZE = 10;
+const page = Number(Astro.url.searchParams.get("page") ?? "1");
+const shown = posts.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
 ---
-{posts.map((p) => <PostCard post={p} />)}
+{shown.map((p) => <PostCard post={p} />)}
+<Pager page={page} total={Math.ceil(posts.length / PAGE_SIZE)} />` },
  ] },
  { path: "src/components/Pager.astro", hunks: [
    { old: 0, new: 1, body:
`+---
+const { page, total } = Astro.props;
+---
+<nav class="pager">
+  {page > 1 && <a href={"?page=" + (page - 1)}>前へ</a>}
+  <span>{page} / {total}</span>
+  {page < total && <a href={"?page=" + (page + 1)}>次へ</a>}
+</nav>` },
  ] },
];

const DIFF_9F21: DiffFile[] = [
  { path: "src/workflow/schema.ts", hunks: [
    { old: 41, new: 41, body:
` const agentStep = baseStep.extend({
   type: z.literal("agent"),
   prompt: z.string(),
+  // 同じ role を持つ agent ステップ同士が1本の会話を共有する。省略時は暗黙の既定ロール
+  session: z.string().optional(),
   permissionMode: z.enum(["default", "acceptEdits", "bypassPermissions"]).optional(),
 });` },
  ] },
  { path: "src/db/migrations.ts", hunks: [
    { old: 0, new: 1, body:
`+export const m011_task_sessions: Migration = {
+  id: "011_task_sessions",
+  up: async (db) => {
+    await db.schema.createTable("task_sessions")
+      .addColumn("task_id", "text", (c) => c.notNull())
+      .addColumn("role", "text", (c) => c.notNull())
+      .addColumn("claude_session_id", "text", (c) => c.notNull())
+      .addPrimaryKeyConstraint("pk_task_sessions", ["task_id", "role"])
+      .execute();
+    // 既存の claude_session_id は役割「default」の行へ複写する（過去タスクの会話を失わないため）
+    await copyLegacySessions(db);
+  },
+};` },
  ] },
  { path: "src/db/queries.ts", hunks: [
    { old: 0, new: 1, body:
`+export async function getSessionId(db: Db, taskId: string, role: string): Promise<string | null> {
+  const row = await db.selectFrom("task_sessions")
+    .select("claude_session_id")
+    .where("task_id", "=", taskId).where("role", "=", role)
+    .executeTakeFirst();
+  return row?.claude_session_id ?? null;
+}
+
+export async function sessionUpsert(db: Db, taskId: string, role: string, sessionId: string) {
+  await db.insertInto("task_sessions")
+    .values({ task_id: taskId, role, claude_session_id: sessionId })
+    .onConflict((oc) => oc.columns(["task_id", "role"]).doUpdateSet({ claude_session_id: sessionId }))
+    .execute();
+}` },
  ] },
  { path: "src/core/engine.ts", hunks: [
    { old: 118, new: 121, body:
` async function runAgentStep(ctx: Ctx, task: Task, step: AgentStep) {
-  const sessionId = task.claude_session_id ?? null;
+  const role = step.session ?? "default";
+  const sessionId = await getSessionId(ctx.db, task.id, role);
   const result = await runClaude(step.prompt, {
     resume: sessionId,
     permissionMode: step.permissionMode ?? "default",
   });
-  await updateTask(ctx.db, task.id, { claude_session_id: result.session_id });
+  await sessionUpsert(ctx.db, task.id, role, result.session_id);
   return result;
 }` },
  ] },
  { path: "test/core/engine.test.ts", hunks: [
    { old: 60, new: 60, body:
`+test("agent ステップは role 単位でセッションを共有する", async () => {
+  const { ctx, task } = await setupGuidedTask();
+  await runAgentStep(ctx, task, { ...planStep, session: "planner" });
+  await runAgentStep(ctx, task, { ...implementStep, session: "implementer" });
+  const resumed = await runAgentStep(ctx, task, { ...planStep, session: "planner" });
+  assert.equal(resumed.resumedSessionId, await getSessionId(ctx.db, task.id, "planner"));
+});
+
+test("session 省略時は暗黙の既定ロールを使う", async () => {
+  const { ctx, task } = await setupGuidedTask();
+  await runAgentStep(ctx, task, implementStepNoSession);
+  assert.ok(await getSessionId(ctx.db, task.id, "default"));
+});` },
  ] },
  { path: "test/db/migrations.test.ts", hunks: [
    { old: 40, new: 40, body:
`+test("011_task_sessions は既存の claude_session_id を default ロールへ複写する", async () => {
+  const db = await freshDbAtMigration(10);
+  await db.updateTable("tasks").set({ claude_session_id: "sess-abc" }).where("id", "=", "t1").execute();
+  await runMigration(db, m011_task_sessions);
+  const row = await db.selectFrom("task_sessions").selectAll()
+    .where("task_id", "=", "t1").where("role", "=", "default").executeTakeFirst();
+  assert.equal(row?.claude_session_id, "sess-abc");
+});` },
  ] },
];

const GUIDE_9F21: Guide = {
  why: "差し戻しのたびに implement ステップの会話が単一の暗黙ロールに閉じていたため、plan ステップで積んだ文脈と implement ステップの文脈が同じ会話に混ざっていた。role ごとにセッションを分け、差し戻された agent ステップに戻ったとき、その役割の会話だけを --resume できるようにする。",
  what: [
    { path: "src/workflow/schema.ts", desc: "agent ステップに任意の session（役割名）を追加" },
    { path: "src/db/migrations.ts", desc: "task_sessions テーブルを追加し、既存の claude_session_id を default ロールへ複写" },
    { path: "src/db/queries.ts", desc: "getSessionId / sessionUpsert を新設" },
    { path: "src/core/engine.ts", desc: "agent ステップの実行前後で、セッションを role 単位に解決・保存するよう変更" },
    { path: "test/core/engine.test.ts", desc: "role 単位の resume と、省略時の既定ロールを確認" },
    { path: "test/db/migrations.test.ts", desc: "既存セッションの複写を確認" },
  ],
  sequence: {
    actors: ["差し戻し", "Engine", "task_sessions", "Claude CLI"],
    messages: [
      { from: "差し戻し", to: "Engine", label: "onReject.goto: implement" },
      { from: "Engine", to: "task_sessions", label: 'getSessionId(taskId, "implementer")' },
      { from: "task_sessions", to: "Engine", label: "claude_session_id | null" },
      { from: "Engine", to: "Claude CLI", label: "--resume <id>（無ければ新規）" },
      { from: "Claude CLI", to: "Engine", label: "session_id" },
      { from: "Engine", to: "task_sessions", label: "sessionUpsert(...)" },
    ],
  },
  readingOrder: [
    { title: "入力側: ワークフローに role を足す", paths: ["src/workflow/schema.ts"], diagram: null,
      explain: "まず入口から。agent ステップに任意の文字列 session を足しただけの変更です。省略すると暗黙の既定ロール default を使うので、既存のワークフロー定義は無変更のまま動きます。" },
    { title: "保存先: task_sessions テーブルと移行", paths: ["src/db/migrations.ts"], diagram: "relation",
      explain: "role ごとにセッションIDを持つため、(task_id, role) を主キーにしたテーブルを新設します。これまで tasks.claude_session_id に1本だけ持っていた値は、default ロールの行へ複写して過去の会話を失わないようにしています。" },
    { title: "中心: セッションの読み書きと、その呼び出し", paths: ["src/db/queries.ts", "src/core/engine.ts"], diagram: "sequence",
      explain: "今回の変更の心臓部で、2つのファイルを続けて読みます。まず queries.ts で role 単位にセッションIDを引く getSessionId と、保存する sessionUpsert を確認し、次に engine.ts の runAgentStep がそれを実行の前後で呼んでいることを確認します。差し戻し（onReject.goto）で同じ role の agent ステップに戻ると、下の流れで同じ会話が --resume されます。" },
    { title: "振る舞いの確認: テスト", paths: ["test/core/engine.test.ts"], diagram: null,
      explain: "role 単位で resume されること、省略時は既定ロールを使うことの2点をテストしています。" },
  ],
  decisions: [
    { title: "session を省略した agent ステップは暗黙の既定ロールを共有する", body: "既存のワークフロー（今までどおり「タスクに会話は1本」）を壊さないため" },
    { title: "セッションの保存は実行後に行う", body: "実行中にデーモンが落ちても、直前の resume 可能な状態を上書きしない" },
    { title: "task_sessions の主キーは (task_id, role)", body: "同じ role の2つ目の agent ステップに来ても同じ会話を拾える" },
  ],
  risks: [
    "同じ role に全く違う目的のステップを割り当てると、意図せず古い文脈を引き継ぐ。role を適切に分けるのはワークフローの書き手の責任",
    "マイグレーションで複写に失敗した行は resume できず新規セッションになる（実害は文脈が失われるだけで、実行自体は止まらない）",
  ],
  tests: [
    { behavior: "差し戻し後に同じ role へ戻ると同一セッションで resume される", test: "engine.test.ts > role単位でセッションを共有する" },
    { behavior: "session 省略時は暗黙の既定ロールを使う", test: "engine.test.ts > 省略時は既定ロール" },
    { behavior: "移行後、既存の claude_session_id が default ロールへ複写される", test: "migrations.test.ts > 011が複写する" },
  ],
};

const PLAN_MD = `# 計画: Review Guide の保存形式
## 目的
③ のレビュー画面が読む Review Guide を、エージェントが worktree に書き出す形式を決める。
## 変更対象
- \`.doctrine-out/guide.json\` を新設し、スキーマを zod で定義する
- \`src/workflow/schema.ts\` は変えない（doctrine はガイドの中身を理解しない）
## 方針
1. Why / What / How / Reading Order / Key Decisions / Risks / Tests の7節を持つ JSON にする
2. Reading Order の各項目に \`path\` と \`lines\` を持たせ、diff と機械的に照合できるようにする
3. Markdown ではなく JSON にする。照合に構造が要るため
## リスク
- エージェントが JSON を壊すと表示できない。検証に失敗したら生の文字列をそのまま出す
## テスト方針
- 7節のどれかが欠けた JSON を検証が落とすこと
- Reading Order に diff に無いパスが入っていたら警告になること`;

const LOG_TEST_FAIL = `$ deno task test
running 41 tests from ./test/daemon/handlers.test.ts
  daemon.warning は後始末の失敗を1回だけ送る ... FAILED (9ms)

error: AssertionError: Expected values to be strictly equal:
  + actual - expected
  + 2
  - 1
    at test/daemon/handlers.test.ts:512:12
FAILED | 40 passed | 1 failed (7s)
exit 1`;
const LOG_DEGRADED = `tool_use Edit src/order/time.ts (+12 −4)
tool_use Bash "git commit -m 'fix: 注文日時を UTC で保存する'"
permission_denied: Bash(git commit) は permissionMode=acceptEdits で許可されていません
assistant: コミットできなかったため、変更はワーキングツリーに残しています
{"type":"result","subtype":"success","permission_denials":1}
[test] $ deno task test
[test] ok | 88 passed | 0 failed (5s)`;
const LOG_RUNNING = `{"type":"system","subtype":"init","session_id":"4be1…"}
assistant: src/daemon/protocol.ts の ServerEvent に task.cleanedUp を足します
tool_use Read src/daemon/protocol.ts
tool_use Edit src/daemon/protocol.ts (+2 −0)
tool_use Read src/daemon/handlers.ts`;
export const FOLLOW_POOL = [
  "assistant: cleanupAfterRun の戻り値に outcome を持たせます",
  "tool_use Edit src/core/engine.ts (+14 −3)",
  "tool_use Bash \"deno test test/core/engine.test.ts\"",
  "ok | 31 passed | 0 failed (3s)",
  "assistant: 承認経路（task.approve）でも同じイベントを送ります",
  "tool_use Edit src/daemon/handlers.ts (+6 −1)",
];

// 状態は doctrine の7状態。degraded / refused はフラグ
type Seed = Omit<Task, "project" | "prompt" | "branch" | "worktree" | "diff" | "reviews"> & Partial<Pick<Task, "diff" | "reviews">>;

const SEEDS: Seed[] = [
  { id: "t-9f21", wf: "doctrine/guided", title: "ステップの再開をロール単位のセッションに切り替える", state: "suspended", step: "human-review", attempt: 1, prio: 1, since: NOW - 8 * MIN, diff: DIFF_9F21, guide: GUIDE_9F21, reviews: [],
    lastCommand: null,
    lastAgentMessage: "role ごとの task_sessions テーブルを追加し、agent ステップ実行の前後で getSessionId / sessionUpsert を呼ぶように変更しました。既存タスクの claude_session_id は default ロールへ複写するマイグレーションも足しています。テストは通っています。" },
  { id: "t-2b91", wf: "doctrine/feature", title: "worktree.list をディスク上の全件にする", state: "suspended", step: "review", attempt: 1, prio: 2, since: NOW - 42 * MIN, diff: DIFF_2B91, reviews: [],
    lastCommand: { step: "test", exitCode: 0, stdout: "running 41 tests from ./test/daemon/handlers.test.ts\nok | 41 passed | 0 failed (6s)", stderr: "" },
    lastAgentMessage: "worktree.list を、孤児だけでなく管理下の全 worktree を返すように書き換えました。task_id / task_state を突き合わせ、age_basis はタスクがあれば終了時刻、孤児ならディレクトリの mtime を使うようにしています。テストは41件とも通っています。" },
  { id: "s-1103", wf: "shop-api/feature", title: "在庫引当のリトライを冪等にする", state: "suspended", step: "review", attempt: 2, prio: 1, since: NOW - 15 * MIN, diff: DIFF_1103,
    reviews: [{ at: NOW - 140 * MIN, comment: "src/stock/reserve.ts:36\n  > return await tx.insert(\"reservations\", { key, orderId, items });\n  同時に2つ走ると一意制約違反で落ちます。既存の行として扱ってください\n\n全体: 同時実行のテストも足してください" }],
    lastCommand: { step: "test", exitCode: 0, stdout: "running 12 tests from ./test/stock/reserve.test.ts\nok | 12 passed | 0 failed (2s)", stderr: "" },
    lastAgentMessage: "ご指摘の一意制約違反を、トランザクション内で find してから insert し、失敗時は find し直す形に直しました。同時実行のテストも2本追加しています。" },
  { id: "t-a1b2", wf: "doctrine/guided", title: "Review Guide の保存形式を試す", state: "suspended", step: "plan-approval", attempt: 1, prio: 2, since: NOW - 130 * MIN, diff: [], reviewFiles: [
      { path: ".doctrine-out/plan.md", status: "ok", content: PLAN_MD, size: PLAN_MD.length },
    ], reviews: [],
    lastCommand: null,
    lastAgentMessage: "Review Guide の保存形式について JSON 案と Markdown 案を比較し、diff との機械照合のしやすさから JSON を選ぶ計画を .doctrine-out/plan.md に書きました。まだ実装はしていません。" },
  { id: "b-204", wf: "blog/feature", title: "記事一覧にページネーションを付ける", state: "suspended", step: "review", attempt: 1, prio: 3, since: NOW - 60 * 26 * MIN, diff: DIFF_B204, reviews: [],
    lastCommand: { step: "build", exitCode: 0, stdout: "$ astro build\n12 page(s) built in 1.8s", stderr: "" },
    lastAgentMessage: "index.astro にページングを追加し、Pager コンポーネントを新設しました。1ページ10件です。" },

  { id: "t-e812", wf: "doctrine/feature", title: "daemon.warning イベントを追加する", state: "failed", step: "test", attempt: 3, prio: 2, since: NOW - 60 * 26 * MIN, log: LOG_TEST_FAIL, dirty: true },
  { id: "t-3cd2", wf: "doctrine/feature", title: "gc の確認文言を直す", state: "completed", step: "open-pr", attempt: 1, prio: 2, since: NOW - 95 * MIN, refused: true, dirty: true, log: "$ gh pr create --fill\nhttps://github.com/todokr/doctrine/pull/31\nexit 0" },
  { id: "s-1202", wf: "shop-api/hotfix", title: "注文日時のタイムゾーンずれ", state: "running", step: "test", attempt: 1, prio: 0, since: NOW - 23 * MIN, degraded: "fix", log: LOG_DEGRADED },

  { id: "t-7f3a", wf: "doctrine/feature", title: "task.cleanedUp イベントを追加する", state: "running", step: "implement", attempt: 1, prio: 1, since: NOW - 11 * MIN, log: LOG_RUNNING },
  { id: "t-c04d", wf: "doctrine/feature", title: "workflow.list にステップを載せる", state: "running", step: "implement", attempt: 2, prio: 2, since: NOW - 134 * MIN, log: "[test #1] FAILED | 1 failed\nassistant: テストの失敗を受けて setupStep の挿入位置を直します\ntool_use Edit src/workflow/project.ts (+5 −2)" },
  { id: "s-1102", wf: "shop-api/feature", title: "注文 API にカーソルページングを入れる", state: "running", step: "lint", attempt: 1, prio: 2, since: NOW - 48 * MIN, log: "$ deno lint\nChecked 214 files" },

  { id: "s-1104", wf: "shop-api/feature", title: "価格改定バッチの分割実行", state: "queued", step: null, attempt: 0, prio: 0, since: NOW - 4 * MIN },
  { id: "t-91e0", wf: "doctrine/feature", title: "ログ追従を1接続1タスクに上書きする", state: "queued", step: null, attempt: 0, prio: 2, since: NOW - 25 * MIN },

  { id: "t-d5e6", wf: "doctrine/guided", title: "step_outputs の全文保持を検討する", state: "paused", step: "plan", attempt: 1, prio: 2, since: NOW - 60 * 5 * MIN, log: "assistant: step_outputs の容量見積もりを出します\n(SIGTERM で一時停止)" },

  { id: "t-0a77", wf: "doctrine/feature", title: "README にデーモン起動手順を書く", state: "completed", step: "open-pr", attempt: 1, prio: 2, since: NOW - 60 * 3 * MIN, log: "exit 0" },
  { id: "s-1105", wf: "shop-api/feature", title: "決済 Webhook の署名検証", state: "canceled", step: "implement", attempt: 1, prio: 2, since: NOW - 60 * 24 * 9 * MIN, dirty: true, log: "(SIGTERM で中止)" },
  { id: "b-198", wf: "blog/feature", title: "OGP 画像を記事ごとに生成する", state: "completed", step: "deploy-preview", attempt: 1, prio: 2, since: NOW - 60 * 24 * 2 * MIN, log: "exit 0" },
];

export function seedTasks(): Task[] {
  return SEEDS.map((t) => {
    const project = t.wf.split("/")[0];
    const keepWorktree = t.state !== "queued" && (t.state !== "completed" || t.refused);
    return {
      ...t,
      project,
      diff: t.diff ?? [],
      reviews: t.reviews ?? [],
      prompt: `${t.title}。詳細は issue を参照してください。`,
      branch: `doctrine/${t.id}-${t.title.length}`,
      worktree: keepWorktree ? `~/.local/state/doctrine/worktrees/${project}/${t.id}` : null,
    };
  });
}
