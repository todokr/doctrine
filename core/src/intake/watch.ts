import type { PrFact } from "../../../shared/intake/github.ts";
import { getPrObservation, upsertPrObservation } from "../db/intakes.ts";
import type { Db, ProjectRow } from "../db/schema.ts";
import type { PrWatcher } from "../github/tracker.ts";

/**
 * 1 ブランチの PR から 1 つを選ぶ。
 * 優先度: baseBranch へマージされたもの > OPEN > number が最大のもの。空なら null。
 */
export function choosePr(facts: readonly PrFact[], baseBranch: string): PrFact | null {
  const byNumber = [...facts].sort((a, b) => b.number - a.number);
  return byNumber.find((f) => f.state === "MERGED" && f.baseRef === baseBranch) ??
    byNumber.find((f) => f.state === "OPEN") ??
    byNumber[0] ?? null;
}

export type ObserveReport = { changedIntakeIds: Set<string> };

/**
 * プロジェクトの active な Intake について、current_task_id のタスクのうち、
 * baseBranch へのマージがまだ観測されていないものの PR を、pullRequests の 1 回の呼び出しで引く。
 * 選んだ PR が前回の観測と違えば upsertPrObservation する。PR が無いタスクは書かない
 * （status.ts がタスクの状態から no_pr を出す）。対象が無ければ gh を呼ばない。
 * pullRequests の失敗はそのまま投げる。
 */
export async function observePullRequests(
  db: Db,
  prWatcher: PrWatcher,
  project: ProjectRow,
): Promise<ObserveReport> {
  const report: ObserveReport = { changedIntakeIds: new Set() };
  // 観測が無い行は o.state が null になるので、「マージ済みでない」は null も含めて数える
  const targets = await db.selectFrom("intake_processes as p")
    .innerJoin("intakes as i", "i.id", "p.intake_id")
    .innerJoin("tasks as t", "t.id", "p.current_task_id")
    .leftJoin("pr_observations as o", "o.task_id", "t.id")
    .select(["i.id as intake_id", "t.id as task_id", "t.branch as branch"])
    .where("i.state", "=", "active")
    .where("i.project_id", "=", project.id)
    .where("p.retired_at", "is", null)
    .where((eb) =>
      eb.or([
        eb("o.state", "is", null),
        eb("o.state", "!=", "MERGED"),
        eb("o.base_ref", "!=", project.base_branch),
      ])
    )
    .orderBy("t.created_at").orderBy("t.id")
    .execute();
  if (targets.length === 0) return report;

  const found = await prWatcher.pullRequests(project.path, targets.map((t) => t.branch));
  for (const t of targets) {
    const chosen = choosePr(found.get(t.branch) ?? [], project.base_branch);
    if (chosen === null) continue;
    const before = await getPrObservation(db, t.task_id);
    if (
      before && before.pr_number === chosen.number && before.state === chosen.state &&
      before.base_ref === chosen.baseRef && before.merged_at === chosen.mergedAt &&
      before.merge_commit === chosen.mergeCommit
    ) continue;
    await upsertPrObservation(db, {
      task_id: t.task_id,
      pr_number: chosen.number,
      pr_url: chosen.url,
      state: chosen.state,
      base_ref: chosen.baseRef,
      merged_at: chosen.mergedAt,
      merge_commit: chosen.mergeCommit,
    });
    report.changedIntakeIds.add(t.intake_id);
  }
  return report;
}
