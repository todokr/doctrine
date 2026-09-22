import { getProject, type TaskRow } from "../db/tasks.ts";
import type { Db, IntakeRunPurpose, IntakeRunRow, IntakeState } from "../db/schema.ts";
import { commitStepBoundary, StateConflictError } from "../db/boundary.ts";
import { IntakeStateConflictError, updateIntake } from "../db/intakes.ts";
import { enqueueIntakeRun } from "../intake/runner.ts";
import { holdsGlobalSlot, holdsProjectSlot } from "./states.ts";

export const DEFAULT_GLOBAL_LIMIT = 4;

export type SlotUsage = { global: number; byProject: Map<number, number> };

/**
 * 調査・分解の実行が走っている（あるいは、上限待ちを解かれて走る）Intake の状態。
 * 上限待ちの Intake が中止や要確認に移っても rate_limited_until は残りうるので、
 * Intake を見る 3 つの関数はどれもこの状態に絞る。
 */
const RUNNING_INTAKE_STATES: IntakeState[] = ["investigating", "decomposing"];

/**
 * カウンタは持たない。状態から数える。持てば必ず状態とズレる。
 * Intake の実行は全体枠だけを取り、プロジェクト枠は取らない（spec 7 章）。
 */
export async function currentUsage(db: Db): Promise<SlotUsage> {
  const rows = await db.selectFrom("tasks").select(["project_id", "state"])
    .where("state", "in", ["running", "suspended", "paused", "rate_limited", "waiting"])
    .execute();

  const usage: SlotUsage = { global: 0, byProject: new Map() };
  for (const r of rows) {
    if (holdsGlobalSlot(r.state)) usage.global += 1;
    if (holdsProjectSlot(r.state)) {
      usage.byProject.set(r.project_id, (usage.byProject.get(r.project_id) ?? 0) + 1);
    }
  }
  const intakeRuns = await db.selectFrom("intake_runs")
    .select((eb) => eb.fn.countAll<number>().as("n"))
    .where("status", "=", "running")
    .executeTakeFirstOrThrow();
  usage.global += Number(intakeRuns.n);
  return usage;
}

/**
 * 期限の来た上限待ちを queued に戻す。戻したタスクのidを返す（呼び出し側が
 * task.stateChanged を配る。配らないとアプリは次の取り直しまで上限待ちのまま見える）。
 *
 * 待ちは runTask の中で sleep せず、タスク行の rate_limited_until と tick で表す。
 * sleep にすると、デーモンを再起動した瞬間に待ちが消えてタスクが永久に止まる。
 */
export async function releaseDueRateLimited(
  db: Db,
  now: Date = new Date(),
): Promise<string[]> {
  const due = await db.selectFrom("tasks").select("id")
    .where("state", "=", "rate_limited")
    .where("rate_limited_until", "<=", now.toISOString())
    .orderBy("rate_limited_until", "asc")
    .execute();

  const released: string[] = [];
  for (const { id } of due) {
    try {
      await commitStepBoundary(db, {
        taskId: id,
        requireState: "rate_limited",
        // 進行中の仕事なので行列の先頭に入る（承認からの再開と同じ扱い）。
        taskPatch: { state: "queued", resumed: 1, rate_limited_until: null },
      });
      released.push(id);
    } catch (e) {
      // 読んでから書くまでに人が pause / cancel した。新しい状態を所有しているのは
      // 先に書いた側なので、上書きせずに見送る。
      if (!(e instanceof StateConflictError)) throw e;
    }
  }
  return released;
}

/**
 * 期限の来たマージ待ちを queued に戻す。戻したタスクのidを返す（配るのは呼び出し側）。
 * 待ち方は releaseDueRateLimited と同じで、runTask の中では sleep しない。
 */
export async function releaseDueWaiting(db: Db, now: Date = new Date()): Promise<string[]> {
  const due = await db.selectFrom("tasks").select("id")
    .where("state", "=", "waiting")
    .where("waiting_until", "<=", now.toISOString())
    .orderBy("waiting_until", "asc")
    .execute();

  const released: string[] = [];
  for (const { id } of due) {
    try {
      await commitStepBoundary(db, {
        taskId: id,
        requireState: "waiting",
        taskPatch: { state: "queued", resumed: 1, waiting_until: null },
      });
      released.push(id);
    } catch (e) {
      if (!(e instanceof StateConflictError)) throw e;
    }
  }
  return released;
}

/**
 * 期限の来た Intake の上限待ちを解く。rate_limited_until を null に戻し、最後の行と同じ
 * purpose の queued の行を resume: true で立てる。戻した Intake の id を返す。
 * 上限待ちは状態にせず、investigating / decomposing のまま rate_limited_until で表す（spec 5 章）。
 */
export async function releaseDueIntakeRateLimited(
  db: Db,
  o: { logRoot: string; now?: Date },
): Promise<string[]> {
  const due = await db.selectFrom("intakes").select(["id", "state"])
    .where("state", "in", RUNNING_INTAKE_STATES)
    .where("rate_limited_until", "<=", (o.now ?? new Date()).toISOString())
    .orderBy("rate_limited_until", "asc")
    .execute();

  const released: string[] = [];
  for (const { id, state } of due) {
    const last = await db.selectFrom("intake_runs").select("purpose")
      .where("intake_id", "=", id).orderBy("id", "desc").executeTakeFirst();
    if (last === undefined) continue;
    try {
      await db.transaction().execute(async (trx) => {
        await updateIntake(trx, id, { rate_limited_until: null }, { requireState: state });
        await enqueueIntakeRun(trx, id, last.purpose, { logRoot: o.logRoot, resume: true });
      });
      released.push(id);
    } catch (e) {
      // 読んでから書くまでに人が中止した。新しい状態を所有しているのは先に書いた側なので見送る。
      if (!(e instanceof IntakeStateConflictError)) throw e;
    }
  }
  return released;
}

/**
 * 上限待ちがいるか。上限はアカウント全体に掛かる。
 * タスクの rate_limited と、Intake の rate_limited_until の両方を見る。
 */
export async function hasActiveRateLimit(db: Db): Promise<boolean> {
  const task = await db.selectFrom("tasks").select("id")
    .where("state", "=", "rate_limited").executeTakeFirst();
  if (task !== undefined) return true;
  const intake = await db.selectFrom("intakes").select("id")
    .where("state", "in", RUNNING_INTAKE_STATES)
    .where("rate_limited_until", "is not", null)
    .executeTakeFirst();
  return intake !== undefined;
}

/**
 * 全体枠の空きの数だけ、queued の Intake の実行を id 順に返す。プロジェクト枠は見ない。
 * 分解は人を待たせているので、tick の中でタスクより先に受け付ける。
 */
export async function selectAdmissibleIntakeRuns(
  db: Db,
  globalLimit: number = DEFAULT_GLOBAL_LIMIT,
): Promise<IntakeRunRow[]> {
  const free = globalLimit - (await currentUsage(db)).global;
  if (free <= 0) return [];
  return await db.selectFrom("intake_runs")
    .innerJoin("intakes", "intakes.id", "intake_runs.intake_id")
    .selectAll("intake_runs")
    .where("intake_runs.status", "=", "queued")
    .where("intakes.state", "in", RUNNING_INTAKE_STATES)
    .orderBy("intake_runs.id", "asc")
    .limit(free)
    .execute();
}

/** queued のタスクを受付順に。再開したタスク → 優先度 → 作成時刻の FIFO。 */
async function queuedInAdmissionOrder(db: Db): Promise<TaskRow[]> {
  return await db.selectFrom("tasks").selectAll()
    .where("state", "=", "queued")
    .orderBy("resumed", "desc").orderBy("priority", "asc").orderBy("created_at", "asc").orderBy(
      "id",
      "asc",
    )
    .execute();
}

/**
 * 受付順: 再開したタスク → 優先度（小さいほど優先） → 作成時刻のFIFO。
 * 両スコープに空きがあるタスクだけを、上限いっぱいまで返す。
 */
export async function selectAdmissible(
  db: Db,
  globalLimit: number = DEFAULT_GLOBAL_LIMIT,
): Promise<TaskRow[]> {
  const usage = await currentUsage(db);
  let globalFree = globalLimit - usage.global;
  if (globalFree <= 0) return [];

  const queued = await queuedInAdmissionOrder(db);

  const admitted: TaskRow[] = [];
  const projectUsed = new Map(usage.byProject);
  for (const task of queued) {
    if (globalFree <= 0) break;
    const project = await getProject(db, task.project_id);
    if (!project) continue;
    const used = projectUsed.get(task.project_id) ?? 0;
    if (used >= project.max_concurrent) continue;
    admitted.push(task);
    projectUsed.set(task.project_id, used + 1);
    globalFree -= 1;
  }
  return admitted;
}

export type SlotsSnapshot = {
  globalLimit: number;
  inUse: number;
  waitingTasks: TaskRow[];
  waitingIntakeRuns: {
    id: number;
    intake_id: string;
    issue_title: string;
    purpose: IntakeRunPurpose;
  }[];
};

/** 全体の実行枠のいまの様子。数え方は currentUsage と受付の関数と同じにする。 */
export async function slotsSnapshot(db: Db, globalLimit: number): Promise<SlotsSnapshot> {
  const inUse = (await currentUsage(db)).global;
  const waitingTasks = await queuedInAdmissionOrder(db);
  const waitingIntakeRuns = await db.selectFrom("intake_runs")
    .innerJoin("intakes", "intakes.id", "intake_runs.intake_id")
    .select([
      "intake_runs.id",
      "intake_runs.intake_id",
      "intakes.issue_title",
      "intake_runs.purpose",
    ])
    .where("intake_runs.status", "=", "queued")
    .where("intakes.state", "in", RUNNING_INTAKE_STATES)
    .orderBy("intake_runs.id", "asc")
    .execute();
  return { globalLimit, inUse, waitingTasks, waitingIntakeRuns };
}
