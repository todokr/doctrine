import { afterEach, beforeEach, test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/db/migrate.ts";
import { getTask } from "../../src/db/tasks.ts";
import { listStepRuns } from "../../src/db/stepRuns.ts";
import {
  createHandler,
  type DaemonContext,
  loadWorkflowFromDisk,
  tick,
} from "../../src/daemon/handlers.ts";
import { createWarningLog } from "../../src/daemon/warnings.ts";
import { createMockAdapter } from "../../src/adapter/mock.ts";
import type { ServerEvent, TaskDetail } from "../../../shared/protocol.ts";
import { makeRepo, tickWhenIdle, until } from "../helpers/repo.ts";

const execFileAsync = promisify(execFile);
const NOOP_CONN = { follow() {}, unfollow() {}, isFollowing: () => false };
let root: string;

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
  root = await mkdtemp(join(tmpdir(), "doctrine-e2e-"));
  process.env.DOCTRINE_STATE_DIR = join(root, "state");
});
afterEach(async () => {
  await until(() => contexts.every((c) => c.running.size === 0));
  contexts.length = 0;
  await rm(root, { recursive: true, force: true });
  delete process.env.DOCTRINE_STATE_DIR;
});

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
      feed: "marker.txt がない:\\n{{ steps.verify.last_stderr }}"
  - id: review
    type: approval
    title: "差分を確認してください"
    onReject:
      goto: implement
      maxAttempts: 5
      feed: "レビューで却下された:\\n{{ steps.review.last_stdout }}"
  - id: record
    type: command
    run: "echo done > result.txt"
`;

async function context(adapter = createMockAdapter({ result: { ok: true, text: "やりました" } })) {
  const db = await openDb(":memory:");
  const events: ServerEvent[] = [];
  const ctx: DaemonContext = {
    db,
    adapter,
    logRoot: join(root, "logs"),
    globalLimit: 4,
    broadcast: (ev) => events.push(ev),
    loadWorkflow: loadWorkflowFromDisk,
    running: new Set(),
    warnings: createWarningLog({ broadcast: () => {}, write: () => {} }),
  };
  contexts.push(ctx);
  return { ctx, events, handler: createHandler(ctx) };
}

test("setup → agent → command → approval → 承認 → 完了まで通る", async () => {
  const repo = await makeRepo(root, {
    ".doctrine/project.yaml":
      "setup: touch marker.txt\ndefaultWorkflow: feature\nmaxConcurrent: 1\nbaseBranch: main\n",
    ".doctrine/workflows/feature.yaml": WORKFLOW,
  });
  const { ctx, events, handler } = await context();
  await handler("project.add", { path: repo }, NOOP_CONN);
  const t = await handler("task.create", {
    project: repo,
    title: "マーカーを作る",
    prompt: "作って",
  }, NOOP_CONN) as { id: string };

  await tick(ctx);
  await until(
    async () => (await getTask(ctx.db, t.id))?.state === "suspended",
    5000,
    "承認待ち(suspended)に到達すること（review ステップで止まるはず）",
  );

  const runs = (await listStepRuns(ctx.db, t.id)).map((r) => r.step_id);
  // review は suspended に入った時点で awaiting の行を立てるので、承認待ちの
  // 時点で既に記録に現れる（setup が先頭に自動挿入されていることも合わせて確認）。
  assert.deepEqual(runs, ["setup", "implement", "verify", "review"]);

  // ブリーフが求める「event が運ぶ id が実際に何かへ解決できる」ことの証明。
  // stepRun.started / stepRun.finished が載せる step_run_id を、broadcast された
  // イベント配列から取り出し、それを task.logs へ渡して本物の行が返ってくるかを見る。
  // プレースホルダの 0 や、別テーブルの id を渡していれば getStepRun が見つからず
  // task.logs がエラーを投げる。
  const stepRunEvent = events.find(
    (e): e is Extract<ServerEvent, { event: "stepRun.started" }> => e.event === "stepRun.started",
  );
  assert.ok(stepRunEvent, "stepRun.started イベントが broadcast されている");
  assert.notEqual(stepRunEvent!.step_run_id, 0, "step_run_id がプレースホルダの0のままではない");
  const logs = await handler(
    "task.logs",
    { task_id: t.id, step_run_id: stepRunEvent!.step_run_id },
    NOOP_CONN,
  ) as { log_path: string };
  assert.ok(logs.log_path, "イベントに載った step_run_id が実在する step_run に解決する");
  const resolvedRun = (await listStepRuns(ctx.db, t.id)).find((r) =>
    r.id === stepRunEvent!.step_run_id
  );
  assert.ok(resolvedRun, "step_run_id が本当に step_runs テーブルの行を指している");
  assert.equal(
    resolvedRun!.step_id,
    stepRunEvent!.step_id,
    "イベントが名乗った step_id と、id で引いた実際の行の step_id が一致する",
  );

  await handler("task.approve", { task_id: t.id }, NOOP_CONN);
  assert.equal((await getTask(ctx.db, t.id))?.state, "queued");

  // review が suspended に入った1回目の runTask は、実際に git を叩いてツリーを
  // 記録してから ctx.running を解放する。その解放が終わる前にこの1回の tick が
  // 素通りすることがあるので、tickWhenIdle で解放を待ってから1回だけ tick する。
  await tickWhenIdle(ctx);
  await until(
    async () => (await getTask(ctx.db, t.id))?.state === "completed",
    5000,
    "承認後の record 実行を経て completed に到達すること",
  );
  // state が completed になった直後は cleanupAfterRun の後始末（.then チェーン）が
  // まだ走っていないことがある。worktree_path が消えるか警告が積まれるまで待つ。
  await until(
    async () =>
      (await getTask(ctx.db, t.id))?.worktree_path === null || ctx.warnings.recent().length > 0,
    5000,
    "cleanupAfterRun が worktree 削除を試みて完了する（成功で null になるか、拒否されて警告が積まれる）まで待つ",
  );

  assert.deepEqual(
    (await listStepRuns(ctx.db, t.id)).map((r) => r.step_id),
    ["setup", "implement", "verify", "review", "record"],
    "承認後は verify までの記録を保ったまま record から再開している（先頭からのやり直しではない）",
  );

  // setup/record が作った marker.txt / result.txt はどちらもコミットされていないので、
  // cleanupAfterRun の worktree 削除は UncommittedChangesError で拒否され、worktree は残る。
  // これはエンジンの不備ではなく、この brief のワークフロー例が commit ステップを
  // 持たないために起きる意図された挙動（未コミットの後始末は黙って削除しない）。
  const wt = (await getTask(ctx.db, t.id))!.worktree_path;
  assert.ok(wt, "未コミットの変更があるので worktree は残っているはず");
  assert.equal(
    ctx.warnings.recent().length,
    1,
    "worktree 削除が拒否されたことが警告として記録される",
  );
  assert.match(ctx.warnings.recent()[0].message, /未コミットの変更/);
  assert.match(await readFile(join(wt!, "result.txt"), "utf8"), /done/);
});

test("却下すると実装ステップへ戻り、コメントがエージェントに渡る", async () => {
  const repo = await makeRepo(root, {
    ".doctrine/project.yaml":
      "setup: touch marker.txt\ndefaultWorkflow: feature\nmaxConcurrent: 1\nbaseBranch: main\n",
    ".doctrine/workflows/feature.yaml": WORKFLOW,
  });
  const adapter = createMockAdapter({ result: { ok: true, text: "やりました" } });
  const { ctx, handler } = await context(adapter);
  await handler("project.add", { path: repo }, NOOP_CONN);
  const t = await handler(
    "task.create",
    { project: repo, title: "T", prompt: "作って" },
    NOOP_CONN,
  ) as { id: string };

  await tick(ctx);
  await until(
    async () => (await getTask(ctx.db, t.id))?.state === "suspended",
    5000,
    "1回目の承認待ちに到達すること",
  );
  await handler("task.reject", { task_id: t.id, comment: "命名が変です" }, NOOP_CONN);
  assert.equal((await getTask(ctx.db, t.id))?.current_step_id, "implement");

  // review は suspended に入るたびに実際の git でツリーを記録する（reviewTree.ts）ので、
  // 1回目の runTask が ctx.running を解放し終わる前にこの1回の tick が素通りすることが
  // ある。tickWhenIdle で解放を待ってから1回だけ tick する。
  await tickWhenIdle(ctx);
  await until(
    async () => (await getTask(ctx.db, t.id))?.state === "suspended",
    5000,
    "却下→再実装→再度の承認待ちに到達すること",
  );

  const resumeCall = adapter.calls.find((c) => c.kind === "resume");
  assert.ok(resumeCall, "却下後は resume で会話が継続する");
  assert.match(resumeCall!.prompt, /命名が変です/, "却下コメントがエージェントに渡っている");
});

test("プロジェクト枠1のとき、承認待ちのタスクが次のタスクを止める", async () => {
  const repo = await makeRepo(root, {
    ".doctrine/project.yaml":
      "setup: touch marker.txt\ndefaultWorkflow: feature\nmaxConcurrent: 1\nbaseBranch: main\n",
    ".doctrine/workflows/feature.yaml": WORKFLOW,
  });
  const { ctx, handler } = await context();
  await handler("project.add", { path: repo }, NOOP_CONN);
  const a = await handler("task.create", { project: repo, title: "A", prompt: "p" }, NOOP_CONN) as {
    id: string;
  };
  // 受付順の FIFO は created_at（ミリ秒精度）で、同じミリ秒に作られると id（ランダムな UUID）で
  // 決まる。A が先に admit される前提を運に任せないよう、B の優先度を下げて順序を固定する。
  const b = await handler(
    "task.create",
    { project: repo, title: "B", prompt: "p", priority: 3 },
    NOOP_CONN,
  ) as { id: string };

  await tick(ctx);
  await until(
    async () => (await getTask(ctx.db, a.id))?.state === "suspended",
    5000,
    "タスクAが承認待ちで枠を保持した状態になること",
  );
  await tick(ctx);
  assert.equal(
    (await getTask(ctx.db, b.id))?.state,
    "queued",
    "承認待ちの間、同じプロジェクトの次のタスクは走らない",
  );
});

test("失敗したタスクの worktree は残る", async () => {
  const repo = await makeRepo(root, {
    ".doctrine/project.yaml": "defaultWorkflow: fail\nmaxConcurrent: 1\nbaseBranch: main\n",
    ".doctrine/workflows/fail.yaml":
      'name: fail\nsteps:\n  - id: boom\n    type: command\n    run: "exit 9"\n',
  });
  const { ctx, handler } = await context();
  await handler("project.add", { path: repo }, NOOP_CONN);
  const t = await handler("task.create", { project: repo, title: "T", prompt: "p" }, NOOP_CONN) as {
    id: string;
  };
  await tick(ctx);
  await until(
    async () => (await getTask(ctx.db, t.id))?.state === "failed",
    5000,
    "exit 9 するステップで failed に到達すること",
  );

  const row = (await getTask(ctx.db, t.id))!;
  assert.ok(row.worktree_path, "失敗した実行こそ中を見たい");
  await access(row.worktree_path!); // ディスク上に本当に存在する
  assert.equal((await listStepRuns(ctx.db, t.id)).at(-1)?.exit_code, 9);
});

test("完了したタスクは worktree を消すがブランチは残す", async () => {
  const repo = await makeRepo(root, {
    ".doctrine/project.yaml": "defaultWorkflow: simple\nmaxConcurrent: 1\nbaseBranch: main\n",
    ".doctrine/workflows/simple.yaml":
      'name: simple\nsteps:\n  - id: ok\n    type: command\n    run: "echo hi"\n',
  });
  const { ctx, handler } = await context();
  await handler("project.add", { path: repo }, NOOP_CONN);
  const t = await handler("task.create", { project: repo, title: "T", prompt: "p" }, NOOP_CONN) as {
    id: string;
  };
  await tick(ctx);
  await until(
    async () => (await getTask(ctx.db, t.id))?.state === "completed",
    5000,
    "echo だけのワークフローが completed に到達すること",
  );
  await until(
    async () => (await getTask(ctx.db, t.id))?.worktree_path === null,
    5000,
    "未コミット変更が無いので cleanupAfterRun が worktree を削除し切ること",
  );

  const row = (await getTask(ctx.db, t.id))!;
  assert.equal(row.worktree_path, null, "completed の worktree は削除される");
  const { stdout } = await execFileAsync("git", ["-C", repo, "branch", "--list", row.branch]);
  assert.match(stdout, new RegExp(row.branch), "ブランチ自体は残る");
});

const AGENT_ONLY =
  'name: solo\nsteps:\n  - id: work\n    type: agent\n    prompt: "{{ task.prompt }}"\n';

/** agent ステップ1つのワークフローを最後まで走らせ、task.get の stepRuns を返す。 */
async function runSolo(adapter: ReturnType<typeof createMockAdapter>) {
  const repo = await makeRepo(root, {
    ".doctrine/project.yaml": "defaultWorkflow: solo\nmaxConcurrent: 1\nbaseBranch: main\n",
    ".doctrine/workflows/solo.yaml": AGENT_ONLY,
  });
  const { ctx, handler } = await context(adapter);
  await handler("project.add", { path: repo }, NOOP_CONN);
  const t = await handler("task.create", { project: repo, title: "T", prompt: "p" }, NOOP_CONN) as {
    id: string;
  };
  await tick(ctx);
  await until(
    async () => (await getTask(ctx.db, t.id))?.state === "completed",
    5000,
    "agent ステップ1つのワークフローが completed に到達すること",
  );
  await until(() => ctx.running.size === 0);
  const detail = await handler("task.get", { task_id: t.id }, NOOP_CONN) as TaskDetail;
  return detail.stepRuns;
}

test("権限拒否を含む実行は task.get から中身が読める", async () => {
  const denial = {
    tool_name: "Bash",
    tool_use_id: "tu_1",
    input: { command: "git push origin main" },
  };
  const runs = await runSolo(createMockAdapter({
    result: { ok: true, text: "やれませんでした", permissionDenials: [denial] },
  }));
  const work = runs.find((r) => r.step_id === "work")!;
  assert.equal(work.status, "success", "拒否があっても成功は成功");
  assert.deepEqual(work.permission_denials, { total: 1, denials: [denial] });
});

test("拒否が無い実行の permission_denials は null", async () => {
  const runs = await runSolo(createMockAdapter({ result: { ok: true, text: "やりました" } }));
  assert.ok(runs.length > 0);
  for (const r of runs) assert.equal(r.permission_denials, null);
});
