import { isAbsolute, join } from "@std/path";
import { computeDiff, mergeBase, type TaskDiff } from "../domain/diff.ts";
import { branchOf, type Workflow } from "../workflow/schema.ts";
import {
  applyProjectConfig,
  parseProjectConfig,
  type ProjectConfig,
  type ProjectConfigInput,
  writeProjectYaml,
} from "../workflow/project.ts";
import { ensureProjectScaffold } from "../workflow/scaffold.ts";
import { pinOf, type WorkflowLoader } from "../workflow/load.ts";
import {
  getProject,
  getProjectByPath,
  getTask,
  insertProject,
  insertTask,
  listProjects,
  listTasks,
  type ProjectRow,
  type TaskRow,
  type TaskState,
} from "../db/tasks.ts";
import { getStepRun, lastRejectedReview, lastStepRun, listStepRuns } from "../db/stepRuns.ts";
import { commitStepBoundary, StateConflictError } from "../db/boundary.ts";
import type { Db } from "../db/schema.ts";
import { recentRateLimitSamples } from "../db/rateLimits.ts";
import { normalizeResetsAt } from "../domain/rateLimit.ts";
import {
  hasActiveRateLimit,
  releaseDueIntakeRateLimited,
  releaseDueRateLimited,
  selectAdmissible,
  selectAdmissibleIntakeRuns,
  slotsSnapshot,
} from "../domain/scheduler.ts";
import { validateGlobalLimit, writeDaemonConfig } from "./config.ts";
import {
  getIntake,
  type IntakeRow,
  listIntakes,
  updateIntake,
  updateIntakeRun,
} from "../db/intakes.ts";
import { isIntakeTerminal } from "../domain/intakeStates.ts";
import { claimIntakeRun, runIntakeRun } from "../intake/runner.ts";
import {
  abandonRevision,
  answerIntake,
  approveIntake,
  cancelIntake,
  closeParentIssue,
  completeHumanProcess,
  type IntakeTransition,
  rejectIntake,
  reviseIntake,
  setDispatchPaused,
  startIntake,
} from "../intake/commands.ts";
import { previewTaskPrompt, redispatchProcess } from "../intake/dispatch.ts";
import { intakeDraft, toIntakeDetail, toIntakeSummary } from "../intake/view.ts";
import type { IntakeWatcher } from "../intake/watch.ts";
import type { Tracker } from "../github/tracker.ts";
import { applyApproval, runTask } from "../domain/engine.ts";
import {
  branchNameFor,
  canonical,
  createWorktree,
  fetchBaseBranch,
  hasUncommittedChanges,
  isUnderWorktreesDir,
  listWorktrees,
  originRef,
  removeWorktree,
  UncommittedChangesError,
  worktreePathFor,
} from "../domain/worktree.ts";
import { cancelTask, closeAwaitingStepRun } from "../domain/cancelTask.ts";
import { defaultProbe, killStaleChild } from "../domain/recovery.ts";
import { buildTaskContext } from "../domain/taskContext.ts";
import { readGuideFile } from "../domain/guideFile.ts";
import { captureTree, releaseTrees } from "../domain/reviewTree.ts";
import { assertTransition, isTerminal } from "../domain/states.ts";
import type { AgentAdapter } from "../adapter/types.ts";
import type { Handler } from "./server.ts";
import type {
  DaemonSlots,
  RateLimitSample,
  ServerEvent,
  StepRunDenials,
  StepView,
  TaskGuide,
  TaskLogs,
  WorktreeEntry,
} from "../../../shared/protocol.ts";
import type { WarningLog } from "./warnings.ts";

export type DaemonContext = {
  db: Db;
  adapter: AgentAdapter;
  logRoot: string;
  globalLimit: number;
  broadcast(ev: ServerEvent, opts?: { taskId?: string; followersOnly?: boolean }): void;
  /** 作成時（task.create）と、作成時の定義を持たない行の読み込みに使う。 */
  loadWorkflow: WorkflowLoader;
  /** タスクが従うワークフロー（setup を差し込んだ後）。tick・承認・読み取りの経路はすべてここを通る。 */
  workflowOf(task: TaskRow, project: ProjectRow): Promise<Workflow>;
  running: Set<string>;
  /** Issue の読み込み。調査・分解の prompt に本文とコメントを載せるのに使う。 */
  tracker: Tracker;
  /** 走らせている Intake の実行（intake_runs.id）。tick の再入ガード。running とは別に持つ。 */
  runningIntakeRuns: Set<number>;
  /** 投入とマージの見張り（spec 11 章）。 */
  intakeWatcher: IntakeWatcher;
  /** 後始末を拒否したときなど、人に見せる必要のある警告 */
  warnings: WarningLog;
  /** 全体の実行枠を保存する設定ファイル（daemon.setGlobalLimit が書く）。 */
  configPath: string;
};

/** step_runs.permission_denials の JSON を読む。NULL も壊れた JSON も null（拒否なし扱い）。 */
function parseDenials(raw: string | null): StepRunDenials | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as StepRunDenials;
  } catch {
    return null;
  }
}

/** 帯が描く分だけを残す。title は approval だけが持ち、branch の feed は画面へ流さない。 */
function toStepViews(workflow: Workflow): StepView[] {
  return workflow.steps.map((step) => {
    const view: StepView = { id: step.id, type: step.type };
    if (step.type === "approval") view.title = step.title;
    const branch = branchOf(step);
    if (branch) view.branch = { goto: branch.goto, maxAttempts: branch.maxAttempts };
    return view;
  });
}

function req(params: Record<string, unknown>, key: string): string {
  const v = params[key];
  if (typeof v !== "string" || v === "") throw new Error(`${key} は必須です`);
  return v;
}

/** 任意の文字列。キーが無いか空文字なら undefined。 */
function opt(params: Record<string, unknown>, key: string): string | undefined {
  const v = params[key];
  return typeof v === "string" && v !== "" ? v : undefined;
}

function reqNumber(params: Record<string, unknown>, key: string): number {
  const v = params[key];
  if (typeof v !== "number") throw new Error(`${key} は必須です`);
  return v;
}

async function reqProject(ctx: DaemonContext, params: Record<string, unknown>) {
  const path = req(params, "project");
  const project = await getProjectByPath(ctx.db, path);
  if (!project) throw new Error(`未登録のプロジェクトです: ${path}`);
  return project;
}

/** project.yaml から読んだ設定を projects の行へ写す。 */
async function syncProjectRow(
  ctx: DaemonContext,
  projectId: number,
  cfg: ProjectConfig,
): Promise<void> {
  await ctx.db.updateTable("projects")
    .set({
      default_workflow: cfg.defaultWorkflow,
      max_concurrent: cfg.maxConcurrent,
      base_branch: cfg.baseBranch,
      setup: cfg.setup ?? null,
    })
    .where("id", "=", projectId)
    .execute();
}

/** params.config を取り出す。オブジェクトでなければ投げる。値の型検証は applyProjectConfig に任せる。 */
function readProjectConfigInput(params: Record<string, unknown>): ProjectConfigInput {
  const config = params.config;
  if (typeof config !== "object" || config === null) throw new Error("config は必須です");
  const c = config as Record<string, unknown>;
  return {
    defaultWorkflow: c.defaultWorkflow as string,
    maxConcurrent: c.maxConcurrent as number,
    baseBranch: c.baseBranch as string,
    setup: c.setup as string | null | undefined,
  };
}

function broadcastIntakeTransition(ctx: DaemonContext, t: IntakeTransition): void {
  ctx.broadcast({
    event: "intake.stateChanged",
    intake_id: t.intakeId,
    from: t.from,
    to: t.to,
    revising: t.revising,
  });
}

/** 行を読み直して IntakeDetail にする。 */
async function intakeDetailOf(ctx: DaemonContext, intakeId: string) {
  const row = (await getIntake(ctx.db, intakeId))!;
  return await toIntakeDetail(ctx.db, row, ctx.intakeWatcher.health(row.project_id));
}

/** 操作が返した遷移をイベントにして配り、読み直した行の要約を返す。 */
async function settleIntakeCommand(ctx: DaemonContext, t: IntakeTransition) {
  broadcastIntakeTransition(ctx, t);
  const row = (await getIntake(ctx.db, t.intakeId))!;
  return await toIntakeSummary(ctx.db, row, ctx.intakeWatcher.health(row.project_id));
}

/**
 * Intake 由来のタスクの worktree の起点（spec 11.3）。見張りは投入の前に取り込んでいるが、
 * 画面からの再投入は見張りを通らないので、ここでも取り込む。取り込めなくても、前に取り込んだ origin 側から切る。
 */
async function intakeBase(project: ProjectRow): Promise<string> {
  await fetchBaseBranch(project.path, project.base_branch).catch((e) => {
    console.error(
      `origin の ${project.base_branch} を取り込めませんでした（前に取り込んだものから切ります）:`,
      e,
    );
  });
  return originRef(project.base_branch);
}

export function createHandler(ctx: DaemonContext): Handler {
  return async (method, params, conn) => {
    switch (method) {
      case "project.add": {
        const path = req(params, "path");
        // 最初に叩く init 的なコマンドなので、2回目はエラーにせず登録済みと伝えるだけにする
        const existing = await getProjectByPath(ctx.db, path);
        if (existing) return { ...existing, created: [], alreadyRegistered: true };

        const { created } = await ensureProjectScaffold(path);
        const cfg = parseProjectConfig(
          await Deno.readTextFile(join(path, ".doctrine", "project.yaml")),
        );
        const id = await insertProject(ctx.db, {
          path,
          default_workflow: cfg.defaultWorkflow,
          max_concurrent: cfg.maxConcurrent,
          base_branch: cfg.baseBranch,
          setup: cfg.setup ?? null,
        });
        return { ...(await getProject(ctx.db, id)), created, alreadyRegistered: false };
      }
      case "project.list":
        return await listProjects(ctx.db);
      case "project.update": {
        const path = req(params, "path");
        const project = await getProjectByPath(ctx.db, path);
        if (!project) throw new Error(`未登録のプロジェクトです: ${path}`);
        const cfg = parseProjectConfig(
          await Deno.readTextFile(join(path, ".doctrine", "project.yaml")),
        );
        await syncProjectRow(ctx, project.id, cfg);
        return await getProject(ctx.db, project.id);
      }
      case "project.config.get": {
        const project = await reqProject(ctx, params);
        return parseProjectConfig(
          await Deno.readTextFile(join(project.path, ".doctrine", "project.yaml")),
        );
      }
      case "project.config.save": {
        const project = await reqProject(ctx, params);
        const input = readProjectConfigInput(params);
        const yamlText = await Deno.readTextFile(
          join(project.path, ".doctrine", "project.yaml"),
        );
        const { text, config } = applyProjectConfig(yamlText, input);
        await ctx.loadWorkflow(project.path, config.defaultWorkflow).catch((e) => {
          throw new Error(
            `defaultWorkflow が指すワークフローを読めません: .doctrine/workflows/${config.defaultWorkflow}.yaml（${
              (e as Error).message
            }）`,
          );
        });
        await writeProjectYaml(project.path, text);
        await syncProjectRow(ctx, project.id, config);
        return await getProject(ctx.db, project.id);
      }

      case "task.create": {
        const projectPath = req(params, "project");
        const project = await getProjectByPath(ctx.db, projectPath);
        if (!project) throw new Error(`未登録のプロジェクトです: ${projectPath}`);
        const title = req(params, "title");
        const prompt = req(params, "prompt");
        const workflowName = typeof params.workflow === "string"
          ? params.workflow
          : project.default_workflow;
        // 不正な定義はタスク作成時に落とす
        const loaded = await ctx.loadWorkflow(projectPath, workflowName);
        const id = crypto.randomUUID();
        const task = await insertTask(ctx.db, {
          id,
          project_id: project.id,
          title,
          prompt,
          workflow_name: workflowName,
          branch: branchNameFor(id, title),
          priority: typeof params.priority === "number" ? params.priority : 2,
          ...pinOf(loaded, project),
        });
        // タスク作成時だけがこの warnings の出口。以後 tick・承認は保存した
        // 作成時の中身を読み直すだけで、ディスクを読まないので警告は積まない。
        for (const w of loaded.warnings) ctx.warnings.push(`作成時の検証: ${w}`, id);
        // dctl add はレスポンスをそのまま表示するCLIなので、ここに乗せておけば
        // ログを探しに行かなくてもユーザーの目の前に出る。
        return { ...task, warnings: loaded.warnings };
      }
      case "task.list": {
        const filter: { projectId?: number; state?: TaskState } = {};
        if (typeof params.project === "string") {
          filter.projectId = (await getProjectByPath(ctx.db, params.project))?.id;
        }
        if (typeof params.state === "string") filter.state = params.state as TaskState;
        return await listTasks(ctx.db, filter);
      }
      case "task.get": {
        const task = await getTask(ctx.db, req(params, "task_id"));
        if (!task) throw new Error("タスクがありません");
        // dctl get の JSON に、エスケープされた文字列ではなく中身を出す。
        const stepRuns = (await listStepRuns(ctx.db, task.id)).map((r) => ({
          ...r,
          permission_denials: parseDenials(r.permission_denials),
        }));
        const project = (await getProject(ctx.db, task.project_id))!;
        // 読み取り専用の経路なので、ワークフローが読めないことで失敗させない（task.context と同じ）。
        // 画面には setup を差し込んだ後の、実際に走る列を渡す。
        const workflow = await ctx.workflowOf(task, project).catch(() => null);
        return { task, stepRuns, steps: workflow && toStepViews(workflow) };
      }

      case "task.context": {
        const task = await getTask(ctx.db, req(params, "task_id"));
        if (!task) throw new Error("タスクがありません");
        const project = (await getProject(ctx.db, task.project_id))!;
        // 読み取り専用の経路なので、ワークフローが読めないことで失敗させない。
        // 定義が引けないと分かるのは種別が要るものだけ（buildTaskContext が扱う）。
        const workflow = await ctx.workflowOf(task, project).catch(() => null);
        return await buildTaskContext(ctx.db, task, workflow);
      }

      case "task.approve":
      case "task.reject": {
        const taskId = req(params, "task_id");
        const task = await getTask(ctx.db, taskId);
        if (!task) throw new Error("タスクがありません");
        const approved = method === "task.approve";
        // 却下はコメント必須。理由の無い却下はエージェントが次にどう動けばいいか分からない。
        const comment = approved ? "" : req(params, "comment");
        const project = (await getProject(ctx.db, task.project_id))!;
        // このワークフローは task.create で既に検証済みの、作成時に保存した中身を
        // 読み直すだけ（ディスクは読まない）。warnings の出口は task.create の1箇所だけ。
        const workflow = await ctx.workflowOf(task, project);
        await applyApproval(ctx.db, taskId, { approved, comment }, workflow);
        const after = (await getTask(ctx.db, taskId))!;
        ctx.broadcast({
          event: "task.stateChanged",
          task_id: taskId,
          from: "suspended",
          to: after.state,
        });
        // 最終ステップが approval のワークフローは、ここが completed への唯一の
        // 入口であり、tick の runTask().then(cleanupAfterRun) を通らない。
        // 後始末しないと worktree_path が非nullのまま残り、findOrphans は既知の
        // worktree とみなすので worktree.list にも出ず、溜まっていることすら見えない。
        // 承認は既に成立しているので、後始末の失敗でこの要求を失敗させてはいけない
        // （cleanupAfterRun は内部で警告に倒すが、想定外の例外もここで受け止める）。
        if (after.state === "completed") {
          await cleanupAfterRun(ctx, taskId);
          // worktree_path は後始末で変わり得るので、応答は読み直した行を返す。
          return (await getTask(ctx.db, taskId))!;
        }
        return after;
      }

      case "task.pause": {
        const taskId = req(params, "task_id");
        const task = await getTask(ctx.db, taskId);
        if (!task) throw new Error("タスクがありません");
        // 遷移表を経由せずに書くと、終端状態や approval 待ちなど許されない
        // 状態からも黙って上書きしてしまう。commitStepBoundary の前に必ず検査する。
        assertTransition(task.state, "paused");
        // デーモンが生きたまま協調的に止める経路。子を SIGTERM で止め、flush の機会を与える。
        await killStaleChild(task, defaultProbe(), "SIGTERM");
        // 子を止めている間にタスクが先へ進んでいたら（例: running から suspended）、
        // 検査した遷移はもう成り立たない。上書きせずに失敗させる。
        await commitStepBoundary(ctx.db, {
          taskId,
          requireState: task.state,
          taskPatch: { state: "paused", child_pid: null, child_started_at: null },
        });
        ctx.broadcast({
          event: "task.stateChanged",
          task_id: taskId,
          from: task.state,
          to: "paused",
        });
        return await getTask(ctx.db, taskId);
      }
      case "task.resume": {
        const taskId = req(params, "task_id");
        const task = await getTask(ctx.db, taskId);
        if (!task) throw new Error("タスクがありません");
        if (
          task.state !== "paused" && task.state !== "suspended" &&
          task.state !== "rate_limited"
        ) {
          throw new Error(`再開できる状態ではありません: ${task.state}`);
        }
        // 行列の先頭に入る。進行中の仕事を新規の仕事より先に終わらせる。
        //
        // suspended からの resume は approval ステップへ入り直すので、スケジューラが
        // 拾えば新しい awaiting 行が立ち、attempt がもう1つ進む。これを正とする
        // （spec 3.4: そのステップに何度 suspended で立ち止まったかを正直に数える）。
        // 開いていた行は人の決定を待たずに閉じられたので interrupted。
        await commitStepBoundary(ctx.db, {
          taskId,
          requireState: task.state,
          // 上限待ちからの再開は、人が「待たずに今やれ」と言ったということ。
          // 期限を消さないと、次の tick が同じ行をもう一度解放しようとする。
          taskPatch: { state: "queued", resumed: 1, rate_limited_until: null },
          stepRunUpdate: await closeAwaitingStepRun(ctx.db, task),
        });
        ctx.broadcast({
          event: "task.stateChanged",
          task_id: taskId,
          from: task.state,
          to: "queued",
        });
        return await getTask(ctx.db, taskId);
      }
      case "task.cancel": {
        const taskId = req(params, "task_id");
        const task = await getTask(ctx.db, taskId);
        if (!task) throw new Error("タスクがありません");
        const { from } = await cancelTask(ctx.db, task, defaultProbe());
        ctx.broadcast({ event: "task.stateChanged", task_id: taskId, from, to: "canceled" });
        return await getTask(ctx.db, taskId);
      }
      case "task.logs": {
        const taskId = req(params, "task_id");
        // 追従先は1接続につき1タスク。follow: true は追従先をこのタスクへ移し、
        // false でやめる。省略したときは今の追従先を変えない（末尾を読むだけ）。
        //
        // やめるのは、そのタスクを追従していたときだけにする。アプリは画面を
        // 切り替えるときに「前のタスクをやめる」と「次のタスクを追う」を別々に
        // 投げるので、遅れて届いた前者が後者を取り消しうる。
        if (params.follow === true) conn.follow(taskId);
        else if (params.follow === false && conn.isFollowing(taskId)) conn.unfollow();
        const run = params.step_run_id === undefined
          ? await lastStepRun(ctx.db, taskId)
          : await getStepRun(ctx.db, Number(params.step_run_id));
        if (params.step_run_id !== undefined && !run) throw new Error("ステップ実行がありません");
        // まだ1度もステップが走っていないタスク（queued）。追従だけ張って空で返す。
        if (!run) return { step_run_id: null, log_path: null, lines: [] } satisfies TaskLogs;
        const text = await Deno.readTextFile(run.log_path).catch(() => "");
        const tailLines = typeof params.tail === "number" ? params.tail : 200;
        return {
          step_run_id: run.id,
          log_path: run.log_path,
          lines: text.split("\n").slice(-tailLines),
        } satisfies TaskLogs;
      }
      case "task.diff": {
        const taskId = req(params, "task_id");
        const task = await getTask(ctx.db, taskId);
        if (!task) throw new Error("タスクがありません");
        if (params.since !== undefined && params.since !== "last_review") {
          throw new Error(`since に指定できるのは last_review だけです: ${String(params.since)}`);
        }
        // 完了して削除済み、またはまだ実行枠が取れていない。空の diff を返すと
        // 「変更なし」と区別がつかないので、はっきり失敗させる。
        if (!task.worktree_path) throw new Error("worktree がありません");
        const project = (await getProject(ctx.db, task.project_id))!;

        const merge_base = await mergeBase(task.worktree_path, project.base_branch);
        const toRef = await captureTree(task.worktree_path);

        // 記録が無ければ全体に倒す（初回のレビューには「前回」が無い）。
        const last = params.since === "last_review"
          ? await lastRejectedReview(ctx.db, taskId)
          : undefined;

        const { files, patch, truncated } = await computeDiff({
          worktreePath: task.worktree_path,
          fromRef: last?.review_tree ?? merge_base,
          toRef,
        });
        const result: TaskDiff = {
          // base は since の有無にかかわらず常に merge-base。画面が
          // 「ブランチ全体のうちどの範囲を今見ているか」を示せるようにする。
          base: { branch: project.base_branch, merge_base },
          since_step_run_id: last?.step_run_id ?? null,
          files,
          patch,
          truncated,
        };
        return result;
      }

      case "task.guide": {
        const task = await getTask(ctx.db, req(params, "task_id"));
        if (!task) throw new Error("タスクがありません");
        // task.diff と同じ理由で、空を返さずはっきり失敗させる。
        if (!task.worktree_path) throw new Error("worktree がありません");

        // 先にファイルを読む。ワークフローはファイルが無いときのラベルを決めるためだけに使うので、
        // ok / stale / broken / too_large はワークフロー YAML が読めなくても返る。
        const read = await readGuideFile(task.worktree_path);
        if (read.status === "missing") {
          const project = (await getProject(ctx.db, task.project_id))!;
          const workflow = await ctx.workflowOf(task, project).catch(() => null);
          const hasGuideStep = workflow?.steps.some((s) => s.type === "guide") ?? true;
          return { status: hasGuideStep ? "missing" : "none" } satisfies TaskGuide;
        }
        if (read.status !== "ok") return read satisfies TaskGuide;

        const worktreeTree = await captureTree(task.worktree_path);
        return {
          status: "ok",
          guide: read.envelope.guide,
          createdAt: read.envelope.createdAt,
          tree: read.envelope.tree,
          worktreeTree,
          stale: read.envelope.tree !== worktreeTree,
        } satisfies TaskGuide;
      }

      case "worktree.list":
        return await worktreeEntries(ctx.db);
      case "worktree.remove": {
        const target = await resolveRemoveTarget(ctx, params);
        // force が外すのは未コミットの変更の拒否だけ。走る・待つ・再開できるタスクや
        // 進行中の Intake の作業場所は、force でも消させない。
        if (target.kind === "task" && !isTerminal(target.task.state)) {
          throw new Error(`終わっていないタスク（${target.task.state}）の worktree は消せません`);
        }
        if (target.kind === "intake" && !isIntakeTerminal(target.intake.state)) {
          throw new Error(
            `終わっていない Intake（${target.intake.state}）の worktree は消せません`,
          );
        }
        // 失敗したタスクの worktree は汚れているのが通常。force を明示しない限り
        // 未コミットの作業は失われず、削除は拒否される。
        await removeWorktree({
          repoPath: target.project.path,
          worktreePath: target.worktreePath,
          force: params.force === true,
        });
        if (target.kind === "task") {
          await releaseReviewRefs(ctx, target.project.path, target.task.id);
          await commitStepBoundary(ctx.db, {
            taskId: target.task.id,
            taskPatch: { worktree_path: null },
          });
        } else if (target.kind === "intake") {
          await updateIntake(ctx.db, target.intake.id, { worktree_path: null });
        }
        return { removed: target.worktreePath };
      }

      case "daemon.warnings":
        return ctx.warnings.recent();

      case "daemon.slots":
        return await daemonSlots(ctx);

      case "daemon.setGlobalLimit": {
        const globalLimit = validateGlobalLimit(params.global_limit);
        ctx.globalLimit = globalLimit;
        try {
          await writeDaemonConfig(ctx.configPath, { globalLimit });
        } catch (e) {
          const message = (e as Error).message;
          ctx.warnings.push(
            `全体の実行枠 ${globalLimit} は効いていますが、設定ファイル (${ctx.configPath}) に保存できませんでした。再起動すると元に戻ります: ${message}`,
          );
          throw new Error(
            `全体の実行枠 ${globalLimit} は効いていますが、設定ファイル (${ctx.configPath}) に保存できませんでした。再起動すると元に戻ります: ${message}`,
          );
        }
        return await daemonSlots(ctx);
      }

      case "ratelimit.recent": {
        const rows = await recentRateLimitSamples(
          ctx.db,
          typeof params.limit === "number" ? params.limit : 50,
        );
        return rows.map((r): RateLimitSample => ({
          observed_at: r.observed_at,
          window: r.window,
          utilization: r.utilization,
          resets_at: normalizeResetsAt(r.resets_at),
        }));
      }

      case "github.status": {
        const project = await reqProject(ctx, params);
        return await ctx.tracker.status(project.path);
      }
      case "github.issues": {
        const project = await reqProject(ctx, params);
        const assignee = params.assignee === "any" ? "any" : "me";
        const search = typeof params.search === "string" ? params.search : undefined;
        const issues = await ctx.tracker.listIssues(project.path, {
          assignee,
          ...(search === undefined ? {} : { search }),
        }).catch(async (e) => {
          // 理由が分かる失敗は、gh の生のエラーより先に返す。
          const status = await ctx.tracker.status(project.path);
          if (!status.ok) throw new Error(`gh が使えません（${status.reason}）: ${status.message}`);
          throw e;
        });
        const open = new Map(
          (await listIntakes(ctx.db, { projectId: project.id }))
            .map((i) => [i.issue_url, i.id]),
        );
        return issues.map((i) => ({ ...i, intake_id: open.get(i.url) ?? null }));
      }
      case "github.issue": {
        const project = await reqProject(ctx, params);
        return await ctx.tracker.readIssue(project.path, req(params, "url"));
      }

      case "intake.start": {
        const project = await reqProject(ctx, params);
        const { intake, alreadyActive } = await startIntake(ctx.db, ctx.tracker, {
          projectId: project.id,
          projectPath: project.path,
          issueUrl: req(params, "issue_url"),
          logRoot: ctx.logRoot,
        });
        const summary = await toIntakeSummary(
          ctx.db,
          intake,
          ctx.intakeWatcher.health(intake.project_id),
        );
        return { ...summary, alreadyActive };
      }
      case "intake.list": {
        const filter: { projectId?: number; includeClosed?: boolean } = {
          includeClosed: params.include_closed === true,
        };
        if (typeof params.project === "string") {
          const project = await getProjectByPath(ctx.db, params.project);
          // task.list と違い、未登録のプロジェクトで全件を返さない。
          if (!project) return [];
          filter.projectId = project.id;
        }
        const rows = await listIntakes(ctx.db, filter);
        return await Promise.all(
          rows.map((r) => toIntakeSummary(ctx.db, r, ctx.intakeWatcher.health(r.project_id))),
        );
      }
      case "intake.get": {
        const intake = await getIntake(ctx.db, req(params, "intake_id"));
        if (!intake) throw new Error("Intake がありません");
        return await toIntakeDetail(ctx.db, intake, ctx.intakeWatcher.health(intake.project_id));
      }
      case "intake.answer":
        return await settleIntakeCommand(
          ctx,
          await answerIntake(ctx.db, {
            intakeId: req(params, "intake_id"),
            questionSetId: reqNumber(params, "question_set_id"),
            answers: params.answers,
            logRoot: ctx.logRoot,
          }),
        );
      case "intake.reject":
        return await settleIntakeCommand(
          ctx,
          await rejectIntake(ctx.db, {
            intakeId: req(params, "intake_id"),
            draftId: reqNumber(params, "draft_id"),
            comments: params.comments,
            logRoot: ctx.logRoot,
          }),
        );
      case "intake.approve": {
        const summary = await settleIntakeCommand(
          ctx,
          await approveIntake(ctx.db, {
            intakeId: req(params, "intake_id"),
            draftId: reqNumber(params, "draft_id"),
            hash: req(params, "hash"),
          }),
        );
        // 承認は commit 済み。最初の投入は待たず、その失敗で承認を失敗させない（request は reject しない）
        void ctx.intakeWatcher.request(summary.project_id);
        return summary;
      }
      case "intake.revise":
        return await settleIntakeCommand(
          ctx,
          await reviseIntake(ctx.db, {
            intakeId: req(params, "intake_id"),
            comments: params.comments,
            logRoot: ctx.logRoot,
          }),
        );
      case "intake.abandonRevision": {
        const summary = await settleIntakeCommand(
          ctx,
          await abandonRevision(ctx.db, { probe: defaultProbe() }, {
            intakeId: req(params, "intake_id"),
          }),
        );
        // 元の計画に戻った。止めていた投入は待たずに再開する（request は reject しない）
        void ctx.intakeWatcher.request(summary.project_id);
        return summary;
      }
      case "intake.draft":
        return await intakeDraft(ctx.db, req(params, "intake_id"), reqNumber(params, "draft_id"));
      case "intake.processPrompt":
        return {
          prompt: await previewTaskPrompt(ctx.db, {
            intakeId: req(params, "intake_id"),
            draftId: reqNumber(params, "draft_id"),
            processId: req(params, "process_id"),
          }),
        };
      case "intake.cancel": {
        const intakeId = req(params, "intake_id");
        if (params.mode !== "leave" && params.mode !== "stop") {
          throw new Error("mode は leave か stop のどちらかです");
        }
        const intake = await getIntake(ctx.db, intakeId);
        if (!intake) throw new Error("Intake がありません");
        const project = (await getProject(ctx.db, intake.project_id))!;
        const outcome = await cancelIntake(
          ctx.db,
          { probe: defaultProbe(), tracker: ctx.tracker },
          { intakeId, mode: params.mode, projectPath: project.path },
        );
        for (const t of outcome.stoppedTasks) {
          ctx.broadcast({
            event: "task.stateChanged",
            task_id: t.taskId,
            from: t.from,
            to: "canceled",
          });
        }
        for (const message of outcome.problems) ctx.warnings.push(message);
        return await settleIntakeCommand(ctx, outcome);
      }
      case "intake.completeHumanProcess": {
        const intakeId = req(params, "intake_id");
        // note は req で取らない。空白だけの判定と文言を completeHumanProcess に寄せる
        await completeHumanProcess(ctx.db, {
          intakeId,
          processId: req(params, "process_id"),
          note: params.note,
        });
        ctx.broadcast({ event: "intake.updated", intake_id: intakeId });
        const row = (await getIntake(ctx.db, intakeId))!;
        // sub-issue を閉じ、下流を投入し、goal が揃えば completed へ移す
        await ctx.intakeWatcher.request(row.project_id);
        return await intakeDetailOf(ctx, intakeId);
      }
      case "intake.redispatch": {
        const intakeId = req(params, "intake_id");
        const { replacedTaskId } = await redispatchProcess(ctx.db, {
          intakeId,
          processId: req(params, "process_id"),
        }, { loadWorkflow: ctx.loadWorkflow });
        if (replacedTaskId !== null) await cleanupReplacedTask(ctx, replacedTaskId);
        ctx.broadcast({ event: "intake.updated", intake_id: intakeId });
        return await intakeDetailOf(ctx, intakeId);
      }
      case "intake.refresh": {
        const intakeId = req(params, "intake_id");
        const intake = await getIntake(ctx.db, intakeId);
        if (!intake) throw new Error("Intake がありません");
        await ctx.intakeWatcher.request(intake.project_id);
        return await intakeDetailOf(ctx, intakeId);
      }
      case "intake.setDispatchPaused": {
        const intakeId = req(params, "intake_id");
        if (typeof params.paused !== "boolean") throw new Error("paused は必須です");
        const row = await setDispatchPaused(ctx.db, { intakeId, paused: params.paused });
        ctx.broadcast({ event: "intake.updated", intake_id: intakeId });
        if (!params.paused) void ctx.intakeWatcher.request(row.project_id);
        return await toIntakeSummary(ctx.db, row, ctx.intakeWatcher.health(row.project_id));
      }
      case "intake.closeIssue": {
        const intake = await getIntake(ctx.db, req(params, "intake_id"));
        if (!intake) throw new Error("Intake がありません");
        const project = (await getProject(ctx.db, intake.project_id))!;
        const row = await closeParentIssue(ctx.db, ctx.tracker, {
          intakeId: intake.id,
          projectPath: project.path,
        });
        return await toIntakeSummary(ctx.db, row, ctx.intakeWatcher.health(row.project_id));
      }

      default:
        throw new Error(`未知のメソッドです: ${method}`);
    }
  };
}

/** daemon.slots の応答。 */
async function daemonSlots(ctx: DaemonContext): Promise<DaemonSlots> {
  const snapshot = await slotsSnapshot(ctx.db, ctx.globalLimit);
  return {
    global_limit: snapshot.globalLimit,
    in_use: snapshot.inUse,
    waiting_tasks: snapshot.waitingTasks,
    waiting_intake_runs: snapshot.waitingIntakeRuns,
  };
}

/** 全プロジェクトの worktree。並びはプロジェクトの id 順、その中は git worktree list の順。 */
async function worktreeEntries(db: Db): Promise<WorktreeEntry[]> {
  const out: WorktreeEntry[] = [];
  for (const project of await listProjects(db)) {
    const tasks = new Map<string, TaskRow>();
    for (const t of await listTasks(db, { projectId: project.id })) {
      if (t.worktree_path !== null) tasks.set(await canonical(t.worktree_path), t);
    }
    const intakes = new Map<string, IntakeRow>();
    for (const i of await listIntakes(db, { projectId: project.id, includeClosed: true })) {
      if (i.worktree_path !== null) intakes.set(await canonical(i.worktree_path), i);
    }
    const entries = await Promise.all(
      (await listWorktrees(project.path)).map(async (w): Promise<WorktreeEntry | null> => {
        let stat: Deno.FileInfo;
        try {
          stat = await Deno.stat(w.path);
        } catch (e) {
          // git は実体の無い worktree も（prunable として）列挙する
          if (e instanceof Deno.errors.NotFound) return null;
          throw e;
        }
        const key = await canonical(w.path);
        const task = tasks.get(key);
        const intake = task ? undefined : intakes.get(key);
        const age = task?.updated_at ?? intake?.updated_at ??
          (stat.mtime ?? stat.birthtime ?? new Date()).toISOString();
        return {
          project: project.path,
          path: w.path,
          branch: w.branch,
          task_id: task?.id ?? null,
          task_state: task?.state ?? null,
          intake_id: intake?.id ?? null,
          dirty: await hasUncommittedChanges(w.path),
          age_basis: age,
        };
      }),
    );
    out.push(...entries.filter((e): e is WorktreeEntry => e !== null));
  }
  return out;
}

/**
 * worktree を消したタスクのレビュー参照を消す。worktree が無くなればレビューの
 * 基準点を使う相手もいなくなり、参照を残すと指しているツリーが永久に gc されない。
 *
 * worktree の削除自体は既に成功しているので、参照を消せなくても要求は失敗させず
 * 警告に倒す（spec 5.4）。worktree を消す2箇所（worktree.remove と
 * cleanupAfterRun）が同じ扱いをするために、ここに1つだけ置く。
 */
async function releaseReviewRefs(
  ctx: DaemonContext,
  projectPath: string,
  taskId: string,
): Promise<void> {
  await releaseTrees(projectPath, taskId).catch((e: Error) => {
    ctx.warnings.push(`レビュー参照を消せませんでした: ${e.message}`, taskId);
  });
}

type RemoveTarget =
  | { kind: "task"; task: TaskRow; project: ProjectRow; worktreePath: string }
  | { kind: "intake"; intake: IntakeRow; project: ProjectRow; worktreePath: string }
  | { kind: "orphan"; project: ProjectRow; worktreePath: string };

/**
 * worktree.remove の対象を task_id か path のどちらか一方から決める。
 * path は stateDir()/worktrees 配下で、かつそのプロジェクトの git worktree list に
 * 出るものだけを通す。タスクや Intake の worktree に当たればその持ち主として扱う。
 */
async function resolveRemoveTarget(
  ctx: DaemonContext,
  params: Record<string, unknown>,
): Promise<RemoveTarget> {
  const taskId = opt(params, "task_id");
  const path = opt(params, "path");
  if ((taskId === undefined) === (path === undefined)) {
    throw new Error("task_id か path のどちらか一方を指定してください");
  }

  if (taskId !== undefined) {
    const task = await getTask(ctx.db, taskId);
    if (!task?.worktree_path) throw new Error("worktree がありません");
    const project = (await getProject(ctx.db, task.project_id))!;
    return { kind: "task", task, project, worktreePath: task.worktree_path };
  }

  // 相対パスはデーモンの cwd から解決されてしまう。
  if (!isAbsolute(path!)) throw new Error(`path は絶対パスで指定してください: ${path}`);
  const real = await canonical(path!);
  if (!await isUnderWorktreesDir(real)) {
    throw new Error(`doctrine の worktree 置き場の外にあるパスは消せません: ${path}`);
  }

  for (const project of await listProjects(ctx.db)) {
    let worktreePath: string | undefined;
    for (const w of await listWorktrees(project.path)) {
      if (await canonical(w.path) === real) worktreePath = w.path;
    }
    if (worktreePath === undefined) continue;

    for (const task of await listTasks(ctx.db, { projectId: project.id })) {
      if (task.worktree_path && await canonical(task.worktree_path) === real) {
        return { kind: "task", task, project, worktreePath };
      }
    }
    for (
      const intake of await listIntakes(ctx.db, { projectId: project.id, includeClosed: true })
    ) {
      if (intake.worktree_path && await canonical(intake.worktree_path) === real) {
        return { kind: "intake", intake, project, worktreePath };
      }
    }
    return { kind: "orphan", project, worktreePath };
  }
  throw new Error(`git worktree list に出ないパスは消せません: ${path}`);
}

/**
 * completed のみ worktree を削除する。failed / canceled は証拠として残す。
 *
 * completed で worktree を持つタスクについては、消したか残したかを必ず
 * `task.cleanedUp` で伝える。これが無いと、`completed` を受け取った直後に
 * worktree を見に行くとまだ存在し、いつ消えるかをクライアントが知る手段が無い。
 *
 * この関数は投げない。呼ぶのは tick の実行後と task.approve の2箇所で、
 * どちらも後始末の失敗で本来の仕事（実行の完了・承認の受理）を失敗させては
 * いけない。想定外の例外も refused として届ける。
 */
export async function cleanupAfterRun(ctx: DaemonContext, taskId: string): Promise<void> {
  const task = await getTask(ctx.db, taskId);
  if (!task || task.state !== "completed" || !task.worktree_path) return;
  await removeTaskWorktree(
    ctx,
    task,
    task.worktree_path,
    "完了時に未コミットの変更が残っているため worktree を削除しませんでした",
  );
}

/**
 * Intake の再投入で置き換えた古いタスクの worktree を消す。failed / canceled を証拠として残すのは、
 * そのプロセスをまだ誰も引き継いでいないからで、新しいタスクが引き継いだ後は残す理由が無い。
 * タスクの記録とブランチは残す。未コミットの変更があれば消さない。投げない（再投入そのものは済んでいる）。
 */
async function cleanupReplacedTask(ctx: DaemonContext, taskId: string): Promise<void> {
  const task = await getTask(ctx.db, taskId);
  if (!task || !isTerminal(task.state) || !task.worktree_path) return;
  await removeTaskWorktree(
    ctx,
    task,
    task.worktree_path,
    "再投入で置き換えた古いタスクの worktree に未コミットの変更があるため削除しませんでした",
  );
}

/** worktree を消し、消したか残したかを task.cleanedUp で伝える。未コミットの変更があれば残す。投げない。 */
async function removeTaskWorktree(
  ctx: DaemonContext,
  task: TaskRow,
  worktreePath: string,
  dirtyWarning: string,
): Promise<void> {
  const taskId = task.id;
  const refuse = (warning: string) => {
    ctx.warnings.push(warning, taskId);
    ctx.broadcast({
      event: "task.cleanedUp",
      task_id: taskId,
      outcome: "refused",
      worktree_path: worktreePath,
      warning,
    });
  };
  try {
    const project = (await getProject(ctx.db, task.project_id))!;
    await removeWorktree({
      repoPath: project.path,
      worktreePath,
      force: false,
    });
    await releaseReviewRefs(ctx, project.path, taskId);
    await commitStepBoundary(ctx.db, { taskId, taskPatch: { worktree_path: null } });
    ctx.broadcast({
      event: "task.cleanedUp",
      task_id: taskId,
      outcome: "removed",
      worktree_path: null,
    });
  } catch (e) {
    if (e instanceof UncommittedChangesError) {
      // 黙って消してよいものではない。人が中身を見て、force で消す
      refuse(`${dirtyWarning} (${worktreePath}): ${e.message}`);
    } else {
      // git worktree remove 自体が失敗した場合など（原因不明）。未コミットの
      // 変更の話にすり替えず、そのまま見せる。
      refuse(`worktree の削除に失敗しました (${worktreePath}): ${(e as Error).message}`);
    }
  }
}

/**
 * タスクを失敗として記録し、可能なら警告を残す。tick の「枠を取ってから
 * running を書くまでの間」で何が起きても、このタスクを queued のまま
 * 残さないための共通経路。
 *
 * トレードオフ: 一時的な失敗（ディスク満杯・瞬間的なロックなど）も同じ扱いで
 * failed になり、成功していたかもしれない試行を失って利用者が作り直す
 * ことになる。それでも、queued のまま永遠にリトライされ続けて board から
 * 見えなくなる（かつプロジェクトの同時実行枠を暗黙に圧迫し続ける）よりは、
 * 理由付きで board に見える failed の方がまし、という判断。
 */
async function failTaskInTick(
  ctx: DaemonContext,
  taskId: string,
  fromState: TaskState,
  reason: string,
): Promise<void> {
  ctx.warnings.push(reason, taskId);
  try {
    assertTransition(fromState, "failed");
    await commitStepBoundary(ctx.db, {
      taskId,
      requireState: fromState,
      taskPatch: { state: "failed" },
    });
    ctx.broadcast({ event: "task.stateChanged", task_id: taskId, from: fromState, to: "failed" });
  } catch {
    // fromState から failed へ遷移できない（既に終端など）、または読んだ後に
    // 状態が変わっていた（cancel が先に書いた）場合はこれ以上書かず、
    // 警告の記録だけに留める。
  }
}

/**
 * tick が同時に2周走っているかどうか。DaemonContext ごとに持つ（テストは
 * 複数の ctx を作る）。module スコープの真偽値にすると別の ctx まで巻き込む。
 */
const ticking = new WeakSet<DaemonContext>();

/**
 * 1周: 枠の空きを見て queued を running にし、次に人を待つ地点まで進める。
 *
 * **不変条件**: ある tick が admit したタスクは、その `running` が
 * DB に書かれるまで、再び admit 候補になってはならず、他のタスクに
 * その枠を取らせてもならない。
 *
 * これを二重に守る:
 *
 * 1. **再入ガード** — tick は 1 秒間隔の setInterval から呼ばれるので、
 *    前の周が終わる前に次の周が始まる。前の周が飛行中なら何もせずに返る。
 *    ガードは finally で必ず解放する。解放を落とすと、デーモンは何も
 *    言わずに永久にスケジュールしなくなり、直そうとしたバグより悪い。
 * 2. **枠の先取り** — 遅い処理（ワークフローの解決 / createWorktree — git の
 *    サブプロセスは大きなリポジトリで数秒かかる）に入る前に `running` を
 *    書く。同時に走る currentUsage から枠が埋まって見えるので、ガードが
 *    無い経路が将来増えても不変条件は DB 側で保たれる。
 */
export async function tick(ctx: DaemonContext): Promise<void> {
  if (ticking.has(ctx)) return; // 警告は積まない。毎秒積み上がって溢れる。
  ticking.add(ctx);
  try {
    await tickOnce(ctx);
  } finally {
    ticking.delete(ctx);
  }
}

/**
 * queued の Intake の実行を、全体枠の空きの分だけ走らせる。枠は claim（queued → running）で
 * 取るので、続くタスクの受付の currentUsage にすぐ映る。
 */
async function startIntakeRuns(ctx: DaemonContext): Promise<void> {
  for (const run of await selectAdmissibleIntakeRuns(ctx.db, ctx.globalLimit)) {
    if (ctx.runningIntakeRuns.has(run.id)) continue;
    ctx.runningIntakeRuns.add(run.id);
    try {
      if (!await claimIntakeRun(ctx.db, run.id)) {
        ctx.runningIntakeRuns.delete(run.id);
        continue;
      }
    } catch (e) {
      ctx.runningIntakeRuns.delete(run.id);
      throw e;
    }

    void runIntakeRun(ctx.db, run.id, {
      db: ctx.db,
      adapter: ctx.adapter,
      tracker: ctx.tracker,
      logRoot: ctx.logRoot,
      onStateChanged: (intakeId, from, to, revising) =>
        ctx.broadcast({ event: "intake.stateChanged", intake_id: intakeId, from, to, revising }),
    })
      .catch(async (e) => {
        // 実行の途中の例外を握りつぶすと .finally() が同じ理由で再 reject し、
        // unhandled rejection でデーモンごと落ちる。ここで受け止め、行を failed、
        // Intake を要確認に倒して警告に残す。この後始末自体も reject させない。
        const message = `Intake ${run.intake_id} の実行中に例外が発生しました: ${
          (e as Error).message
        }`;
        try {
          await updateIntakeRun(ctx.db, run.id, {
            status: "failed",
            ended_at: new Date().toISOString(),
          });
          const intake = await getIntake(ctx.db, run.intake_id);
          if (intake && (intake.state === "investigating" || intake.state === "decomposing")) {
            await updateIntake(ctx.db, intake.id, {
              state: "needs_attention",
              attention_reason: JSON.stringify({ kind: "agent_failed", runId: run.id, message }),
              rate_limited_until: null,
              child_pid: null,
              child_started_at: null,
            }, { requireState: intake.state });
            broadcastIntakeTransition(ctx, {
              intakeId: intake.id,
              from: intake.state,
              to: "needs_attention",
              revising: intake.revising === 1,
            });
          }
          ctx.warnings.push(message);
        } catch (e2) {
          ctx.warnings.push(`${message}（要確認への記録にも失敗: ${(e2 as Error).message}）`);
        }
      })
      .finally(() => ctx.runningIntakeRuns.delete(run.id));
  }
}

async function tickOnce(ctx: DaemonContext): Promise<void> {
  for (const taskId of await releaseDueRateLimited(ctx.db)) {
    ctx.broadcast({
      event: "task.stateChanged",
      task_id: taskId,
      from: "rate_limited",
      to: "queued",
    });
  }
  await releaseDueIntakeRateLimited(ctx.db, { logRoot: ctx.logRoot });
  // 上限はアカウント全体に掛かるので、待っている間に新しいタスクを始めても
  // 同じように弾かれ、step_run と worktree だけが増える。既に running のタスクは
  // 止めない（自分で上限に当たれば同じ経路で待ちに入る）。
  if (await hasActiveRateLimit(ctx.db)) return;

  // 調査・分解は人を待たせているので、queued のタスクより先に枠を取る。
  await startIntakeRuns(ctx);

  for (const task of await selectAdmissible(ctx.db, ctx.globalLimit)) {
    if (ctx.running.has(task.id)) continue;
    ctx.running.add(task.id);

    // 遅い処理に入る前に枠を確定させる。ここから先の失敗経路が見る
    // 「現在の状態」は queued ではなく running である。
    // selectAdmissible で読んでからここまでに await があるので、その間に
    // task.cancel が届いていれば queued ではなくなっている。canceled を running で
    // 上書きして走らせてはいけないので、queued のままであるときだけ書き、
    // そうでなければこのタスクは見送る。
    try {
      await commitStepBoundary(ctx.db, {
        taskId: task.id,
        requireState: "queued",
        taskPatch: { state: "running", resumed: 0 },
      });
    } catch (e) {
      ctx.running.delete(task.id);
      if (e instanceof StateConflictError) continue;
      throw e;
    }
    ctx.broadcast({
      event: "task.stateChanged",
      task_id: task.id,
      from: task.state,
      to: "running",
    });

    let workflow: Workflow;
    let worktreePath: string;
    try {
      const project = (await getProject(ctx.db, task.project_id))!;
      // 作成時に保存した中身を読み直すだけ（ディスクは読まない）。
      workflow = await ctx.workflowOf(task, project);

      // worktree はタスク作成時ではなく、実行枠が取れた瞬間に作る
      // DB には createWorktree が返す実パスを保存する（worktree.list が返す表記と揃える）
      worktreePath = task.worktree_path ?? await createWorktree({
        repoPath: project.path,
        worktreePath: worktreePathFor(project.path, task.id),
        branch: task.branch,
        baseBranch: task.intake_id === null ? project.base_branch : await intakeBase(project),
      });

      await commitStepBoundary(ctx.db, {
        taskId: task.id,
        taskPatch: { worktree_path: worktreePath },
      });
    } catch (e) {
      // ワークフローが読めない・worktree が作れないなど、枠を取った後に
      // 何が起きても queued に戻してはいけない。放置するとスケジューラが
      // 毎周期リトライし続け、1タスクの不備で他タスクの tick まで止めかねない。
      // 枠は既に先取りしてあるので、現在の状態は running（running -> failed は正当）。
      await failTaskInTick(
        ctx,
        task.id,
        "running",
        `実行を開始できませんでした: ${(e as Error).message}`,
      );
      ctx.running.delete(task.id);
      continue;
    }

    // log.line に載せる実行中のステップの step_runs.id。まだ始まっていなければ 0。
    // onLogLine は出力のチャンクごとに同期で呼ばれるので、DBに問い合わせず
    // onStepRunStarted が渡す id を覚えておく。
    let currentStepRunId = 0;
    try {
      void runTask(ctx.db, task.id, workflow, {
        db: ctx.db,
        adapter: ctx.adapter,
        logRoot: ctx.logRoot,
        globalLimit: ctx.globalLimit,
        onStateChanged: (id, from, to) =>
          ctx.broadcast({ event: "task.stateChanged", task_id: id, from, to }),
        onWarning: (id, message) => ctx.warnings.push(message, id),
        onStepRunStarted: (id, stepRunId, stepId) => {
          currentStepRunId = stepRunId;
          ctx.broadcast({
            event: "stepRun.started",
            task_id: id,
            step_run_id: stepRunId,
            step_id: stepId,
          });
        },
        onStepRunFinished: (id, stepRunId, stepId, status, gotoStepId, attempt) =>
          ctx.broadcast({
            event: "stepRun.finished",
            task_id: id,
            step_run_id: stepRunId,
            step_id: stepId,
            status,
            goto_step_id: gotoStepId,
            attempt,
          }),
        onRateLimit: (s) =>
          ctx.broadcast({
            event: "ratelimit.sample",
            window: s.window,
            utilization: s.utilization,
            resets_at: normalizeResetsAt(s.resetsAt),
          }),
        onLogLine: (line) =>
          ctx.broadcast(
            { event: "log.line", task_id: task.id, step_run_id: currentStepRunId, line },
            { taskId: task.id, followersOnly: true },
          ),
      })
        .then(() => cleanupAfterRun(ctx, task.id))
        .catch(async (e) => {
          // runTask は意図的に例外を伝播させる箇所がある（壊れたテンプレート変数など、
          // ワークフロー作者に見せるべき失敗）。void で握りつぶすと .finally() が
          // 同じ理由で再rejectし、誰も catch しないまま unhandled rejection になって
          // デーモンごと落ちる。ここで受け止め、タスクを failed に倒して警告に残す。
          // この後始末自体（DBの読み書き）も reject させない。
          const message = `実行中に例外が発生しました: ${(e as Error).message}`;
          try {
            const after = await getTask(ctx.db, task.id);
            if (after && !isTerminal(after.state)) {
              await failTaskInTick(ctx, task.id, after.state, message);
            } else {
              ctx.warnings.push(message, task.id);
            }
          } catch (e2) {
            ctx.warnings.push(
              `${message}（failed への記録にも失敗: ${(e2 as Error).message}）`,
              task.id,
            );
          }
        })
        .finally(() => ctx.running.delete(task.id));
    } catch (e) {
      // void runTask(...) の呼び出し自体（Promise が返る前）で何か起きた場合も、
      // ctx.running の解放を必ず通す。
      ctx.running.delete(task.id);
      ctx.warnings.push(`tick 中に例外が発生しました: ${(e as Error).message}`, task.id);
    }
  }
}
