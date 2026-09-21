import { afterEach, beforeEach, test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { createMockAdapter } from "../../src/adapter/mock.ts";
import { getIntake, listIntakeRuns } from "../../src/db/intakes.ts";
import { insertTask } from "../../src/db/tasks.ts";
import {
  currentUsage,
  hasActiveRateLimit,
  releaseDueIntakeRateLimited,
  selectAdmissible,
} from "../../src/domain/scheduler.ts";
import { claimIntakeRun, enqueueIntakeRun, runIntakeRun } from "../../src/intake/runner.ts";
import {
  createFixture,
  depsOf,
  destroyFixture,
  drive,
  type Fixture,
  pfdOut,
  question,
  questionsOut,
} from "./runnerHelper.ts";
import { example } from "./pfd/fixture.ts";

let f: Fixture;
beforeEach(async () => {
  f = await createFixture();
});
afterEach(async () => {
  await destroyFixture(f);
});

const opts = { logRoot: "", resume: false };
const minutesLater = (n: number) => new Date(Date.now() + n * 60_000);

const limitEvent = (resetsAt: string) => ({
  kind: "rateLimit" as const,
  window: "five_hour",
  utilization: 1,
  resetsAt,
});

test("(d) 実行中は全体の実行枠を 1 つ消費する", async () => {
  const adapter = createMockAdapter({ result: questionsOut([question("q1")]), delayMs: 200 });
  const id = await enqueueIntakeRun(f.db, "i1", "investigate", { ...opts, logRoot: f.logRoot });
  assert.ok(await claimIntakeRun(f.db, id));

  const running = runIntakeRun(f.db, id, depsOf(f, adapter));
  const during = await currentUsage(f.db);
  assert.equal(during.global, 1);
  assert.equal(during.byProject.size, 0);

  await insertTask(f.db, {
    id: "t1",
    project_id: f.projectId,
    title: "t",
    prompt: "p",
    workflow_name: "f",
    branch: "b/t1",
    priority: 2,
  });
  assert.deepEqual(await selectAdmissible(f.db, 1), []);

  await running;
  assert.equal((await currentUsage(f.db)).global, 0);
  assert.equal((await selectAdmissible(f.db, 1)).length, 1);
});

test("上限に当たったら待ち、明けた後に同じ purpose で再開する", async () => {
  const resetsAt = minutesLater(10).toISOString();
  const adapter = createMockAdapter({
    result: {},
    sequence: [{ ok: false }, questionsOut([question("q1")])],
    eventsSequence: [[limitEvent(resetsAt)]],
  });
  const deps = depsOf(f, adapter);
  const id = await enqueueIntakeRun(f.db, "i1", "investigate", { ...opts, logRoot: f.logRoot });
  assert.ok(await claimIntakeRun(f.db, id));
  await runIntakeRun(f.db, id, deps);

  const waiting = (await getIntake(f.db, "i1"))!;
  const [first] = await listIntakeRuns(f.db, "i1");
  assert.equal(first.status, "rate_limited");
  assert.notEqual(waiting.rate_limited_until, null);
  assert.equal(waiting.state, "investigating");
  // 最初の呼び出しが弾かれたので、会話の記録は消える
  assert.equal(waiting.claude_session_id, null);
  assert.equal(await hasActiveRateLimit(f.db), true);

  const released = await releaseDueIntakeRateLimited(f.db, {
    logRoot: f.logRoot,
    now: minutesLater(11),
  });
  assert.deepEqual(released, ["i1"]);
  assert.equal(await hasActiveRateLimit(f.db), false);
  const runs = await listIntakeRuns(f.db, "i1");
  assert.equal(runs[1].status, "queued");
  assert.equal(runs[1].attempt, first.attempt);

  await drive(f.db, deps);
  assert.equal((await getIntake(f.db, "i1"))!.state, "answering");
  assert.equal(adapter.calls[1].kind, "start");
});

test("上限待ちが会話の途中なら同じ会話で再開する", async () => {
  const resetsAt = minutesLater(10).toISOString();
  const adapter = createMockAdapter({
    result: {},
    sequence: [questionsOut([]), { ok: false }, pfdOut(example())],
    eventsSequence: [[], [limitEvent(resetsAt)]],
  });
  const deps = depsOf(f, adapter);
  await enqueueIntakeRun(f.db, "i1", "investigate", { ...opts, logRoot: f.logRoot });
  await drive(f.db, deps);

  const waiting = (await getIntake(f.db, "i1"))!;
  assert.equal(waiting.state, "decomposing");
  assert.notEqual(waiting.rate_limited_until, null);
  assert.notEqual(waiting.claude_session_id, null, "会話ができているので記録は残す");

  await releaseDueIntakeRateLimited(f.db, { logRoot: f.logRoot, now: minutesLater(11) });
  await drive(f.db, deps);

  assert.equal((await getIntake(f.db, "i1"))!.state, "reviewing");
  assert.equal(adapter.calls[2].kind, "resume");
  assert.equal(adapter.calls[2].sessionId, adapter.calls[0].sessionId);
  assert.equal(adapter.calls[2].prompt, adapter.calls[1].prompt);
});

test("上限に連続して当たり続けたら要確認にする", async () => {
  const resetsAt = minutesLater(10).toISOString();
  const adapter = createMockAdapter({
    result: { ok: false },
    events: [limitEvent(resetsAt)],
  });
  const deps = depsOf(f, adapter);
  await enqueueIntakeRun(f.db, "i1", "investigate", { ...opts, logRoot: f.logRoot });
  for (let i = 0; i < 5; i++) {
    await drive(f.db, deps);
    assert.equal((await getIntake(f.db, "i1"))!.state, "investigating");
    await releaseDueIntakeRateLimited(f.db, { logRoot: f.logRoot, now: minutesLater(11) });
  }
  await drive(f.db, deps);

  const intake = (await getIntake(f.db, "i1"))!;
  assert.equal(intake.state, "needs_attention");
  assert.equal(intake.rate_limited_until, null);
  assert.equal(await hasActiveRateLimit(f.db), false);
});
