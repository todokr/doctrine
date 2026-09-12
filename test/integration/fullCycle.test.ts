import { test, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/db/migrate.ts";
import { getTask } from "../../src/db/tasks.ts";
import { listStepRuns } from "../../src/db/stepRuns.ts";
import { createHandler, tick, loadWorkflowFromDisk, type DaemonContext } from "../../src/daemon/handlers.ts";
import { createMockAdapter } from "../../src/adapter/mock.ts";
import { makeRepo, until } from "../helpers/repo.ts";

const execFileAsync = promisify(execFile);
const NOOP_CONN = { follow() {}, unfollow() {}, isFollowing: () => false };
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "doctrine-e2e-"));
  process.env.DOCTRINE_STATE_DIR = join(root, "state");
});
afterEach(async () => {
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

function context(adapter = createMockAdapter({ result: { ok: true, text: "やりました" } })) {
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
  const { ctx, handler } = context();
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
  // state が completed になった直後は cleanupAfterRun の後始末（.then チェーン）が
  // まだ走っていないことがある。worktree_path が消えるか警告が積まれるまで待つ。
  await until(() => getTask(ctx.db, t.id)?.worktree_path === null || ctx.warnings.length > 0);

  assert.deepEqual(
    listStepRuns(ctx.db, t.id).map((r) => r.step_id),
    ["setup", "implement", "verify", "review", "record"],
    "承認後は verify までの記録を保ったまま record から再開している（先頭からのやり直しではない）",
  );

  // setup/record が作った marker.txt / result.txt はどちらもコミットされていないので、
  // cleanupAfterRun の worktree 削除は UncommittedChangesError で拒否され、worktree は残る。
  // これはエンジンの不備ではなく、この brief のワークフロー例が commit ステップを
  // 持たないために起きる意図された挙動（未コミットの後始末は黙って削除しない）。
  const wt = getTask(ctx.db, t.id)!.worktree_path;
  assert.ok(wt, "未コミットの変更があるので worktree は残っているはず");
  assert.equal(ctx.warnings.length, 1, "worktree 削除が拒否されたことが警告として記録される");
  assert.match(ctx.warnings[0], /未コミットの変更/);
  assert.match(await readFile(join(wt!, "result.txt"), "utf8"), /done/);
});

test("却下すると実装ステップへ戻り、コメントがエージェントに渡る", async () => {
  const repo = await makeRepo(root, {
    ".doctrine/project.yaml": "setup: touch marker.txt\ndefaultWorkflow: feature\nmaxConcurrent: 1\nbaseBranch: main\n",
    ".doctrine/workflows/feature.yaml": WORKFLOW,
  });
  const adapter = createMockAdapter({ result: { ok: true, text: "やりました" } });
  const { ctx, handler } = context(adapter);
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
  const { ctx, handler } = context();
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
  const { ctx, handler } = context();
  await handler("project.add", { path: repo }, NOOP_CONN);
  const t = await handler("task.create", { project: repo, title: "T", prompt: "p" }, NOOP_CONN) as { id: string };
  await tick(ctx);
  await until(() => getTask(ctx.db, t.id)?.state === "failed");

  const row = getTask(ctx.db, t.id)!;
  assert.ok(row.worktree_path, "失敗した実行こそ中を見たい");
  await access(row.worktree_path!); // ディスク上に本当に存在する
  assert.equal(listStepRuns(ctx.db, t.id).at(-1)?.exit_code, 9);
});

test("完了したタスクは worktree を消すがブランチは残す", async () => {
  const repo = await makeRepo(root, {
    ".doctrine/project.yaml": "defaultWorkflow: simple\nmaxConcurrent: 1\nbaseBranch: main\n",
    ".doctrine/workflows/simple.yaml": "name: simple\nsteps:\n  - id: ok\n    type: command\n    run: \"echo hi\"\n",
  });
  const { ctx, handler } = context();
  await handler("project.add", { path: repo }, NOOP_CONN);
  const t = await handler("task.create", { project: repo, title: "T", prompt: "p" }, NOOP_CONN) as { id: string };
  await tick(ctx);
  await until(() => getTask(ctx.db, t.id)?.state === "completed");
  await until(() => getTask(ctx.db, t.id)?.worktree_path === null);

  const row = getTask(ctx.db, t.id)!;
  assert.equal(row.worktree_path, null, "completed の worktree は削除される");
  const { stdout } = await execFileAsync("git", ["-C", repo, "branch", "--list", row.branch]);
  assert.match(stdout, new RegExp(row.branch), "ブランチ自体は残る");
});
