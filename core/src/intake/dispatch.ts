import { decisionTexts } from "../../../shared/intake/answerText.ts";
import type { Pfd } from "../../../shared/intake/pfd.ts";
import {
  getDraft,
  getIntake,
  latestApproval,
  listProcesses,
  replaceCurrentTask,
} from "../db/intakes.ts";
import { loadQuestionSets } from "./questionSet.ts";
import type { Db, IntakeProcessRow, IntakeRow, ProjectRow } from "../db/schema.ts";
import { getProject, insertTask, type NewTask } from "../db/tasks.ts";
import { branchNameFor } from "../domain/worktree.ts";
import { pinOf, type WorkflowLoader, type WorkflowPin } from "../workflow/load.ts";
import { sha256Hex } from "./pfd/hash.ts";
import { buildTaskPrompt } from "./pfd/prompt.ts";
import { computeProcessStatuses, type ProcessProgress } from "./pfd/status.ts";
import { intakeDraft, processProgressOf } from "./view.ts";

export type DispatchDeps = { loadWorkflow: WorkflowLoader };

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

type DispatchSource = {
  intake: IntakeRow;
  project: ProjectRow;
  pfd: Pfd;
  /** 生きた行だけ。process_id ごと。 */
  rows: Map<string, IntakeProcessRow>;
  humanNotes: Record<string, string>;
  decisions: Record<string, string>;
};

/** タスクの prompt に載せる材料を DB から組む。dispatchIntake と redispatchProcess が使う。 */
async function loadDispatchSource(db: Db, intake: IntakeRow, pfd: Pfd): Promise<DispatchSource> {
  const project = (await getProject(db, intake.project_id))!;
  const rows = new Map(
    (await listProcesses(db, intake.id)).filter((r) => r.retired_at === null)
      .map((r) => [r.process_id, r]),
  );
  const humanNotes: Record<string, string> = {};
  for (const r of rows.values()) {
    if (r.human_done_at !== null) humanNotes[r.process_id] = r.human_note ?? "";
  }
  const decisions = decisionTexts(await loadQuestionSets(db, intake.id));
  return { intake, project, pfd, rows, humanNotes, decisions };
}

/**
 * 案のプロセスがタスクになったときの prompt（R-3）。承認の前でも組める。
 * 決定の回答や人の完了が無ければ、投入と同じ理由で投げる。
 */
export async function previewTaskPrompt(
  db: Db,
  o: { intakeId: string; draftId: number; processId: string },
): Promise<string> {
  const intake = await getIntake(db, o.intakeId);
  if (!intake) throw new Error(`Intake がありません: ${o.intakeId}`);
  const { pfd } = await intakeDraft(db, o.intakeId, o.draftId);
  const process = pfd.processes.find((p) => p.id === o.processId);
  if (!process) throw new Error(`プロセス ${o.processId} は案にありません`);
  if (process.actor === "human") throw new Error("人のプロセスはタスクになりません");

  const src = await loadDispatchSource(db, intake, pfd);
  return buildTaskPrompt({
    pfd,
    processId: o.processId,
    parentIssue: { url: intake.issue_url, title: intake.issue_title },
    subIssueUrl: src.rows.get(o.processId)?.sub_issue_url ?? null,
    humanNotes: src.humanNotes,
    decisions: src.decisions,
  });
}

function statusesOf(src: DispatchSource, progress: ReadonlyMap<string, ProcessProgress>) {
  return computeProcessStatuses({
    pfd: src.pfd,
    baseBranch: src.project.base_branch,
    revising: false,
    dispatchPaused: false,
    progress,
  });
}

/**
 * 1 プロセスのタスクを作り、current_task_id を row の値から置き換える。
 * prompt を組めなければ投げる。置き換えが食い違えば null。作ったタスクの id を返す。
 */
async function dispatchProcess(
  db: Db,
  src: DispatchSource,
  row: IntakeProcessRow,
  pin: WorkflowPin,
): Promise<string | null> {
  const { intake, project, pfd } = src;
  const process = pfd.processes.find((p) => p.id === row.process_id)!;
  const prompt = buildTaskPrompt({
    pfd,
    processId: process.id,
    parentIssue: { url: intake.issue_url, title: intake.issue_title },
    subIssueUrl: row.sub_issue_url,
    humanNotes: src.humanNotes,
    decisions: src.decisions,
  });
  const taskId = crypto.randomUUID();
  const committed = await commitDispatch(db, {
    intakeId: intake.id,
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
      ...pin,
    },
  });
  return committed ? taskId : null;
}

/**
 * active・revising 0・dispatch_paused 0 の Intake について、ready で blockedBy が null の
 * エージェントのプロセスをタスクにする。ワークフローは deps から読み、gh は呼ばない。
 */
export async function dispatchIntake(
  db: Db,
  intakeId: string,
  deps: DispatchDeps,
): Promise<DispatchReport> {
  const report: DispatchReport = { created: [], errors: [] };
  const intake = await getIntake(db, intakeId);
  if (
    !intake || intake.state !== "active" || intake.revising === 1 || intake.dispatch_paused === 1
  ) return report;
  const plan = await loadApprovedPlan(db, intakeId);
  if (!plan) return report;
  const src = await loadDispatchSource(db, intake, plan.pfd);
  const statuses = statusesOf(src, await processProgressOf(db, intakeId));

  const ready = statuses.filter((s) => s.state === "ready" && s.blockedBy === null)
    .map((s) => plan.pfd.processes.find((p) => p.id === s.id)!)
    .filter((p) => p.actor === "agent");
  if (ready.length === 0) return report;

  // どのプロセスも同じ default_workflow なので、1回の呼び出しでは1度だけ読む。
  const pin = pinOf(
    await deps.loadWorkflow(src.project.path, src.project.default_workflow),
    src.project,
  );

  for (const process of ready) {
    try {
      const taskId = await dispatchProcess(db, src, src.rows.get(process.id)!, pin);
      if (taskId !== null) report.created.push({ processId: process.id, taskId });
    } catch (e) {
      report.errors.push({
        processId: process.id,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return report;
}

/**
 * 要確認のプロセスに新しいタスクを作る（C-6）。新しいタスクは同じプロセス・同じ sub-issue に紐づき、
 * 古いタスクは intake_process_id を持ったまま残る。自動 dispatch の一時停止は見ない（人の明示の操作のため）。
 */
export async function redispatchProcess(
  db: Db,
  o: { intakeId: string; processId: string },
  deps: DispatchDeps,
): Promise<{ taskId: string; replacedTaskId: string | null }> {
  const intake = await getIntake(db, o.intakeId);
  if (!intake) throw new Error("Intake がありません");
  if (intake.state !== "active") {
    throw new Error(`再投入できる状態ではありません: ${intake.state}`);
  }
  const plan = await loadApprovedPlan(db, o.intakeId);
  if (!plan) throw new Error("承認された計画がありません");
  const src = await loadDispatchSource(db, intake, plan.pfd);
  const row = src.rows.get(o.processId);
  const status = statusesOf(src, await processProgressOf(db, o.intakeId))
    .find((s) => s.id === o.processId);
  if (!row || status?.state !== "needs_attention") {
    throw new Error(
      `要確認のプロセスだけを再投入できます: ${o.processId}（${status?.state ?? "案に無い"}）`,
    );
  }
  const pin = pinOf(
    await deps.loadWorkflow(src.project.path, src.project.default_workflow),
    src.project,
  );
  const taskId = await dispatchProcess(db, src, row, pin);
  if (taskId === null) throw new Error("ほかの操作が先にタスクを置き換えました");
  return { taskId, replacedTaskId: row.current_task_id };
}
