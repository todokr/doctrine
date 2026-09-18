import type { Db, StepRunRow } from "../db/schema.ts";
import type { TaskRow } from "../db/tasks.ts";
import { listStepOutputs, listStepRuns } from "../db/stepRuns.ts";
import type { Step, Workflow } from "../workflow/schema.ts";
import { readReviewFiles, type ReviewFile } from "./reviewFiles.ts";

type StepOutputRow = { last_stdout: string; last_stderr: string; exit_code: number | null };

type ReviewBase = {
  stepRunId: number;
  stepId: string;
  attempt: number;
  startedAt: string;
  /** 記録できなかった回は null。 */
  reviewTree: string | null;
};

/** レビュー1回。 */
export type ReviewEntry =
  /** まだ人が見ていない。 */
  | (ReviewBase & { status: "awaiting" })
  /** 承認された。task.approve は comment を受けないので、承認にコメントは無い。 */
  | (ReviewBase & { status: "approved"; endedAt: string })
  /** 却下された。task.reject はコメント必須なので、必ずある。 */
  | (ReviewBase & { status: "rejected"; endedAt: string; comment: string })
  /** 人の決定を待たずに外から閉じられた（task.cancel / task.resume）。 */
  | (ReviewBase & { status: "interrupted"; endedAt: string });

export type CommandResult = {
  stepId: string;
  /** シグナルで殺された実行は null。 */
  exitCode: number | null;
  /** DB が持つのは末尾 8KB（OUTPUT_TAIL_BYTES）まで。全文はログファイルにある。 */
  stdout: string;
  stderr: string;
};

export type TaskContext = {
  prompt: string;
  reviews: ReviewEntry[];
  lastCommand: CommandResult | null;
  lastAgentMessage: string | null;
  reviewFiles: ReviewFile[];
};

/**
 * レビュー画面が要る「経緯」を1回で組み立てる。
 *
 * workflow が null なのは、承認待ちの間にワークフローYAMLが消えた・壊れた場合。
 * 読み取りをそこで止めると人は経緯を読むことすらできなくなるので、種別が要らない
 * ものだけ返す。
 */
export async function buildTaskContext(
  db: Db,
  task: TaskRow,
  workflow: Workflow | null,
): Promise<TaskContext> {
  const types = new Map<string, Step["type"]>(workflow?.steps.map((s) => [s.id, s.type]) ?? []);
  const runs = await listStepRuns(db, task.id);
  const outputs = await listStepOutputs(db, task.id);

  // 定義が引けないときは、今止まっているステップの行だけをレビューとみなす。
  const isReview = (r: StepRunRow) =>
    workflow ? types.get(r.step_id) === "approval" : r.step_id === task.current_step_id;

  return {
    prompt: task.prompt,
    reviews: runs.filter(isReview).map((r) => toReview(r, outputs)),
    lastCommand: lastCommandOf(runs, outputs, types),
    lastAgentMessage: lastOutputOf(runs, outputs, types, "agent")?.last_stdout ?? null,
    reviewFiles: await reviewFilesOf(task, workflow),
  };
}

function toReview(r: StepRunRow, outputs: Map<number, StepOutputRow>): ReviewEntry {
  const base: ReviewBase = {
    stepRunId: r.id,
    stepId: r.step_id,
    attempt: r.attempt,
    startedAt: r.started_at,
    reviewTree: r.review_tree,
  };
  switch (r.status) {
    case "awaiting":
      return { ...base, status: "awaiting" };
    case "success":
      return { ...base, status: "approved", endedAt: closedAt(r) };
    case "failed": {
      const output = outputs.get(r.id);
      if (!output) {
        throw new Error(
          `却下されたレビュー ${r.id} にコメントがありません（applyApproval が同じ境界で書くはず）`,
        );
      }
      return { ...base, status: "rejected", endedAt: closedAt(r), comment: output.last_stdout };
    }
    case "interrupted":
      return { ...base, status: "interrupted", endedAt: closedAt(r) };
    default:
      throw new Error(
        `レビューの記録に想定外の status があります: ${r.status}（step_run ${r.id}）`,
      );
  }
}

function closedAt(r: StepRunRow): string {
  if (r.ended_at === null) {
    throw new Error(`閉じたはずのレビュー ${r.id} に決定の時刻がありません`);
  }
  return r.ended_at;
}

/** その種別のステップのうち、出力を持つ最後の実行。 */
function lastOutputOf(
  runs: StepRunRow[],
  outputs: Map<number, StepOutputRow>,
  types: Map<string, Step["type"]>,
  type: Step["type"],
): StepOutputRow | null {
  for (let i = runs.length - 1; i >= 0; i--) {
    if (types.get(runs[i].step_id) !== type) continue;
    const output = outputs.get(runs[i].id);
    if (output) return output;
  }
  return null;
}

function lastCommandOf(
  runs: StepRunRow[],
  outputs: Map<number, StepOutputRow>,
  types: Map<string, Step["type"]>,
): CommandResult | null {
  for (let i = runs.length - 1; i >= 0; i--) {
    if (types.get(runs[i].step_id) !== "command") continue;
    const output = outputs.get(runs[i].id);
    if (!output) continue;
    return {
      stepId: runs[i].step_id,
      exitCode: output.exit_code,
      stdout: output.last_stdout,
      stderr: output.last_stderr,
    };
  }
  return null;
}

async function reviewFilesOf(task: TaskRow, workflow: Workflow | null): Promise<ReviewFile[]> {
  if (task.state !== "suspended" || !task.current_step_id || !task.worktree_path || !workflow) {
    return [];
  }
  const step = workflow.steps.find((s) => s.id === task.current_step_id);
  if (step?.type !== "approval" || !step.review) return [];
  return await readReviewFiles(task.worktree_path, step.review.files);
}
