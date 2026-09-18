import { afterEach, beforeEach, test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/db/migrate.ts";
import {
  logPathFor,
  runAgentStep,
  runCommandStep,
  type RunnerDeps,
} from "../../src/core/stepRunner.ts";
import { createMockAdapter } from "../../src/adapter/mock.ts";
import type { TemplateContext } from "../../src/workflow/template.ts";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "doctrine-run-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const ctx: TemplateContext = {
  task: { id: "t1", title: "T", prompt: "直して", branch: "doctrine/t1-t" },
  worktree: { path: "/wt" },
  project: { path: "/repo" },
  steps: {},
};

async function deps(over: Partial<RunnerDeps> = {}): Promise<RunnerDeps> {
  return {
    db: await openDb(":memory:"),
    adapter: createMockAdapter({ result: { ok: true, text: "やりました" } }),
    logRoot: join(root, "logs"),
    ...over,
  };
}

test("成功した command は success", async () => {
  const out = await runCommandStep(
    { id: "s", type: "command", run: "echo hello" },
    ctx,
    { cwd: root, taskId: "t1", attempt: 1, deps: await deps() },
  );
  assert.equal(out.status, "success");
  assert.equal(out.exitCode, 0);
  assert.match(out.stdout, /hello/);
});

test("非0終了でステップ失敗", async () => {
  const out = await runCommandStep(
    { id: "s", type: "command", run: "exit 3" },
    ctx,
    { cwd: root, taskId: "t1", attempt: 1, deps: await deps() },
  );
  assert.equal(out.status, "failed");
  assert.equal(out.exitCode, 3);
});

test("コマンドの変数は実行前に展開される", async () => {
  const out = await runCommandStep(
    { id: "s", type: "command", run: "echo {{ task.branch }}" },
    ctx,
    { cwd: root, taskId: "t1", attempt: 1, deps: await deps() },
  );
  assert.match(out.stdout, /doctrine\/t1-t/);
});

test("ログ本文はファイルに書かれる", async () => {
  const d = await deps();
  const out = await runCommandStep(
    { id: "s", type: "command", run: "echo ログ行" },
    ctx,
    { cwd: root, taskId: "t1", attempt: 2, deps: d },
  );
  assert.equal(out.logPath, logPathFor(d.logRoot, "t1", "s", 2));
  assert.match(await readFile(out.logPath, "utf8"), /ログ行/);
});

test("agent ステップは最終テキストを stdout にする", async () => {
  const adapter = createMockAdapter({
    result: { ok: true, text: "できました", costUsd: 0.3, numTurns: 4 },
  });
  const out = await runAgentStep(
    { id: "a", type: "agent", prompt: "{{ task.prompt }}" },
    ctx,
    {
      cwd: root,
      taskId: "t1",
      attempt: 1,
      sessionId: "s1",
      resume: false,
      deps: await deps({ adapter }),
    },
  );
  assert.equal(out.status, "success");
  assert.equal(out.stdout, "できました");
  assert.equal(out.costUsd, 0.3);
  assert.equal(adapter.calls[0].kind, "start");
  assert.equal(adapter.calls[0].prompt, "直して", "プロンプトの変数が展開されている");
});

test("resume: true なら resume が呼ばれる", async () => {
  const adapter = createMockAdapter({ result: { ok: true, text: "続きです" } });
  await runAgentStep(
    { id: "a", type: "agent", prompt: "{{ task.prompt }} を直して" },
    ctx,
    {
      cwd: root,
      taskId: "t1",
      attempt: 2,
      sessionId: "s1",
      resume: true,
      deps: await deps({ adapter }),
    },
  );
  assert.equal(adapter.calls[0].kind, "resume");
  assert.equal(adapter.calls[0].sessionId, "s1");
  assert.equal(
    adapter.calls[0].prompt,
    "直して を直して",
    "resume でもプロンプトの変数が展開されている",
  );
});

test("permission_denials があれば degraded として返る", async () => {
  const adapter = createMockAdapter({ result: { ok: true, degraded: true, text: "何もできず" } });
  const out = await runAgentStep(
    { id: "a", type: "agent", prompt: "p" },
    ctx,
    {
      cwd: root,
      taskId: "t1",
      attempt: 1,
      sessionId: "s1",
      resume: false,
      deps: await deps({ adapter }),
    },
  );
  assert.equal(out.status, "degraded", "成功に見えるが何もできていない実行を区別する");
});

test("子プロセスのpidと開始時刻が通知される", async () => {
  const seen: { pid: number; startedAt: string }[] = [];
  const d = await deps({
    onChildSpawned: (pid, startedAt) => {
      seen.push({ pid, startedAt });
    },
  });
  await runAgentStep(
    { id: "a", type: "agent", prompt: "p" },
    ctx,
    { cwd: root, taskId: "t1", attempt: 1, sessionId: "s1", resume: false, deps: d },
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0].pid, 424242, "モックが返す実際のpidと一致する（>0だけでは不十分）");
  assert.ok(Date.parse(seen[0].startedAt) > 0);
});

test("rate_limit イベントが通知される", async () => {
  const samples: { window: string; utilization: number }[] = [];
  const adapter = createMockAdapter({
    events: [{ kind: "rateLimit", window: "five_hour", utilization: 0.14, resetsAt: null }],
    result: { ok: true, text: "" },
  });
  await runAgentStep(
    { id: "a", type: "agent", prompt: "p" },
    ctx,
    {
      cwd: root,
      taskId: "t1",
      attempt: 1,
      sessionId: "s1",
      resume: false,
      deps: await deps({
        adapter,
        onRateLimit: (s) => {
          samples.push(s);
        },
      }),
    },
  );
  assert.deepEqual(samples, [{ window: "five_hour", utilization: 0.14, resetsAt: null }]);
});

test("command ステップでも子プロセスのpidと開始時刻が通知される", async () => {
  const seen: { pid: number; startedAt: string }[] = [];
  const d = await deps({
    onChildSpawned: (pid, startedAt) => {
      seen.push({ pid, startedAt });
    },
  });
  await runCommandStep(
    { id: "s", type: "command", run: "echo x" },
    ctx,
    { cwd: root, taskId: "t1", attempt: 1, deps: d },
  );
  assert.equal(seen.length, 1);
  assert.ok(seen[0].pid > 0);
  assert.ok(Date.parse(seen[0].startedAt) > 0);
});

test("stdout はexitではなくcloseまで待ってから確定する（大量出力の取りこぼしがない）", async () => {
  const n = 200000;
  const out = await runCommandStep(
    { id: "s", type: "command", run: `yes | head -c ${n}` },
    ctx,
    { cwd: root, taskId: "t1", attempt: 1, deps: await deps() },
  );
  assert.equal(out.stdout.length, n);
  const logged = await readFile(out.logPath, "utf8");
  assert.equal(logged.length, n);
});

test("run に未知の変数を使うとTemplateErrorが伝播する（握りつぶさない）", async () => {
  await assert.rejects(
    runCommandStep(
      { id: "s", type: "command", run: "echo {{ nope.nope }}" },
      ctx,
      { cwd: root, taskId: "t1", attempt: 1, deps: await deps() },
    ),
  );
});

test("ログ先が書き込み不能でもステップの実行結果には影響しない", async () => {
  // logRoot の親をディレクトリではなくファイルにして、
  // ログファイル用の mkdir/createWriteStream を確実に失敗させる。
  const blocker = join(root, "blocker");
  await writeFile(blocker, "not a directory");
  const d = await deps({ logRoot: join(blocker, "logs") });

  const out = await runCommandStep(
    { id: "s", type: "command", run: "echo hello" },
    ctx,
    { cwd: root, taskId: "t1", attempt: 1, deps: d },
  );

  assert.equal(out.status, "success");
  assert.match(out.stdout, /hello/);
});

test("失敗したagentステップは stderrTail を stderr として返す", async () => {
  const adapter = createMockAdapter({
    result: { ok: false, text: "", stderrTail: "Error: something went wrong\n" },
  });
  const out = await runAgentStep(
    { id: "a", type: "agent", prompt: "p" },
    ctx,
    {
      cwd: root,
      taskId: "t1",
      attempt: 1,
      sessionId: "s1",
      resume: false,
      deps: await deps({ adapter }),
    },
  );
  assert.equal(out.status, "failed");
  assert.equal(out.stderr, "Error: something went wrong\n");
});
