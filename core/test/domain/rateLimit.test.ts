import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import {
  classifyRateLimit,
  consecutiveRateLimited,
  MAX_CONSECUTIVE_RATE_LIMITS,
  MAX_WAIT_MS,
  MIN_WAIT_MS,
  normalizeResetsAt,
  parseResetsAt,
} from "../../src/domain/rateLimit.ts";
import type { RateLimitObservation } from "../../src/adapter/types.ts";

const NOW = new Date("2026-09-19T03:10:00.000Z");
const RESETS = "2026-09-19T03:20:00.000Z";

const saturated = (o: Partial<RateLimitObservation> = {}): RateLimitObservation => ({
  window: "five_hour",
  utilization: 1,
  resetsAt: RESETS,
  ...o,
});

function classify(o: {
  status?: "success" | "failed" | "degraded" | "suspended";
  observed?: RateLimitObservation[];
  samples?: RateLimitObservation[];
  now?: Date;
}) {
  return classifyRateLimit({
    status: o.status ?? "failed",
    observed: o.observed ?? [],
    samples: o.samples ?? [],
    now: o.now ?? NOW,
  });
}

test("飽和したイベントと失敗が揃えば、resetsAt まで待つ", () => {
  assert.deepEqual(classify({ observed: [saturated()] }), {
    kind: "wait",
    until: RESETS,
    resetsAt: RESETS,
  });
});

test("utilization が閾値未満なら上限ではない", () => {
  assert.deepEqual(classify({ observed: [saturated({ utilization: 0.99 })] }), { kind: "none" });
});

test("成功・degraded・suspended の実行は上限扱いしない", () => {
  for (const status of ["success", "degraded", "suspended"] as const) {
    assert.deepEqual(classify({ status, observed: [saturated()] }), { kind: "none" }, status);
  }
});

test("resetsAt が無い・過去・空文字・不正な文字列なら待てないので上限扱いしない", () => {
  for (const resetsAt of [null, "2026-09-19T03:00:00.000Z", "", "いつか", "NaN"]) {
    assert.deepEqual(
      classify({ observed: [saturated({ resetsAt })] }),
      { kind: "none" },
      String(resetsAt),
    );
  }
});

test("resetsAt が epoch の数値・数字だけの文字列でも読む", () => {
  const sec = Math.floor(Date.parse(RESETS) / 1000);
  for (const resetsAt of [sec, String(sec), Date.parse(RESETS), String(Date.parse(RESETS))]) {
    assert.deepEqual(
      // 型注釈は string だが、実データが数値で来ても判定が黙って止まらないことを固定する
      classify({ observed: [saturated({ resetsAt: resetsAt as unknown as string })] }),
      { kind: "wait", until: RESETS, resetsAt: RESETS },
      String(resetsAt),
    );
  }
});

test("小数付きの epoch 秒の文字列（TEXT 列に数値を bind した形）を秒として読む", () => {
  assert.equal(parseResetsAt("1789828800.0"), 1789828800000);
  assert.equal(parseResetsAt("1789828800.5"), 1789828800500);
  for (const v of ["1789828800.", ".5", "1.2.3", "-1789828800.0"]) {
    assert.equal(parseResetsAt(v), null, v);
  }
});

test("代替根拠の resetsAt が小数付きの epoch 秒の文字列でも、上限として待つ", () => {
  const sec = Math.floor(Date.parse(RESETS) / 1000);
  assert.deepEqual(classify({ samples: [saturated({ resetsAt: `${sec}.0` })] }), {
    kind: "wait",
    until: RESETS,
    resetsAt: RESETS,
  });
  const far = Math.floor((NOW.getTime() + MAX_WAIT_MS + 60_000) / 1000);
  assert.equal(classify({ samples: [saturated({ resetsAt: `${far}.0` })] }).kind, "too-long");
});

test("normalizeResetsAt はどの形の生値も ISO 8601 にし、読めない値は null にする", () => {
  const sec = Math.floor(Date.parse(RESETS) / 1000);
  for (const v of [sec, `${sec}.0`, String(sec), Date.parse(RESETS), RESETS]) {
    assert.equal(normalizeResetsAt(v), RESETS, String(v));
  }
  for (const v of [null, undefined, "", "いつか", Number.NaN]) {
    assert.equal(normalizeResetsAt(v), null, String(v));
  }
});

test("飽和した window が複数あるなら遅い方まで待つ", () => {
  const late = "2026-09-19T08:00:00.000Z";
  assert.deepEqual(
    classify({
      observed: [saturated(), saturated({ window: "seven_day", resetsAt: late })],
    }),
    { kind: "wait", until: late, resetsAt: late },
  );
});

test("飽和していない window は無視する", () => {
  assert.deepEqual(
    classify({
      observed: [
        saturated({ window: "seven_day", utilization: 0.2, resetsAt: "2026-09-26T00:00:00.000Z" }),
        saturated(),
      ],
    }),
    { kind: "wait", until: RESETS, resetsAt: RESETS },
  );
});

test("6時間より先の resetsAt は待たない", () => {
  const far = new Date(NOW.getTime() + MAX_WAIT_MS + 1000).toISOString();
  assert.deepEqual(classify({ observed: [saturated({ resetsAt: far })] }), {
    kind: "too-long",
    resetsAt: far,
  });
});

test("resetsAt が目前でも最低60秒は待つ", () => {
  const soon = new Date(NOW.getTime() + 1000).toISOString();
  assert.deepEqual(classify({ observed: [saturated({ resetsAt: soon })] }), {
    kind: "wait",
    until: new Date(NOW.getTime() + MIN_WAIT_MS).toISOString(),
    resetsAt: soon,
  });
});

test("イベントが1件も無ければ、実行開始以降のサンプルで同じ判定をする", () => {
  assert.deepEqual(classify({ samples: [saturated()] }), {
    kind: "wait",
    until: RESETS,
    resetsAt: RESETS,
  });
});

test("イベントを受け取っていればサンプルは見ない", () => {
  assert.deepEqual(
    classify({
      observed: [saturated({ utilization: 0.3 })],
      samples: [saturated()],
    }),
    { kind: "none" },
    "その実行が受け取ったイベントが飽和していないなら、他の実行が残した行で上書きしない",
  );
});

test("どちらの材料にも飽和が無ければ、今までどおりの失敗", () => {
  assert.deepEqual(classify({}), { kind: "none" });
});

test("そのステップの末尾に並ぶ rate_limited の数を数える", () => {
  const runs = [
    { step_id: "implement", status: "failed" as const },
    { step_id: "implement", status: "rate_limited" as const },
    { step_id: "test", status: "failed" as const },
    { step_id: "implement", status: "rate_limited" as const },
  ];
  assert.equal(consecutiveRateLimited(runs, "implement"), 2, "他のステップの行は間に挟めない");
  assert.equal(consecutiveRateLimited(runs, "test"), 0);
  assert.equal(
    consecutiveRateLimited([...runs, { step_id: "implement", status: "success" }], "implement"),
    0,
    "上限以外で終わった実行が間に入れば連続は切れる",
  );
  assert.equal(consecutiveRateLimited([], "implement"), 0);
});

test("連続して上限に当たれる回数には上限がある", () => {
  assert.equal(MAX_CONSECUTIVE_RATE_LIMITS, 5);
});
