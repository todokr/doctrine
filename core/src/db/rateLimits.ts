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
