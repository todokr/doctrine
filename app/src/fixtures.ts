// テスト用の標本。画面はこれを使わない（画面のデータはデーモンから来る）
import type { Project, Task, TaskDiff } from "./types";
import type {
  GithubIssue,
  IntakeDetail,
  IntakeSummary,
  ServerEvent,
  WorkflowDetail,
  WorkflowListEntry,
} from "../../shared/protocol.ts";
import type { Pfd } from "../../shared/intake/pfd.ts";
import type { PrFact, ProcessStatus } from "../../shared/intake/processStatus.ts";
import type { Answer, Assumption, AssumptionResponse, Question } from "../../shared/intake/question.ts";
import examplePatch from "../../shared/guide/examples/step-artifacts.patch?raw";

export const NOW = Date.parse("2026-09-15T15:00:00+09:00");
export const MIN = 60000;
export const PROJECTS: Project[] = [
  { id: "doctrine", daemonId: 1, color: "#2E6CA4", path: "~/git/doctrine", def: "feature" },
  { id: "shop-api", daemonId: 2, color: "#AA3A2C", path: "~/work/shop-api", def: "feature" },
  { id: "blog", daemonId: 3, color: "#296B49", path: "~/git/blog", def: "feature" },
];

// 状態は doctrine の7状態。refused はフラグ。
// worktree は seedTasks が state から決めるので、dctl gc で消した後の姿は gced で指定する
type Seed = Omit<Task, "project" | "prompt" | "branch" | "worktree" | "intake"> & { gced?: true };

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
      intake: null,
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

/** PFD の図の標本。成果物 7・プロセス 5。given・goal・決定・人のプロセス・並列の段を含む */
export const PFD_SAMPLE: Pfd = {
  title: "注文の CSV 出力",
  goal: ["release"],
  artifacts: [
    { id: "issue", name: "Issue", given: true, verify: "Issue の本文が読める" },
    { id: "policy", name: "出力方針", given: true, decision: "q1", verify: "方針が回答に残っている" },
    { id: "schema", name: "CSV スキーマ", given: false, verify: "列の一覧が docs にある" },
    { id: "api", name: "出力 API", given: false, verify: "API のテストが通る" },
    { id: "ui", name: "出力ボタン", given: false, verify: "ボタンを押すと CSV が落ちる" },
    { id: "review", name: "受け入れ確認", given: false, verify: "確認のメモが残っている" },
    { id: "release", name: "リリース", given: false, verify: "本番で CSV が落ちる" },
  ],
  processes: [
    { id: "design", name: "スキーマを設計する", actor: "agent", inputs: ["issue", "policy"], outputs: ["schema"], purpose: "CSV の列を決める" },
    { id: "build-api", name: "API を作る", actor: "agent", inputs: ["schema"], outputs: ["api"], purpose: "CSV を返す API を作る" },
    { id: "build-ui", name: "ボタンを作る", actor: "agent", inputs: ["schema"], outputs: ["ui"], purpose: "画面にボタンを置く" },
    { id: "approve", name: "受け入れる", actor: "human", inputs: ["api", "ui"], outputs: ["review"] },
    { id: "ship", name: "リリースする", actor: "agent", inputs: ["review"], outputs: ["release"], purpose: "本番に出す" },
  ],
};

/** ラベルの長い PFD の標本（#62 の 1 回目の案を縮めたもの）。折り返しと、作り手の無い成果物の列の寄せを確かめる */
export const PFD_LONG_LABELS: Pfd = {
  title: "日常運用の操作をアプリに揃える",
  goal: ["view", "settings-ui"],
  artifacts: [
    { id: "rpc", name: "既存の RPC（task.pause / task.resume / task.logs / daemon.warnings、core/src/domain/worktree.ts、states.ts）", given: true },
    { id: "cli", name: "既存の dctl CLI（core/src/cli/dctl.ts）", given: true },
    { id: "app", name: "既存のアプリ（app/src のタスク画面・サイドバー・store、app/src-tauri の lib.rs）", given: true },
    { id: "d-launch", name: "外部コマンドを起動する場所の決定", given: true, decision: "q1", verify: "回答に残っている" },
    { id: "d-resume", name: "アプリの再開ボタンを出す状態の決定", given: true, decision: "q2", verify: "回答に残っている" },
    { id: "list", name: "全件を返す worktree.list", given: false, verify: "テストが通る" },
    { id: "follow", name: "dctl logs --follow のストリーミング表示", given: false, verify: "テストが通る" },
    { id: "tauri", name: "設定の読み書きと外部コマンド起動の Tauri コマンド", given: false, verify: "テストが通る" },
    { id: "view", name: "worktree と警告のビュー", given: false, verify: "画面のテストが通る" },
    { id: "settings-ui", name: "設定の画面", given: false, verify: "画面のテストが通る" },
  ],
  processes: [
    { id: "1", name: "worktree.list を全件を返す形に変える", actor: "agent", inputs: ["rpc"], outputs: ["list"], purpose: "p" },
    { id: "2", name: "dctl logs --follow をストリーミング表示にする", actor: "agent", inputs: ["cli", "rpc"], outputs: ["follow"], purpose: "p" },
    { id: "3", name: "設定の読み書きと外部コマンド起動の Tauri コマンドを足す", actor: "agent", inputs: ["app", "d-launch"], outputs: ["tauri"], purpose: "p" },
    { id: "4", name: "worktree と警告のビューを作る", actor: "agent", inputs: ["list", "app", "d-resume"], outputs: ["view"], purpose: "p" },
    { id: "5", name: "設定の画面を作る", actor: "agent", inputs: ["tauri"], outputs: ["settings-ui"], purpose: "p" },
  ],
};

const PFD_PR: PrFact = {
  number: 42,
  url: "https://github.com/todokr/doctrine/pull/42",
  state: "OPEN",
  baseRef: "develop",
  mergedAt: null,
  mergeCommit: null,
};

/** 状態の標本 2 組。A と B を合わせて 8 状態がすべて出る。見た目を確かめるための組で、実際に起きる遷移の組ではない */
export const PFD_STATUSES_A: Record<string, ProcessStatus> = {
  design: { state: "merged", taskId: "t1", pr: { ...PFD_PR, number: 41, state: "MERGED", mergedAt: "2026-09-15T10:00:00+09:00", mergeCommit: "abc1234" } },
  "build-api": { state: "pr_open", taskId: "t2", pr: PFD_PR },
  "build-ui": { state: "running", taskId: "t3" },
  approve: { state: "done", note: "確認した", at: "2026-09-15T14:00:00+09:00" },
  ship: { state: "waiting", missing: ["review"] },
};

export const PFD_STATUSES_B: Record<string, ProcessStatus> = {
  design: { state: "needs_attention", taskId: "t1", reason: "task_stopped" },
  "build-api": { state: "ready", blockedBy: null },
  "build-ui": { state: "waiting", missing: ["schema"] },
  approve: { state: "your_turn" },
  ship: { state: "waiting", missing: ["review"] },
};

/** 質問の面の標本。3 種の質問と 4 種の判断材料をすべて含む */
export const QUESTIONS: Question[] = [
  {
    id: "q1",
    prompt: "書き込みをどう扱うか",
    kind: "single",
    options: [
      { id: "a", label: "同期", description: "呼び出しの中で書く" },
      { id: "b", label: "非同期", description: "キューに積む" },
    ],
    materials: [
      { kind: "text", body: "現状は **同期** で書き込んでいる" },
      {
        kind: "table",
        caption: "案の比較",
        columns: ["案", "利点", "欠点"],
        rows: [["a", "単純", "遅い"], ["b", "速い", "複雑"]],
      },
      {
        kind: "code",
        caption: "いまの書き込み",
        language: "ts",
        path: "core/src/x.ts",
        code: "await write(x);",
      },
    ],
  },
  {
    id: "q2",
    prompt: "対象にするものを選ぶ",
    kind: "multiple",
    options: [
      { id: "a", label: "A", description: "説明 A" },
      { id: "b", label: "B", description: "説明 B" },
      { id: "c", label: "C", description: "説明 C" },
    ],
    materials: [{
      kind: "diagram",
      caption: "状態",
      diagram: {
        id: "g2",
        title: "状態遷移",
        body: {
          shape: "graph",
          kind: "state",
          nodes: [{ id: "n1", label: "開始" }, { id: "n2", label: "終了" }],
          edges: [{ from: "n1", to: "n2", label: "完了" }],
        },
      },
    }],
  },
  {
    id: "q3",
    prompt: "ほかに考慮すべきことは",
    kind: "free",
    options: [],
    materials: [],
  },
];

/** 仮定の標本。3 種の根拠をすべて含む */
export const ASSUMPTIONS: Assumption[] = [
  {
    id: "s1",
    statement: "書き込みは 1 秒に数回に収まる",
    evidence: [
      { kind: "issue", commentUrl: null, quote: "利用者は社内の数人" },
      { kind: "code", path: "core/src/x.ts", startLine: 10, endLine: 12, excerpt: "await write(x);" },
    ],
    impact: "書き込みのプロセスにキューが要るかが変わる",
  },
  {
    id: "s2",
    statement: "設定は既存の `settings.json` に足す",
    evidence: [{ kind: "convention", body: "設定はすべて `settings.json` にある" }],
    impact: "設定の読み込みのプロセスが増える",
  },
];

/** ASSUMPTIONS への応答。1 つは認め、1 つは書き直す */
export const RESPONSES: AssumptionResponse[] = [
  { assumptionId: "s1", verdict: "accepted" },
  { assumptionId: "s2", verdict: "corrected", correction: "設定は別のファイルに分ける" },
];

/** QUESTIONS へのそろった回答。その他と補足を含む */
export const ANSWERS: Answer[] = [
  { questionId: "q1", optionIds: ["a"], other: null, note: "移行は後で" },
  { questionId: "q2", optionIds: ["b"], other: "D も入れる", note: null },
  { questionId: "q3", optionIds: [], other: "ログの量", note: "急がない" },
];

const at = (minutesAgo: number) => new Date(NOW - minutesAgo * MIN).toISOString();

function intake(n: number, o: Partial<IntakeSummary>): IntakeSummary {
  return {
    id: `i${n}`,
    project_id: 1,
    issue_url: `https://github.com/o/r/issues/${n}`,
    issue_title: `Issue ${n} のタイトル`,
    state: "investigating",
    revising: false,
    attention_reason: null,
    dispatch_paused: false,
    rate_limited_until: null,
    progress: { done: 0, total: 0 },
    needs_human: false,
    watch: { lastSucceededAt: null, consecutiveFailures: 0, lastError: null },
    created_at: at(300),
    updated_at: at(5),
    ...o,
  };
}

/** 並びを確かめられるよう、区分や更新の順とは違う並びで持つ */
export const INTAKES: IntakeSummary[] = [
  intake(4, { state: "decomposing", project_id: 2, rate_limited_until: at(-40), updated_at: at(20) }),
  intake(6, { state: "canceled", project_id: 2, updated_at: at(100) }),
  intake(2, { state: "active", needs_human: true, project_id: 2, progress: { done: 1, total: 4 }, updated_at: at(10) }),
  intake(5, { state: "active", revising: true, progress: { done: 2, total: 5 }, updated_at: at(30) }),
  intake(1, { state: "reviewing", needs_human: true, updated_at: at(60) }),
  intake(7, { state: "completed", updated_at: at(200) }),
  intake(3, { state: "investigating", updated_at: at(5) }),
];

/** intake_id のあるもの（進行中の Intake の Issue）と無いもの */
export const GITHUB_ISSUES: GithubIssue[] = [
  {
    url: "https://github.com/o/r/issues/5",
    number: 5,
    title: "Issue 5 のタイトル",
    assignees: ["me"],
    updatedAt: at(30),
    intake_id: "i5",
  },
  {
    url: "https://github.com/o/r/issues/8",
    number: 8,
    title: "Issue 8 のタイトル",
    assignees: [],
    updatedAt: at(90),
    intake_id: null,
  },
];

/** ワークフローの定義の標本。.doctrine/workflows/default.yaml と同じ形の 10 ステップ。 */
export const WORKFLOW_DEFAULT = {
  name: "default",
  ok: true,
  warnings: ["open-pr: 再実行で二重に効くコマンドがあります"],
  steps: [
    {
      id: "plan",
      type: "agent",
      prompt: "計画を立ててください\n{{ task.prompt }}",
      session: "planner",
      model: "claude-opus-5",
      permissionMode: "acceptEdits",
      allowedTools: ["Bash(git diff:*)", "Bash(grep:*)"],
      branch: null,
    },
    {
      id: "plan-review",
      type: "agent",
      prompt: "計画をレビューしてください",
      session: "plan-reviewer",
      model: "claude-opus-5",
      permissionMode: null,
      allowedTools: null,
      branch: null,
    },
    {
      id: "plan-gate",
      type: "command",
      run: "grep -q '^verdict: approve' .doctrine-out/plan-review.md",
      branch: {
        goto: "plan",
        maxAttempts: 3,
        feed: "計画がレビューで却下された:\n{{ steps.plan-gate.last_stdout }}",
        implicit: false,
      },
    },
    {
      id: "implement",
      type: "agent",
      prompt: "計画に沿って実装してください",
      session: "implementer",
      model: "claude-sonnet-5",
      permissionMode: null,
      allowedTools: null,
      branch: null,
    },
    {
      id: "verify",
      type: "command",
      run: "mise run app:test",
      branch: {
        goto: "implement",
        maxAttempts: 3,
        feed: "テストが落ちた:\n{{ steps.verify.last_stdout }}",
        implicit: false,
      },
    },
    {
      id: "agent-review",
      type: "agent",
      prompt: "変更をレビューしてください",
      session: null,
      model: "claude-opus-5",
      permissionMode: null,
      allowedTools: null,
      branch: null,
    },
    {
      id: "review-gate",
      type: "command",
      run: "grep -q '^verdict: approve' .doctrine-out/agent-review.md",
      branch: { goto: "implement", maxAttempts: 3, feed: null, implicit: false },
    },
    {
      id: "guide",
      type: "guide",
      session: "guide",
      model: "claude-opus-5",
      permissionMode: "acceptEdits",
      allowedTools: ["Bash(git diff:*)"],
      branch: { goto: "guide", maxAttempts: 3, feed: "{{ steps.guide.last_stderr }}", implicit: true },
    },
    {
      id: "review",
      type: "approval",
      title: "変更を確認してください",
      reviewFiles: [".doctrine-out/review.md", ".doctrine-out/plan.md"],
      branch: { goto: "implement", maxAttempts: 5, feed: "差し戻されました:\n{{ steps.review.reason }}", implicit: false },
    },
    {
      id: "open-pr",
      type: "command",
      run: "git push -u origin HEAD",
      branch: null,
    },
  ],
} satisfies WorkflowDetail;

export const WORKFLOW_LIST: WorkflowListEntry[] = [
  { name: "broken", ok: false, issues: ["steps[1].goto: 存在しないステップ nowhere を指しています"] },
  { name: "default", ok: true },
  { name: "light", ok: true },
];

const INTAKE_1 = INTAKES.find((i) => i.id === "i1")!;

/** レビュー待ち。案は 2 回目（1 回目の案へのコメント 1 件と、その返答を持つ）。質問は回答済みの 1 件 */
export const INTAKE_REVIEWING: IntakeDetail = {
  ...INTAKE_1,
  state: "reviewing",
  drafts: [
    { id: 11, seq: 1, created_at: at(150) },
    { id: 12, seq: 2, created_at: at(60) },
  ],
  latest_draft: {
    id: 12,
    seq: 2,
    pfd: PFD_SAMPLE,
    hash: "hash-of-draft-12",
    replies: [{ commentId: 7, reply: "列を減らしました" }],
    created_at: at(60),
  },
  approval: null,
  question_sets: [{
    id: 1,
    run_id: 1,
    questions: QUESTIONS,
    assumptions: ASSUMPTIONS,
    reply: { answers: ANSWERS, assumptionResponses: RESPONSES },
    created_at: at(200),
    answered_at: at(180),
  }],
  comments: [{
    id: 7,
    draft_id: 11,
    target_kind: "process",
    target_id: "design",
    body: "列が多すぎる",
    created_at: at(100),
  }],
  processes: [],
  runs: [],
};

/** 進行中。承認済みの案は 12（latest_draft と同じ）。PFD_STATUSES_B の状態で、あなたの番と要確認を 1 つずつ持つ */
export const INTAKE_ACTIVE: IntakeDetail = {
  ...INTAKE_REVIEWING,
  state: "active",
  needs_human: true,
  progress: { done: 0, total: 5 },
  approval: { id: 1, draft_id: 12, hash: "hash-of-draft-12", approved_at: at(50) },
  processes: Object.entries(PFD_STATUSES_B).map(([id, status], i) => ({
    id,
    ...status,
    sub_issue_url: `https://github.com/o/r/issues/10${i}`,
    task_ids: id === "design" ? ["t-old", "t1"] : [],
  })),
};

/** 回答待ち。回答済みの質問のまとまり 1 件と、未回答のまとまり 1 件 */
export const INTAKE_ANSWERING: IntakeDetail = {
  ...INTAKE_1,
  state: "answering",
  drafts: [],
  latest_draft: null,
  approval: null,
  question_sets: [
    {
      id: 1,
      run_id: 1,
      questions: QUESTIONS,
      assumptions: ASSUMPTIONS,
      reply: { answers: ANSWERS, assumptionResponses: RESPONSES },
      created_at: at(200),
      answered_at: at(180),
    },
    {
      id: 2,
      run_id: 2,
      questions: QUESTIONS.slice(0, 1),
      assumptions: ASSUMPTIONS.slice(0, 1).map((a) => ({ ...a, id: "s3" })),
      reply: null,
      created_at: at(20),
      answered_at: null,
    },
  ],
  comments: [],
  processes: [],
  runs: [],
};
