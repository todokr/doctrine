import { join } from "@std/path";
import { computeDiff, mergeBase, type TaskDiff } from "../domain/diff.ts";
import { parseWorkflow, type Workflow } from "../workflow/schema.ts";
import { parseProjectConfig, withSetupStep } from "../workflow/project.ts";
import { ensureProjectScaffold } from "../workflow/scaffold.ts";
import {
  getProject,
  getProjectByPath,
  getTask,
  insertProject,
  insertTask,
  listProjects,
  listTasks,
  type TaskState,
} from "../db/tasks.ts";
import {
  getAwaitingStepRun,
  getStepRun,
  lastRejectedReview,
  listStepRuns,
} from "../db/stepRuns.ts";
import { commitStepBoundary, StateConflictError, type StepBoundary } from "../db/boundary.ts";
import type { TaskRow } from "../db/tasks.ts";
import type { Db } from "../db/schema.ts";
import { recentRateLimitSamples } from "../db/rateLimits.ts";
import { selectAdmissible } from "../domain/scheduler.ts";
import { applyApproval, runTask } from "../domain/engine.ts";
import {
  branchNameFor,
  createWorktree,
  findOrphans,
  removeWorktree,
  UncommittedChangesError,
  worktreePathFor,
} from "../domain/worktree.ts";
import { defaultProbe, killStaleChild } from "../domain/recovery.ts";
import { buildTaskContext } from "../domain/taskContext.ts";
import { captureTree, releaseTrees } from "../domain/reviewTree.ts";
import { assertTransition, isTerminal } from "../domain/states.ts";
import type { AgentAdapter } from "../adapter/types.ts";
import type { Handler } from "./server.ts";
import type { ServerEvent } from "../../../shared/protocol.ts";

export type DaemonContext = {
  db: Db;
  adapter: AgentAdapter;
  logRoot: string;
  globalLimit: number;
  broadcast(ev: ServerEvent, opts?: { taskId?: string; followersOnly?: boolean }): void;
  loadWorkflow(
    projectPath: string,
    name: string,
  ): Promise<{ workflow: Workflow; warnings: string[] }>;
  running: Set<string>;
  /** 後始末を拒否したときなど、人に見せる必要のある警告 */
  warnings: string[];
};

function req(params: Record<string, unknown>, key: string): string {
  const v = params[key];
  if (typeof v !== "string" || v === "") throw new Error(`${key} は必須です`);
  return v;
}

/**
 * `suspended` から、人の決定を待たずに外へ出るとき（task.cancel / task.resume）に、
 * 開いている `awaiting` 行を閉じるための `stepRunUpdate` を作る。
 *
 * `interrupted` の意味は「人の決定を待たずに外から閉じられた」。閉じずに放置すると、
 * 中止されたタスクや再開されたタスクの記録が「この人はまだレビューを待っている」と
 * 言い続ける（`running` のまま放置された行と同じ嘘になる）。
 *
 * 返り値は状態を書くのと**同じ** `commitStepBoundary` に渡すこと。別トランザクションに
 * すると、片方だけ書かれた記録が作れてしまう。
 *
 * 閉じるべき行が無ければ undefined を返す（`paused` からの resume、`queued` /
 * `running` からの cancel、`current_step_id` が null のタスクなど）。
 */
async function closeAwaitingStepRun(
  db: Db,
  task: TaskRow,
): Promise<StepBoundary["stepRunUpdate"]> {
  if (task.state !== "suspended" || !task.current_step_id) return undefined;
  const awaiting = await getAwaitingStepRun(db, task.id, task.current_step_id);
  if (!awaiting) return undefined;
  return {
    id: awaiting.id,
    status: "interrupted",
    exit_code: null,
    ended_at: new Date().toISOString(),
  };
}

export async function loadWorkflowFromDisk(
  projectPath: string,
  name: string,
): Promise<{ workflow: Workflow; warnings: string[] }> {
  const path = join(projectPath, ".doctrine", "workflows", `${name}.yaml`);
  const text = await Deno.readTextFile(path).catch(() => {
    throw new Error(`ワークフローがありません: ${path}`);
  });
  return parseWorkflow(text);
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
        await ctx.db.updateTable("projects")
          .set({
            default_workflow: cfg.defaultWorkflow,
            max_concurrent: cfg.maxConcurrent,
            base_branch: cfg.baseBranch,
            setup: cfg.setup ?? null,
          })
          .where("id", "=", project.id)
          .execute();
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
        const { warnings } = await ctx.loadWorkflow(projectPath, workflowName);
        const id = crypto.randomUUID();
        const task = await insertTask(ctx.db, {
          id,
          project_id: project.id,
          title,
          prompt,
          workflow_name: workflowName,
          branch: branchNameFor(id, title),
          priority: typeof params.priority === "number" ? params.priority : 2,
        });
        // タスク作成時だけがこの warnings の出口。task.approve/reject や tick も
        // 同じ loadWorkflow を通るが、そちらは既存タスクを毎回再読込するので、
        // ここで積むと同じ警告が tick のたびに ctx.warnings に溜まり続ける
        // （デーモンのstderrを埋め尽くす）。作成時の1回だけに絞る。
        for (const w of warnings) ctx.warnings.push(`タスク ${id} の作成時の検証: ${w}`);
        // dctl add はレスポンスをそのまま表示するCLIなので、ここに乗せておけば
        // ログを探しに行かなくてもユーザーの目の前に出る。
        return { ...task, warnings };
      }
      case "task.list": {
        const filter: { projectId?: number; state?: TaskState } = {};
        if (typeof params.project === "string") {
          filter.projectId = (await getProjectByPath(ctx.db, params.project))?.id;
        }
        if (typeof params.state === "string") filter.state = params.state as TaskState;
        const tasks = await listTasks(ctx.db, filter);
        // サイドバーの「要確認」に degraded を含めるために要る（レビューアプリ設計spec 5章）。
        // 1タスクずつ問い合わせると件数ぶん往復するので、一度に集めて突き合わせる。
        const degraded = new Set(
          (await ctx.db.selectFrom("step_runs").select("task_id").distinct()
            .where("status", "=", "degraded").execute()).map((r) => r.task_id),
        );
        return tasks.map((t) => ({ ...t, has_degraded: degraded.has(t.id) }));
      }
      case "task.get": {
        const task = await getTask(ctx.db, req(params, "task_id"));
        if (!task) throw new Error("タスクがありません");
        return { task, stepRuns: await listStepRuns(ctx.db, task.id) };
      }

      case "task.context": {
        const task = await getTask(ctx.db, req(params, "task_id"));
        if (!task) throw new Error("タスクがありません");
        const project = (await getProject(ctx.db, task.project_id))!;
        // 読み取り専用の経路なので、ワークフローが読めないことで失敗させない。
        // 定義が引けないと分かるのは種別が要るものだけ（buildTaskContext が扱う）。
        const workflow = await ctx.loadWorkflow(project.path, task.workflow_name)
          .then(({ workflow }) => withSetupStep(workflow, project.setup ?? undefined))
          .catch(() => null);
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
        // warnings は意図的に読み捨てる。このワークフローは task.create で
        // 既に検証済みであり、ここで再び ctx.warnings に積むと、却下ループ
        // （onReject.goto で最大 maxAttempts 回まで繰り返され得る）のたびに
        // 同じ警告が積み上がって溢れる。警告の出口は task.create の1箇所だけ。
        const { workflow: loaded } = await ctx.loadWorkflow(project.path, task.workflow_name);
        const workflow = withSetupStep(loaded, project.setup ?? undefined);
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
          await cleanupAfterRun(ctx, taskId).catch((e: Error) => {
            ctx.warnings.push(`タスク ${taskId}: 承認後の後始末に失敗しました: ${e.message}`);
          });
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
        if (task.state !== "paused" && task.state !== "suspended") {
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
          taskPatch: { state: "queued", resumed: 1 },
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
        // 終端状態（completed/failed/canceled）から二度 cancel されて記録を
        // 上書きしないよう、書き込み前に遷移表で検査する。
        assertTransition(task.state, "canceled");
        // デーモンが生きたまま協調的に止める経路。pause と同じく SIGTERM。
        await killStaleChild(task, defaultProbe(), "SIGTERM");
        // worktree は残す。失敗・中止した実行こそ中を見たい。
        // suspended からの cancel なら、開いていた awaiting 行も同じトランザクションで
        // 閉じる（放置すると、中止されたタスクの記録が永久に「レビュー待ち」と言い続ける）。
        await commitStepBoundary(ctx.db, {
          taskId,
          requireState: task.state,
          taskPatch: { state: "canceled", child_pid: null, child_started_at: null },
          stepRunUpdate: await closeAwaitingStepRun(ctx.db, task),
        });
        ctx.broadcast({
          event: "task.stateChanged",
          task_id: taskId,
          from: task.state,
          to: "canceled",
        });
        return await getTask(ctx.db, taskId);
      }
      case "task.logs": {
        const taskId = req(params, "task_id");
        if (params.follow) conn.follow(taskId);
        const stepRunId = Number(params.step_run_id);
        const run = await getStepRun(ctx.db, stepRunId);
        if (!run) throw new Error("ステップ実行がありません");
        const text = await Deno.readTextFile(run.log_path).catch(() => "");
        const tailLines = typeof params.tail === "number" ? params.tail : 200;
        return { log_path: run.log_path, lines: text.split("\n").slice(-tailLines) };
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

      case "worktree.list": {
        const out: { project: string; orphans: string[] }[] = [];
        for (const project of await listProjects(ctx.db)) {
          const known = (await listTasks(ctx.db, { projectId: project.id }))
            .map((t) => t.worktree_path).filter((p): p is string => p !== null);
          out.push({ project: project.path, orphans: await findOrphans(project.path, known) });
        }
        return out;
      }
      case "worktree.remove": {
        const taskId = req(params, "task_id");
        const task = await getTask(ctx.db, taskId);
        if (!task?.worktree_path) throw new Error("worktree がありません");
        const project = (await getProject(ctx.db, task.project_id))!;
        // 失敗したタスクの worktree は汚れているのが通常。force を明示しない限り
        // 未コミットの作業は失われず、削除は拒否される。
        await removeWorktree({
          repoPath: project.path,
          worktreePath: task.worktree_path,
          force: params.force === true,
        });
        await releaseReviewRefs(ctx, project.path, taskId);
        await commitStepBoundary(ctx.db, { taskId, taskPatch: { worktree_path: null } });
        return { removed: task.worktree_path };
      }

      case "ratelimit.recent":
        return await recentRateLimitSamples(
          ctx.db,
          typeof params.limit === "number" ? params.limit : 50,
        );

      default:
        throw new Error(`未知のメソッドです: ${method}`);
    }
  };
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
    ctx.warnings.push(`タスク ${taskId}: レビュー参照を消せませんでした: ${e.message}`);
  });
}

/** completed のみ worktree を削除する。failed / canceled は証拠として残す。 */
export async function cleanupAfterRun(ctx: DaemonContext, taskId: string): Promise<void> {
  const task = await getTask(ctx.db, taskId);
  if (!task || task.state !== "completed" || !task.worktree_path) return;
  const project = (await getProject(ctx.db, task.project_id))!;
  try {
    await removeWorktree({
      repoPath: project.path,
      worktreePath: task.worktree_path,
      force: false,
    });
    await releaseReviewRefs(ctx, project.path, taskId);
    await commitStepBoundary(ctx.db, { taskId, taskPatch: { worktree_path: null } });
  } catch (e) {
    if (e instanceof UncommittedChangesError) {
      // ワークフローの書き方のバグ。黙って消してよいものではない。
      ctx.warnings.push(
        `タスク ${taskId}: 完了時に未コミットの変更が残っているため worktree を削除しませんでした ` +
          `(${task.worktree_path}): ${e.message}`,
      );
    } else {
      // git worktree remove 自体が失敗した場合など（原因不明）。未コミットの
      // 変更の話にすり替えず、そのまま見せる。
      ctx.warnings.push(
        `タスク ${taskId}: worktree の削除に失敗しました (${task.worktree_path}): ${
          (e as Error).message
        }`,
      );
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
  ctx.warnings.push(`タスク ${taskId}: ${reason}`);
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
 * 2. **枠の先取り** — 遅い処理（loadWorkflow / createWorktree — git の
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

async function tickOnce(ctx: DaemonContext): Promise<void> {
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
      // warnings は意図的に読み捨てる（task.create の警告と同じ理由）。
      // tick は同じタスクを何周期にもわたって読み直すので、ここで積むと
      // 起動している間ずっと同じ警告が ctx.warnings に積み上がり続ける。
      const { workflow: loaded } = await ctx.loadWorkflow(project.path, task.workflow_name);
      workflow = withSetupStep(loaded, project.setup ?? undefined);

      // worktree はタスク作成時ではなく、実行枠が取れた瞬間に作る
      // DB には createWorktree が返す実パスを保存する（worktree.list が返す表記と揃える）
      worktreePath = task.worktree_path ?? await createWorktree({
        repoPath: project.path,
        worktreePath: worktreePathFor(project.path, task.id),
        branch: task.branch,
        baseBranch: project.base_branch,
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
        onWarning: (id, message) => ctx.warnings.push(`タスク ${id}: ${message}`),
        onStepRunStarted: (id, stepRunId, stepId) => {
          currentStepRunId = stepRunId;
          ctx.broadcast({
            event: "stepRun.started",
            task_id: id,
            step_run_id: stepRunId,
            step_id: stepId,
          });
        },
        onStepRunFinished: (id, stepRunId, stepId, status) =>
          ctx.broadcast({
            event: "stepRun.finished",
            task_id: id,
            step_run_id: stepRunId,
            step_id: stepId,
            status,
          }),
        onRateLimit: (s) =>
          ctx.broadcast({
            event: "ratelimit.sample",
            window: s.window,
            utilization: s.utilization,
            resets_at: s.resetsAt,
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
              ctx.warnings.push(`タスク ${task.id}: ${message}`);
            }
          } catch (e2) {
            ctx.warnings.push(
              `タスク ${task.id}: ${message}（failed への記録にも失敗: ${(e2 as Error).message}）`,
            );
          }
        })
        .finally(() => ctx.running.delete(task.id));
    } catch (e) {
      // void runTask(...) の呼び出し自体（Promise が返る前）で何か起きた場合も、
      // ctx.running の解放を必ず通す。
      ctx.running.delete(task.id);
      ctx.warnings.push(`タスク ${task.id}: tick 中に例外が発生しました: ${(e as Error).message}`);
    }
  }
}
