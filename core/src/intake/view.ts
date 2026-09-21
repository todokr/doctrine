import {
  getDraft,
  getPrObservation,
  latestApproval,
  latestDraft,
  listComments,
  listDrafts,
  listIntakeRuns,
  listProcesses,
  listQuestionSets,
} from "../db/intakes.ts";
import type { Db, IntakeDraftRow, IntakeRow } from "../db/schema.ts";
import { getProject, getTask } from "../db/tasks.ts";
import type { AttentionReason, CommentReply } from "../../../shared/intake/decomposer.ts";
import type { Pfd } from "../../../shared/intake/pfd.ts";
import type { PrFact, ProcessStatus } from "../../../shared/intake/processStatus.ts";
import type { Answer, Question } from "../../../shared/intake/question.ts";
import type { IntakeState } from "../../../shared/intake/state.ts";
import type {
  IntakeDetail,
  IntakeProcessView,
  IntakeSummary,
  PfdDraft,
  StepRunDenials,
  WatchHealth,
} from "../../../shared/protocol.ts";
import { computeProcessStatuses, type ProcessProgress } from "./pfd/status.ts";

/** 人の手が要る状態か（spec 5 章）。active は、あなたの番か要確認のプロセスがあるときだけ。 */
export function needsHuman(state: IntakeState, statuses: readonly ProcessStatus[]): boolean {
  if (state === "answering" || state === "reviewing" || state === "needs_attention") return true;
  if (state !== "active") return false;
  return statuses.some((s) => s.state === "your_turn" || s.state === "needs_attention");
}

type ProcessFacts = { id: string; status: ProcessStatus; subIssueUrl: string | null };

/** intake_processes の生きた行（retired を除く）から、現在のタスク・観測した PR・sub-issue・人の完了を集める。 */
export async function processProgressOf(
  db: Db,
  intakeId: string,
): Promise<Map<string, ProcessProgress>> {
  const progress = new Map<string, ProcessProgress>();
  for (const p of await listProcesses(db, intakeId)) {
    if (p.retired_at !== null) continue;
    const task = p.current_task_id === null ? undefined : await getTask(db, p.current_task_id);
    const obs = p.current_task_id === null
      ? undefined
      : await getPrObservation(db, p.current_task_id);
    const pr: PrFact | null = obs
      ? {
        number: obs.pr_number,
        url: obs.pr_url,
        state: obs.state,
        baseRef: obs.base_ref,
        mergedAt: obs.merged_at,
        mergeCommit: obs.merge_commit,
      }
      : null;
    progress.set(p.process_id, {
      task: task ? { id: task.id, state: task.state } : null,
      pr,
      subIssueUrl: p.sub_issue_url,
      humanDone: p.human_done_at === null
        ? null
        : { note: p.human_note ?? "", at: p.human_done_at },
    });
  }
  return progress;
}

/** 承認の前は空配列。承認後は、承認された案と DB の進み具合から組む。 */
async function processStatusesOf(db: Db, row: IntakeRow): Promise<ProcessFacts[]> {
  const approval = await latestApproval(db, row.id);
  if (!approval) return [];
  const pfd = JSON.parse((await getDraft(db, approval.draft_id))!.pfd) as Pfd;
  const project = (await getProject(db, row.project_id))!;
  const progress = await processProgressOf(db, row.id);

  return computeProcessStatuses({
    pfd,
    baseBranch: project.base_branch,
    revising: row.revising === 1,
    dispatchPaused: row.dispatch_paused === 1,
    progress,
  }).map((entry) => ({
    id: entry.id,
    status: entry,
    subIssueUrl: progress.get(entry.id)?.subIssueUrl ?? null,
  }));
}

function summaryOf(
  row: IntakeRow,
  facts: readonly ProcessFacts[],
  watch: WatchHealth,
): IntakeSummary {
  const statuses = facts.map((f) => f.status);
  return {
    id: row.id,
    project_id: row.project_id,
    issue_url: row.issue_url,
    issue_title: row.issue_title,
    state: row.state,
    revising: row.revising === 1,
    attention_reason: row.attention_reason === null
      ? null
      : JSON.parse(row.attention_reason) as AttentionReason,
    dispatch_paused: row.dispatch_paused === 1,
    rate_limited_until: row.rate_limited_until,
    progress: {
      done: statuses.filter((s) => s.state === "merged" || s.state === "done").length,
      total: statuses.length,
    },
    needs_human: needsHuman(row.state, statuses),
    watch,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function toIntakeSummary(
  db: Db,
  row: IntakeRow,
  watch: WatchHealth,
): Promise<IntakeSummary> {
  return summaryOf(row, await processStatusesOf(db, row), watch);
}

export function toPfdDraft(row: IntakeDraftRow): PfdDraft {
  return {
    id: row.id,
    seq: row.seq,
    pfd: JSON.parse(row.pfd) as Pfd,
    hash: row.hash,
    replies: JSON.parse(row.replies) as CommentReply[],
    created_at: row.created_at,
  };
}

/** 案 1 件を中身込みで読む。別の Intake の案は「案がありません」にする。 */
export async function intakeDraft(db: Db, intakeId: string, draftId: number): Promise<PfdDraft> {
  const row = await getDraft(db, draftId);
  if (!row || row.intake_id !== intakeId) throw new Error(`案がありません: ${draftId}`);
  return toPfdDraft(row);
}

export async function toIntakeDetail(
  db: Db,
  row: IntakeRow,
  watch: WatchHealth,
): Promise<IntakeDetail> {
  const facts = await processStatusesOf(db, row);
  const latest = await latestDraft(db, row.id);
  const approval = await latestApproval(db, row.id);

  const taskIds = new Map<string, string[]>();
  const tasks = await db.selectFrom("tasks").select(["id", "intake_process_id"])
    .where("intake_id", "=", row.id).orderBy("created_at").orderBy("id").execute();
  for (const t of tasks) {
    if (t.intake_process_id === null) continue;
    taskIds.set(t.intake_process_id, [...(taskIds.get(t.intake_process_id) ?? []), t.id]);
  }

  return {
    ...summaryOf(row, facts, watch),
    drafts: (await listDrafts(db, row.id)).map((d) => ({
      id: d.id,
      seq: d.seq,
      created_at: d.created_at,
    })),
    latest_draft: latest ? toPfdDraft(latest) : null,
    approval: approval
      ? {
        id: approval.id,
        draft_id: approval.draft_id,
        hash: approval.hash,
        approved_at: approval.approved_at,
      }
      : null,
    question_sets: (await listQuestionSets(db, row.id)).map((q) => ({
      id: q.id,
      run_id: q.run_id,
      questions: JSON.parse(q.questions) as Question[],
      answers: q.answers === null ? null : JSON.parse(q.answers) as Answer[],
      created_at: q.created_at,
      answered_at: q.answered_at,
    })),
    comments: (await listComments(db, row.id)).map((c) => ({
      id: c.id,
      draft_id: c.draft_id,
      target_kind: c.target_kind,
      target_id: c.target_id,
      body: c.body,
      created_at: c.created_at,
    })),
    processes: facts.map((f): IntakeProcessView => ({
      id: f.id,
      ...f.status,
      sub_issue_url: f.subIssueUrl,
      task_ids: taskIds.get(f.id) ?? [],
    })),
    runs: (await listIntakeRuns(db, row.id)).map((r) => ({
      id: r.id,
      purpose: r.purpose,
      attempt: r.attempt,
      status: r.status,
      started_at: r.started_at,
      ended_at: r.ended_at,
      cost_usd: r.cost_usd,
      num_turns: r.num_turns,
      duration_ms: r.duration_ms,
      issues: r.issues === null ? null : JSON.parse(r.issues) as string[],
      permission_denials: r.permission_denials === null
        ? null
        : JSON.parse(r.permission_denials) as StepRunDenials,
    })),
  };
}
