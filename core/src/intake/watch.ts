import type { PrFact } from "../../../shared/intake/github.ts";
import type { WatchHealth } from "../../../shared/protocol.ts";
import {
  getPrObservation,
  IntakeStateConflictError,
  listIntakes,
  updateIntake,
  upsertPrObservation,
} from "../db/intakes.ts";
import type { Db, ProjectRow } from "../db/schema.ts";
import { getProject, listProjects } from "../db/tasks.ts";
import { assertIntakeTransition } from "../domain/intakeStates.ts";
import type { PrWatcher, Tracker } from "../github/tracker.ts";
import type { IntakeTransition } from "./commands.ts";
import { dispatchIntake, loadApprovedPlan } from "./dispatch.ts";
import { computeProcessStatuses, goalReached } from "./pfd/status.ts";
import { syncSubIssues } from "./subIssueSync.ts";
import { processProgressOf } from "./view.ts";

export const WATCH_INTERVAL_MS = 120_000;

const describe = (e: unknown): string => e instanceof Error ? e.message : String(e);

/**
 * 1 ブランチの PR から 1 つを選ぶ。
 * 優先度: baseBranch へマージされたもの > OPEN > number が最大のもの。空なら null。
 */
export function choosePr(facts: readonly PrFact[], baseBranch: string): PrFact | null {
  const byNumber = [...facts].sort((a, b) => b.number - a.number);
  return byNumber.find((f) => f.state === "MERGED" && f.baseRef === baseBranch) ??
    byNumber.find((f) => f.state === "OPEN") ??
    byNumber[0] ?? null;
}

export type ObserveReport = { changedIntakeIds: Set<string> };

/**
 * プロジェクトの active な Intake について、current_task_id のタスクのうち、
 * baseBranch へのマージがまだ観測されていないものの PR を、pullRequests の 1 回の呼び出しで引く。
 * 選んだ PR が前回の観測と違えば upsertPrObservation する。PR が無いタスクは書かない
 * （status.ts がタスクの状態から no_pr を出す）。対象が無ければ gh を呼ばない。
 * pullRequests の失敗はそのまま投げる。
 */
export async function observePullRequests(
  db: Db,
  prWatcher: PrWatcher,
  project: ProjectRow,
): Promise<ObserveReport> {
  const report: ObserveReport = { changedIntakeIds: new Set() };
  // 観測が無い行は o.state が null になるので、「マージ済みでない」は null も含めて数える
  const targets = await db.selectFrom("intake_processes as p")
    .innerJoin("intakes as i", "i.id", "p.intake_id")
    .innerJoin("tasks as t", "t.id", "p.current_task_id")
    .leftJoin("pr_observations as o", "o.task_id", "t.id")
    .select(["i.id as intake_id", "t.id as task_id", "t.branch as branch"])
    .where("i.state", "=", "active")
    .where("i.project_id", "=", project.id)
    .where("p.retired_at", "is", null)
    .where((eb) =>
      eb.or([
        eb("o.state", "is", null),
        eb("o.state", "!=", "MERGED"),
        eb("o.base_ref", "!=", project.base_branch),
      ])
    )
    .orderBy("t.created_at").orderBy("t.id")
    .execute();
  if (targets.length === 0) return report;

  const found = await prWatcher.pullRequests(project.path, targets.map((t) => t.branch));
  for (const t of targets) {
    const chosen = choosePr(found.get(t.branch) ?? [], project.base_branch);
    if (chosen === null) continue;
    const before = await getPrObservation(db, t.task_id);
    if (
      before && before.pr_number === chosen.number && before.state === chosen.state &&
      before.base_ref === chosen.baseRef && before.merged_at === chosen.mergedAt &&
      before.merge_commit === chosen.mergeCommit
    ) continue;
    await upsertPrObservation(db, {
      task_id: t.task_id,
      pr_number: chosen.number,
      pr_url: chosen.url,
      state: chosen.state,
      base_ref: chosen.baseRef,
      merged_at: chosen.mergedAt,
      merge_commit: chosen.mergeCommit,
    });
    report.changedIntakeIds.add(t.intake_id);
  }
  return report;
}

/** active → completed。書く前に状態が変わっていれば null（requireState: "active"）。 */
export async function completeIntake(db: Db, intakeId: string): Promise<IntakeTransition | null> {
  assertIntakeTransition("active", "completed", false);
  try {
    await updateIntake(
      db,
      intakeId,
      { state: "completed", ended_at: new Date().toISOString() },
      { requireState: "active" },
    );
  } catch (e) {
    if (e instanceof IntakeStateConflictError) return null;
    throw e;
  }
  return { intakeId, from: "active", to: "completed", revising: false };
}

export type ProjectWatchReport = {
  /** この周で見た active な Intake の id。空なら、gh を呼ばずに終えた。 */
  watched: string[];
  /** gh の失敗・承認の食い違い・prompt を組めなかったことなど。空なら成功の周。 */
  errors: string[];
  /** 状態以外が変わった Intake（intake.updated を配る）。 */
  updated: Set<string>;
  transitions: IntakeTransition[];
};

/** 1 プロジェクトの 1 周。投げない（想定外の例外も errors に入れる）。 */
export async function watchProject(
  db: Db,
  deps: { tracker: Tracker; prWatcher: PrWatcher },
  projectId: number,
): Promise<ProjectWatchReport> {
  const report: ProjectWatchReport = {
    watched: [],
    errors: [],
    updated: new Set(),
    transitions: [],
  };
  try {
    const project = await getProject(db, projectId);
    if (!project) return report;
    const intakes = (await listIntakes(db, { projectId })).filter((i) => i.state === "active");
    if (intakes.length === 0) return report;
    report.watched = intakes.map((i) => i.id);

    for (const intake of intakes) {
      try {
        const plan = await loadApprovedPlan(db, intake.id);
        if (!plan) continue;
        const synced = await syncSubIssues(db, deps.tracker, {
          projectPath: project.path,
          intake,
          pfd: plan.pfd,
        });
        for (const f of synced.failures) {
          report.errors.push(
            `${intake.issue_url} プロセス ${f.processId} の sub-issue（${f.op}）: ${f.message}`,
          );
        }
        if (
          [synced.created, synced.adopted, synced.updated, synced.closed].some((l) => l.length > 0)
        ) report.updated.add(intake.id);
      } catch (e) {
        report.errors.push(`${intake.issue_url} の sub-issue の同期: ${describe(e)}`);
      }
    }

    // 観測の失敗で投入を止めない（W-12）
    try {
      const observed = await observePullRequests(db, deps.prWatcher, project);
      observed.changedIntakeIds.forEach((id) => report.updated.add(id));
    } catch (e) {
      report.errors.push(`PR の観測: ${describe(e)}`);
    }

    for (const intake of intakes) {
      try {
        const dispatched = await dispatchIntake(db, intake.id);
        if (dispatched.created.length > 0) report.updated.add(intake.id);
        for (const f of dispatched.errors) {
          report.errors.push(`${intake.issue_url} プロセス ${f.processId} の投入: ${f.message}`);
        }
      } catch (e) {
        report.errors.push(`${intake.issue_url} の投入: ${describe(e)}`);
      }
    }

    for (const intake of intakes) {
      try {
        const plan = await loadApprovedPlan(db, intake.id);
        if (!plan) continue;
        const statuses = computeProcessStatuses({
          pfd: plan.pfd,
          baseBranch: project.base_branch,
          revising: false,
          dispatchPaused: false,
          progress: await processProgressOf(db, intake.id),
        });
        if (!goalReached(plan.pfd, statuses)) continue;
        const transition = await completeIntake(db, intake.id);
        if (transition) report.transitions.push(transition);
      } catch (e) {
        report.errors.push(`${intake.issue_url} の完了の判定: ${describe(e)}`);
      }
    }
  } catch (e) {
    report.errors.push(describe(e));
  }
  return report;
}

export const INITIAL_WATCH_HEALTH: WatchHealth = {
  lastSucceededAt: null,
  consecutiveFailures: 0,
  lastError: null,
};

export interface IntakeWatcher {
  /** 登録済みの全プロジェクトを 1 周する。決して reject しない。 */
  cycle(): Promise<void>;
  /**
   * 1 プロジェクトを今すぐ 1 周する。そのプロジェクトの周がすでに走っていれば、
   * それが終わった後にもう 1 周回す（走っている周が承認の前に行を読んでいた場合に取りこぼさないため）。
   * 決して reject しない。
   */
  request(projectId: number): Promise<void>;
  /** プロジェクトの見張りの健康状態。まだ回っていなければ INITIAL_WATCH_HEALTH。 */
  health(projectId: number): WatchHealth;
  /** 走っている周が無いか。テストの後始末が待つ。 */
  idle(): boolean;
}

export function createIntakeWatcher(deps: {
  db: Db;
  tracker: Tracker;
  prWatcher: PrWatcher;
  onStateChanged(t: IntakeTransition): void;
  onUpdated(intakeId: string): void;
  now?: () => Date;
}): IntakeWatcher {
  const now = deps.now ?? (() => new Date());
  const inFlight = new Map<number, Promise<void>>();
  const pending = new Set<number>();
  const health = new Map<number, WatchHealth>();

  const healthOf = (projectId: number) => health.get(projectId) ?? INITIAL_WATCH_HEALTH;

  // コールバックの例外で周を止めない。失敗は errors に足して健康状態に出す
  function safely(errors: string[], call: () => void): void {
    try {
      call();
    } catch (e) {
      console.error("intake watcher callback failed:", e);
      errors.push(`通知: ${describe(e)}`);
    }
  }

  // 健康状態を更新し、失敗に入った・続いた・治ったときだけ true を返す。
  // lastSucceededAt だけの変化では配らない（成功の周のたびに全 Intake へ飛ぶため）
  function record(projectId: number, errors: string[]): boolean {
    const before = healthOf(projectId);
    const next: WatchHealth = errors.length === 0
      ? { lastSucceededAt: now().toISOString(), consecutiveFailures: 0, lastError: null }
      : {
        lastSucceededAt: before.lastSucceededAt,
        consecutiveFailures: before.consecutiveFailures + 1,
        lastError: errors.join("\n"),
      };
    health.set(projectId, next);
    return next.consecutiveFailures !== before.consecutiveFailures ||
      next.lastError !== before.lastError;
  }

  async function pass(projectId: number): Promise<void> {
    let report: ProjectWatchReport;
    try {
      report = await watchProject(deps.db, deps, projectId);
    } catch (e) {
      console.error("intake watch failed:", e);
      record(projectId, [describe(e)]);
      return;
    }
    if (report.watched.length === 0) return;

    const errors = [...report.errors];
    for (const t of report.transitions) safely(errors, () => deps.onStateChanged(t));
    for (const id of report.updated) safely(errors, () => deps.onUpdated(id));
    if (record(projectId, errors)) {
      for (const id of report.watched) {
        if (!report.updated.has(id)) safely([], () => deps.onUpdated(id));
      }
    }
  }

  // pending の確認と inFlight からの削除は同じ同期区間で行う。分けると、その間に来た要求を取りこぼす
  async function loop(projectId: number): Promise<void> {
    try {
      while (true) {
        pending.delete(projectId);
        await pass(projectId);
        if (!pending.has(projectId)) break;
      }
    } finally {
      inFlight.delete(projectId);
    }
  }

  function request(projectId: number): Promise<void> {
    const running = inFlight.get(projectId);
    if (running) {
      pending.add(projectId);
      return running;
    }
    // 最初の await より前に登録する。ハンドラは void で起動して応答を返すので、
    // 遅れると idle() が周の始まる前に true になる
    const started = loop(projectId);
    inFlight.set(projectId, started);
    return started;
  }

  // listProjects を待つ間は inFlight が空なので、cycle 自身も idle の判定に数える
  let cycling = 0;

  return {
    async cycle() {
      cycling++;
      try {
        for (const p of await listProjects(deps.db)) await request(p.id);
      } catch (e) {
        console.error("intake watch cycle failed:", e);
      } finally {
        cycling--;
      }
    },
    request,
    health: healthOf,
    idle: () => inFlight.size === 0 && cycling === 0,
  };
}
