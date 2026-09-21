import { decisionTexts } from "../../../shared/intake/answerText.ts";
import type { Pfd } from "../../../shared/intake/pfd.ts";
import type { Answer, Question } from "../../../shared/intake/question.ts";
import {
  getDraft,
  getIntake,
  latestApproval,
  listProcesses,
  listQuestionSets,
  replaceCurrentTask,
} from "../db/intakes.ts";
import type { Db } from "../db/schema.ts";
import { getProject, insertTask, type NewTask } from "../db/tasks.ts";
import { branchNameFor } from "../domain/worktree.ts";
import { sha256Hex } from "./pfd/hash.ts";
import { buildTaskPrompt } from "./pfd/prompt.ts";
import { computeProcessStatuses } from "./pfd/status.ts";
import { processProgressOf } from "./view.ts";

export type ApprovedPlan = { pfd: Pfd; draftId: number };

/**
 * 最新の承認の案を読み、承認の hash・案の hash・案の本文の SHA-256 が一致することを確かめる（spec 6 章）。
 * 承認が無ければ null。一致しなければ投げる。
 */
export async function loadApprovedPlan(db: Db, intakeId: string): Promise<ApprovedPlan | null> {
  const approval = await latestApproval(db, intakeId);
  if (!approval) return null;
  const draft = await getDraft(db, approval.draft_id);
  if (!draft || draft.hash !== approval.hash || draft.hash !== await sha256Hex(draft.pfd)) {
    throw new Error(`Intake ${intakeId} の承認と案の内容が食い違っています`);
  }
  return { pfd: JSON.parse(draft.pfd) as Pfd, draftId: draft.id };
}

class DispatchConflict extends Error {}

/**
 * タスクの挿入と current_task_id の比較付き更新を 1 トランザクションで行う（spec 11.5 W-5）。
 * current_task_id が expectedTaskId でなければ、タスクの挿入ごと巻き戻して false を返す。
 */
export async function commitDispatch(
  db: Db,
  o: { intakeId: string; processId: string; expectedTaskId: string | null; task: NewTask },
): Promise<boolean> {
  try {
    await db.transaction().execute(async (trx) => {
      await insertTask(trx, o.task);
      if (!await replaceCurrentTask(trx, o.intakeId, o.processId, o.expectedTaskId, o.task.id)) {
        throw new DispatchConflict();
      }
    });
    return true;
  } catch (e) {
    if (e instanceof DispatchConflict) return false;
    throw e;
  }
}

export type DispatchReport = {
  created: { processId: string; taskId: string }[];
  /** prompt を組めなかったなど、そのプロセスだけを見送った理由。 */
  errors: { processId: string; message: string }[];
};

/**
 * active・revising 0・dispatch_paused 0 の Intake について、ready で blockedBy が null の
 * エージェントのプロセスをタスクにする。DB だけを読み書きし、gh は呼ばない。
 */
export async function dispatchIntake(db: Db, intakeId: string): Promise<DispatchReport> {
  const report: DispatchReport = { created: [], errors: [] };
  const intake = await getIntake(db, intakeId);
  if (
    !intake || intake.state !== "active" || intake.revising === 1 || intake.dispatch_paused === 1
  ) return report;
  const plan = await loadApprovedPlan(db, intakeId);
  if (!plan) return report;
  const { pfd } = plan;
  const project = (await getProject(db, intake.project_id))!;

  const statuses = computeProcessStatuses({
    pfd,
    baseBranch: project.base_branch,
    revising: false,
    dispatchPaused: false,
    progress: await processProgressOf(db, intakeId),
  });

  const rows = new Map(
    (await listProcesses(db, intakeId)).filter((r) => r.retired_at === null)
      .map((r) => [r.process_id, r]),
  );
  const humanNotes: Record<string, string> = {};
  for (const r of rows.values()) {
    if (r.human_done_at !== null) humanNotes[r.process_id] = r.human_note ?? "";
  }
  const decisions = decisionTexts(
    (await listQuestionSets(db, intakeId)).map((q) => ({
      questions: JSON.parse(q.questions) as Question[],
      answers: q.answers === null ? null : JSON.parse(q.answers) as Answer[],
    })),
  );

  for (const status of statuses) {
    if (status.state !== "ready" || status.blockedBy !== null) continue;
    const process = pfd.processes.find((p) => p.id === status.id)!;
    if (process.actor !== "agent") continue;
    const row = rows.get(process.id)!;

    let prompt: string;
    try {
      prompt = buildTaskPrompt({
        pfd,
        processId: process.id,
        parentIssue: { url: intake.issue_url, title: intake.issue_title },
        subIssueUrl: row.sub_issue_url,
        humanNotes,
        decisions,
      });
    } catch (e) {
      report.errors.push({
        processId: process.id,
        message: e instanceof Error ? e.message : String(e),
      });
      continue;
    }

    const taskId = crypto.randomUUID();
    const committed = await commitDispatch(db, {
      intakeId,
      processId: process.id,
      expectedTaskId: row.current_task_id,
      task: {
        id: taskId,
        project_id: intake.project_id,
        title: process.name,
        prompt,
        workflow_name: project.default_workflow,
        branch: branchNameFor(taskId, process.name),
        priority: 2,
        intake_id: intake.id,
        intake_process_id: process.id,
        issue_url: row.sub_issue_url,
        parent_issue_url: intake.issue_url,
      },
    });
    if (committed) report.created.push({ processId: process.id, taskId });
  }
  return report;
}
