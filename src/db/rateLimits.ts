import type { DatabaseSync } from "node:sqlite";

export type RateLimitRow = {
  id: number; observed_at: string; window: string; utilization: number; resets_at: string | null;
};

export function insertRateLimitSample(
  db: DatabaseSync, s: { window: string; utilization: number; resets_at: string | null },
): void {
  db.prepare(
    "INSERT INTO rate_limit_samples (observed_at, window, utilization, resets_at) VALUES (?, ?, ?, ?)",
  ).run(new Date().toISOString(), s.window, s.utilization, s.resets_at);
}

export function recentRateLimitSamples(db: DatabaseSync, limit: number): RateLimitRow[] {
  return db.prepare("SELECT * FROM rate_limit_samples ORDER BY id DESC LIMIT ?")
    .all(limit) as RateLimitRow[];
}
