import { join } from "@std/path";
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
  listComments,
  listDrafts,
  listIntakeRuns,
  updateIntake,
  updateIntakeRun,
} from "../db/intakes.ts";
import { loadQuestionSets, questionSetIds } from "./questionSet.ts";
import { insertRateLimitSample, rateLimitsObservedSince } from "../db/rateLimits.ts";
import type {
  Db,
  IntakeCommentRow,
  IntakeDraftRow,
  IntakeRow,
  IntakeRunPurpose,
  IntakeRunRow,
  IntakeState,
  ProjectRow,
} from "../db/schema.ts";
import { listProjectsOf, workspaceRefOf } from "../db/workspaces.ts";
import { assertIntakeTransition } from "../domain/intakeStates.ts";
import {
  classifyRateLimit,
  consecutiveRateLimited,
  MAX_CONSECUTIVE_RATE_LIMITS,
} from "../domain/rateLimit.ts";
import { driveAgent, logPathFor, openLog, type RunnerDeps } from "../domain/stepRunner.ts";
import { BUILTIN_APPEND_SYSTEM_PROMPT } from "../domain/systemPrompt.ts";
import {
  canonical,
  changedPaths,
  checkoutDetached,
  createDetachedWorktree,
  intakeWorktreePathFor,
  listIntakeWorktrees,
  restoreWorktree,
} from "../domain/worktree.ts";
import type { TrackerOf } from "../tracker/tracker.ts";
import type { WorkspaceTracker } from "../tracker/workspaceTracker.ts";
import { READ_ONLY_TOOLS } from "../workflow/scaffold.ts";
import {
  type AttentionReason,
  decomposerJsonSchema,
  type DecomposerOutput,
} from "../../../shared/intake/decomposer.ts";
import { decisionTexts } from "../../../shared/intake/answerText.ts";
import { buildFeedback } from "../../../shared/intake/feedback.ts";
import type { IssueDetail } from "../../../shared/intake/tracker.ts";
import { canonicalJson } from "../../../shared/intake/pfd.ts";
import { consecutiveInvalid, continuationMessage, MAX_INVALID_OUTPUTS } from "./conversation.ts";
import { checkDecomposerOutput } from "./output.ts";
import { pfdHash } from "./pfd/hash.ts";
import { buildInitialPrompt, buildRevisionPrompt, type PromptProject } from "./prompt.ts";
import { loadRevisionConstraints } from "./revision.ts";

export { MAX_INVALID_OUTPUTS } from "./conversation.ts";

/**
 * 読むだけの道具（spec 7 章）。Write・Edit・gh・dctl は含めない。
 * cwd が git リポジトリでないので、git の許可はプロジェクトごとの git -C <名前> に展開する（workspace spec 5 章）。
 */
export function intakeAllowedTools(projectNames: readonly string[]): string[] {
  const tools: string[] = ["Read", "Grep", "Glob"];
  for (const t of READ_ONLY_TOOLS) {
    if (t.startsWith("Bash(git ")) {
      const rest = t.slice("Bash(git ".length);
      for (const name of projectNames) tools.push(`Bash(git -C ${name} ${rest}`);
    } else {
      tools.push(t);
    }
  }
  return tools;
}

export type IntakeRunnerDeps = {
  db: Db;
  adapter: AgentAdapter;
  trackerOf: TrackerOf;
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
      // 改訂をやめて入り直すと、状態は decomposing のまま別の改訂になる。前の改訂の実行は書かない。
      if (run.purpose === "revise") {
        const current = await getIntake(trx, intake.id);
        if (current?.revision_run_id !== intake.revision_run_id) {
          throw new IntakeStateConflictError(intake.id, intake.state, current?.state ?? null);
        }
      }
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

/** 会話の文面と検証落ちの数え方に使う行。revise のときは今の改訂の分だけ。 */
type ConversationRows = {
  closedRuns: IntakeRunRow[];
  drafts: IntakeDraftRow[];
  comments: IntakeCommentRow[];
  /** 次の出力の replies が指すコメント（buildFeedback と同じ順）。 */
  feedback: IntakeCommentRow[];
};

/**
 * 改訂の会話は revision_run_id 以降の実行と案で始まり、開始コメントは run_id で選ぶ。
 * 放棄した改訂の実行・案・コメントを次の改訂に持ち込まない。
 */
async function conversationRows(
  db: Db,
  intake: IntakeRow,
  run: IntakeRunRow,
): Promise<ConversationRows> {
  const closedAll = (await listIntakeRuns(db, intake.id)).filter((r) =>
    !NOT_OPEN.includes(r.status)
  );
  const draftsAll = await listDrafts(db, intake.id);
  const commentsAll = await listComments(db, intake.id);
  const onDraft = (draftId: number | undefined) =>
    draftId === undefined ? [] : commentsAll.filter((c) => c.draft_id === draftId);

  if (run.purpose !== "revise") {
    return {
      closedRuns: closedAll,
      drafts: draftsAll,
      comments: commentsAll,
      feedback: onDraft(draftsAll.at(-1)?.id),
    };
  }

  const from = intake.revision_run_id;
  if (from === null) throw new Error("改訂の最初の実行が記録されていません");
  const drafts = draftsAll.filter((d) => d.run_id >= from);
  const draftIds = new Set(drafts.map((d) => d.id));
  const comments = commentsAll.filter((c) => c.run_id === from || draftIds.has(c.draft_id));
  const latest = drafts.at(-1);
  return {
    closedRuns: closedAll.filter((r) => r.id >= from),
    drafts,
    comments,
    feedback: latest === undefined ? comments.filter((c) => c.run_id === from) : onDraft(latest.id),
  };
}

/** プロンプトに載せるプロジェクト。GitHub なら repoOf の nameWithOwner、失敗したら repo は null。 */
async function promptProjectsOf(
  projects: readonly ProjectRow[],
  wt: WorkspaceTracker,
): Promise<PromptProject[]> {
  return await Promise.all(projects.map(async (p) => {
    let repo: string | null = null;
    if (wt.kind === "github" && wt.tracker.repoOf) {
      try {
        repo = (await wt.tracker.repoOf(p.path)).nameWithOwner;
      } catch {
        repo = null;
      }
    }
    return { name: p.name, baseBranch: p.base_branch, repo };
  }));
}

/** 会話の最初に送る文面。revise は承認済みの計画と固定された部分を載せる。 */
async function firstPromptOf(
  db: Db,
  intake: IntakeRow,
  run: IntakeRunRow,
  opening: { issue: IssueDetail; projects: PromptProject[] },
  rows: ConversationRows,
): Promise<string> {
  const { issue, projects } = opening;
  if (run.purpose !== "revise") return buildInitialPrompt({ issue, projects });
  const constraints = await loadRevisionConstraints(db, intake.id);
  const approved = constraints.approved.pfd;
  const decisions = decisionTexts(await loadQuestionSets(db, intake.id));
  return buildRevisionPrompt({
    issue,
    approved,
    frozen: constraints.frozen,
    retiredProcessIds: [...constraints.retiredProcessIds],
    decisions,
    feedback: buildFeedback(
      approved,
      rows.comments.filter((c) => c.run_id === intake.revision_run_id),
    ),
    projects,
  });
}

/**
 * 親ディレクトリを作り、登録中のプロジェクトのうち子 worktree が無いものを baseBranch から作り足す。
 * 外されたプロジェクトの子は残す。戻り値は親の実パス。
 */
async function prepareIntakeWorktrees(
  db: Db,
  intake: IntakeRow,
  projects: readonly ProjectRow[],
): Promise<string> {
  const parent = intake.worktree_path ?? intakeWorktreePathFor(intake.id);
  await Deno.mkdir(parent, { recursive: true });
  const canonicalParent = await canonical(parent);
  for (const p of projects) {
    const child = join(canonicalParent, p.name);
    try {
      await Deno.stat(child);
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
      await createDetachedWorktree({
        repoPath: p.path,
        worktreePath: child,
        baseBranch: p.base_branch,
      });
    }
  }
  if (intake.worktree_path === null) {
    await updateIntake(db, intake.id, { worktree_path: canonicalParent });
  }
  return canonicalParent;
}

/**
 * 親の下の子 worktree（外されたプロジェクトの分も含む）の書き換えを <名前>/<パス> で集め、
 * 書き換えのあった子を巻き戻す。書き換えが無ければ空配列。
 */
async function revertWrites(parentPath: string): Promise<string[]> {
  const children = await listIntakeWorktrees(parentPath);
  const paths: string[] = [];
  const changedChildren: typeof children = [];
  for (const child of children) {
    const changed = await changedPaths(child.path);
    if (changed.length > 0) {
      changedChildren.push(child);
      for (const p of changed) paths.push(`${child.name}/${p}`);
    }
  }
  for (const child of changedChildren) {
    await restoreWorktree(child.path);
  }
  return paths;
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
  const expected: IntakeState = run.purpose === "investigate" ? "investigating" : "decomposing";
  if (intake.state !== expected) return await interrupt();

  // 会話の最初の呼び出しか。最初の呼び出しが落ちたら、会話ができたか分からないので記録を消す。
  const fresh = intake.claude_session_id === null;

  let worktree: string;
  let sessionId: string;
  let prompt: string;
  let projects: ProjectRow[];
  try {
    projects = await listProjectsOf(db, intake.workspace_id);
    if (projects.length === 0) {
      throw new Error(`workspace ${intake.workspace_id} にプロジェクトがありません`);
    }

    worktree = await prepareIntakeWorktrees(db, intake, projects);

    // 改訂に入った直後の会話は、承認の後に進んだ baseBranch から読ませる
    if (run.purpose === "revise" && fresh) {
      for (const p of projects) {
        await checkoutDetached(join(worktree, p.name), p.base_branch);
      }
    }

    const rows = await conversationRows(db, intake, run);
    const continuation = continuationMessage({
      closedRuns: rows.closedRuns,
      questionSets: await loadQuestionSets(db, intake.id),
      drafts: rows.drafts,
      comments: rows.comments,
    });
    const opening = continuation === null || fresh
      ? await (async () => {
        const wt = await deps.trackerOf(await workspaceRefOf(db, intake.workspace_id));
        const projectPath = (await wt.projectPathFor(intake.issue_url)) ?? projects[0].path;
        const issue = await wt.tracker.readIssue(projectPath, intake.issue_url);
        const promptProjects = await promptProjectsOf(projects, wt);
        return { issue, projects: promptProjects };
      })()
      : null;
    const firstPrompt = () => firstPromptOf(db, intake, run, opening!, rows);

    if (fresh) {
      sessionId = crypto.randomUUID();
      await updateIntake(db, intake.id, { claude_session_id: sessionId });
      const initial = await firstPrompt();
      prompt = continuation === null ? initial : `${initial}\n\n${continuation}`;
    } else {
      sessionId = intake.claude_session_id!;
      prompt = continuation ?? await firstPrompt();
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
        allowedTools: intakeAllowedTools(projects.map((p) => p.name)),
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
  const changed = await revertWrites(worktree);
  if (changed.length > 0) {
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
      const { closedRuns } = await conversationRows(db, intake, run);
      const rows = closedRuns.map((r) => ({ step_id: r.purpose, status: r.status }));
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

  const sets = await loadQuestionSets(db, intake.id);
  const { closedRuns, feedback } = await conversationRows(db, intake, run);

  const checked = checkDecomposerOutput(result.structuredOutput, {
    purpose: run.purpose,
    askedIds: new Set(sets.flatMap(questionSetIds)),
    decisionIds: new Set(sets.filter((set) => set.reply !== null).flatMap(questionSetIds)),
    projectNames: new Set((await listProjectsOf(db, intake.workspace_id)).map((p) => p.name)),
    feedbackCount: feedback.length,
    revision: run.purpose === "revise" ? await loadRevisionConstraints(db, intake.id) : null,
  });

  if (!checked.ok) {
    const issues = JSON.stringify(checked.issues);
    const streak = consecutiveInvalid(
      [...closedRuns, { purpose: run.purpose, status: "failed", issues }],
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

  if (
    output.kind === "questions" &&
    (output.questions.length > 0 || output.assumptions.length > 0)
  ) {
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
          assumptions: JSON.stringify(output.assumptions),
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
