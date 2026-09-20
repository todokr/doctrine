import type { RateLimitObservation } from "../adapter/types.ts";
import type { StepRunStatus } from "../db/schema.ts";
import type { StepOutcome } from "./stepRunner.ts";

/**
 * 利用上限に当たった実行を見分け、いつまで待つかを決める（I/O を持たない）。
 * 判定の根拠と各定数の理由は
 * docs/superpowers/specs/2026-09-19-rate-limit-wait-design.md にある。
 */

/** この値に達した window は、もうその枠で実行できない。 */
export const SATURATED_UTILIZATION = 1;

export const MAX_WAIT_MS = 6 * 60 * 60 * 1000;

export const MIN_WAIT_MS = 60 * 1000;

export const MAX_CONSECUTIVE_RATE_LIMITS = 5;

export type RateLimitVerdict =
  /** 上限ではない。今までどおり decide に渡す。 */
  | { kind: "none" }
  /** until（ISO 8601）まで待ってから、同じステップをやり直す。 */
  | { kind: "wait"; until: string; resetsAt: string }
  /** 上限ではあるが、明けるのが遠すぎて待たない。 */
  | { kind: "too-long"; resetsAt: string };

/**
 * resetsAt を時刻として読む。型注釈は string だが、アダプタは claude の JSON を
 * 素通しするので、実データは数値（epoch 秒 / ミリ秒）や空文字であり得る。
 * rate_limit_samples から読んだ値は "1789828800.0" の形で来る（TEXT 列に数値を bind した結果）。
 * 読めないものは null を返し、呼び出し側が「待てない」に倒す。
 */
export function parseResetsAt(v: unknown): number | null {
  const n = typeof v === "number"
    ? v
    : typeof v === "string" && /^\d+(\.\d+)?$/.test(v)
    ? Number(v)
    : null;
  // 1e12 ミリ秒は 2001 年。これより小さい数は秒として読むほかない。
  if (n !== null) return Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : null;
  if (typeof v !== "string") return null;
  // V8 の Date.parse は ".5" や "1.2.3" を日付として読んでしまう。数字の崩れた形は渡さない。
  if (/^\s*[+-]?[\d.]*\s*$/.test(v)) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

/** デーモンの外へ出す形。ISO 8601 か、読めない生値なら null。 */
export function normalizeResetsAt(v: unknown): string | null {
  const at = parseResetsAt(v);
  if (at === null) return null;
  const d = new Date(at);
  // Date の範囲を超える数値は toISOString が投げる。
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function classifyRateLimit(o: {
  status: StepOutcome["status"];
  /** その実行の最中に受け取った rate_limit_event（window ごとの最新）。 */
  observed: RateLimitObservation[];
  /** イベントが1件も来なかったときの代替根拠（実行開始以降に観測された行）。 */
  samples: RateLimitObservation[];
  now: Date;
}): RateLimitVerdict {
  if (o.status !== "failed") return { kind: "none" };

  const source = o.observed.length > 0 ? o.observed : o.samples;
  const now = o.now.getTime();
  let latest: { at: number; resetsAt: string } | null = null;
  for (const w of source) {
    if (w.utilization < SATURATED_UTILIZATION) continue;
    const at = parseResetsAt(w.resetsAt);
    if (at === null || at <= now) continue;
    if (!latest || at > latest.at) latest = { at, resetsAt: new Date(at).toISOString() };
  }
  if (!latest) return { kind: "none" };

  if (latest.at - now > MAX_WAIT_MS) return { kind: "too-long", resetsAt: latest.resetsAt };
  return {
    kind: "wait",
    until: new Date(Math.max(latest.at, now + MIN_WAIT_MS)).toISOString(),
    resetsAt: latest.resetsAt,
  };
}

/**
 * そのステップの末尾に何回連続で上限に当たっているか。カウンタを持たず、
 * step_runs から数える（デーモンの再起動をまたいでも同じ数になる）。
 */
export function consecutiveRateLimited(
  runs: readonly { step_id: string; status: StepRunStatus }[],
  stepId: string,
): number {
  let n = 0;
  for (let i = runs.length - 1; i >= 0; i--) {
    if (runs[i].step_id !== stepId) continue;
    if (runs[i].status !== "rate_limited") break;
    n++;
  }
  return n;
}
