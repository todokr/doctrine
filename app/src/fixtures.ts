// テスト用の標本。画面はこれを使わない（画面のデータはデーモンから来る）
import type { Guide, Project, StepDef, Task, TaskDiff } from "./types";
import type { ServerEvent } from "../../shared/protocol.ts";

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


// 状態は doctrine の7状態。degraded / refused はフラグ。
// worktree は seedTasks が state から決めるので、dctl gc で消した後の姿は gced で指定する
type Seed = Omit<Task, "project" | "prompt" | "branch" | "worktree"> & { gced?: true };

const SEEDS: Seed[] = [
  { id: "t-9f21", wf: "doctrine/guided", title: "ステップの再開をロール単位のセッションに切り替える", state: "suspended", step: "human-review", attempt: 1, prio: 1, since: NOW - 8 * MIN, guide: GUIDE_9F21 },
  { id: "t-2b91", wf: "doctrine/feature", title: "worktree.list をディスク上の全件にする", state: "suspended", step: "review", attempt: 1, prio: 2, since: NOW - 42 * MIN },
  { id: "s-1103", wf: "shop-api/feature", title: "在庫引当のリトライを冪等にする", state: "suspended", step: "review", attempt: 2, prio: 1, since: NOW - 15 * MIN },
  { id: "t-a1b2", wf: "doctrine/guided", title: "Review Guide の保存形式を試す", state: "suspended", step: "plan-approval", attempt: 1, prio: 2, since: NOW - 130 * MIN },
  { id: "b-204", wf: "blog/feature", title: "記事一覧にページネーションを付ける", state: "suspended", step: "review", attempt: 1, prio: 3, since: NOW - 60 * 26 * MIN },
  { id: "t-e812", wf: "doctrine/feature", title: "daemon.warning イベントを追加する", state: "failed", step: "test", attempt: 3, prio: 2, since: NOW - 60 * 26 * MIN, dirty: true },
  { id: "t-6ba3", wf: "doctrine/feature", title: "ratelimit のサンプルを日次で丸める", state: "failed", step: "test", attempt: 1, prio: 2, since: NOW - 60 * 24 * 12 * MIN, gced: true },
  { id: "t-3cd2", wf: "doctrine/feature", title: "gc の確認文言を直す", state: "completed", step: "open-pr", attempt: 1, prio: 2, since: NOW - 95 * MIN, refused: true, dirty: true },
  { id: "s-1202", wf: "shop-api/hotfix", title: "注文日時のタイムゾーンずれ", state: "running", step: "test", attempt: 1, prio: 0, since: NOW - 23 * MIN, degraded: "fix" },

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

/** 飽和が近い状態。7日枠だけが警告に入る（5時間枠は 0.80 でも待てば明ける）。 */
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
