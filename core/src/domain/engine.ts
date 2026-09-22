import type { Branch, Workflow } from "../workflow/schema.ts";
import { branchOf } from "../workflow/schema.ts";
import { expand, type TemplateContext } from "../workflow/template.ts";
import { commitStepBoundary, StateConflictError, type StepBoundary } from "../db/boundary.ts";
import {
  getAwaitingStepRun,
  getStepOutputs,
  lastStepRunFor,
  listStepRuns,
  type StepRunStatus,
} from "../db/stepRuns.ts";
import { captureTree, retainTree } from "./reviewTree.ts";
import {
  attemptCount,
  getProject,
  getTask,
  type TaskRow,
  type TaskState,
  withAttempt,
} from "../db/tasks.ts";
import { insertRateLimitSample, rateLimitsObservedSince } from "../db/rateLimits.ts";
import {
  classifyRateLimit,
  consecutiveRateLimited,
  MAX_CONSECUTIVE_RATE_LIMITS,
  type RateLimitVerdict,
} from "./rateLimit.ts";
import { getSessionId } from "../db/sessions.ts";
import type { Db } from "../db/schema.ts";
import { assertTransition } from "./states.ts";
import { buildTaskContext } from "./taskContext.ts";
import {
  logPathFor,
  runAgentStep,
  runCommandStep,
  runGuideStep,
  type RunnerDeps,
  type StepOutcome,
} from "./stepRunner.ts";

/** session を省略した agent ステップが共有する暗黙のロール名。 */
export const DEFAULT_SESSION_ROLE = "default";

export type Decision =
  | { kind: "next"; stepId: string }
  | { kind: "goto"; stepId: string; feed: string | null }
  | { kind: "suspend" }
  | { kind: "complete" }
  | { kind: "fail"; reason: string };

/**
 * ワークフローの意味論。I/Oを持たないので、ここだけを読めば進行規則が分かる。
 */
export function decide(o: {
  workflow: Workflow;
  currentStepId: string;
  outcome: StepOutcome["status"];
  attempts: number;
}): Decision {
  const index = o.workflow.steps.findIndex((s) => s.id === o.currentStepId);
  if (index === -1) return { kind: "fail", reason: `ステップが見つかりません: ${o.currentStepId}` };
  const step = o.workflow.steps[index];

  if (o.outcome === "suspended") return { kind: "suspend" };

  if (o.outcome === "success") {
    const next = o.workflow.steps[index + 1];
    return next ? { kind: "next", stepId: next.id } : { kind: "complete" };
  }

  const branch: Branch | undefined = branchOf(step);
  if (!branch) {
    return { kind: "fail", reason: `ステップ "${step.id}" が失敗し、onFailure がありません` };
  }
  if (o.attempts >= branch.maxAttempts) {
    return {
      kind: "fail",
      reason: `ステップ "${step.id}" が maxAttempts (${branch.maxAttempts}) を超えました`,
    };
  }
  return { kind: "goto", stepId: branch.goto, feed: branch.feed ?? null };
}

export type EngineDeps = RunnerDeps & {
  globalLimit: number;
  onStateChanged?(taskId: string, from: TaskState, to: TaskState): void;
  onStepRunStarted?(taskId: string, stepRunId: number, stepId: string, attempt: number): void;
  /**
   * stepRunId は commitStepBoundary が返した step_runs.id。イベントがこれを載せる。
   * status は step_runs に**記録した**値（差し戻しなら bounced）。gotoStepId は
   * その差し戻し先で、差し戻しでなければ null。
   */
  onStepRunFinished?(
    taskId: string,
    stepRunId: number,
    stepId: string,
    status: StepRunStatus,
    gotoStepId: string | null,
    attempt: number,
  ): void;
  /**
   * ワークフローは止めないが人に見せるべきこと（レビュー時点のツリーを記録できな
   * かった等）。デーモンは ctx.warnings に積む。
   */
  onWarning?(taskId: string, message: string): void;
};

async function contextFor(db: Db, task: TaskRow): Promise<TemplateContext> {
  const project = (await getProject(db, task.project_id))!;
  return {
    task: { id: task.id, title: task.title, prompt: task.prompt, branch: task.branch },
    issue: { url: task.issue_url, parent_url: task.parent_issue_url },
    worktree: { path: task.worktree_path ?? "" },
    project: { path: project.path },
    steps: await getStepOutputs(db, task.id),
  };
}

/**
 * task.state から to へ遷移させる。読んだ時点から状態が変わっていたら
 * （cancel / pause が先に書いた）何も書かずに返る。新しい状態を所有しているのは
 * 先に書いた側であり、ここで上書きすると中止したはずのタスクが completed などに化ける。
 */
async function setState(
  db: Db,
  task: TaskRow,
  to: TaskState,
  deps: EngineDeps,
  extra: Partial<StepBoundary["taskPatch"]> = {},
): Promise<void> {
  assertTransition(task.state, to);
  try {
    await commitStepBoundary(db, {
      taskId: task.id,
      requireState: task.state,
      taskPatch: { state: to, ...extra },
    });
  } catch (e) {
    if (e instanceof StateConflictError) return;
    throw e;
  }
  deps.onStateChanged?.(task.id, task.state, to);
}

/**
 * 上限に当たった実行をどう扱うか。give-up は「上限ではあるが待たない」で、
 * step_run は failed として閉じたうえで、タスクをそのまま failed にする
 * （onFailure には渡さない。理由は runTask の give-up の分岐にある）。
 */
type RateLimitDecision =
  | { kind: "none" }
  | { kind: "wait"; until: string; resetsAt: string }
  | { kind: "give-up"; note: string };

function withNote(stderr: string, note: string): string {
  return stderr ? `${stderr}\n${note}` : note;
}

/**
 * 状態が running でなくなった後に終わった実行の行を interrupted で閉じる。
 * （task.pause / task.cancel が先に状態を書いた。状態はそちらが持つので触らない。）
 */
async function closeInterrupted(
  db: Db,
  taskId: string,
  stepRunId: number,
  outcome: StepOutcome,
): Promise<void> {
  await commitStepBoundary(db, {
    taskId,
    taskPatch: {},
    stepRunUpdate: {
      id: stepRunId,
      status: "interrupted",
      exit_code: outcome.exitCode,
      ended_at: outcome.endedAt,
      cost_usd: outcome.costUsd,
      num_turns: outcome.numTurns,
      duration_ms: outcome.durationMs,
      permission_denials: outcome.permissionDenials,
    },
    // 止められた子の stderr の末尾は、後から診断するのに使う。
    outputs: {
      last_stdout: outcome.stdout,
      last_stderr: outcome.stderr,
      exit_code: outcome.exitCode,
    },
  });
}

async function decideRateLimit(
  db: Db,
  outcome: StepOutcome,
  taskId: string,
  stepId: string,
): Promise<RateLimitDecision> {
  const verdict: RateLimitVerdict = classifyRateLimit({
    status: outcome.status,
    observed: outcome.rateLimits,
    // イベントを1件も受け取れなかったときだけ、その実行の開始以降に観測された
    // 記録を代替の根拠にする。
    samples: outcome.rateLimits.length > 0
      ? []
      : await rateLimitsObservedSince(db, outcome.startedAt),
    now: new Date(),
  });
  if (verdict.kind === "none") return verdict;
  if (verdict.kind === "too-long") {
    return {
      kind: "give-up",
      note: `利用上限に達しましたが、枠が明けるのが ${verdict.resetsAt} と遠いので待ちません`,
    };
  }

  // 開いている今回の行（status は running）は数に入れない。
  const closed = (await listStepRuns(db, taskId)).filter((r) => r.status !== "running");
  if (consecutiveRateLimited(closed, stepId) >= MAX_CONSECUTIVE_RATE_LIMITS) {
    return {
      kind: "give-up",
      note:
        `利用上限に連続して ${MAX_CONSECUTIVE_RATE_LIMITS} 回当たりました（次に明けるのは ${verdict.resetsAt}）`,
    };
  }
  return verdict;
}

/**
 * running のタスクを、次に人を待つ地点（approval / 終端）まで進める。
 * ステップ境界ごとに1トランザクションで書く。落ちて失うのは最大1ステップ分。
 */
export async function runTask(
  db: Db,
  taskId: string,
  workflow: Workflow,
  deps: EngineDeps,
): Promise<void> {
  let task = await getTask(db, taskId);
  if (!task) throw new Error(`タスクがありません: ${taskId}`);

  let stepId = task.current_step_id ?? workflow.steps[0].id;
  // suspend 境界（承認待ち）をまたいだ feed は task.pending_feed に永続化されている。
  // ローカル変数だけでは runTask の呼び出し自体が終わってしまうと消えるし、
  // daemon が承認待ちの最中に再起動しても復元できない。ここで一度だけ取り込み、
  // 直後のステップ開始コミットで DB 側を null に戻して「消費は一度きり」を保証する。
  let pendingFeed: string | null = task.pending_feed ?? null;

  while (true) {
    task = (await getTask(db, taskId))!;
    // ループが走り続ける権利を毎周確認する。task.cancel / task.pause は子を
    // SIGTERM して新しい状態を書くが、このループを止める手段は持っていない
    // （走っていた実行の行は、終了コミットが状態の食い違いを見て interrupted で閉じる）。
    // ここで降りないと、cancel 後も次のステップの子を spawn して、ユーザーが
    // 捨てたつもりの worktree に書き続ける。pause ではさらに current_step_id を
    // 進めてしまい、後の resume が1ステップ黙って飛ばす。
    // 新しい状態を所有しているのは状態を書いた側なので、ここでは何も書かずに返る。
    //
    // この読み取りは早く降りるためのもので、保証ではない。読んでから下の
    // ステップ開始コミットまでには await があり、その隙に cancel が届き得る。
    // 保証はステップ開始コミットの requireState: "running" が持つ。
    if (task.state !== "running") return;
    const step = workflow.steps.find((s) => s.id === stepId);
    if (!step) {
      await setState(db, task, "failed", deps);
      return;
    }

    if (step.type === "approval") {
      // ここから「レビュー1回」が始まる。待ち始めた時刻・そのときのツリーを
      // 決定時ではなく今の時点で記録する（決定時に作る行は待ち時間を常に0にする）。
      //
      // ツリーは判断材料であって承認そのものではないので、取れなくても止めない
      // （spec 5.3）。欠けるのは次の差し戻しで「前回レビュー以降」が引けないことだけ。
      let reviewTree: string | null = null;
      if (task.worktree_path) {
        try {
          reviewTree = await captureTree(task.worktree_path);
        } catch (e) {
          deps.onWarning?.(
            taskId,
            `レビュー時点のツリーを記録できませんでした: ${(e as Error).message}`,
          );
        }
      } else {
        // 「記録に失敗した」と「記録する対象がそもそも無かった」を区別できるようにする。
        // どちらも review_tree は null になるので、黙ると後から見分けがつかない。
        deps.onWarning?.(taskId, "worktree が無いためレビュー時点のツリーを記録できませんでした");
      }

      assertTransition(task.state, "suspended");
      let stepRunId: number | null;
      try {
        stepRunId = await commitStepBoundary(db, {
          taskId,
          requireState: "running",
          taskPatch: {
            state: "suspended",
            current_step_id: step.id,
            // approval も他のステップと同じく「開始時」に attempt を進める。
            // applyApproval はこの数をそのまま decide へ渡す。
            attempt_counts: withAttempt(task, step.id),
            child_pid: null,
            child_started_at: null,
          },
          stepRun: {
            step_id: step.id,
            attempt: attemptCount(task, step.id) + 1,
            status: "awaiting",
            exit_code: null,
            started_at: new Date().toISOString(),
            ended_at: null,
            // 人の判断にログファイルは無い。
            log_path: "",
            review_tree: reviewTree,
          },
        });
      } catch (e) {
        if (e instanceof StateConflictError) return;
        throw e;
      }
      deps.onStateChanged?.(taskId, task.state, "suspended");

      // 参照は step_run の id を名前に持つので、行を書いた後でしか張れない。
      // この隙間で落ちるとツリーが gc に刈られ得るが、そのとき欠けるのは基準点
      // だけで、レビューそのものは回る（spec 5.2）。
      if (reviewTree !== null && stepRunId !== null) {
        try {
          await retainTree({
            worktreePath: task.worktree_path!,
            taskId,
            stepRunId,
            tree: reviewTree,
          });
        } catch (e) {
          deps.onWarning?.(
            taskId,
            `レビュー時点のツリーの参照を張れませんでした: ${(e as Error).message}`,
          );
        }
      }
      return;
    }

    // 上限待ちから戻ってきた実行は、ワークフロー上の新しい試行ではない。カウンタは
    // 持たず、直前の step_run の status から導く（デーモンの再起動をまたいでも同じ）。
    // 進めてしまうと onFailure / onReject の maxAttempts を上限が食い潰す。
    const resumingAfterRateLimit =
      (await lastStepRunFor(db, taskId, step.id))?.status === "rate_limited";
    const attempt = attemptCount(task, step.id) + (resumingAfterRateLimit ? 0 : 1);
    const ctx = await contextFor(db, task);
    // セッションはロール単位（agent ステップの session、省略時は既定ロール）。
    // 「このロールで会話が既にあったか」だけが resume すべきかを決める
    // （ステップ内の再試行かどうかではない）。session を省略すると全 agent ステップが
    // 同じ既定ロールを共有するので、今までどおり「タスクに会話は1本」になる。
    // guide の session は必須なので、既定ロールには落ちない。
    const role = step.type === "agent"
      ? (step.session ?? DEFAULT_SESSION_ROLE)
      : step.type === "guide"
      ? step.session
      : null;
    const existingSessionId = role ? await getSessionId(db, taskId, role) : undefined;
    const hadSession = existingSessionId !== undefined;
    const sessionId = existingSessionId ?? crypto.randomUUID();

    const logPath = logPathFor(deps.logRoot, taskId, step.id, attempt);
    // 開始時に running の行を立てる。クラッシュ復帰はこの行を見て、
    // どのステップの途中で落ちたかを知る（Task 11）。
    let stepRunId: number;
    try {
      stepRunId = (await commitStepBoundary(db, {
        taskId,
        // 状態の確認と書き込みを同じトランザクションで行う。running でなくなって
        // いれば（上の読み取りの後に cancel / pause が書いた）何も書かずに降りる。
        requireState: "running",
        taskPatch: {
          current_step_id: step.id,
          attempt_counts: resumingAfterRateLimit ? task.attempt_counts : withAttempt(task, step.id),
          pending_feed: null,
        },
        // 会話を始めるのは agent ステップだけ。command ステップでは書かない —
        // 一度も start していないロールが「会話がある」ことにされ、次の agent が
        // そのロールで resume してしまうのを防ぐ（project.setup は全ワークフローの
        // 先頭に command ステップとして入るので、これは常道の形で必ず踏む）。
        sessionUpsert: role ? { role, session_id: sessionId } : undefined,
        stepRun: {
          step_id: step.id,
          attempt,
          status: "running",
          exit_code: null,
          started_at: new Date().toISOString(),
          ended_at: null,
          log_path: logPath,
        },
      }))!;
    } catch (e) {
      if (e instanceof StateConflictError) return;
      throw e;
    }
    deps.onStepRunStarted?.(taskId, stepRunId, step.id, attempt);

    const runnerDeps: RunnerDeps = {
      ...deps,
      onChildSpawned: async (pid, startedAt) => {
        await commitStepBoundary(db, {
          taskId,
          taskPatch: { child_pid: pid, child_started_at: startedAt },
        });
        await deps.onChildSpawned?.(pid, startedAt);
      },
      onRateLimit: async (s) => {
        await insertRateLimitSample(db, {
          window: s.window,
          utilization: s.utilization,
          resets_at: s.resetsAt,
        });
        await deps.onRateLimit?.(s);
      },
    };

    const isResume = hadSession;
    // 上限で待ちに入るときに pending_feed へ書き戻す値。stepRunner が展開した
    // プロンプト文字列ではなく、goto の時点で expand 済みのこのローカル変数が正。
    const feedForThisStep = pendingFeed;
    let outcome: StepOutcome;
    // Task 4 で poll ステップの実行を実装するまでの暫定。ここが無いと else 節が
    // AgentStep を期待する runAgentStep に PollStep を渡すことになり型が壊れる。
    if (step.type === "poll") throw new Error("poll ステップはまだ実行できません");
    if (step.type === "command") {
      outcome = await runCommandStep(step, ctx, {
        cwd: task.worktree_path!,
        taskId,
        attempt,
        deps: runnerDeps,
      });
    } else if (step.type === "guide") {
      // DB にしか無い入力（テスト結果と人の差し戻しコメント）はここで集めて渡す。
      const taskContext = await buildTaskContext(db, task, workflow);
      const project = (await getProject(db, task.project_id))!;
      outcome = await runGuideStep(step, ctx, {
        cwd: task.worktree_path!,
        taskId,
        attempt,
        sessionId,
        resume: isResume,
        baseBranch: project.base_branch,
        lastCommand: taskContext.lastCommand,
        rejections: taskContext.reviews.flatMap((r) => r.status === "rejected" ? [r.comment] : []),
        feed: pendingFeed,
        deps: runnerDeps,
      });
    } else {
      outcome = await runAgentStep(
        step,
        ctx,
        {
          cwd: task.worktree_path!,
          taskId,
          attempt,
          sessionId,
          resume: isResume,
          feed: pendingFeed,
          deps: runnerDeps,
        },
      );
    }
    pendingFeed = null;

    // 上限に当たれるのはアダプタを通る agent / guide ステップだけ。command ステップは
    // この分岐に入る余地がない。
    const verdict: RateLimitDecision = step.type === "agent" || step.type === "guide"
      ? await decideRateLimit(db, outcome, taskId, step.id)
      : { kind: "none" };

    if (verdict.kind === "wait") {
      assertTransition(task.state, "rate_limited");
      try {
        await commitStepBoundary(db, {
          taskId,
          requireState: "running",
          taskPatch: {
            state: "rate_limited",
            rate_limited_until: verdict.until,
            child_pid: null,
            child_started_at: null,
            // feed 無しのステップでは書き戻さない。展開済みの step.prompt を入れると、
            // 再開時の入力がワークフロー定義由来から DB 由来に変わり、待っている間に
            // worktree やステップ出力が変わっても古い文面が固定される。
            ...(feedForThisStep !== null ? { pending_feed: feedForThisStep } : {}),
          },
          stepRunUpdate: {
            id: stepRunId,
            status: "rate_limited",
            exit_code: outcome.exitCode,
            ended_at: outcome.endedAt,
            cost_usd: outcome.costUsd,
            num_turns: outcome.numTurns,
            duration_ms: outcome.durationMs,
            permission_denials: outcome.permissionDenials,
          },
          outputs: {
            last_stdout: outcome.stdout,
            last_stderr: withNote(
              outcome.stderr,
              `利用上限に達しました（枠が明けるのは ${verdict.resetsAt}、${verdict.until} に再開します）`,
            ),
            exit_code: outcome.exitCode,
          },
          // その role の最初の呼び出しで弾かれたなら、会話が作られたかは分からない。
          // 記録を取り消し、再開時は新しい session id で start し直す。
          sessionDelete: !isResume && role ? { role } : undefined,
        });
      } catch (e) {
        if (e instanceof StateConflictError) {
          await closeInterrupted(db, taskId, stepRunId, outcome);
          deps.onStepRunFinished?.(taskId, stepRunId, step.id, "interrupted", null, attempt);
          return;
        }
        throw e;
      }
      // この経路は setState を通らないので、通知は自分で呼ぶ（呼ばないとアプリは
      // 次の取り直しまで「実行中」のまま見え続ける）。
      deps.onStateChanged?.(taskId, "running", "rate_limited");
      deps.onStepRunFinished?.(taskId, stepRunId, step.id, "rate_limited", null, attempt);
      return;
    }

    // 決定を終了のコミットより前に出す。差し戻し（goto が発火した実行）と本当の
    // 失敗（分岐先が無い・maxAttempts を使い切った）は、決定を知らないと書き分け
    // られない。渡す attempts はステップ開始コミットで進めた後の数でなければ
    // ならず、それは開始時に算出済みの attempt がそのまま持っている
    // （タスクの読み直しは要らない）。判断規則そのものは decide のまま変えない。
    const decision = decide({
      workflow,
      currentStepId: step.id,
      outcome: outcome.status,
      attempts: attempt,
    });
    // 待たずに失敗させた上限（give-up）は decide に渡さない（下の分岐）ので、
    // onFailure があっても差し戻しとは記録しない。
    const bounced = verdict.kind !== "give-up" && decision.kind === "goto";
    const recordedStatus: StepRunStatus = bounced ? "bounced" : outcome.status as StepRunStatus;

    try {
      await commitStepBoundary(db, {
        taskId,
        // running でなくなっていれば（pause / cancel が先に書いた）、この実行の
        // 結果は使わず行を interrupted で閉じる。
        requireState: "running",
        taskPatch: { child_pid: null, child_started_at: null },
        stepRunUpdate: {
          id: stepRunId,
          status: recordedStatus,
          exit_code: outcome.exitCode,
          ended_at: outcome.endedAt,
          cost_usd: outcome.costUsd,
          num_turns: outcome.numTurns,
          duration_ms: outcome.durationMs,
          goto_step_id: bounced ? decision.stepId : null,
          permission_denials: outcome.permissionDenials,
        },
        outputs: {
          last_stdout: outcome.stdout,
          // 待たずに失敗させた上限は、board 上で普通の失敗と区別が付くようにする。
          last_stderr: verdict.kind === "give-up"
            ? withNote(outcome.stderr, verdict.note)
            : outcome.stderr,
          exit_code: outcome.exitCode,
        },
      });
    } catch (e) {
      if (e instanceof StateConflictError) {
        await closeInterrupted(db, taskId, stepRunId, outcome);
        deps.onStepRunFinished?.(taskId, stepRunId, step.id, "interrupted", null, attempt);
        return;
      }
      throw e;
    }
    // イベントとDBが食い違わないよう、渡すのは記録した status。
    deps.onStepRunFinished?.(
      taskId,
      stepRunId,
      step.id,
      recordedStatus,
      bounced ? decision.stepId : null,
      attempt,
    );

    if (verdict.kind === "give-up") {
      // 上限で待たないと決めた実行は decide に渡さない。渡すと onFailure が
      // 同じステップをやり直し、閉じていると分かっている枠に対して maxAttempts の
      // 回ぶん claude を起動し直したうえ、上限がワークフロー本来の試行回数を食う
      // （待ちの連続数も failed の行で切れるので、待ちは 5 回では止まらなくなる）。
      // ここで止めるのが「人が作り直すか上限を上げるかを決める機会」（spec 6章）。
      await setState(db, task, "failed", deps);
      return;
    }

    task = (await getTask(db, taskId))!;

    switch (decision.kind) {
      case "next":
        stepId = decision.stepId;
        break;
      case "goto":
        stepId = decision.stepId;
        pendingFeed = decision.feed ? expand(decision.feed, await contextFor(db, task)) : null;
        break;
      case "complete":
        await setState(db, task, "completed", deps);
        return;
      case "fail":
        await setState(db, task, "failed", deps);
        return;
      case "suspend":
        await setState(db, task, "suspended", deps);
        return;
    }
  }
}

/**
 * approval の結果を適用する。却下コメントは approval ステップの last_stdout として保存する
 * （agent ステップの last_stdout を最終結果テキストとしたのと同じ扱い。変数の系統を増やさない）。
 *
 * 書き込みはすべて requireState: "suspended" 付き。読んでから書くまでの間に
 * task.cancel などが届いていれば、StateConflictError で何も書かずに失敗する。
 */
export async function applyApproval(
  db: Db,
  taskId: string,
  verdict: { approved: boolean; comment: string },
  workflow: Workflow,
): Promise<void> {
  const task = await getTask(db, taskId);
  if (!task) throw new Error(`タスクがありません: ${taskId}`);
  if (task.state !== "suspended") throw new Error(`承認待ちではありません: ${task.state}`);

  const stepId = task.current_step_id!;
  const index = workflow.steps.findIndex((s) => s.id === stepId);
  // ワークフローは承認のたびにディスクから読み直される。承認待ちの間に YAML が
  // 編集されて承認ステップが消えていると、index は -1 になり steps[-1 + 1] が
  // steps[0]（＝先頭ステップ）になる。黙ってワークフローを頭からやり直すより、
  // 消えたステップ名を名指しして止める方がよい。
  if (index === -1) {
    throw new Error(
      `承認待ちのステップがワークフローにありません: ${stepId}（承認待ちの間に定義が変更された可能性があります）`,
    );
  }
  const now = new Date().toISOString();

  // 「suspended なら awaiting の行がちょうど1件ある」は runTask と 0003 の
  // マイグレーションが保つ不変条件。無ければ記録が壊れている。ここで started_at =
  // now の行を作って取り繕うと、待ち時間0という嘘を記録に残すことになる。
  const awaiting = await getAwaitingStepRun(db, taskId, stepId);
  if (!awaiting) {
    throw new Error(`承認待ちのステップ実行がありません: ${taskId} / ${stepId}`);
  }

  if (verdict.approved) {
    const next = workflow.steps[index + 1];
    const to: TaskState = next ? "queued" : "completed";
    // 遷移表に反する書き込みを防ぐ。ここで投げれば commitStepBoundary は一切呼ばれず、
    // タスク行・step_run・outputs のどれも書き換わらない（呼び出し前に検査するのが要点）。
    assertTransition(task.state, to);
    await commitStepBoundary(db, {
      taskId,
      requireState: "suspended",
      taskPatch: next
        ? { state: "queued", current_step_id: next.id, resumed: 1 }
        : { state: "completed" },
      stepRunUpdate: { id: awaiting.id, status: "success", exit_code: 0, ended_at: now },
      outputs: { last_stdout: "", last_stderr: "", exit_code: 0 },
    });
    return;
  }

  // 却下は onFailure と同じ「失敗して分岐する」ケースであり、goto/maxAttempts の
  // 判断はここで作り直さず decide に委ねる。attempt は suspended に入った時点で
  // 既に進んでいるので、attemptCount がそのまま maxAttempts と比較される数であり、
  // かつ awaiting の行に記録されている attempt と一致する。
  const decision = decide({
    workflow,
    currentStepId: stepId,
    outcome: "failed",
    attempts: attemptCount(task, stepId),
  });

  // {{ steps.review.last_stdout }} は却下コメントを指す。DBへ書く前に、これから書く値を
  // 直接コンテキストへ差し込んで展開する（コマンド実行パスが「出力を書いてから
  // 次のステップで参照する」のと同じ意味を、1トランザクション内で再現する）。
  const ctx = await contextFor(db, task);
  ctx.steps[stepId] = { last_stdout: verdict.comment, last_stderr: "", exitCode: "1" };

  // 却下コメントの書き方はどちらの枝でも同じ。status だけは枝で分かれる
  // （前のステップへ戻る却下は差し戻しであってタスクの失敗ではない）。
  const comment = {
    outputs: { last_stdout: verdict.comment, last_stderr: "", exit_code: 1 },
  };

  if (decision.kind === "goto") {
    const to: TaskState = "queued";
    assertTransition(task.state, to);
    await commitStepBoundary(db, {
      taskId,
      requireState: "suspended",
      taskPatch: {
        state: "queued",
        current_step_id: decision.stepId,
        resumed: 1,
        pending_feed: decision.feed ? expand(decision.feed, ctx) : null,
      },
      stepRunUpdate: {
        id: awaiting.id,
        status: "bounced",
        exit_code: 1,
        ended_at: now,
        goto_step_id: decision.stepId,
      },
      ...comment,
    });
    return;
  }

  // decision.kind === "fail"（onReject が無い、または maxAttempts を使い切った）
  const to: TaskState = "failed";
  assertTransition(task.state, to);
  await commitStepBoundary(db, {
    taskId,
    requireState: "suspended",
    taskPatch: { state: "failed" },
    stepRunUpdate: { id: awaiting.id, status: "failed", exit_code: 1, ended_at: now },
    ...comment,
  });
}
