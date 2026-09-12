import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { parseWorkflow, type Workflow } from "../workflow/schema.ts";
import { parseProjectConfig, withSetupStep } from "../workflow/project.ts";
import {
  getProject, getProjectByPath, getTask, insertProject, insertTask, listProjects, listTasks,
  type TaskState,
} from "../db/tasks.ts";
import { getStepRun, listStepRuns } from "../db/stepRuns.ts";
import { commitStepBoundary } from "../db/boundary.ts";
import { recentRateLimitSamples } from "../db/rateLimits.ts";
import { selectAdmissible } from "../core/scheduler.ts";
import { applyApproval, runTask } from "../core/engine.ts";
import {
  branchNameFor, createWorktree, findOrphans, removeWorktree, worktreePathFor,
  UncommittedChangesError,
} from "../core/worktree.ts";
import { killStaleChild, defaultProbe } from "../core/recovery.ts";
import { assertTransition, isTerminal } from "../core/states.ts";
import type { AgentAdapter } from "../adapter/types.ts";
import type { Handler } from "./server.ts";
import type { ServerEvent } from "./protocol.ts";

export type DaemonContext = {
  db: DatabaseSync;
  adapter: AgentAdapter;
  logRoot: string;
  globalLimit: number;
  broadcast(ev: ServerEvent, opts?: { taskId?: string; followersOnly?: boolean }): void;
  loadWorkflow(projectPath: string, name: string): Promise<Workflow>;
  running: Set<string>;
  /** 後始末を拒否したときなど、人に見せる必要のある警告 */
  warnings: string[];
};

function req(params: Record<string, unknown>, key: string): string {
  const v = params[key];
  if (typeof v !== "string" || v === "") throw new Error(`${key} は必須です`);
  return v;
}

export async function loadWorkflowFromDisk(projectPath: string, name: string): Promise<Workflow> {
  const path = join(projectPath, ".doctrine", "workflows", `${name}.yaml`);
  const text = await readFile(path, "utf8").catch(() => {
    throw new Error(`ワークフローがありません: ${path}`);
  });
  return parseWorkflow(text).workflow;
}

export function createHandler(ctx: DaemonContext): Handler {
  return async (method, params, conn) => {
    switch (method) {
      case "project.add": {
        const path = req(params, "path");
        const cfgText = await readFile(join(path, ".doctrine", "project.yaml"), "utf8");
        const cfg = parseProjectConfig(cfgText);
        const id = insertProject(ctx.db, {
          path, default_workflow: cfg.defaultWorkflow, max_concurrent: cfg.maxConcurrent,
          base_branch: cfg.baseBranch, setup: cfg.setup ?? null,
        });
        return getProject(ctx.db, id);
      }
      case "project.list":
        return listProjects(ctx.db);
      case "project.update": {
        const path = req(params, "path");
        const project = getProjectByPath(ctx.db, path);
        if (!project) throw new Error(`未登録のプロジェクトです: ${path}`);
        const cfg = parseProjectConfig(await readFile(join(path, ".doctrine", "project.yaml"), "utf8"));
        ctx.db.prepare(
          `UPDATE projects SET default_workflow=?, max_concurrent=?, base_branch=?, setup=? WHERE id=?`,
        ).run(cfg.defaultWorkflow, cfg.maxConcurrent, cfg.baseBranch, cfg.setup ?? null, project.id);
        return getProject(ctx.db, project.id);
      }

      case "task.create": {
        const projectPath = req(params, "project");
        const project = getProjectByPath(ctx.db, projectPath);
        if (!project) throw new Error(`未登録のプロジェクトです: ${projectPath}`);
        const title = req(params, "title");
        const prompt = req(params, "prompt");
        const workflowName = typeof params.workflow === "string" ? params.workflow : project.default_workflow;
        // 不正な定義はタスク作成時に落とす
        await ctx.loadWorkflow(projectPath, workflowName);
        const id = randomUUID();
        return insertTask(ctx.db, {
          id, project_id: project.id, title, prompt, workflow_name: workflowName,
          branch: branchNameFor(id, title),
          priority: typeof params.priority === "number" ? params.priority : 2,
        });
      }
      case "task.list": {
        const filter: { projectId?: number; state?: TaskState } = {};
        if (typeof params.project === "string") {
          filter.projectId = getProjectByPath(ctx.db, params.project)?.id;
        }
        if (typeof params.state === "string") filter.state = params.state as TaskState;
        return listTasks(ctx.db, filter);
      }
      case "task.get": {
        const task = getTask(ctx.db, req(params, "task_id"));
        if (!task) throw new Error("タスクがありません");
        return { task, stepRuns: listStepRuns(ctx.db, task.id) };
      }

      case "task.approve":
      case "task.reject": {
        const taskId = req(params, "task_id");
        const task = getTask(ctx.db, taskId);
        if (!task) throw new Error("タスクがありません");
        const approved = method === "task.approve";
        // 却下はコメント必須。理由の無い却下はエージェントが次にどう動けばいいか分からない。
        const comment = approved ? "" : req(params, "comment");
        const project = getProject(ctx.db, task.project_id)!;
        const workflow = withSetupStep(
          await ctx.loadWorkflow(project.path, task.workflow_name), project.setup ?? undefined);
        applyApproval(ctx.db, taskId, { approved, comment }, workflow);
        const after = getTask(ctx.db, taskId)!;
        ctx.broadcast({ event: "task.stateChanged", task_id: taskId, from: "suspended", to: after.state });
        return after;
      }

      case "task.pause": {
        const taskId = req(params, "task_id");
        const task = getTask(ctx.db, taskId);
        if (!task) throw new Error("タスクがありません");
        // 遷移表を経由せずに書くと、終端状態や approval 待ちなど許されない
        // 状態からも黙って上書きしてしまう。commitStepBoundary の前に必ず検査する。
        assertTransition(task.state, "paused");
        // デーモンが生きたまま協調的に止める経路。子を SIGTERM で止め、flush の機会を与える。
        await killStaleChild(task, defaultProbe(), "SIGTERM");
        commitStepBoundary(ctx.db, {
          taskId, taskPatch: { state: "paused", child_pid: null, child_started_at: null },
        });
        ctx.broadcast({ event: "task.stateChanged", task_id: taskId, from: task.state, to: "paused" });
        return getTask(ctx.db, taskId);
      }
      case "task.resume": {
        const taskId = req(params, "task_id");
        const task = getTask(ctx.db, taskId);
        if (!task) throw new Error("タスクがありません");
        if (task.state !== "paused" && task.state !== "suspended") {
          throw new Error(`再開できる状態ではありません: ${task.state}`);
        }
        // 行列の先頭に入る。進行中の仕事を新規の仕事より先に終わらせる。
        commitStepBoundary(ctx.db, { taskId, taskPatch: { state: "queued", resumed: 1 } });
        ctx.broadcast({ event: "task.stateChanged", task_id: taskId, from: task.state, to: "queued" });
        return getTask(ctx.db, taskId);
      }
      case "task.cancel": {
        const taskId = req(params, "task_id");
        const task = getTask(ctx.db, taskId);
        if (!task) throw new Error("タスクがありません");
        // 終端状態（completed/failed/canceled）から二度 cancel されて記録を
        // 上書きしないよう、書き込み前に遷移表で検査する。
        assertTransition(task.state, "canceled");
        // デーモンが生きたまま協調的に止める経路。pause と同じく SIGTERM。
        await killStaleChild(task, defaultProbe(), "SIGTERM");
        // worktree は残す。失敗・中止した実行こそ中を見たい。
        commitStepBoundary(ctx.db, {
          taskId, taskPatch: { state: "canceled", child_pid: null, child_started_at: null },
        });
        ctx.broadcast({ event: "task.stateChanged", task_id: taskId, from: task.state, to: "canceled" });
        return getTask(ctx.db, taskId);
      }
      case "task.logs": {
        const taskId = req(params, "task_id");
        if (params.follow) conn.follow(taskId);
        const stepRunId = Number(params.step_run_id);
        const run = getStepRun(ctx.db, stepRunId);
        if (!run) throw new Error("ステップ実行がありません");
        const text = await readFile(run.log_path, "utf8").catch(() => "");
        const tailLines = typeof params.tail === "number" ? params.tail : 200;
        return { log_path: run.log_path, lines: text.split("\n").slice(-tailLines) };
      }

      case "worktree.list": {
        const out: { project: string; orphans: string[] }[] = [];
        for (const project of listProjects(ctx.db)) {
          const known = listTasks(ctx.db, { projectId: project.id })
            .map((t) => t.worktree_path).filter((p): p is string => p !== null);
          out.push({ project: project.path, orphans: await findOrphans(project.path, known) });
        }
        return out;
      }
      case "worktree.remove": {
        const taskId = req(params, "task_id");
        const task = getTask(ctx.db, taskId);
        if (!task?.worktree_path) throw new Error("worktree がありません");
        const project = getProject(ctx.db, task.project_id)!;
        // 失敗したタスクの worktree は汚れているのが通常。force を明示しない限り
        // 未コミットの作業は失われず、削除は拒否される。
        await removeWorktree({
          repoPath: project.path, worktreePath: task.worktree_path, force: params.force === true,
        });
        commitStepBoundary(ctx.db, { taskId, taskPatch: { worktree_path: null } });
        return { removed: task.worktree_path };
      }

      case "ratelimit.recent":
        return recentRateLimitSamples(ctx.db, typeof params.limit === "number" ? params.limit : 50);

      default:
        throw new Error(`未知のメソッドです: ${method}`);
    }
  };
}

/** 実行中のステップの step_runs.id。まだ1件も無ければ 0。 */
function latestStepRunId(db: DatabaseSync, taskId: string): number {
  return listStepRuns(db, taskId).at(-1)?.id ?? 0;
}

/** completed のみ worktree を削除する。failed / canceled は証拠として残す。 */
export async function cleanupAfterRun(ctx: DaemonContext, taskId: string): Promise<void> {
  const task = getTask(ctx.db, taskId);
  if (!task || task.state !== "completed" || !task.worktree_path) return;
  const project = getProject(ctx.db, task.project_id)!;
  try {
    await removeWorktree({ repoPath: project.path, worktreePath: task.worktree_path, force: false });
    commitStepBoundary(ctx.db, { taskId, taskPatch: { worktree_path: null } });
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
        `タスク ${taskId}: worktree の削除に失敗しました (${task.worktree_path}): ${(e as Error).message}`,
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
function failTaskInTick(ctx: DaemonContext, taskId: string, fromState: TaskState, reason: string): void {
  ctx.warnings.push(`タスク ${taskId}: ${reason}`);
  try {
    assertTransition(fromState, "failed");
    commitStepBoundary(ctx.db, { taskId, taskPatch: { state: "failed" } });
    ctx.broadcast({ event: "task.stateChanged", task_id: taskId, from: fromState, to: "failed" });
  } catch {
    // fromState から failed へ遷移できない（既に終端など）場合はこれ以上書かず、
    // 警告の記録だけに留める。
  }
}

/** 1周: 枠の空きを見て queued を running にし、次に人を待つ地点まで進める。 */
export async function tick(ctx: DaemonContext): Promise<void> {
  for (const task of selectAdmissible(ctx.db, ctx.globalLimit)) {
    if (ctx.running.has(task.id)) continue;
    ctx.running.add(task.id);

    let workflow: Workflow;
    let worktreePath: string;
    try {
      const project = getProject(ctx.db, task.project_id)!;
      workflow = withSetupStep(
        await ctx.loadWorkflow(project.path, task.workflow_name), project.setup ?? undefined);

      // worktree はタスク作成時ではなく、実行枠が取れた瞬間に作る
      worktreePath = task.worktree_path ?? worktreePathFor(project.path, task.id);
      if (!task.worktree_path) {
        await createWorktree({
          repoPath: project.path, worktreePath, branch: task.branch, baseBranch: project.base_branch,
        });
      }

      commitStepBoundary(ctx.db, {
        taskId: task.id,
        taskPatch: { state: "running", worktree_path: worktreePath, resumed: 0 },
      });
      ctx.broadcast({ event: "task.stateChanged", task_id: task.id, from: task.state, to: "running" });
    } catch (e) {
      // ワークフローが読めない・worktree が作れないなど、running を書く前に
      // 何が起きても queued に留めてはいけない。放置するとスケジューラが
      // 毎周期リトライし続け、1タスクの不備で他タスクの tick まで止めかねない。
      failTaskInTick(ctx, task.id, task.state, `実行を開始できませんでした: ${(e as Error).message}`);
      ctx.running.delete(task.id);
      continue;
    }

    try {
      void runTask(ctx.db, task.id, workflow, {
        db: ctx.db, adapter: ctx.adapter, logRoot: ctx.logRoot, globalLimit: ctx.globalLimit,
        onStateChanged: (id, from, to) =>
          ctx.broadcast({ event: "task.stateChanged", task_id: id, from, to }),
        onStepRunStarted: (id, stepRunId, stepId) =>
          ctx.broadcast({ event: "stepRun.started", task_id: id, step_run_id: stepRunId, step_id: stepId }),
        onStepRunFinished: (id, stepRunId, stepId, status) =>
          ctx.broadcast({ event: "stepRun.finished", task_id: id, step_run_id: stepRunId, step_id: stepId, status }),
        onRateLimit: (s) =>
          ctx.broadcast({ event: "ratelimit.sample", window: s.window, utilization: s.utilization, resets_at: s.resetsAt }),
        onLogLine: (line) =>
          ctx.broadcast(
            { event: "log.line", task_id: task.id, step_run_id: latestStepRunId(ctx.db, task.id), line },
            { taskId: task.id, followersOnly: true }),
      })
        .then(() => cleanupAfterRun(ctx, task.id))
        .catch((e) => {
          // runTask は意図的に例外を伝播させる箇所がある（壊れたテンプレート変数など、
          // ワークフロー作者に見せるべき失敗）。void で握りつぶすと .finally() が
          // 同じ理由で再rejectし、誰も catch しないまま unhandled rejection になって
          // デーモンごと落ちる。ここで受け止め、タスクを failed に倒して警告に残す。
          const after = getTask(ctx.db, task.id);
          if (after && !isTerminal(after.state)) {
            failTaskInTick(ctx, task.id, after.state, `実行中に例外が発生しました: ${(e as Error).message}`);
          } else {
            ctx.warnings.push(`タスク ${task.id}: 実行中に例外が発生しました: ${(e as Error).message}`);
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
