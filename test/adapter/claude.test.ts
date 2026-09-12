import { test } from "vitest";
import assert from "node:assert/strict";
import { buildArgs, normalize, resultFrom } from "../../src/adapter/claude.ts";

test("起動フラグは実測した契約どおりに並ぶ", () => {
  const args = buildArgs("やって", {
    cwd: "/wt", sessionId: "11111111-1111-4111-8111-111111111111",
    permissionMode: "acceptEdits", model: "claude-opus-5",
  });
  assert.deepEqual(args, [
    "-p", "やって",
    "--output-format", "stream-json",
    "--verbose",
    "--session-id", "11111111-1111-4111-8111-111111111111",
    "--permission-mode", "acceptEdits",
    "--permission-prompts", "none",
    "--model", "claude-opus-5",
  ]);
});

test("stream-json には必ず --verbose が付く", () => {
  const args = buildArgs("x", { cwd: "/wt", sessionId: "s" });
  const i = args.indexOf("--output-format");
  assert.ok(i !== -1 && args.includes("--verbose"),
    "--verbose がないと 'requires --verbose' で即座に終了する");
});

test("再開は --resume を使い --fork-session を使わない", () => {
  const args = buildArgs("追加で直して", { cwd: "/wt", sessionId: "s1" }, "s1");
  assert.ok(args.includes("--resume"));
  assert.equal(args.includes("--fork-session"), false);
});

test("rate_limit_event を正規化する", () => {
  const ev = normalize({
    type: "rate_limit_event",
    rate_limit_info: {
      status: "allowed", rateLimitType: "five_hour",
      unifiedWindows: {
        five_hour: { utilization: 0.14, resetsAt: "2026-09-12T05:00:00Z" },
        seven_day: { utilization: 0.04, resetsAt: "2026-09-19T00:00:00Z" },
      },
    },
  });
  assert.deepEqual(ev, [
    { kind: "rateLimit", window: "five_hour", utilization: 0.14, resetsAt: "2026-09-12T05:00:00Z" },
    { kind: "rateLimit", window: "seven_day", utilization: 0.04, resetsAt: "2026-09-19T00:00:00Z" },
  ]);
});

test("result 行から成否・テキスト・コストを取る", () => {
  const r = resultFrom({
    type: "result", subtype: "success", is_error: false,
    result: "できました", total_cost_usd: 0.42, num_turns: 7, duration_ms: 12000,
    permission_denials: [], terminal_reason: "completed",
  }, 0);
  assert.equal(r.ok, true);
  assert.equal(r.degraded, false);
  assert.equal(r.text, "できました");
  assert.equal(r.costUsd, 0.42);
  assert.equal(r.numTurns, 7);
  assert.equal(r.durationMs, 12000);
});

test("permission_denials が空でなければ degraded", () => {
  const r = resultFrom({
    type: "result", subtype: "success", is_error: false, result: "やれませんでした",
    permission_denials: [{ tool_name: "Bash" }],
  }, 0);
  assert.equal(r.ok, true, "ワークフローは止めない");
  assert.equal(r.degraded, true, "成功に見えるが何もできていない実行を区別する");
});

test("result 行が来なければ失敗とみなす", () => {
  const r = resultFrom(undefined, 1);
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 1);
});

test("is_error が true なら失敗", () => {
  const r = resultFrom({ type: "result", subtype: "error", is_error: true, result: "だめ" }, 0);
  assert.equal(r.ok, false);
});
