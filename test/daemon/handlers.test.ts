import { test, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/db/migrate.ts";
import { getTask } from "../../src/db/tasks.ts";
import { listStepRuns } from "../../src/db/stepRuns.ts";
import { createHandler, tick, type DaemonContext } from "../../src/daemon/handlers.ts";
import { createMockAdapter } from "../../src/adapter/mock.ts";
import type { ServerEvent } from "../../src/daemon/protocol.ts";
import { until, makeRepo } from "../helpers/repo.ts";

const run = promisify(execFile);
let root: string;
let repo: string;

const NOOP_CONN = { follow() {}, unfollow() {}, isFollowing: () => false };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "doctrine-daemon-"));
  repo = await makeRepo(root, {
    "README.md": "x\n",
    ".doctrine/project.yaml": "defaultWorkflow: feature\nmaxConcurrent: 1\nbaseBranch: main\n",
    ".doctrine/workflows/feature.yaml":
      "name: feature\nsteps:\n  - id: review\n    type: approval\n    title: 見て\n",
  });
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
      return parseWorkflow(await readFile(join(projectPath, ".doctrine", "workflows", `${name}.yaml`), "utf8"));
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

test("非冪等コマンドを含むワークフローは task.create の応答と ctx.warnings の両方に警告が乗る", async () => {
  const ctx = context();
  const h = createHandler(ctx);
  await writeFile(
    join(repo, ".doctrine", "workflows", "risky.yaml"),
    "name: risky\nsteps:\n  - id: open-pr\n    type: command\n    run: gh pr create --fill\n",
  );
  await h("project.add", { path: repo }, NOOP_CONN);
  const created = await h(
    "task.create", { project: repo, title: "T", prompt: "p", workflow: "risky" }, NOOP_CONN,
  ) as { warnings: string[] };
  assert.equal(created.warnings.length, 1, "レスポンスに警告が乗る（ユーザーの目の前に出る）");
  assert.match(created.warnings[0], /gh pr create/);
  assert.equal(ctx.warnings.length, 1, "デーモンのstderr相当（ctx.warnings）にも記録される");
  assert.match(ctx.warnings[0], /gh pr create/);
});

test("冪等なワークフローは task.create で警告を出さない", async () => {
  const ctx = context();
  const h = createHandler(ctx);
  await h("project.add", { path: repo }, NOOP_CONN);
  const created = await h(
    "task.create", { project: repo, title: "T", prompt: "p" }, NOOP_CONN,
  ) as { warnings: string[] };
  assert.deepEqual(created.warnings, []);
  assert.equal(ctx.warnings.length, 0);
});

test("tick は非冪等コマンドの警告を毎周期 ctx.warnings に積み直さない", async () => {
  const events: ServerEvent[] = [];
  const ctx = context(events);
  const h = createHandler(ctx);
  // git push を使う（gh pr create と違い、remote未設定のこのテスト用リポジトリでは
  // ネットワークに触らずすぐ失敗する。tick が実際にステップを実行しても安全）。
  await writeFile(
    join(repo, ".doctrine", "workflows", "risky.yaml"),
    "name: risky\nsteps:\n  - id: push\n    type: command\n    run: git push\n",
  );
  await h("project.add", { path: repo }, NOOP_CONN);
  await h("task.create", { project: repo, title: "T", prompt: "p", workflow: "risky" }, NOOP_CONN);
  ctx.warnings.length = 0; // task.create 自身が積んだ分をリセットし、tick 由来だけを見る

  await tick(ctx);
  await until(() => ctx.running.size === 0);
  await tick(ctx);
  await tick(ctx);

  assert.deepEqual(
    ctx.warnings, [],
    "tick が同じワークフローを毎回読み込んでも、作成時に一度出た警告を再び積まない",
  );
});

test("却下ループを何度回しても task.approve/task.reject は警告を積み直さない", async () => {
  const ctx = context();
  const h = createHandler(ctx);
  // review を却下すると noop に戻り、また review に戻ってくるループ。
  // push は非冪等（git push）なので task.create の時点で1件だけ警告が出る。
  // このワークフロー自体は却下ループ中は一度も push まで到達しない。
  await writeFile(
    join(repo, ".doctrine", "workflows", "risky-loop.yaml"),
    "name: risky-loop\nsteps:\n"
      + "  - id: noop\n    type: command\n    run: \"true\"\n"
      + "  - id: review\n    type: approval\n    title: 見て\n"
      + "    onReject:\n      goto: noop\n      maxAttempts: 5\n"
      + "  - id: push\n    type: command\n    run: git push\n",
  );
  await h("project.add", { path: repo }, NOOP_CONN);
  const t = await h(
    "task.create", { project: repo, title: "T", prompt: "p", workflow: "risky-loop" }, NOOP_CONN,
  ) as { id: string; warnings: string[] };
  assert.equal(t.warnings.length, 1, "作成時に push ステップの警告が1件出る");
  const afterCreate = ctx.warnings.length;
  assert.equal(afterCreate, 1);

  // review へ到達するまで進める
  await tick(ctx);
  await until(() => getTask(ctx.db, t.id)?.state === "suspended");

  // 却下を3回繰り返す（review -> noop -> review のループ）。
  for (let i = 0; i < 3; i++) {
    await h("task.reject", { task_id: t.id, comment: `だめ${i}` }, NOOP_CONN);
    assert.equal(getTask(ctx.db, t.id)?.state, "queued");
    await tick(ctx);
    await until(() => getTask(ctx.db, t.id)?.state === "suspended");
  }

  assert.equal(
    ctx.warnings.length, afterCreate,
    "却下ループ中、task.reject も tick も同じワークフローを読み直すが ctx.warnings は増えない",
  );

  // 最後に承認して push まで進める（push 自体は失敗してよい。ここでの関心は
  // task.approve が warnings を積まないことだけ）。
  await h("task.approve", { task_id: t.id }, NOOP_CONN);
  await tick(ctx);
  await until(() => ctx.running.size === 0);

  assert.equal(
    ctx.warnings.length, afterCreate,
    "task.approve も同じワークフローを読み直すが ctx.warnings を増やさない",
  );
});

test("tick で枠を取り、worktree を作って approval まで進む", async () => {
  const events: ServerEvent[] = [];
  const ctx = context(events);
  const h = createHandler(ctx);
  await h("project.add", { path: repo }, NOOP_CONN);
  const t = await h("task.create", { project: repo, title: "T", prompt: "p" }, NOOP_CONN) as { id: string };
  await tick(ctx);
  await until(() => ctx.running.size === 0);
  const row = getTask(ctx.db, t.id)!;
  assert.equal(row.state, "suspended");
  assert.ok(row.worktree_path, "枠が取れた瞬間に worktree ができている");
  assert.ok(events.some((e) => e.event === "task.stateChanged"));
});

test("task.approve で queued に戻り、行列の先頭に入る", async () => {
  const ctx = context();
  const h = createHandler(ctx);
  await h("project.add", { path: repo }, NOOP_CONN);
  // approval の後にもステップがあるワークフロー。承認直後に completed になってしまう
  // 1ステップだけの workflow では「queued に戻る」経路を確認できない。
  await writeFile(join(repo, ".doctrine", "workflows", "twostep.yaml"),
    "name: twostep\nsteps:\n  - id: review\n    type: approval\n    title: 見て\n  - id: after\n    type: command\n    run: \"true\"\n");
  const t = await h("task.create", { project: repo, title: "T", prompt: "p", workflow: "twostep" }, NOOP_CONN) as { id: string };
  await tick(ctx);
  await until(() => ctx.running.size === 0);
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
  await until(() => ctx.running.size === 0);
  await assert.rejects(() => h("task.reject", { task_id: t.id }, NOOP_CONN));
});

test("task.cancel は canceled にして worktree を残す", async () => {
  const ctx = context();
  const h = createHandler(ctx);
  await h("project.add", { path: repo }, NOOP_CONN);
  const t = await h("task.create", { project: repo, title: "T", prompt: "p" }, NOOP_CONN) as { id: string };
  await tick(ctx);
  await until(() => ctx.running.size === 0);
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
  await until(() => ctx.running.size === 0);
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
  await until(() => ctx.running.size === 0);
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
  await until(() => ctx.running.size === 0);
  assert.ok(getTask(ctx.db, t.id)?.worktree_path);
});

test("tick 時点でワークフローが読めないタスクは failed になり、以後 tick で再試行されない", async () => {
  const ctx = context();
  const h = createHandler(ctx);
  await h("project.add", { path: repo }, NOOP_CONN);
  await writeFile(join(repo, ".doctrine", "workflows", "vanishing.yaml"),
    "name: vanishing\nsteps:\n  - id: a\n    type: command\n    run: \"true\"\n");
  const t = await h(
    "task.create", { project: repo, title: "T", prompt: "p", workflow: "vanishing" }, NOOP_CONN,
  ) as { id: string };
  // 作成時点では読めたワークフローが、tick までの間に壊れる/消える場合を再現する。
  await writeFile(join(repo, ".doctrine", "workflows", "vanishing.yaml"), "not: [valid");

  await tick(ctx);
  assert.equal(ctx.running.size, 0, "枠のガードは例外経路でも必ず解放される");
  assert.equal(getTask(ctx.db, t.id)?.state, "failed", "queued のまま残すと毎周期リトライし続ける");
  assert.ok(ctx.warnings.some((w) => /ワークフロー/.test(w)));

  // 2周目のtickでも再試行されず、他のタスクの進行を妨げない
  await tick(ctx);
  assert.equal(getTask(ctx.db, t.id)?.state, "failed");
});

test("runTask が例外を投げても daemon は落ちず、タスクは failed になる", async () => {
  const ctx = context();
  const h = createHandler(ctx);
  await h("project.add", { path: repo }, NOOP_CONN);
  // {{ steps.nope.stdout }} は存在しないステップの出力を参照する。
  // expand() はこれを意図的に例外として投げ、runTask はそれを握りつぶさず
  // 伝播させる（ワークフロー作者に見える形にするため）。
  await writeFile(join(repo, ".doctrine", "workflows", "brokenvar.yaml"),
    "name: brokenvar\nsteps:\n  - id: a\n    type: command\n    run: \"echo {{ steps.nope.stdout }}\"\n");
  const t = await h(
    "task.create", { project: repo, title: "T", prompt: "p", workflow: "brokenvar" }, NOOP_CONN,
  ) as { id: string };

  await tick(ctx);
  await until(() => getTask(ctx.db, t.id)?.state === "failed");
  await until(() => ctx.running.size === 0);
  assert.equal(getTask(ctx.db, t.id)?.state, "failed");
  assert.ok(ctx.warnings.some((w) => /例外/.test(w)));
});

test("stepRun.started の step_run_id は本物で、task.logs から引ける", async () => {
  const events: ServerEvent[] = [];
  const ctx = context(events);
  const h = createHandler(ctx);
  await h("project.add", { path: repo }, NOOP_CONN);
  await writeFile(join(repo, ".doctrine", "workflows", "quick.yaml"),
    "name: quick\nsteps:\n  - id: a\n    type: command\n    run: \"true\"\n");
  const t = await h(
    "task.create", { project: repo, title: "T", prompt: "p", workflow: "quick" }, NOOP_CONN,
  ) as { id: string };
  await tick(ctx);
  await until(() => getTask(ctx.db, t.id)?.state === "completed");
  await until(() => ctx.running.size === 0);

  const started = events.find((e) => e.event === "stepRun.started") as
    { event: "stepRun.started"; step_run_id: number } | undefined;
  assert.ok(started, "stepRun.started イベントが届いていない");
  assert.ok(started!.step_run_id > 0, "プレースホルダーの0であってはならない");

  const log = await h(
    "task.logs", { task_id: t.id, step_run_id: started!.step_run_id }, NOOP_CONN,
  ) as { log_path: string };
  assert.ok(log.log_path.length > 0, "届いた step_run_id で本物のログが引ける");
});

test("worktree 作成に失敗したタスクは failed になり、他プロジェクトの健全なタスクは同じ pass で進む", async () => {
  const ctx = context();
  const h = createHandler(ctx);

  // 壊れたプロジェクト: baseBranch が存在しないので `git worktree add` が失敗する。
  await writeFile(join(repo, ".doctrine", "project.yaml"),
    "defaultWorkflow: feature\nmaxConcurrent: 1\nbaseBranch: nonexistent-base\n");
  await h("project.add", { path: repo }, NOOP_CONN);
  const broken = await h(
    "task.create", { project: repo, title: "broken", prompt: "p" }, NOOP_CONN,
  ) as { id: string };

  // 健全な別プロジェクト: 同じ pass で普通に進めるはず。
  const healthyRoot = await mkdtemp(join(tmpdir(), "doctrine-daemon-healthy-"));
  const healthyRepo = await makeRepo(healthyRoot, {
    "README.md": "x\n",
    ".doctrine/project.yaml": "defaultWorkflow: feature\nmaxConcurrent: 1\nbaseBranch: main\n",
    ".doctrine/workflows/feature.yaml":
      "name: feature\nsteps:\n  - id: review\n    type: approval\n    title: 見て\n",
  });
  await h("project.add", { path: healthyRepo }, NOOP_CONN);
  const healthy = await h(
    "task.create", { project: healthyRepo, title: "healthy", prompt: "p" }, NOOP_CONN,
  ) as { id: string };

  try {
    await tick(ctx);
    await until(() => ctx.running.size === 0);
    assert.equal(getTask(ctx.db, broken.id)?.state, "failed",
      "作れないまま queued に残すと毎周期リトライされ続ける");
    assert.ok(ctx.warnings.some((w) => /実行を開始できませんでした/.test(w)));
    assert.equal(getTask(ctx.db, healthy.id)?.state, "suspended",
      "1タスクの不備が他プロジェクトのタスクの進行を妨げてはいけない");
  } finally {
    await rm(healthyRoot, { recursive: true, force: true });
  }
});

// --- 実行中の cancel / pause が runTask のループを止める -------------------

const TWO_AGENTS =
  "name: twoagents\nsteps:\n  - id: a\n    type: agent\n    prompt: \"p1\"\n" +
  "  - id: b\n    type: agent\n    prompt: \"p2\"\n";

/** agent ステップ a の実行中（まだ結果が返らない状態）まで進めたタスクを作る。 */
async function midFlight(ctx: DaemonContext, h: ReturnType<typeof createHandler>) {
  const adapter = createMockAdapter({ result: { ok: true, text: "done" }, delayMs: 300 });
  ctx.adapter = adapter;
  await writeFile(join(repo, ".doctrine", "workflows", "twoagents.yaml"), TWO_AGENTS);
  await h("project.add", { path: repo }, NOOP_CONN);
  const t = await h(
    "task.create", { project: repo, title: "T", prompt: "p", workflow: "twoagents" }, NOOP_CONN,
  ) as { id: string };
  await tick(ctx);
  // 最初のステップの running 行が立ち、子が動き出したところまで待つ。
  await until(() => listStepRuns(ctx.db, t.id).length === 1, 5000, "ステップ a の開始");
  return { taskId: t.id, adapter };
}

test("実行中に cancel されたら runTask は次のステップを始めない", async () => {
  const ctx = context();
  const h = createHandler(ctx);
  const { taskId, adapter } = await midFlight(ctx, h);

  await h("task.cancel", { task_id: taskId }, NOOP_CONN);
  const runsAtCancel = listStepRuns(ctx.db, taskId).length;
  await until(() => ctx.running.size === 0, 5000, "runTask の終了");

  assert.equal(listStepRuns(ctx.db, taskId).length, runsAtCancel,
    "cancel 後に新しい step_runs 行を立ててはいけない");
  assert.equal(adapter.calls.length, 1, "cancel 後にアダプタを呼び直してはいけない");
  assert.equal(getTask(ctx.db, taskId)?.state, "canceled",
    "状態を書いたのは handler 側であり、エンジンが上書きしてはいけない");
});

test("実行中に pause されたら runTask は current_step_id を進めない", async () => {
  const ctx = context();
  const h = createHandler(ctx);
  const { taskId, adapter } = await midFlight(ctx, h);

  await h("task.pause", { task_id: taskId }, NOOP_CONN);
  const runsAtPause = listStepRuns(ctx.db, taskId).length;
  await until(() => ctx.running.size === 0, 5000, "runTask の終了");

  assert.equal(listStepRuns(ctx.db, taskId).length, runsAtPause);
  assert.equal(adapter.calls.length, 1);
  assert.equal(getTask(ctx.db, taskId)?.state, "paused");
  assert.equal(getTask(ctx.db, taskId)?.current_step_id, "a",
    "中断されたステップより先に進むと resume が1ステップ飛ばしてしまう");
});

// --- 最終ステップが approval のワークフローの後始末 -----------------------

test("最終ステップの approval を承認したら worktree は削除され、ブランチは残る", async () => {
  const ctx = context();
  const h = createHandler(ctx);
  await h("project.add", { path: repo }, NOOP_CONN);
  // beforeEach の feature.yaml は approval 1ステップだけ。承認がそのまま完了になる。
  const t = await h("task.create", { project: repo, title: "T", prompt: "p" }, NOOP_CONN) as { id: string };
  await tick(ctx);
  await until(() => getTask(ctx.db, t.id)?.state === "suspended");
  await until(() => ctx.running.size === 0);
  const worktreePath = getTask(ctx.db, t.id)!.worktree_path!;
  const branch = getTask(ctx.db, t.id)!.branch;

  await h("task.approve", { task_id: t.id }, NOOP_CONN);

  assert.equal(getTask(ctx.db, t.id)?.state, "completed");
  assert.equal(getTask(ctx.db, t.id)?.worktree_path, null,
    "worktree_path が残ると findOrphans が既知扱いして孤児にも出てこない");
  assert.equal(existsSync(worktreePath), false, "completed は worktree を削除する");
  const { stdout } = await run("git", ["-C", repo, "branch", "--list", branch]);
  assert.match(stdout, /doctrine\//, "ブランチは残す");
});

test("最終ステップの approval でも未コミットの変更が残っていたら削除せず警告する", async () => {
  const ctx = context();
  const h = createHandler(ctx);
  await writeFile(join(repo, ".doctrine", "workflows", "dirtyapproval.yaml"),
    "name: dirtyapproval\nsteps:\n  - id: a\n    type: command\n    run: \"touch leftover.txt\"\n" +
    "  - id: review\n    type: approval\n    title: 見て\n");
  await h("project.add", { path: repo }, NOOP_CONN);
  const t = await h(
    "task.create", { project: repo, title: "T", prompt: "p", workflow: "dirtyapproval" }, NOOP_CONN,
  ) as { id: string };
  await tick(ctx);
  await until(() => getTask(ctx.db, t.id)?.state === "suspended");
  await until(() => ctx.running.size === 0);

  const after = await h("task.approve", { task_id: t.id }, NOOP_CONN) as { state: string };

  assert.equal(after.state, "completed", "後始末に失敗しても承認自体は成立している");
  assert.ok(getTask(ctx.db, t.id)?.worktree_path, "削除を拒否して残す");
  assert.ok(ctx.warnings.some((w) => /未コミット/.test(w)), "警告として出す");
});
