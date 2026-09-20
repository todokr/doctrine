import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { createMockAdapter } from "../../src/adapter/mock.ts";

test("start/resume の呼び出しを kind 付きで記録する", async () => {
  const adapter = createMockAdapter({ result: {} });
  adapter.start("最初の指示", { cwd: "/wt", sessionId: "s1" });
  adapter.resume("s1", "追加の指示", { cwd: "/wt", sessionId: "s1" });
  assert.equal(adapter.calls.length, 2);
  assert.equal(adapter.calls[0].kind, "start");
  assert.equal(adapter.calls[0].prompt, "最初の指示");
  assert.equal(adapter.calls[1].kind, "resume");
  assert.equal(adapter.calls[1].prompt, "追加の指示");
});

test("sequence は通算呼び出し回数で結果を切り替える", async () => {
  const adapter = createMockAdapter({
    result: { ok: true },
    sequence: [{ ok: true, text: "1回目" }, { ok: false, text: "2回目" }],
  });
  const r1 = await adapter.start("a", { cwd: "/wt", sessionId: "s1" }).result;
  const r2 = await adapter.start("b", { cwd: "/wt", sessionId: "s2" }).result;
  assert.equal(r1.text, "1回目");
  assert.equal(r1.ok, true);
  assert.equal(r2.text, "2回目");
  assert.equal(r2.ok, false);
});

test("result は DEFAULT にスクリプトの部分指定をマージしたもの", async () => {
  const adapter = createMockAdapter({ result: { degraded: true } });
  const r = await adapter.start("x", { cwd: "/wt", sessionId: "s1" }).result;
  assert.equal(r.ok, true); // DEFAULT 由来
  assert.equal(r.degraded, true); // スクリプト由来
  assert.equal(r.costUsd, 0); // DEFAULT 由来
});

test("eventsSequence は呼び出しごとに違うイベントを流す", async () => {
  const adapter = createMockAdapter({
    events: [{ kind: "result" }],
    result: {},
    eventsSequence: [
      [{
        kind: "rateLimit",
        window: "five_hour",
        utilization: 1,
        resetsAt: "2026-09-19T03:20:00Z",
      }],
      [{ kind: "assistant", text: "2回目" }],
    ],
  });
  const collect = async (run: { events: AsyncIterable<unknown> }) => {
    const out = [];
    for await (const ev of run.events) out.push(ev);
    return out;
  };
  assert.deepEqual(await collect(adapter.start("a", { cwd: "/wt", sessionId: "s1" })), [
    { kind: "rateLimit", window: "five_hour", utilization: 1, resetsAt: "2026-09-19T03:20:00Z" },
  ]);
  assert.deepEqual(await collect(adapter.resume("s1", "b", { cwd: "/wt", sessionId: "s1" })), [
    { kind: "assistant", text: "2回目" },
  ]);
  assert.deepEqual(
    await collect(adapter.resume("s1", "c", { cwd: "/wt", sessionId: "s1" })),
    [{ kind: "result" }],
    "範囲を越えたら events に戻る",
  );
});

test("DEFAULT の structuredOutput は null", async () => {
  const run = createMockAdapter({ result: {} }).start("x", { cwd: "/wt", sessionId: "s1" });
  const r = await run.result;
  assert.equal(r.structuredOutput, null);
});

test("events はスクリプトどおりに流れる", async () => {
  const adapter = createMockAdapter({
    events: [{ kind: "assistant", text: "こんにちは" }],
    result: {},
  });
  const run = adapter.start("x", { cwd: "/wt", sessionId: "s1" });
  const out = [];
  for await (const ev of run.events) out.push(ev);
  assert.deepEqual(out, [{ kind: "assistant", text: "こんにちは" }]);
});
