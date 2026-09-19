import type { RateLimitObservation } from "../adapter/types.ts";
import type { Db, RateLimitRow } from "./schema.ts";

export type { RateLimitRow } from "./schema.ts";

export async function insertRateLimitSample(
  db: Db,
  s: { window: string; utilization: number; resets_at: string | null },
): Promise<void> {
  await db.insertInto("rate_limit_samples")
    .values({ ...s, observed_at: new Date().toISOString() })
    .execute();
}

export function recentRateLimitSamples(db: Db, limit: number): Promise<RateLimitRow[]> {
  return db.selectFrom("rate_limit_samples").selectAll().orderBy("id", "desc").limit(limit)
    .execute();
}

/**
 * since 以降に観測された行を、window ごとに最新1件だけ返す。
 * この表はタスク横断・実行横断の1本で、行はタスクIDも step_run_id も持たないので、
 * 「上限に当たったか」の代替根拠に使うときは必ず実行開始時刻で絞る
 * （絞らないと、別のタスクが残した飽和行で無関係な失敗まで上限扱いになる）。
 */
export async function rateLimitsObservedSince(
  db: Db,
  since: string,
): Promise<RateLimitObservation[]> {
  const rows = await db.selectFrom("rate_limit_samples").selectAll()
    .where("observed_at", ">=", since)
    .orderBy("id", "asc")
    .execute();
  const latest = new Map<string, RateLimitObservation>();
  for (const r of rows) {
    latest.set(r.window, {
      window: r.window,
      utilization: r.utilization,
      resetsAt: r.resets_at,
    });
  }
  return [...latest.values()];
}
