import { afterEach, beforeEach, test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDb, openDbOn } from "../../src/db/migrate.ts";
import { getTask, insertTask } from "../../src/db/tasks.ts";
import { listStepRuns } from "../../src/db/stepRuns.ts";
import { reviewRefName } from "../../src/core/reviewTree.ts";
import { createHandler, type DaemonContext, tick } from "../../src/daemon/handlers.ts";
import { createMockAdapter } from "../../src/adapter/mock.ts";
import { parseWorkflow } from "../../src/workflow/schema.ts";
import type { ServerEvent } from "../../src/daemon/protocol.ts";
import { branchNameFor } from "../../src/core/worktree.ts";
import { randomUUID } from "node:crypto";
import { makeRepo, tickWhenIdle, until } from "../helpers/repo.ts";

const run = promisify(execFile);
let root: string;
let repo: string;

const NOOP_CONN = { follow() {}, unfollow() {}, isFollowing: () => false };

// テストが context() で作った DaemonContext をすべて控えておく。approval が
// suspended に入るときの retainTree（reviewTree.ts）は commitStepBoundary の
// あとに実際の git を叩くので、DB の状態がもう "suspended" でも、その runTask
// はまだ ctx.running を持ったまま git サブプロセスを走らせていることがある。
// テスト本体は「状態が suspended になった」ところで終わってしまうので、
// 個々のテストに drain を書かせるのではなく、afterEach が rm の前に必ず
// ここへ控えた全 ctx の running が空になるのを待つ（書き込み中の worktree を
// 消して ENOTEMPTY になるのを防ぐ）。
const contexts: DaemonContext[] = [];

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
afterEach(async () => {
  await until(() => contexts.every((c) => c.running.size === 0));
  contexts.length = 0;
  await rm(root, { recursive: true, force: true });
  delete process.env.DOCTRINE_STATE_DIR;
});

async function context(events: ServerEvent[] = []): Promise<DaemonContext> {
  const db = await openDb(":memory:");
  const ctx: DaemonContext = {
    db,
    adapter: createMockAdapter({ result: { ok: true, text: "done" } }),
    logRoot: join(root, "logs"),
    globalLimit: 4,
    broadcast: (ev) => events.push(ev),
    warnings: [],
    loadWorkflow: async (projectPath, name) => {
      const { parseWorkflow } = await import("../../src/workflow/schema.ts");
      const { readFile } = await import("node:fs/promises");
      return parseWorkflow(
        await readFile(join(projectPath, ".doctrine", "workflows", `${name}.yaml`), "utf8"),
      );
    },
    running: new Set(),
  };
  contexts.push(ctx);
  return ctx;
}

test("project.add でプロジェクトを登録し、設定を読む", async () => {
  const ctx = await context();
  const h = createHandler(ctx);
  const p = await h("project.add", { path: repo }, NOOP_CONN) as {
    id: number;
    default_workflow: string;
  };
  assert.equal(p.default_workflow, "feature");
  const list = await h("project.list", {}, NOOP_CONN) as unknown[];
  assert.equal(list.length, 1);
});

test("task.create は queued のタスクを作り、worktree はまだ作らない", async () => {
  const ctx = await context();
  const h = createHandler(ctx);
  await h("project.add", { path: repo }, NOOP_CONN);
  const t = await h("task.create", { project: repo, title: "T", prompt: "直して" }, NOOP_CONN) as {
    id: string;
  };
  const row = (await getTask(ctx.db, t.id))!;
  assert.equal(row.state, "queued");
  assert.equal(row.worktree_path, null, "枠が取れた瞬間に作る");
  assert.match(row.branch, /^doctrine\//);
});

test("不正なワークフロー名はタスク作成時に落とす", async () => {
  const ctx = await context();
  const h = createHandler(ctx);
  await h("project.add", { path: repo }, NOOP_CONN);
  await assert.rejects(() =>
    h("task.create", { project: repo, title: "T", prompt: "p", workflow: "nonexistent" }, NOOP_CONN)
  );
});

test("非冪等コマンドを含むワークフローは task.create の応答と ctx.warnings の両方に警告が乗る", async () => {
  const ctx = await context();
  const h = createHandler(ctx);
  await writeFile(
    join(repo, ".doctrine", "workflows", "risky.yaml"),
    "name: risky\nsteps:\n  - id: open-pr\n    type: command\n    run: gh pr create --fill\n",
  );
  await h("project.add", { path: repo }, NOOP_CONN);
  const created = await h(
    "task.create",
    { project: repo, title: "T", prompt: "p", workflow: "risky" },
    NOOP_CONN,
  ) as { warnings: string[] };
  assert.equal(created.warnings.length, 1, "レスポンスに警告が乗る（ユーザーの目の前に出る）");
  assert.match(created.warnings[0], /gh pr create/);
  assert.equal(ctx.warnings.length, 1, "デーモンのstderr相当（ctx.warnings）にも記録される");
  assert.match(ctx.warnings[0], /gh pr create/);
});

test("冪等なワークフローは task.create で警告を出さない", async () => {
  const ctx = await context();
  const h = createHandler(ctx);
  await h("project.add", { path: repo }, NOOP_CONN);
  const created = await h(
    "task.create",
    { project: repo, title: "T", prompt: "p" },
    NOOP_CONN,
  ) as { warnings: string[] };
  assert.deepEqual(created.warnings, []);
  assert.equal(ctx.warnings.length, 0);
});

test("tick は非冪等コマンドの警告を毎周期 ctx.warnings に積み直さない", async () => {
  const events: ServerEvent[] = [];
  const ctx = await context(events);
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
    ctx.warnings,
    [],
    "tick が同じワークフローを毎回読み込んでも、作成時に一度出た警告を再び積まない",
  );
});

test("却下ループを何度回しても task.approve/task.reject は警告を積み直さない", async () => {
  const ctx = await context();
  const h = createHandler(ctx);
  // review を却下すると noop に戻り、また review に戻ってくるループ。
  // push は非冪等（git push）なので task.create の時点で1件だけ警告が出る。
  // このワークフロー自体は却下ループ中は一度も push まで到達しない。
  await writeFile(
    join(repo, ".doctrine", "workflows", "risky-loop.yaml"),
    "name: risky-loop\nsteps:\n" +
      '  - id: noop\n    type: command\n    run: "true"\n' +
      "  - id: review\n    type: approval\n    title: 見て\n" +
      "    onReject:\n      goto: noop\n      maxAttempts: 5\n" +
      "  - id: push\n    type: command\n    run: git push\n",
  );
  await h("project.add", { path: repo }, NOOP_CONN);
  const t = await h(
    "task.create",
    { project: repo, title: "T", prompt: "p", workflow: "risky-loop" },
    NOOP_CONN,
  ) as { id: string; warnings: string[] };
  assert.equal(t.warnings.length, 1, "作成時に push ステップの警告が1件出る");
  const afterCreate = ctx.warnings.length;
  assert.equal(afterCreate, 1);

  // review へ到達するまで進める
  await tick(ctx);
  await until(async () => (await getTask(ctx.db, t.id))?.state === "suspended");

  // 却下を3回繰り返す（review -> noop -> review のループ）。
  for (let i = 0; i < 3; i++) {
    await h("task.reject", { task_id: t.id, comment: `だめ${i}` }, NOOP_CONN);
    assert.equal((await getTask(ctx.db, t.id))?.state, "queued");
    // suspend するたびに review ステップがツリーを記録する（実際に git を叩く）ので、
    // 直前の runTask が ctx.running を解放し終わる前にこの1回の tick が素通りする
    // ことがある。tickWhenIdle が解放を待ってから1回だけ tick する。
    await tickWhenIdle(ctx);
    await until(async () => (await getTask(ctx.db, t.id))?.state === "suspended");
  }

  assert.equal(
    ctx.warnings.length,
    afterCreate,
    "却下ループ中、task.reject も tick も同じワークフローを読み直すが ctx.warnings は増えない",
  );

  // 最後に承認して push まで進める（push 自体は失敗してよい。ここでの関心は
  // task.approve が warnings を積まないことだけ）。
  await h("task.approve", { task_id: t.id }, NOOP_CONN);
  await tick(ctx);
  await until(() => ctx.running.size === 0);

  assert.equal(
    ctx.warnings.length,
    afterCreate,
    "task.approve も同じワークフローを読み直すが ctx.warnings を増やさない",
  );
});

test("tick で枠を取り、worktree を作って approval まで進む", async () => {
  const events: ServerEvent[] = [];
  const ctx = await context(events);
  const h = createHandler(ctx);
  await h("project.add", { path: repo }, NOOP_CONN);
  const t = await h("task.create", { project: repo, title: "T", prompt: "p" }, NOOP_CONN) as {
    id: string;
  };
  await tick(ctx);
  await until(() => ctx.running.size === 0);
  const row = (await getTask(ctx.db, t.id))!;
  assert.equal(row.state, "suspended");
  assert.ok(row.worktree_path, "枠が取れた瞬間に worktree ができている");
  assert.ok(events.some((e) => e.event === "task.stateChanged"));
});

test("task.approve で queued に戻り、行列の先頭に入る", async () => {
  const ctx = await context();
  const h = createHandler(ctx);
  await h("project.add", { path: repo }, NOOP_CONN);
  // approval の後にもステップがあるワークフロー。承認直後に completed になってしまう
  // 1ステップだけの workflow では「queued に戻る」経路を確認できない。
  await writeFile(
    join(repo, ".doctrine", "workflows", "twostep.yaml"),
    'name: twostep\nsteps:\n  - id: review\n    type: approval\n    title: 見て\n  - id: after\n    type: command\n    run: "true"\n',
  );
  const t = await h(
    "task.create",
    { project: repo, title: "T", prompt: "p", workflow: "twostep" },
    NOOP_CONN,
  ) as { id: string };
  await tick(ctx);
  await until(() => ctx.running.size === 0);
  await h("task.approve", { task_id: t.id }, NOOP_CONN);
  const row = (await getTask(ctx.db, t.id))!;
  assert.equal(row.state, "queued");
  assert.equal(row.resumed, 1);
});

test("task.reject はコメントを必須にする", async () => {
  const ctx = await context();
  const h = createHandler(ctx);
  await h("project.add", { path: repo }, NOOP_CONN);
  const t = await h("task.create", { project: repo, title: "T", prompt: "p" }, NOOP_CONN) as {
    id: string;
  };
  await tick(ctx);
  await until(() => ctx.running.size === 0);
  await assert.rejects(() => h("task.reject", { task_id: t.id }, NOOP_CONN));
});

test("task.cancel は canceled にして worktree を残す", async () => {
  const ctx = await context();
  const h = createHandler(ctx);
  await h("project.add", { path: repo }, NOOP_CONN);
  const t = await h("task.create", { project: repo, title: "T", prompt: "p" }, NOOP_CONN) as {
    id: string;
  };
  await tick(ctx);
  await until(() => ctx.running.size === 0);
  const before = (await getTask(ctx.db, t.id))!.worktree_path;
  await h("task.cancel", { task_id: t.id }, NOOP_CONN);
  const row = (await getTask(ctx.db, t.id))!;
  assert.equal(row.state, "canceled");
  assert.equal(row.worktree_path, before, "失敗・中止の worktree は残す");
});

test("task.list は state でフィルタできる", async () => {
  const ctx = await context();
  const h = createHandler(ctx);
  await h("project.add", { path: repo }, NOOP_CONN);
  await h("task.create", { project: repo, title: "A", prompt: "p" }, NOOP_CONN);
  await h("task.create", { project: repo, title: "B", prompt: "p" }, NOOP_CONN);
  const queued = await h("task.list", { state: "queued" }, NOOP_CONN) as unknown[];
  assert.equal(queued.length, 2);
});

test("worktree.list は孤児を報告する", async () => {
  const ctx = await context();
  const h = createHandler(ctx);
  await h("project.add", { path: repo }, NOOP_CONN);
  const res = await h("worktree.list", {}, NOOP_CONN) as { orphans: string[] }[];
  assert.ok(Array.isArray(res));
});

test("DB の worktree_path は worktree.list と同じ表記（実パス）で保存される", async () => {
  const ctx = await context();
  const h = createHandler(ctx);
  await h("project.add", { path: repo }, NOOP_CONN);
  const t = await h("task.create", { project: repo, title: "T", prompt: "p" }, NOOP_CONN) as {
    id: string;
  };
  await tick(ctx);
  await until(() => ctx.running.size === 0);
  const saved = (await getTask(ctx.db, t.id))!.worktree_path!;
  // macOS の tmpdir は /var -> /private/var の symlink 配下。未解決のまま保存すると
  // git が報告するパスと食い違う。
  assert.equal(saved, await Deno.realPath(saved));
  // DB から外すと、同じ表記のまま孤児として出てくる
  await ctx.db.updateTable("tasks").set({ worktree_path: null }).where("id", "=", t.id).execute();
  const res = await h("worktree.list", {}, NOOP_CONN) as { orphans: string[] }[];
  assert.deepEqual(res.flatMap((r) => r.orphans), [saved]);
});

test("未知のメソッドはエラーになる", async () => {
  const ctx = await context();
  await assert.rejects(() => createHandler(ctx)("task.nope", {}, NOOP_CONN));
});

test("完了したタスクの worktree は削除され、ブランチは残る", async () => {
  const ctx = await context();
  const h = createHandler(ctx);
  await h("project.add", { path: repo }, NOOP_CONN);
  // approval を含まない、すぐ終わるワークフローに差し替える
  await writeFile(
    join(repo, ".doctrine", "workflows", "quick.yaml"),
    'name: quick\nsteps:\n  - id: a\n    type: command\n    run: "true"\n',
  );
  const t = await h(
    "task.create",
    { project: repo, title: "T", prompt: "p", workflow: "quick" },
    NOOP_CONN,
  ) as { id: string };
  await tick(ctx);
  await until(async () => (await getTask(ctx.db, t.id))?.state === "completed");
  await until(() => ctx.running.size === 0);
  assert.equal((await getTask(ctx.db, t.id))?.worktree_path, null);
  const { stdout } = await run("git", [
    "-C",
    repo,
    "branch",
    "--list",
    (await getTask(ctx.db, t.id))!.branch,
  ]);
  assert.match(stdout, /doctrine\//, "完了後の扱いは最終ステップが決めている。ブランチは残す");
});

test("未コミットの変更が残っていたら削除せず警告する", async () => {
  const ctx = await context();
  const h = createHandler(ctx);
  await h("project.add", { path: repo }, NOOP_CONN);
  await writeFile(
    join(repo, ".doctrine", "workflows", "dirty.yaml"),
    'name: dirty\nsteps:\n  - id: a\n    type: command\n    run: "touch leftover.txt"\n',
  );
  const t = await h(
    "task.create",
    { project: repo, title: "T", prompt: "p", workflow: "dirty" },
    NOOP_CONN,
  ) as { id: string };
  await tick(ctx);
  await until(async () => (await getTask(ctx.db, t.id))?.state === "completed");
  await until(() => ctx.running.size === 0);
  assert.ok((await getTask(ctx.db, t.id))?.worktree_path, "削除を拒否して残す");
  assert.ok(ctx.warnings.some((w) => /未コミット/.test(w)), "警告として出す");
});

test("失敗したタスクの worktree は削除しない", async () => {
  const ctx = await context();
  const h = createHandler(ctx);
  await h("project.add", { path: repo }, NOOP_CONN);
  await writeFile(
    join(repo, ".doctrine", "workflows", "boom.yaml"),
    'name: boom\nsteps:\n  - id: a\n    type: command\n    run: "exit 1"\n',
  );
  const t = await h(
    "task.create",
    { project: repo, title: "T", prompt: "p", workflow: "boom" },
    NOOP_CONN,
  ) as { id: string };
  await tick(ctx);
  await until(async () => (await getTask(ctx.db, t.id))?.state === "failed");
  await until(() => ctx.running.size === 0);
  assert.ok((await getTask(ctx.db, t.id))?.worktree_path);
});

test("tick 時点でワークフローが読めないタスクは failed になり、以後 tick で再試行されない", async () => {
  const ctx = await context();
  const h = createHandler(ctx);
  await h("project.add", { path: repo }, NOOP_CONN);
  await writeFile(
    join(repo, ".doctrine", "workflows", "vanishing.yaml"),
    'name: vanishing\nsteps:\n  - id: a\n    type: command\n    run: "true"\n',
  );
  const t = await h(
    "task.create",
    { project: repo, title: "T", prompt: "p", workflow: "vanishing" },
    NOOP_CONN,
  ) as { id: string };
  // 作成時点では読めたワークフローが、tick までの間に壊れる/消える場合を再現する。
  await writeFile(join(repo, ".doctrine", "workflows", "vanishing.yaml"), "not: [valid");

  await tick(ctx);
  assert.equal(ctx.running.size, 0, "枠のガードは例外経路でも必ず解放される");
  assert.equal(
    (await getTask(ctx.db, t.id))?.state,
    "failed",
    "queued のまま残すと毎周期リトライし続ける",
  );
  assert.ok(ctx.warnings.some((w) => /ワークフロー/.test(w)));

  // 2周目のtickでも再試行されず、他のタスクの進行を妨げない
  await tick(ctx);
  assert.equal((await getTask(ctx.db, t.id))?.state, "failed");
});

test("runTask が例外を投げても daemon は落ちず、タスクは failed になる", async () => {
  const ctx = await context();
  const h = createHandler(ctx);
  await h("project.add", { path: repo }, NOOP_CONN);
  // {{ steps.nope.last_stdout }} は存在しないステップの出力を参照する。
  // expand() はこれを意図的に例外として投げ、runTask はそれを握りつぶさず
  // 伝播させる（ワークフロー作者に見える形にするため）。
  await writeFile(
    join(repo, ".doctrine", "workflows", "brokenvar.yaml"),
    'name: brokenvar\nsteps:\n  - id: a\n    type: command\n    run: "echo {{ steps.nope.last_stdout }}"\n',
  );
  const t = await h(
    "task.create",
    { project: repo, title: "T", prompt: "p", workflow: "brokenvar" },
    NOOP_CONN,
  ) as { id: string };

  await tick(ctx);
  await until(async () => (await getTask(ctx.db, t.id))?.state === "failed");
  await until(() => ctx.running.size === 0);
  assert.equal((await getTask(ctx.db, t.id))?.state, "failed");
  assert.ok(ctx.warnings.some((w) => /例外/.test(w)));
});

test("stepRun.started の step_run_id は本物で、task.logs から引ける", async () => {
  const events: ServerEvent[] = [];
  const ctx = await context(events);
  const h = createHandler(ctx);
  await h("project.add", { path: repo }, NOOP_CONN);
  await writeFile(
    join(repo, ".doctrine", "workflows", "quick.yaml"),
    'name: quick\nsteps:\n  - id: a\n    type: command\n    run: "true"\n',
  );
  const t = await h(
    "task.create",
    { project: repo, title: "T", prompt: "p", workflow: "quick" },
    NOOP_CONN,
  ) as { id: string };
  await tick(ctx);
  await until(async () => (await getTask(ctx.db, t.id))?.state === "completed");
  await until(() => ctx.running.size === 0);

  const started = events.find((e) => e.event === "stepRun.started") as {
    event: "stepRun.started";
    step_run_id: number;
  } | undefined;
  assert.ok(started, "stepRun.started イベントが届いていない");
  assert.ok(started!.step_run_id > 0, "プレースホルダーの0であってはならない");

  const log = await h(
    "task.logs",
    { task_id: t.id, step_run_id: started!.step_run_id },
    NOOP_CONN,
  ) as { log_path: string };
  assert.ok(log.log_path.length > 0, "届いた step_run_id で本物のログが引ける");
});

test("worktree 作成に失敗したタスクは failed になり、他プロジェクトの健全なタスクは同じ pass で進む", async () => {
  const ctx = await context();
  const h = createHandler(ctx);

  // 壊れたプロジェクト: baseBranch が存在しないので `git worktree add` が失敗する。
  await writeFile(
    join(repo, ".doctrine", "project.yaml"),
    "defaultWorkflow: feature\nmaxConcurrent: 1\nbaseBranch: nonexistent-base\n",
  );
  await h("project.add", { path: repo }, NOOP_CONN);
  const broken = await h(
    "task.create",
    { project: repo, title: "broken", prompt: "p" },
    NOOP_CONN,
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
    "task.create",
    { project: healthyRepo, title: "healthy", prompt: "p" },
    NOOP_CONN,
  ) as { id: string };

  try {
    await tick(ctx);
    await until(() => ctx.running.size === 0);
    assert.equal(
      (await getTask(ctx.db, broken.id))?.state,
      "failed",
      "作れないまま queued に残すと毎周期リトライされ続ける",
    );
    assert.ok(ctx.warnings.some((w) => /実行を開始できませんでした/.test(w)));
    assert.equal(
      (await getTask(ctx.db, healthy.id))?.state,
      "suspended",
      "1タスクの不備が他プロジェクトのタスクの進行を妨げてはいけない",
    );
  } finally {
    await rm(healthyRoot, { recursive: true, force: true });
  }
});

// --- 実行中の cancel / pause が runTask のループを止める -------------------

const TWO_AGENTS = 'name: twoagents\nsteps:\n  - id: a\n    type: agent\n    prompt: "p1"\n' +
  '  - id: b\n    type: agent\n    prompt: "p2"\n';

/** agent ステップ a の実行中（まだ結果が返らない状態）まで進めたタスクを作る。 */
async function midFlight(ctx: DaemonContext, h: ReturnType<typeof createHandler>) {
  const adapter = createMockAdapter({ result: { ok: true, text: "done" }, delayMs: 300 });
  ctx.adapter = adapter;
  await writeFile(join(repo, ".doctrine", "workflows", "twoagents.yaml"), TWO_AGENTS);
  await h("project.add", { path: repo }, NOOP_CONN);
  const t = await h(
    "task.create",
    { project: repo, title: "T", prompt: "p", workflow: "twoagents" },
    NOOP_CONN,
  ) as { id: string };
  await tick(ctx);
  // 最初のステップの running 行が立ち、子が動き出したところまで待つ。
  await until(
    async () => (await listStepRuns(ctx.db, t.id)).length === 1,
    5000,
    "ステップ a の開始",
  );
  return { taskId: t.id, adapter };
}

test("実行中に cancel されたら runTask は次のステップを始めない", async () => {
  const ctx = await context();
  const h = createHandler(ctx);
  const { taskId, adapter } = await midFlight(ctx, h);

  await h("task.cancel", { task_id: taskId }, NOOP_CONN);
  const runsAtCancel = (await listStepRuns(ctx.db, taskId)).length;
  await until(() => ctx.running.size === 0, 5000, "runTask の終了");

  assert.equal(
    (await listStepRuns(ctx.db, taskId)).length,
    runsAtCancel,
    "cancel 後に新しい step_runs 行を立ててはいけない",
  );
  assert.equal(adapter.calls.length, 1, "cancel 後にアダプタを呼び直してはいけない");
  assert.equal(
    (await getTask(ctx.db, taskId))?.state,
    "canceled",
    "状態を書いたのは handler 側であり、エンジンが上書きしてはいけない",
  );
});

test("実行中に pause されたら runTask は current_step_id を進めない", async () => {
  const ctx = await context();
  const h = createHandler(ctx);
  const { taskId, adapter } = await midFlight(ctx, h);

  await h("task.pause", { task_id: taskId }, NOOP_CONN);
  const runsAtPause = (await listStepRuns(ctx.db, taskId)).length;
  await until(() => ctx.running.size === 0, 5000, "runTask の終了");

  assert.equal((await listStepRuns(ctx.db, taskId)).length, runsAtPause);
  assert.equal(adapter.calls.length, 1);
  assert.equal((await getTask(ctx.db, taskId))?.state, "paused");
  assert.equal(
    (await getTask(ctx.db, taskId))?.current_step_id,
    "a",
    "中断されたステップより先に進むと resume が1ステップ飛ばしてしまう",
  );
});

// --- 最終ステップが approval のワークフローの後始末 -----------------------

test("最終ステップの approval を承認したら worktree は削除され、ブランチは残る", async () => {
  const ctx = await context();
  const h = createHandler(ctx);
  await h("project.add", { path: repo }, NOOP_CONN);
  // beforeEach の feature.yaml は approval 1ステップだけ。承認がそのまま完了になる。
  const t = await h("task.create", { project: repo, title: "T", prompt: "p" }, NOOP_CONN) as {
    id: string;
  };
  await tick(ctx);
  await until(async () => (await getTask(ctx.db, t.id))?.state === "suspended");
  await until(() => ctx.running.size === 0);
  const worktreePath = (await getTask(ctx.db, t.id))!.worktree_path!;
  const branch = (await getTask(ctx.db, t.id))!.branch;

  await h("task.approve", { task_id: t.id }, NOOP_CONN);

  assert.equal((await getTask(ctx.db, t.id))?.state, "completed");
  assert.equal(
    (await getTask(ctx.db, t.id))?.worktree_path,
    null,
    "worktree_path が残ると findOrphans が既知扱いして孤児にも出てこない",
  );
  assert.equal(existsSync(worktreePath), false, "completed は worktree を削除する");
  const { stdout } = await run("git", ["-C", repo, "branch", "--list", branch]);
  assert.match(stdout, /doctrine\//, "ブランチは残す");
});

test("最終ステップの approval でも未コミットの変更が残っていたら削除せず警告する", async () => {
  const ctx = await context();
  const h = createHandler(ctx);
  await writeFile(
    join(repo, ".doctrine", "workflows", "dirtyapproval.yaml"),
    'name: dirtyapproval\nsteps:\n  - id: a\n    type: command\n    run: "touch leftover.txt"\n' +
      "  - id: review\n    type: approval\n    title: 見て\n",
  );
  await h("project.add", { path: repo }, NOOP_CONN);
  const t = await h(
    "task.create",
    { project: repo, title: "T", prompt: "p", workflow: "dirtyapproval" },
    NOOP_CONN,
  ) as { id: string };
  await tick(ctx);
  await until(async () => (await getTask(ctx.db, t.id))?.state === "suspended");
  await until(() => ctx.running.size === 0);

  const after = await h("task.approve", { task_id: t.id }, NOOP_CONN) as { state: string };

  assert.equal(after.state, "completed", "後始末に失敗しても承認自体は成立している");
  assert.ok((await getTask(ctx.db, t.id))?.worktree_path, "削除を拒否して残す");
  assert.ok(ctx.warnings.some((w) => /未コミット/.test(w)), "警告として出す");
});

// --- tick の再入 ----------------------------------------------------------

/**
 * tick は1秒間隔で呼ばれるので、前の周が終わる前に次の周が始まる。
 *
 * **守られるべき不変条件**: ある tick が admit したタスクは、その `running` が
 * DB に書かれるまで、再び admit 候補になってはならず、他のタスクにその枠を
 * 取らせてもならない。
 *
 * 受付順（resumed DESC, priority ASC, created_at ASC, id ASC）が決定的である
 * ことは、この不変条件の根拠には**ならない**。窓の中に priority のより高い
 * タスクが入れば、2周目の先頭は決定的に別のタスクになり、それが枠を奪う
 * （後続の2テストが再現する）。安全性を支えているのは順序ではなく、
 * tick の再入ガードと、遅い処理の前に `running` を書く枠の先取りである。
 */
test("tick が重なって呼ばれても maxConcurrent: 1 のプロジェクトで2件が走り出さない", async () => {
  const ctx = await context();
  const h = createHandler(ctx);
  await h("project.add", { path: repo }, NOOP_CONN);
  const a = await h("task.create", { project: repo, title: "A", prompt: "p" }, NOOP_CONN) as {
    id: string;
  };
  // 受付順の FIFO は created_at（ミリ秒精度）で、同じミリ秒に作られると id（ランダムな UUID）で
  // 決まる。A が先に admit される前提を運に任せないよう、B の優先度を下げて順序を固定する。
  const b = await h(
    "task.create",
    { project: repo, title: "B", prompt: "p", priority: 3 },
    NOOP_CONN,
  ) as { id: string };

  // 実際に admit された回数を数える。2周目が2件目を繰り上げたならここが増える。
  const admitted: string[] = [];
  const stateAtSlowWork: string[] = [];
  const loadWorkflow = ctx.loadWorkflow;
  ctx.loadWorkflow = async (projectPath, name) => {
    admitted.push(name);
    stateAtSlowWork.push((await getTask(ctx.db, a.id))!.state);
    return loadWorkflow(projectPath, name);
  };

  // 1周目が飛行中（DB読み書きや loadWorkflow / createWorktree を await している最中）に2周目を始める
  const first = tick(ctx);
  const second = tick(ctx);
  await Promise.all([first, second]);
  await until(() => ctx.running.size === 0);

  assert.deepEqual(
    stateAtSlowWork,
    ["running"],
    "遅い処理に入る前に running を書き切っている（枠の先取り）。ここが queued に戻ると窓が開く",
  );

  const states = [(await getTask(ctx.db, a.id))!.state, (await getTask(ctx.db, b.id))!.state];
  const holding = states.filter((s) => s === "running" || s === "suspended" || s === "paused");
  assert.equal(holding.length, 1, `プロジェクト枠は1。実際: ${states.join(",")}`);
  assert.equal(
    (await getTask(ctx.db, a.id))!.state,
    "suspended",
    "先に admit された A が枠を持ち続ける",
  );
  assert.equal((await getTask(ctx.db, b.id))!.state, "queued");
  assert.equal(
    (await getTask(ctx.db, b.id))!.worktree_path,
    null,
    "走らなかったタスクは worktree も作られない",
  );

  // 2周目が同じタスクを二重に開始していないこと（step_runs が重複しない）。
  // approval も suspended に入る時点で awaiting の行を1つ立てるので、
  // 重複していなければちょうど1件になる。
  assert.equal(
    (await listStepRuns(ctx.db, a.id)).length,
    1,
    "review の awaiting 行が1件だけ（2周目が重複して立てていない）",
  );
  assert.equal(admitted.length, 1, "2周目は再入ガードで即座に返り、何も admit しない");
});

/**
 * 枠を奪われる窓の再現。修正前の tick は `state: "running"` を書く前に
 * loadWorkflow / createWorktree を await するので、その間に入った
 * 優先度の高いタスクが2周目の受付順の先頭に立ち、1周目のタスクを
 * 押しのけて admit される（1周目のタスクはまだ queued なので枠は空に見え、
 * 押しのけられた側は ctx.running にも入っていないので弾かれない）。
 */
test("窓の中に priority 0 のタスクが入っても maxConcurrent: 1 のプロジェクトで2件が走り出さない", async () => {
  const ctx = await context();
  const h = createHandler(ctx);
  const project = await h("project.add", { path: repo }, NOOP_CONN) as { id: number };
  const a = await h("task.create", { project: repo, title: "A", prompt: "p" }, NOOP_CONN) as {
    id: string;
  };

  let release!: () => void;
  const released = new Promise<void>((r) => {
    release = r;
  });
  const bId = randomUUID();
  const admitted: string[] = [];
  const inner = ctx.loadWorkflow;
  let first = true;
  ctx.loadWorkflow = async (projectPath, name) => {
    admitted.push(name);
    if (first) {
      first = false;
      // 1周目が await している最中に、より優先度の高いタスクが作られる。
      // handler 経由だと ctx.loadWorkflow に再入するので直接 insert する。
      await insertTask(ctx.db, {
        id: bId,
        project_id: project.id,
        title: "B",
        prompt: "p",
        workflow_name: "feature",
        branch: branchNameFor(bId, "B"),
        priority: 0,
      });
      await released;
    }
    return inner(projectPath, name);
  };

  const t1 = tick(ctx);
  const t2 = tick(ctx);
  release();
  await Promise.all([t1, t2]);
  await until(() => ctx.running.size === 0);

  const states = [(await getTask(ctx.db, a.id))!.state, (await getTask(ctx.db, bId))!.state];
  const holding = states.filter((s) => s === "running" || s === "suspended" || s === "paused");
  assert.equal(holding.length, 1, `プロジェクト枠は1。実際: ${states.join(",")}`);
  assert.equal(admitted.length, 1, "admit されたのは1件だけ");
  assert.equal(
    (await getTask(ctx.db, bId))!.state,
    "queued",
    "後から来た priority 0 は枠が空くまで待つ",
  );
  assert.equal(
    (await getTask(ctx.db, bId))!.worktree_path,
    null,
    "走らなかったタスクは worktree も作られない",
  );
});

/**
 * 同じ窓は globalLimit も破る。プロジェクトが違えばプロジェクト枠は
 * 助けにならないので、全体枠だけが最後の砦になる。
 *
 * ここは終了状態では判定できない（approval で suspended になったタスクは
 * holdsGlobalSlot ではない）。admit された回数そのものを見る。
 */
test("窓の中に別プロジェクトの priority 0 が入っても globalLimit を超えて admit しない", async () => {
  const ctx = await context();
  ctx.globalLimit = 1;
  const h = createHandler(ctx);
  await h("project.add", { path: repo }, NOOP_CONN);
  const repo2 = await makeRepo(join(root, "two"), {
    "README.md": "y\n",
    ".doctrine/project.yaml": "defaultWorkflow: feature\nmaxConcurrent: 1\nbaseBranch: main\n",
    ".doctrine/workflows/feature.yaml":
      "name: feature\nsteps:\n  - id: review\n    type: approval\n    title: 見て\n",
  });
  const project2 = await h("project.add", { path: repo2 }, NOOP_CONN) as { id: number };
  const a = await h("task.create", { project: repo, title: "A", prompt: "p" }, NOOP_CONN) as {
    id: string;
  };

  let release!: () => void;
  const released = new Promise<void>((r) => {
    release = r;
  });
  const bId = randomUUID();
  const admitted: string[] = [];
  const inner = ctx.loadWorkflow;
  let first = true;
  ctx.loadWorkflow = async (projectPath, name) => {
    admitted.push(projectPath);
    if (first) {
      first = false;
      await insertTask(ctx.db, {
        id: bId,
        project_id: project2.id,
        title: "B",
        prompt: "p",
        workflow_name: "feature",
        branch: branchNameFor(bId, "B"),
        priority: 0,
      });
      await released;
    }
    return inner(projectPath, name);
  };

  const t1 = tick(ctx);
  const t2 = tick(ctx);
  release();
  await Promise.all([t1, t2]);
  await until(() => ctx.running.size === 0);

  assert.equal(admitted.length, 1, `globalLimit は1。admit されたのは: ${admitted.join(",")}`);
  assert.equal((await getTask(ctx.db, bId))!.state, "queued", "全体枠が空くまで待つ");
  assert.equal((await getTask(ctx.db, bId))!.worktree_path, null);
  assert.equal((await getTask(ctx.db, a.id))!.state, "suspended");
});

test("tick が例外で抜けても再入ガードは解放され、次の周期が止まらない", async () => {
  const ctx = await context();
  const sqlite = new DatabaseSync(":memory:");
  ctx.db = await openDbOn(sqlite);
  const h = createHandler(ctx);
  await h("project.add", { path: repo }, NOOP_CONN);
  const a = await h("task.create", { project: repo, title: "A", prompt: "p" }, NOOP_CONN) as {
    id: string;
  };

  // DBの故障は素の接続（DatabaseSync）の prepare に仕込む。Kysely はクエリごとに
  // ここを通るので、受付候補を読むクエリ（resumed の降順で並べる唯一のクエリ）だけを落とす。
  const prepare = sqlite.prepare.bind(sqlite);
  let boom = true;
  // selectAdmissible は tick のタスク別 try の外側にあるので、ここでの例外は
  // tick 自体から漏れる。ガードが finally で解放されていなければ、以後
  // tick は永久に何もしなくなる。
  sqlite.prepare = ((sql: string) => {
    if (boom && sql.includes('order by "resumed" desc')) throw new Error("DBが壊れた");
    return prepare(sql);
  }) as typeof prepare;

  await assert.rejects(() => tick(ctx), /DBが壊れた/);

  boom = false;
  await tick(ctx);
  await until(async () => (await getTask(ctx.db, a.id))!.state === "suspended");
  assert.equal((await getTask(ctx.db, a.id))!.state, "suspended", "次の周期は普通に admit できる");
});

/**
 * selectAdmissible で queued を読んでから running を書くまでの間にも await がある。
 * その隙に cancel されたタスクを running で上書きして走らせてはいけない。
 *
 * tick の running コミットの requireState: "queued" を外すとこのテストは落ちることを
 * 確認済み。差し込み先のクエリが変わると窓を外して素通りし得るので、
 * `injected` の検査を消さないこと。
 */
test("受付候補を読んだ後に cancel が届いたタスクは、running で上書きせず見送る", async () => {
  const ctx = await context();
  const sqlite = new DatabaseSync(":memory:");
  ctx.db = await openDbOn(sqlite);
  const h = createHandler(ctx);
  await h("project.add", { path: repo }, NOOP_CONN);
  const a = await h("task.create", { project: repo, title: "A", prompt: "p" }, NOOP_CONN) as {
    id: string;
  };

  const loaded: string[] = [];
  const inner = ctx.loadWorkflow;
  ctx.loadWorkflow = async (projectPath, name) => {
    loaded.push(name);
    return inner(projectPath, name);
  };

  // selectAdmissible は queued を読んだ後、プロジェクト枠の判定のためにプロジェクトを読む。
  // その瞬間に cancel が届いたことにする。
  const prepare = sqlite.prepare.bind(sqlite);
  let injected = false;
  sqlite.prepare = ((sql: string) => {
    if (!injected && sql.startsWith('select * from "projects"')) {
      injected = true;
      prepare("UPDATE tasks SET state = 'canceled' WHERE id = ?").run(a.id);
    }
    return prepare(sql);
  }) as typeof prepare;

  await tick(ctx);

  assert.ok(injected, "窓に cancel を差し込めていない（テストの前提が崩れている）");
  assert.equal(ctx.running.size, 0, "見送ったタスクの枠のガードは解放される");
  const row = (await getTask(ctx.db, a.id))!;
  assert.equal(row.state, "canceled", "cancel を running で上書きしてはいけない");
  assert.equal(row.worktree_path, null, "見送ったタスクの worktree は作らない");
  assert.deepEqual(loaded, [], "ワークフローの読み込み（実行の開始）に進まない");
  assert.deepEqual(ctx.warnings, [], "見送りは失敗ではない");
});

// --- project.add は最初に叩くコマンドなので、足りない .doctrine の雛形を作る ---

/** .doctrine を持たない、最初のコミットだけ済んだリポジトリ */
async function bareRepo(name: string): Promise<string> {
  return await makeRepo(join(root, name), { "README.md": "x\n" });
}

test("project.add: .doctrine が無ければ雛形を作り、そのままタスクを作れる", async () => {
  const bare = await bareRepo("bare");
  const ctx = await context();
  const h = createHandler(ctx);
  const p = await h("project.add", { path: bare }, NOOP_CONN) as {
    default_workflow: string;
    created: string[];
  };

  const projectYaml = join(bare, ".doctrine", "project.yaml");
  const workflowYaml = join(bare, ".doctrine", "workflows", "default.yaml");
  assert.ok(existsSync(projectYaml), "project.yaml が作られている");
  assert.ok(existsSync(workflowYaml), "既定のワークフローが作られている");
  assert.deepEqual(
    [...p.created].sort(),
    [projectYaml, workflowYaml].sort(),
    "作ったファイルをレスポンスで伝える（ユーザーのリポジトリに未追跡ファイルが増えるため）",
  );
  assert.equal(p.default_workflow, "default");

  // 雛形が検証を通らなければ、ここで落ちる
  const t = await h("task.create", { project: bare, title: "T", prompt: "直して" }, NOOP_CONN) as {
    id: string;
  };
  assert.equal((await getTask(ctx.db, t.id))!.state, "queued");
});

test("project.add: 既定のワークフローは agent と approval だけで、command を含まない", async () => {
  const bare = await bareRepo("bare");
  const h = createHandler(await context());
  await h("project.add", { path: bare }, NOOP_CONN);
  const { workflow } = parseWorkflow(
    await readFile(join(bare, ".doctrine", "workflows", "default.yaml"), "utf8"),
  );
  assert.deepEqual(workflow.steps.map((s) => s.type), ["agent", "approval"]);
});

test("project.add: 雛形の project.yaml に setup を書かない（パッケージマネージャを強制しない）", async () => {
  const bare = await bareRepo("bare");
  const h = createHandler(await context());
  const p = await h("project.add", { path: bare }, NOOP_CONN) as { setup: string | null };
  assert.equal(p.setup, null);
  const text = await readFile(join(bare, ".doctrine", "project.yaml"), "utf8");
  assert.equal(/^\s*setup\s*:/m.test(text), false, "setup キーが書かれていない");
});

test("project.add: ベースブランチは main 決め打ちではなく git から取る", async () => {
  const bare = await bareRepo("bare");
  await run("git", ["-C", bare, "branch", "-m", "trunk"]);
  const h = createHandler(await context());
  const p = await h("project.add", { path: bare }, NOOP_CONN) as { base_branch: string };
  assert.equal(p.base_branch, "trunk");
  assert.equal(
    baseBranchWrittenIn(await readFile(join(bare, ".doctrine", "project.yaml"), "utf8")),
    "trunk",
  );
});

test("project.add: 既存の project.yaml は上書きしない", async () => {
  const before = await readFile(join(repo, ".doctrine", "project.yaml"), "utf8");
  const h = createHandler(await context());
  const p = await h("project.add", { path: repo }, NOOP_CONN) as {
    created: string[];
    default_workflow: string;
  };
  assert.equal(await readFile(join(repo, ".doctrine", "project.yaml"), "utf8"), before);
  assert.deepEqual(p.created, []);
  assert.equal(p.default_workflow, "feature");
});

test("project.add: project.yaml が指すワークフローが無ければ、何も作らずに分かる形で失敗する", async () => {
  const r = await makeRepo(join(root, "partial"), {
    "README.md": "x\n",
    ".doctrine/project.yaml": "defaultWorkflow: feature\n",
  });
  const h = createHandler(await context());
  await assert.rejects(
    () => h("project.add", { path: r }, NOOP_CONN),
    (e: unknown) => {
      const m = (e as Error).message;
      assert.match(m, /feature/, "どのワークフローが無いのか名前を出す");
      assert.match(m, /workflows/, "どこに置けばいいか分かる");
      return true;
    },
  );
  assert.equal(
    existsSync(join(r, ".doctrine", "workflows")),
    false,
    "ユーザーが書いていないワークフローを勝手に作らない",
  );
  assert.equal((await h("project.list", {}, NOOP_CONN) as unknown[]).length, 0);
});

test("project.add: git リポジトリでなければ .doctrine を作らずに失敗する", async () => {
  const plain = join(root, "plain");
  await mkdir(plain);
  const h = createHandler(await context());
  await assert.rejects(() => h("project.add", { path: plain }, NOOP_CONN), /git/);
  assert.equal(existsSync(join(plain, ".doctrine")), false);
});

test("project.add: リポジトリのサブディレクトリを指したら、ルートを案内して失敗する", async () => {
  const bare = await bareRepo("bare");
  const sub = join(bare, "packages", "app");
  await mkdir(sub, { recursive: true });
  const h = createHandler(await context());
  const realRoot = await Deno.realPath(bare);
  await assert.rejects(
    () => h("project.add", { path: sub }, NOOP_CONN),
    (e: unknown) => {
      // サブディレクトリのパスはルートを前方一致で含むので、それを取り除いた後にも
      // ルートが残っていることを確かめる — 単に sub のパスを含むエラー（NotFound 等）
      // では通らないようにする
      const withoutSub = (e as Error).message.replaceAll(sub, "");
      assert.ok(
        withoutSub.includes(realRoot),
        `リポジトリのルートを案内する: ${(e as Error).message}`,
      );
      return true;
    },
  );
  assert.equal(existsSync(join(sub, ".doctrine")), false);
});

test("project.add: 同じパスで2回呼んでも失敗せず、登録済みとして同じプロジェクトを返す", async () => {
  const h = createHandler(await context());
  const first = await h("project.add", { path: repo }, NOOP_CONN) as { id: number };
  const second = await h("project.add", { path: repo }, NOOP_CONN) as {
    id: number;
    alreadyRegistered: boolean;
  };
  assert.equal(second.id, first.id);
  assert.equal(second.alreadyRegistered, true);
  assert.equal((await h("project.list", {}, NOOP_CONN) as unknown[]).length, 1);
});

function baseBranchWrittenIn(text: string): string {
  const m = /^baseBranch:\s*(\S+)\s*$/m.exec(text);
  return m ? m[1] : "";
}

test("project.add: project.yaml が無くても、既にあるワークフローファイルは上書きしない", async () => {
  const custom =
    "name: default\nsteps:\n  - id: mine\n    type: approval\n    title: 自分で書いた\n";
  const r = await makeRepo(join(root, "wfonly"), {
    "README.md": "x\n",
    ".doctrine/workflows/default.yaml": custom,
  });
  const h = createHandler(await context());
  const p = await h("project.add", { path: r }, NOOP_CONN) as { created: string[] };
  assert.equal(
    await readFile(join(r, ".doctrine", "workflows", "default.yaml"), "utf8"),
    custom,
    "ユーザーが書いたワークフローを雛形で潰さない",
  );
  assert.deepEqual(
    p.created,
    [join(r, ".doctrine", "project.yaml")],
    "作ったのは project.yaml だけ",
  );
});

test("worktree を消すとそのタスクのレビュー参照も消える", async () => {
  const ctx = await context();
  const h = createHandler(ctx);
  await h("project.add", { path: repo }, NOOP_CONN);
  const t = await h("task.create", { project: repo, title: "T", prompt: "p" }, NOOP_CONN) as {
    id: string;
  };
  await tick(ctx);
  await until(async () => (await getTask(ctx.db, t.id))?.state === "suspended");
  await until(() => ctx.running.size === 0);

  const review = (await listStepRuns(ctx.db, t.id)).find((r) => r.status === "awaiting")!;
  const ref = reviewRefName(t.id, review.id);
  const before = await run("git", ["-C", repo, "for-each-ref", "--format=%(refname)", ref]);
  assert.equal(before.stdout.trim(), ref, "suspended に入った時点で参照が張られている");

  await h("worktree.remove", { task_id: t.id, force: true }, NOOP_CONN);

  const after = await run("git", [
    "-C",
    repo,
    "for-each-ref",
    "--format=%(refname)",
    "refs/doctrine/reviews",
  ]);
  assert.equal(after.stdout.trim(), "", "worktree と一緒に参照も消える");
  assert.equal((await getTask(ctx.db, t.id))?.worktree_path, null);
});

test("削除を拒否されたら参照は残す", async () => {
  const ctx = await context();
  const h = createHandler(ctx);
  await h("project.add", { path: repo }, NOOP_CONN);
  const t = await h("task.create", { project: repo, title: "T", prompt: "p" }, NOOP_CONN) as {
    id: string;
  };
  await tick(ctx);
  await until(async () => (await getTask(ctx.db, t.id))?.state === "suspended");
  await until(() => ctx.running.size === 0);
  const worktree = (await getTask(ctx.db, t.id))!.worktree_path!;
  await writeFile(join(worktree, "dirty.txt"), "未コミット\n");

  // force を付けなければ、未コミットの変更を理由に削除は拒否される。
  await assert.rejects(() => h("worktree.remove", { task_id: t.id }, NOOP_CONN));

  const after = await run("git", [
    "-C",
    repo,
    "for-each-ref",
    "--format=%(refname)",
    "refs/doctrine/reviews",
  ]);
  assert.notEqual(after.stdout.trim(), "", "worktree が残るなら基準点も残す");
});

// --- suspended から出る3つの経路が、開いている awaiting 行を必ず閉じる -------

/** beforeEach の feature ワークフロー（approval 1つ）を suspended まで進める。 */
async function suspendedTask(
  ctx: DaemonContext,
  h: ReturnType<typeof createHandler>,
): Promise<string> {
  await h("project.add", { path: repo }, NOOP_CONN);
  const t = await h("task.create", { project: repo, title: "T", prompt: "p" }, NOOP_CONN) as {
    id: string;
  };
  await tick(ctx);
  await until(async () => (await getTask(ctx.db, t.id))?.state === "suspended");
  await until(() => ctx.running.size === 0);
  return t.id;
}

test("suspended のタスクを cancel すると awaiting 行は interrupted で閉じられる", async () => {
  const ctx = await context();
  const h = createHandler(ctx);
  const taskId = await suspendedTask(ctx, h);

  await h("task.cancel", { task_id: taskId }, NOOP_CONN);

  assert.equal((await getTask(ctx.db, taskId))?.state, "canceled");
  const runs = await listStepRuns(ctx.db, taskId);
  assert.equal(runs.length, 1);
  assert.equal(
    runs[0].status,
    "interrupted",
    "中止されたタスクに「まだレビューを待っている」行を残してはいけない",
  );
  assert.notEqual(runs[0].ended_at, null, "閉じた時刻が入る");
});

test("suspended のタスクを resume すると awaiting 行は interrupted で閉じられる", async () => {
  const ctx = await context();
  const h = createHandler(ctx);
  const taskId = await suspendedTask(ctx, h);

  await h("task.resume", { task_id: taskId }, NOOP_CONN);

  assert.equal((await getTask(ctx.db, taskId))?.state, "queued");
  const runs = await listStepRuns(ctx.db, taskId);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "interrupted");
  assert.notEqual(runs[0].ended_at, null);
});

test("resume 後に再び suspended に入ると新しい awaiting 行が立ち、attempt が2になる", async () => {
  const ctx = await context();
  const h = createHandler(ctx);
  const taskId = await suspendedTask(ctx, h);

  await h("task.resume", { task_id: taskId }, NOOP_CONN);
  await tickWhenIdle(ctx);
  await until(async () => (await getTask(ctx.db, taskId))?.state === "suspended");
  await until(() => ctx.running.size === 0);

  const runs = await listStepRuns(ctx.db, taskId);
  assert.equal(runs.length, 2, "閉じた行と、新しく立った行");
  assert.equal(runs[0].status, "interrupted");
  assert.equal(runs[0].attempt, 1);
  assert.equal(runs[1].status, "awaiting");
  assert.equal(
    runs[1].attempt,
    2,
    "suspended に立ち止まった回数を正直に数える（resume は1回ぶん消費する）",
  );
  assert.equal(
    JSON.parse((await getTask(ctx.db, taskId))!.attempt_counts).review,
    2,
    "attempt_counts は step_runs.attempt とちょうど一致する",
  );
});

test("paused のタスクを resume しても、閉じるべき awaiting 行が無いので何も壊れない", async () => {
  const ctx = await context();
  const h = createHandler(ctx);
  await h("project.add", { path: repo }, NOOP_CONN);
  const t = await h("task.create", { project: repo, title: "T", prompt: "p" }, NOOP_CONN) as {
    id: string;
  };
  await h("task.pause", { task_id: t.id }, NOOP_CONN);

  await h("task.resume", { task_id: t.id }, NOOP_CONN);

  assert.equal((await getTask(ctx.db, t.id))?.state, "queued");
  assert.deepEqual(await listStepRuns(ctx.db, t.id), []);
});
