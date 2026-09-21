import type { AgentAdapter, AgentResult, RateLimitObservation } from "../adapter/types.ts";
import { denialsColumn } from "../db/boundary.ts";
import {
  getIntake,
  getIntakeRun,
  insertDraft,
  insertIntakeRun,
  insertQuestionSet,
  type IntakePatch,
  type IntakeRunPatch,
  IntakeStateConflictError,
  latestDraft,
  listComments,
  listDrafts,
  listIntakeRuns,
  listQuestionSets,
  updateIntake,
  updateIntakeRun,
} from "../db/intakes.ts";
import { insertRateLimitSample, rateLimitsObservedSince } from "../db/rateLimits.ts";
import type { Db, IntakeRow, IntakeRunPurpose, IntakeRunRow, IntakeState } from "../db/schema.ts";
import { getProject } from "../db/tasks.ts";
import { assertIntakeTransition } from "../domain/intakeStates.ts";
import {
  classifyRateLimit,
  consecutiveRateLimited,
  MAX_CONSECUTIVE_RATE_LIMITS,
} from "../domain/rateLimit.ts";
import { driveAgent, logPathFor, openLog, type RunnerDeps } from "../domain/stepRunner.ts";
import { BUILTIN_APPEND_SYSTEM_PROMPT } from "../domain/systemPrompt.ts";
import {
  changedPaths,
  createDetachedWorktree,
  intakeWorktreePathFor,
  restoreWorktree,
} from "../domain/worktree.ts";
import type { Tracker } from "../github/tracker.ts";
import { READ_ONLY_TOOLS } from "../workflow/scaffold.ts";
import {
  type AttentionReason,
  decomposerJsonSchema,
  type DecomposerOutput,
} from "../../../shared/intake/decomposer.ts";
import { canonicalJson } from "../../../shared/intake/pfd.ts";
import type { Question } from "../../../shared/intake/question.ts";
import { consecutiveInvalid, continuationMessage, MAX_INVALID_OUTPUTS } from "./conversation.ts";
import { checkDecomposerOutput } from "./output.ts";
import { pfdHash } from "./pfd/hash.ts";
import { buildInitialPrompt } from "./prompt.ts";

export { MAX_INVALID_OUTPUTS } from "./conversation.ts";

/** 読むだけの道具（spec 7 章）。Write・Edit・gh・dctl は含めない。 */
export const INTAKE_ALLOWED_TOOLS: readonly string[] = ["Read", "Grep", "Glob", ...READ_ONLY_TOOLS];

export type IntakeRunnerDeps = {
  db: Db;
  adapter: AgentAdapter;
  tracker: Pick<Tracker, "readIssue">;
  logRoot: string;
  onStateChanged?(intakeId: string, from: IntakeState, to: IntakeState, revising: boolean): void;
  onRateLimit?(s: RateLimitObservation): void | Promise<void>;
  onLogLine?(line: string): void;
};

/**
 * queued の実行を立てる。attempt は同じ purpose の最新の行の attempt に、
 * resume（上限待ちからの再開）なら 0、それ以外は 1 を足す。log_path はここで決める。
 */
export async function enqueueIntakeRun(
  db: Db,
  intakeId: string,
  purpose: IntakeRunPurpose,
  o: { logRoot: string; resume: boolean },
): Promise<number> {
  const latest = await db.selectFrom("intake_runs").select("attempt")
    .where("intake_id", "=", intakeId).where("purpose", "=", purpose)
    .orderBy("id", "desc").executeTakeFirst();
  const attempt = latest === undefined ? 1 : latest.attempt + (o.resume ? 0 : 1);
  return await insertIntakeRun(db, {
    intake_id: intakeId,
    purpose,
    attempt,
    status: "queued",
    started_at: null,
    log_path: logPathFor(o.logRoot, `intake-${intakeId}`, purpose, attempt),
  });
}

/** queued のときだけ running にして started_at を入れる。書けたら true。 */
export async function claimIntakeRun(db: Db, runId: number): Promise<boolean> {
  const updated = await db.updateTable("intake_runs")
    .set({ status: "running", started_at: new Date().toISOString() })
    .where("id", "=", runId)
    .where("status", "=", "queued")
    .executeTakeFirstOrThrow();
  return updated.numUpdatedRows > 0n;
}

type Settle = {
  run: IntakeRunRow;
  intake: IntakeRow;
  runPatch: IntakeRunPatch;
  result: AgentResult | null;
  /** 状態を変えるときだけ。 */
  to?: IntakeState;
  intakePatch?: IntakePatch;
  /** 同じトランザクションで書く行。 */
  extra?: (trx: Db) => Promise<void>;
};

const NOT_OPEN: readonly string[] = ["queued", "running"];

/**
 * 実行の行を閉じ、Intake を更新する。1 トランザクションで、Intake の状態が読んだときのままのときだけ書く。
 * 人が中止していたら何も書かず、行だけ interrupted で閉じて false を返す。
 */
async function settle(db: Db, deps: IntakeRunnerDeps, s: Settle): Promise<boolean> {
  const { run, intake, result } = s;
  const now = new Date().toISOString();
  const closePatch: IntakeRunPatch = {
    ended_at: now,
    cost_usd: result?.costUsd ?? null,
    num_turns: result?.numTurns ?? null,
    duration_ms: result?.durationMs ?? null,
    permission_denials: result === null ? null : denialsColumn(result.permissionDenials),
    ...s.runPatch,
  };
  if (s.to !== undefined) assertIntakeTransition(intake.state, s.to, intake.revising === 1);
  try {
    await db.transaction().execute(async (trx) => {
      await updateIntake(trx, intake.id, {
        ...s.intakePatch,
        ...(s.to !== undefined ? { state: s.to } : {}),
        child_pid: null,
        child_started_at: null,
      }, { requireState: intake.state });
      await s.extra?.(trx);
      await updateIntakeRun(trx, run.id, closePatch);
    });
  } catch (e) {
    if (!(e instanceof IntakeStateConflictError)) throw e;
    await updateIntakeRun(db, run.id, { status: "interrupted", ended_at: now });
    return false;
  }
  if (s.to !== undefined) {
    deps.onStateChanged?.(intake.id, intake.state, s.to, intake.revising === 1);
  }
  return true;
}

function attention(reason: AttentionReason): IntakePatch {
  return { attention_reason: JSON.stringify(reason), rate_limited_until: null };
}

async function failAgent(
  db: Db,
  deps: IntakeRunnerDeps,
  s: { run: IntakeRunRow; intake: IntakeRow; result: AgentResult | null; message: string },
  resetSession: boolean,
): Promise<void> {
  await settle(db, deps, {
    run: s.run,
    intake: s.intake,
    result: s.result,
    runPatch: { status: "failed" },
    to: "needs_attention",
    intakePatch: {
      ...attention({ kind: "agent_failed", runId: s.run.id, message: s.message }),
      ...(resetSession ? { claude_session_id: null } : {}),
    },
  });
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * running の実行 1 行を最後まで走らせ、行を閉じ、Intake の状態を進める。
 * 検証落ちのやり直しは次の queued の行を立てて返る（次の tick が拾う）。
 */
export async function runIntakeRun(db: Db, runId: number, deps: IntakeRunnerDeps): Promise<void> {
  const run = await getIntakeRun(db, runId);
  if (run === undefined || run.status !== "running") return;
  const interrupt = () =>
    updateIntakeRun(db, runId, {
      status: "interrupted",
      ended_at: new Date().toISOString(),
    });

  const intake = await getIntake(db, run.intake_id);
  if (intake === undefined) return await interrupt();
  if (run.purpose === "revise") throw new Error("改訂の実行はまだ扱えません");
  const expected: IntakeState = run.purpose === "investigate" ? "investigating" : "decomposing";
  if (intake.state !== expected) return await interrupt();

  // 会話の最初の呼び出しか。最初の呼び出しが落ちたら、会話ができたか分からないので記録を消す。
  const fresh = intake.claude_session_id === null;

  let worktree: string;
  let sessionId: string;
  let prompt: string;
  try {
    const project = await getProject(db, intake.project_id);
    if (project === undefined) throw new Error(`プロジェクト ${intake.project_id} がありません`);

    worktree = intake.worktree_path ?? await createDetachedWorktree({
      repoPath: project.path,
      worktreePath: intakeWorktreePathFor(project.path, intake.id),
      baseBranch: project.base_branch,
    });
    if (intake.worktree_path === null) {
      await updateIntake(db, intake.id, { worktree_path: worktree });
    }

    const closedRuns = (await listIntakeRuns(db, intake.id)).filter((r) =>
      !NOT_OPEN.includes(r.status)
    );
    const continuation = continuationMessage({
      closedRuns,
      questionSets: await listQuestionSets(db, intake.id),
      drafts: await listDrafts(db, intake.id),
      comments: await listComments(db, intake.id),
    });
    const issue = continuation === null || fresh
      ? await deps.tracker.readIssue(project.path, intake.issue_url)
      : null;

    if (fresh) {
      sessionId = crypto.randomUUID();
      await updateIntake(db, intake.id, { claude_session_id: sessionId });
      const initial = buildInitialPrompt({ issue: issue! });
      prompt = continuation === null ? initial : `${initial}\n\n${continuation}`;
    } else {
      sessionId = intake.claude_session_id!;
      prompt = continuation ?? buildInitialPrompt({ issue: issue! });
    }
  } catch (e) {
    return await failAgent(
      db,
      deps,
      { run, intake, result: null, message: errorMessage(e) },
      fresh,
    );
  }

  const runnerDeps: RunnerDeps = {
    db,
    adapter: deps.adapter,
    logRoot: deps.logRoot,
    onChildSpawned: (pid, startedAt) =>
      updateIntake(db, intake.id, { child_pid: pid, child_started_at: startedAt }),
    onRateLimit: async (s) => {
      await insertRateLimitSample(db, {
        window: s.window,
        utilization: s.utilization,
        resets_at: s.resetsAt,
      });
      await deps.onRateLimit?.(s);
    },
    onLogLine: deps.onLogLine,
  };

  const log = await openLog(run.log_path);
  let driven: Awaited<ReturnType<typeof driveAgent>>;
  try {
    driven = await driveAgent(
      { sessionId, resume: !fresh, deps: runnerDeps },
      prompt,
      {
        cwd: worktree,
        sessionId,
        allowedTools: [...INTAKE_ALLOWED_TOOLS],
        appendSystemPrompt: BUILTIN_APPEND_SYSTEM_PROMPT,
        jsonSchema: decomposerJsonSchema(),
      },
      log,
    );
  } catch (e) {
    return await failAgent(
      db,
      deps,
      { run, intake, result: null, message: errorMessage(e) },
      fresh,
    );
  } finally {
    await log.close();
  }
  const { result, rateLimits } = driven;

  // 書き換えの検出は結果の成否より先に見る。出力は捨てて、worktree を戻す。
  const changed = await changedPaths(worktree);
  if (changed.length > 0) {
    await restoreWorktree(worktree);
    await settle(db, deps, {
      run,
      intake,
      result,
      runPatch: { status: "failed" },
      to: "needs_attention",
      intakePatch: attention({ kind: "wrote_repository", runId: run.id, paths: changed }),
    });
    return;
  }

  if (!result.ok) {
    const verdict = classifyRateLimit({
      status: "failed",
      observed: rateLimits,
      samples: rateLimits.length > 0
        ? []
        : await rateLimitsObservedSince(db, run.started_at ?? new Date().toISOString()),
      now: new Date(),
    });
    let note = "";
    if (verdict.kind === "wait") {
      const closed = (await listIntakeRuns(db, intake.id)).filter((r) =>
        !NOT_OPEN.includes(r.status)
      );
      const rows = closed.map((r) => ({ step_id: r.purpose, status: r.status }));
      if (consecutiveRateLimited(rows, run.purpose) < MAX_CONSECUTIVE_RATE_LIMITS) {
        await settle(db, deps, {
          run,
          intake,
          result,
          runPatch: { status: "rate_limited" },
          intakePatch: {
            rate_limited_until: verdict.until,
            ...(fresh ? { claude_session_id: null } : {}),
          },
        });
        return;
      }
      note =
        `利用上限に連続して ${MAX_CONSECUTIVE_RATE_LIMITS} 回当たりました（次に明けるのは ${verdict.resetsAt}）`;
    } else if (verdict.kind === "too-long") {
      note = `利用上限に達しましたが、枠が明けるのが ${verdict.resetsAt} と遠いので待ちません`;
    }
    const message = [result.text || result.stderrTail || `終了コード ${result.exitCode}`, note]
      .filter((m) => m !== "").join("\n");
    return await failAgent(db, deps, { run, intake, result, message }, fresh);
  }

  await settleOutput(db, deps, { run, intake, result });
}

async function settleOutput(
  db: Db,
  deps: IntakeRunnerDeps,
  s: { run: IntakeRunRow; intake: IntakeRow; result: AgentResult },
): Promise<void> {
  const { run, intake, result } = s;

  const sets = await listQuestionSets(db, intake.id);
  const latest = await latestDraft(db, intake.id);
  const feedback = latest === undefined
    ? []
    : (await listComments(db, intake.id)).filter((c) => c.draft_id === latest.id)
      .sort((a, b) => a.id - b.id);

  const checked = checkDecomposerOutput(result.structuredOutput, {
    purpose: run.purpose,
    askedQuestionIds: new Set(
      sets.flatMap((set) => (JSON.parse(set.questions) as Question[]).map((q) => q.id)),
    ),
    answeredQuestionIds: new Set(
      sets.filter((set) => set.answers !== null)
        .flatMap((set) => (JSON.parse(set.questions) as Question[]).map((q) => q.id)),
    ),
    feedbackCount: feedback.length,
    revision: null,
  });

  if (!checked.ok) {
    const issues = JSON.stringify(checked.issues);
    const closed = (await listIntakeRuns(db, intake.id)).filter((r) =>
      !NOT_OPEN.includes(r.status)
    );
    const streak = consecutiveInvalid(
      [...closed, { purpose: run.purpose, status: "failed", issues }],
      run.purpose,
    );
    if (streak >= MAX_INVALID_OUTPUTS) {
      await settle(db, deps, {
        run,
        intake,
        result,
        runPatch: { status: "failed", issues },
        to: "needs_attention",
        intakePatch: attention({
          kind: "invalid_output",
          runId: run.id,
          issues: checked.issues,
        }),
      });
      return;
    }
    await settle(db, deps, {
      run,
      intake,
      result,
      runPatch: { status: "failed", issues },
      extra: async (trx) => {
        await enqueueIntakeRun(trx, intake.id, run.purpose, {
          logRoot: deps.logRoot,
          resume: false,
        });
      },
    });
    return;
  }

  const output: DecomposerOutput = checked.output;
  const runPatch: IntakeRunPatch = { status: "success", output: JSON.stringify(output) };

  if (output.kind === "questions" && output.questions.length > 0) {
    await settle(db, deps, {
      run,
      intake,
      result,
      runPatch,
      to: "answering",
      extra: async (trx) => {
        await insertQuestionSet(trx, {
          intake_id: intake.id,
          run_id: run.id,
          questions: JSON.stringify(output.questions),
        });
      },
    });
    return;
  }

  if (output.kind === "questions") {
    await settle(db, deps, {
      run,
      intake,
      result,
      runPatch,
      to: "decomposing",
      extra: async (trx) => {
        await enqueueIntakeRun(trx, intake.id, "decompose", {
          logRoot: deps.logRoot,
          resume: false,
        });
      },
    });
    return;
  }

  // 返答の番号は、画面のプレビューと同じ 1 からの番号。DB のコメントの id に直して残す。
  const replies = output.replies.map((r) => ({
    commentId: feedback[r.commentId - 1].id,
    reply: r.reply,
  }));
  const pfd = canonicalJson(output.pfd);
  const hash = await pfdHash(output.pfd);
  await settle(db, deps, {
    run,
    intake,
    result,
    runPatch,
    to: "reviewing",
    extra: async (trx) => {
      await insertDraft(trx, {
        intake_id: intake.id,
        run_id: run.id,
        pfd,
        hash,
        replies: JSON.stringify(replies),
      });
    },
  });
}
