import { ISSUE_PHASES, type IssuePhase } from "../../../shared/intake/tracker.ts";
import { type IntakeRow, listProcesses, updateIntake, updateProcess } from "../db/intakes.ts";
import type { Db } from "../db/schema.ts";
import type { Tracker } from "../tracker/tracker.ts";
import type { ProcessProgress } from "./pfd/status.ts";
import { processProgressOf } from "./view.ts";

type Advancer = Pick<Tracker, "kind" | "advanceIssue">;

/** 親 Issue のあるべき段階。Intake が始まれば inProgress。 */
export const PARENT_PHASE: IssuePhase = "inProgress";

/** sub-issue のあるべき段階。タスクがあれば inProgress、PR が OPEN か MERGED なら inReview、それ以外は todo。 */
export function desiredSubIssuePhase(progress: ProcessProgress | undefined): IssuePhase {
  if (!progress?.task) return "todo";
  if (progress.pr?.state === "OPEN" || progress.pr?.state === "MERGED") return "inReview";
  return "inProgress";
}

/** a が b より先か。b が null なら常に true。 */
export function isAhead(a: IssuePhase, b: IssuePhase | null): boolean {
  return b === null || ISSUE_PHASES.indexOf(a) > ISSUE_PHASES.indexOf(b);
}

export type IssueStateSyncResult = {
  /** 進めた Issue の URL と段階。 */
  advanced: { url: string; phase: IssuePhase }[];
  failures: { url: string; message: string }[];
};

/**
 * 親 Issue を PARENT_PHASE へ進め、intakes.issue_phase に記録する。
 * Linear でなければ何もしない。記録が PARENT_PHASE と同じか先なら呼ばない。失敗は投げる。
 * 呼んだら true。
 */
export async function advanceParentIssue(
  db: Db,
  tracker: Advancer,
  o: {
    projectPath: string;
    intake: Pick<IntakeRow, "id" | "issue_url" | "issue_node_id" | "issue_phase">;
  },
): Promise<boolean> {
  if (tracker.kind !== "linear" || !isAhead(PARENT_PHASE, o.intake.issue_phase)) return false;
  await tracker.advanceIssue(
    o.projectPath,
    { url: o.intake.issue_url, nodeId: o.intake.issue_node_id },
    PARENT_PHASE,
  );
  await updateIntake(db, o.intake.id, { issue_phase: PARENT_PHASE });
  return true;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * 承認済みの Intake の親 Issue と sub-issue を、あるべき段階へ進める。
 * Linear でなければ何もしない（空の結果）。行の読み出しに失敗したときだけ投げ、
 * Issue ごとの失敗は failures に入れて残りを続ける。
 */
export async function syncIssueStates(
  db: Db,
  tracker: Advancer,
  o: { projectPath: string; intake: IntakeRow },
): Promise<IssueStateSyncResult> {
  const result: IssueStateSyncResult = { advanced: [], failures: [] };
  if (tracker.kind !== "linear") return result;

  try {
    if (await advanceParentIssue(db, tracker, o)) {
      result.advanced.push({ url: o.intake.issue_url, phase: PARENT_PHASE });
    }
  } catch (e) {
    result.failures.push({ url: o.intake.issue_url, message: message(e) });
  }

  const rows = await listProcesses(db, o.intake.id);
  const progress = await processProgressOf(db, o.intake.id);
  for (const row of rows) {
    if (row.retired_at !== null || row.sub_issue_url === null || row.sub_issue_closed !== 0) {
      continue;
    }
    const desired = desiredSubIssuePhase(progress.get(row.process_id));
    if (!isAhead(desired, row.sub_issue_phase)) continue;
    try {
      await tracker.advanceIssue(
        o.projectPath,
        { url: row.sub_issue_url, nodeId: row.sub_issue_node_id! },
        desired,
      );
      await updateProcess(db, o.intake.id, row.process_id, { sub_issue_phase: desired });
      result.advanced.push({ url: row.sub_issue_url, phase: desired });
    } catch (e) {
      result.failures.push({ url: row.sub_issue_url, message: message(e) });
    }
  }
  return result;
}
