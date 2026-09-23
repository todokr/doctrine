import { listProcesses } from "../db/intakes.ts";
import type { Db, IntakeProcessRow } from "../db/schema.ts";
import type { Pfd } from "../../../shared/intake/pfd.ts";
import { type ApprovedPlan, loadApprovedPlan } from "./dispatch.ts";
import { type FrozenPart, frozenPart, validatePfd } from "./pfd/validate.ts";

/** 改訂の案が守るべきもの（spec 6 章「改訂の固定」）。 */
export type RevisionConstraints = {
  frozen: FrozenPart;
  /** 過去の改訂で取りやめたプロセスの id。使い回すと、閉じた sub-issue を目印で採用してしまう。 */
  retiredProcessIds: ReadonlySet<string>;
};

/** 生きた行のうち、current_task_id を持つか human_done_at のあるプロセスの id。 */
export function frozenProcessIds(rows: readonly IntakeProcessRow[]): Set<string> {
  return new Set(
    rows
      .filter((r) =>
        r.retired_at === null && (r.current_task_id !== null || r.human_done_at !== null)
      )
      .map((r) => r.process_id),
  );
}

/** 承認済みの案と intake_processes の行から組む。承認が無ければ投げる。 */
export async function loadRevisionConstraints(
  db: Db,
  intakeId: string,
): Promise<RevisionConstraints & { approved: ApprovedPlan }> {
  const approved = await loadApprovedPlan(db, intakeId);
  if (!approved) throw new Error("承認された計画がありません");
  const rows = await listProcesses(db, intakeId);
  return {
    approved,
    frozen: frozenPart(approved.pfd, frozenProcessIds(rows)),
    retiredProcessIds: new Set(rows.filter((r) => r.retired_at !== null).map((r) => r.process_id)),
  };
}

/**
 * frozen_changed（validatePfd に frozen を渡し、その規則の違反だけを取り出す）と、
 * 取りやめた id を使ったプロセス（retired_reused）を、output.ts と同じ
 * 「<rule> <id>: <message>」の文字列で返す。違反が無ければ空配列。
 *
 * retired_reused は PfdRule に足さない。validatePfd は案だけで決まる規則を持ち、これは DB の履歴で決まる。
 */
export function revisionIssues(pfd: Pfd, c: RevisionConstraints): string[] {
  const issues = validatePfd(pfd, { decisionIds: new Set(), frozen: c.frozen })
    .filter((v) => v.rule === "frozen_changed")
    .map((v) => `${v.rule} ${v.id}: ${v.message}`);
  for (const p of pfd.processes) {
    if (c.retiredProcessIds.has(p.id)) {
      issues.push(
        `retired_reused ${p.id}: プロセス ${p.id} は前の改訂で取りやめたので、この id は使えません。別の id にしてください`,
      );
    }
  }
  return issues;
}

/** 承認で行を揃えるための差分。insert は行が 1 つも無い id、retire は生きた行のうち案に無い id。 */
export function processRowChanges(
  rows: readonly IntakeProcessRow[],
  pfd: Pfd,
): { insert: string[]; retire: string[] } {
  const inPfd = new Set(pfd.processes.map((p) => p.id));
  const hasRow = new Set(rows.map((r) => r.process_id));
  return {
    insert: pfd.processes.map((p) => p.id).filter((id) => !hasRow.has(id)),
    retire: rows.filter((r) => r.retired_at === null && !inPfd.has(r.process_id))
      .map((r) => r.process_id),
  };
}
