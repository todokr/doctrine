import { commitStepBoundary, type StepBoundary } from "../db/boundary.ts";
import type { Db } from "../db/schema.ts";
import { getAwaitingStepRun } from "../db/stepRuns.ts";
import type { TaskRow, TaskState } from "../db/tasks.ts";
import { killStaleChild, type ProcessProbe } from "./recovery.ts";
import { assertTransition } from "./states.ts";

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
export async function closeAwaitingStepRun(
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

/**
 * タスクを canceled にする。task.cancel と Intake の中止（stop）が使う。
 * 終端からは InvalidTransitionError、読んだ後に状態が変わっていれば StateConflictError を投げる。
 * イベントは配らない（呼び出し側が配る）。
 */
export async function cancelTask(
  db: Db,
  task: TaskRow,
  probe: ProcessProbe,
): Promise<{ from: TaskState }> {
  // 終端状態（completed/failed/canceled）から二度 cancel されて記録を
  // 上書きしないよう、書き込み前に遷移表で検査する。
  assertTransition(task.state, "canceled");
  // デーモンが生きたまま協調的に止める経路。pause と同じく SIGTERM。
  await killStaleChild(task, probe, "SIGTERM");
  // worktree は残す。失敗・中止した実行こそ中を見たい。
  // suspended からの cancel なら、開いていた awaiting 行も同じトランザクションで
  // 閉じる（放置すると、中止されたタスクの記録が永久に「レビュー待ち」と言い続ける）。
  await commitStepBoundary(db, {
    taskId: task.id,
    requireState: task.state,
    taskPatch: { state: "canceled", child_pid: null, child_started_at: null },
    stepRunUpdate: await closeAwaitingStepRun(db, task),
  });
  return { from: task.state };
}
