import { afterEach, beforeEach, test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/db/migrate.ts";
import { getTask } from "../../src/db/tasks.ts";
import {
  createHandler,
  type DaemonContext,
  loadWorkflowFromDisk,
  tick,
} from "../../src/daemon/handlers.ts";
import { createMockAdapter } from "../../src/adapter/mock.ts";
import type { ServerEvent } from "../../src/daemon/protocol.ts";
import { makeRepo, tickWhenIdle, until } from "../helpers/repo.ts";
import type { ReviewFile } from "../../src/core/reviewFiles.ts";
import type { CommandResult, ReviewEntry } from "../../src/core/taskContext.ts";

const NOOP_CONN = { follow() {}, unfollow() {}, isFollowing: () => false };
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "doctrine-taskctx-e2e-"));
  process.env.DOCTRINE_STATE_DIR = join(root, "state");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  delete process.env.DOCTRINE_STATE_DIR;
});

/** 計画を .doctrine-out/plan.md に書き、その計画を承認させるワークフロー。 */
const GUIDED = `
name: guided
steps:
  - id: plan
    type: command
    run: "mkdir -p .doctrine-out && printf '# 計画\\n\\n1. 引当をトランザクションに入れる\\n' > .doctrine-out/plan.md"
  - id: plan-approval
    type: approval
    title: "計画を確認してください"
    onReject:
      goto: plan
      maxAttempts: 5
    review:
      files:
        - .doctrine-out/plan.md
`;

async function context() {
  const db = await openDb(":memory:");
  const events: ServerEvent[] = [];
  const ctx: DaemonContext = {
    db,
    adapter: createMockAdapter({ result: { ok: true, text: "やりました" } }),
    logRoot: join(root, "logs"),
    globalLimit: 4,
    broadcast: (ev) => events.push(ev),
    loadWorkflow: loadWorkflowFromDisk,
    running: new Set(),
    warnings: [],
  };
  return { ctx, handler: createHandler(ctx) };
}

type Got = {
  prompt: string;
  reviews: ReviewEntry[];
  lastCommand: CommandResult | null;
  lastAgentMessage: string | null;
  reviewFiles: ReviewFile[];
};

test("approval の時点で task.context から計画の本文が取れる（完了条件1）", async () => {
  const repo = await makeRepo(root, {
    "README.md": "x\n",
    ".doctrine/project.yaml": "defaultWorkflow: guided\nmaxConcurrent: 1\nbaseBranch: main\n",
    ".doctrine/workflows/guided.yaml": GUIDED,
  });
  const { ctx, handler } = await context();
  await handler("project.add", { path: repo }, NOOP_CONN);
  const t = await handler(
    "task.create",
    { project: repo, title: "在庫の引当", prompt: "在庫の引当を冪等にして" },
    NOOP_CONN,
  ) as { id: string };

  await tick(ctx);
  await until(
    async () => (await getTask(ctx.db, t.id))?.state === "suspended",
    5000,
    "計画の承認待ちに到達すること",
  );

  const got = await handler("task.context", { task_id: t.id }, NOOP_CONN) as Got;

  assert.equal(got.prompt, "在庫の引当を冪等にして");
  assert.equal(got.reviewFiles.length, 1);
  const [plan] = got.reviewFiles;
  assert.equal(plan.path, ".doctrine-out/plan.md");
  assert.equal(plan.status, "ok");
  if (plan.status !== "ok") throw new Error("unreachable");
  assert.match(plan.content, /引当をトランザクションに入れる/);

  assert.equal(got.lastCommand?.stepId, "plan", "直前に走った command の結果も返る");
  assert.equal(got.lastCommand?.exitCode, 0);
});

test("2回差し戻したタスクで、両方のレビューが返る（完了条件2）", async () => {
  const repo = await makeRepo(root, {
    "README.md": "x\n",
    ".doctrine/project.yaml": "defaultWorkflow: guided\nmaxConcurrent: 1\nbaseBranch: main\n",
    ".doctrine/workflows/guided.yaml": GUIDED,
  });
  const { ctx, handler } = await context();
  await handler("project.add", { path: repo }, NOOP_CONN);
  const t = await handler(
    "task.create",
    { project: repo, title: "T", prompt: "やって" },
    NOOP_CONN,
  ) as { id: string };

  const waitSuspended = (label: string) =>
    until(async () => (await getTask(ctx.db, t.id))?.state === "suspended", 5000, label);

  await tick(ctx);
  await waitSuspended("1回目の承認待ち");
  await handler("task.reject", { task_id: t.id, comment: "手順が粗いです" }, NOOP_CONN);

  await tickWhenIdle(ctx);
  await waitSuspended("2回目の承認待ち");
  await handler(
    "task.reject",
    { task_id: t.id, comment: "ロールバックの話がありません" },
    NOOP_CONN,
  );

  await tickWhenIdle(ctx);
  await waitSuspended("3回目の承認待ち");

  const { reviews } = await handler("task.context", { task_id: t.id }, NOOP_CONN) as Got;

  assert.equal(reviews.length, 3, "却下2回 + まだ決まっていない1回");
  assert.deepEqual(reviews.map((r) => r.status), ["rejected", "rejected", "awaiting"]);
  assert.deepEqual(reviews.map((r) => r.attempt), [1, 2, 3]);
  assert.deepEqual(
    reviews.filter((r) => r.status === "rejected").map((r) => r.comment),
    ["手順が粗いです", "ロールバックの話がありません"],
    "2回目の却下が1回目を上書きしていない",
  );

  for (const r of reviews) {
    if (r.status === "awaiting") {
      assert.equal("endedAt" in r, false, "待機中の回に決定時刻は無い");
      continue;
    }
    assert.ok(
      Date.parse(r.endedAt) >= Date.parse(r.startedAt),
      "待ち時間は endedAt - startedAt で出せる",
    );
  }
});
