import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { Branch, Workflow } from "../workflow/schema.ts";
import { branchOf } from "../workflow/schema.ts";
import { expand, type TemplateContext } from "../workflow/template.ts";
import { commitStepBoundary, type StepBoundary } from "../db/boundary.ts";
import { getStepOutputs, type StepRunStatus } from "../db/stepRuns.ts";
import { attemptCount, getProject, getTask, withAttempt, type TaskRow, type TaskState } from "../db/tasks.ts";
import { insertRateLimitSample } from "../db/rateLimits.ts";
import { assertTransition } from "./states.ts";
import { logPathFor, runAgentStep, runCommandStep, type RunnerDeps, type StepOutcome } from "./stepRunner.ts";

export type Decision =
  | { kind: "next"; stepId: string }
  | { kind: "goto"; stepId: string; feed: string | null }
  | { kind: "suspend" }
  | { kind: "complete" }
  | { kind: "fail"; reason: string };

/**
 * ワークフローの意味論。I/Oを持たないので、ここだけを読めば進行規則が分かる。
 * degraded は success と同じ扱い（判断材料は step_runs に残るが、流れは止めない）。
 */
export function decide(o: {
  workflow: Workflow; currentStepId: string;
  outcome: StepOutcome["status"]; attempts: number;
}): Decision {
  const index = o.workflow.steps.findIndex((s) => s.id === o.currentStepId);
  if (index === -1) return { kind: "fail", reason: `ステップが見つかりません: ${o.currentStepId}` };
  const step = o.workflow.steps[index];

  if (o.outcome === "suspended") return { kind: "suspend" };

  if (o.outcome === "success" || o.outcome === "degraded") {
    const next = o.workflow.steps[index + 1];
    return next ? { kind: "next", stepId: next.id } : { kind: "complete" };
  }

  const branch: Branch | undefined = branchOf(step);
  if (!branch) return { kind: "fail", reason: `ステップ "${step.id}" が失敗し、onFailure がありません` };
  if (o.attempts >= branch.maxAttempts) {
    return { kind: "fail", reason: `ステップ "${step.id}" が maxAttempts (${branch.maxAttempts}) を超えました` };
  }
  return { kind: "goto", stepId: branch.goto, feed: branch.feed ?? null };
}

export type EngineDeps = RunnerDeps & {
  globalLimit: number;
  onStateChanged?(taskId: string, from: TaskState, to: TaskState): void;
  onStepRunStarted?(taskId: string, stepRunId: number, stepId: string, attempt: number): void;
  /** stepRunId は commitStepBoundary が返した step_runs.id。イベントがこれを載せる。 */
  onStepRunFinished?(taskId: string, stepRunId: number, stepId: string, status: StepRunStatus): void;
};

function contextFor(db: DatabaseSync, task: TaskRow): TemplateContext {
  const project = getProject(db, task.project_id)!;
  return {
    task: { id: task.id, title: task.title, prompt: task.prompt, branch: task.branch },
    worktree: { path: task.worktree_path ?? "" },
    project: { path: project.path },
    steps: getStepOutputs(db, task.id),
  };
}

function setState(
  db: DatabaseSync, task: TaskRow, to: TaskState, deps: EngineDeps,
  extra: Partial<StepBoundary["taskPatch"]> = {},
): void {
  assertTransition(task.state, to);
  commitStepBoundary(db, { taskId: task.id, taskPatch: { state: to, ...extra } });
  deps.onStateChanged?.(task.id, task.state, to);
}

/**
 * running のタスクを、次に人を待つ地点（approval / 終端）まで進める。
 * ステップ境界ごとに1トランザクションで書く。落ちて失うのは最大1ステップ分。
 */
export async function runTask(
  db: DatabaseSync, taskId: string, workflow: Workflow, deps: EngineDeps,
): Promise<void> {
  let task = getTask(db, taskId);
  if (!task) throw new Error(`タスクがありません: ${taskId}`);

  let stepId = task.current_step_id ?? workflow.steps[0].id;
  // suspend 境界（承認待ち）をまたいだ feed は task.pending_feed に永続化されている。
  // ローカル変数だけでは runTask の呼び出し自体が終わってしまうと消えるし、
  // daemon が承認待ちの最中に再起動しても復元できない。ここで一度だけ取り込み、
  // 直後のステップ開始コミットで DB 側を null に戻して「消費は一度きり」を保証する。
  let pendingFeed: string | null = task.pending_feed ?? null;

  while (true) {
    task = getTask(db, taskId)!;
    const step = workflow.steps.find((s) => s.id === stepId);
    if (!step) {
      setState(db, task, "failed", deps);
      return;
    }

    if (step.type === "approval") {
      setState(db, task, "suspended", deps, { current_step_id: step.id, child_pid: null, child_started_at: null });
      return;
    }

    const attempt = attemptCount(task, step.id) + 1;
    const ctx = contextFor(db, task);
    const sessionId = task.claude_session_id ?? randomUUID();

    const logPath = logPathFor(deps.logRoot, taskId, step.id, attempt);
    // 開始時に running の行を立てる。クラッシュ復帰はこの行を見て、
    // どのステップの途中で落ちたかを知る（Task 11）。
    const stepRunId = commitStepBoundary(db, {
      taskId,
      taskPatch: {
        current_step_id: step.id, attempt_counts: withAttempt(task, step.id),
        claude_session_id: sessionId, pending_feed: null,
      },
      stepRun: {
        step_id: step.id, attempt, status: "running", exit_code: null,
        started_at: new Date().toISOString(), ended_at: null, log_path: logPath,
      },
    })!;
    deps.onStepRunStarted?.(taskId, stepRunId, step.id, attempt);

    const runnerDeps: RunnerDeps = {
      ...deps,
      onChildSpawned: (pid, startedAt) => {
        commitStepBoundary(db, { taskId, taskPatch: { child_pid: pid, child_started_at: startedAt } });
        deps.onChildSpawned?.(pid, startedAt);
      },
      onRateLimit: (s) => {
        insertRateLimitSample(db, { window: s.window, utilization: s.utilization, resets_at: s.resetsAt });
        deps.onRateLimit?.(s);
      },
    };

    const isResume = pendingFeed !== null || attempt > 1;
    const outcome: StepOutcome = step.type === "command"
      ? await runCommandStep(step, ctx, { cwd: task.worktree_path!, taskId, attempt, deps: runnerDeps })
      : await runAgentStep(
          { ...step, prompt: pendingFeed ?? step.prompt }, ctx,
          { cwd: task.worktree_path!, taskId, attempt, sessionId,
            resume: isResume, deps: runnerDeps });
    pendingFeed = null;

    commitStepBoundary(db, {
      taskId,
      taskPatch: { child_pid: null, child_started_at: null },
      stepRunUpdate: {
        id: stepRunId, status: outcome.status as StepRunStatus, exit_code: outcome.exitCode,
        ended_at: outcome.endedAt, cost_usd: outcome.costUsd,
        num_turns: outcome.numTurns, duration_ms: outcome.durationMs,
      },
      outputs: { step_id: step.id, stdout: outcome.stdout, stderr: outcome.stderr, exit_code: outcome.exitCode },
    });
    deps.onStepRunFinished?.(taskId, stepRunId, step.id, outcome.status as StepRunStatus);

    task = getTask(db, taskId)!;
    const decision = decide({
      workflow, currentStepId: step.id, outcome: outcome.status,
      attempts: attemptCount(task, step.id),
    });

    switch (decision.kind) {
      case "next":
        stepId = decision.stepId;
        break;
      case "goto":
        stepId = decision.stepId;
        pendingFeed = decision.feed ? expand(decision.feed, contextFor(db, task)) : null;
        break;
      case "complete":
        setState(db, task, "completed", deps);
        return;
      case "fail":
        setState(db, task, "failed", deps);
        return;
      case "suspend":
        setState(db, task, "suspended", deps);
        return;
    }
  }
}

/**
 * approval の結果を適用する。却下コメントは approval ステップの stdout として保存する
 * （agent ステップの stdout を最終結果テキストとしたのと同じ扱い。変数の系統を増やさない）。
 */
export function applyApproval(
  db: DatabaseSync, taskId: string,
  verdict: { approved: boolean; comment: string },
  workflow: Workflow,
): void {
  const task = getTask(db, taskId);
  if (!task) throw new Error(`タスクがありません: ${taskId}`);
  if (task.state !== "suspended") throw new Error(`承認待ちではありません: ${task.state}`);

  const stepId = task.current_step_id!;
  const index = workflow.steps.findIndex((s) => s.id === stepId);
  const step = workflow.steps[index];
  const now = new Date().toISOString();

  if (verdict.approved) {
    const next = workflow.steps[index + 1];
    const to: TaskState = next ? "queued" : "completed";
    // 遷移表に反する書き込みを防ぐ。ここで投げれば commitStepBoundary は一切呼ばれず、
    // タスク行・step_run・outputs のどれも書き換わらない（呼び出し前に検査するのが要点）。
    assertTransition(task.state, to);
    commitStepBoundary(db, {
      taskId,
      taskPatch: next
        ? { state: "queued", current_step_id: next.id, resumed: 1 }
        : { state: "completed" },
      stepRun: { step_id: stepId, attempt: attemptCount(task, stepId) + 1, status: "success",
                 exit_code: 0, started_at: now, ended_at: now, log_path: "" },
      outputs: { step_id: stepId, stdout: "", stderr: "", exit_code: 0 },
    });
    return;
  }

  // 却下は onFailure と同じ「失敗して分岐する」ケースであり、goto/maxAttempts の
  // 判断はここで作り直さず decide に委ねる。attemptCount(task, stepId) + 1 は
  // このコミットで attempt_counts に書く値そのものであり、decide に渡す attempts と
  // 一致させる（この数がそのまま maxAttempts と比較される数、かつ step_runs に
  // 記録される attempt になる）。
  const advancedAttempt = attemptCount(task, stepId) + 1;
  const advancedAttemptCounts = withAttempt(task, stepId);
  const decision = decide({
    workflow, currentStepId: stepId, outcome: "failed", attempts: advancedAttempt,
  });

  // {{ steps.review.stdout }} は却下コメントを指す。DBへ書く前に、これから書く値を
  // 直接コンテキストへ差し込んで展開する（コマンド実行パスが「出力を書いてから
  // 次のステップで参照する」のと同じ意味を、1トランザクション内で再現する）。
  const ctx = contextFor(db, task);
  ctx.steps[stepId] = { stdout: verdict.comment, stderr: "", exitCode: "1" };

  if (decision.kind === "goto") {
    const to: TaskState = "queued";
    assertTransition(task.state, to);
    commitStepBoundary(db, {
      taskId,
      taskPatch: {
        state: "queued", current_step_id: decision.stepId, resumed: 1,
        attempt_counts: advancedAttemptCounts,
        pending_feed: decision.feed ? expand(decision.feed, ctx) : null,
      },
      stepRun: { step_id: stepId, attempt: advancedAttempt, status: "failed",
                 exit_code: 1, started_at: now, ended_at: now, log_path: "" },
      outputs: { step_id: stepId, stdout: verdict.comment, stderr: "", exit_code: 1 },
    });
    return;
  }

  // decision.kind === "fail"（onReject が無い、または maxAttempts を使い切った）
  const to: TaskState = "failed";
  assertTransition(task.state, to);
  commitStepBoundary(db, {
    taskId,
    taskPatch: { state: "failed", attempt_counts: advancedAttemptCounts },
    stepRun: { step_id: stepId, attempt: advancedAttempt, status: "failed",
               exit_code: 1, started_at: now, ended_at: now, log_path: "" },
    outputs: { step_id: stepId, stdout: verdict.comment, stderr: "", exit_code: 1 },
  });
}
