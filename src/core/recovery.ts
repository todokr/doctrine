import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import { commitStepBoundary } from "../db/boundary.ts";
import { listTasks, type TaskRow } from "../db/tasks.ts";
import { assertTransition } from "./states.ts";
import type { Workflow } from "../workflow/schema.ts";

const run = promisify(execFile);

export type ProcessProbe = {
  startTimeOf(pid: number): Promise<string | null>;
  kill(pid: number, signal: NodeJS.Signals): void;
};

/**
 * タスクの current_step_id から、そのタスクが従うワークフロー定義を引く関数。
 * 復帰時にステップ種別（agent / command）を正しく判別するために使う。
 * ワークフローが引けない場合は undefined を返してよい（呼び出し側は安全側に倒す）。
 */
export type WorkflowLookup = (task: TaskRow) => Workflow | undefined;

/** ps の lstart は秒精度なので、既定の許容は2秒。 */
export function isSameChild(
  recorded: { pid: number; startedAt: string },
  actualStartTime: string | null,
  toleranceMs = 2000,
): boolean {
  if (actualStartTime === null) return false;
  const a = Date.parse(recorded.startedAt);
  const b = Date.parse(actualStartTime);
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  return Math.abs(a - b) <= toleranceMs;
}

export function defaultProbe(): ProcessProbe {
  return {
    async startTimeOf(pid) {
      try {
        const { stdout } = await run("ps", ["-o", "lstart=", "-p", String(pid)]);
        const t = stdout.trim();
        if (!t) return null;
        const parsed = new Date(t);
        return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
      } catch {
        return null; // プロセスが存在しない
      }
    },
    kill(pid, signal) {
      try { process.kill(pid, signal); } catch { /* 既に消えている */ }
    },
  };
}

/**
 * デーモンが SIGKILL された場合、子の claude / コマンドは生き残ったまま同じ worktree に
 * 書き続けていることがある。--resume や再実行の前に必ず殺す。
 *
 * signal は既定 SIGKILL。デーモンが自分で子を止める task.pause / cancel の経路は
 * SIGTERM（デーモンが生きたまま協調的に止める）を渡す。復帰はデーモンが一度
 * ストリームを見失った後の後始末であり、SIGTERM を無視する子がいれば worktree を
 * 壊し続けてしまうので SIGKILL のままにする。
 */
export async function killStaleChild(
  task: TaskRow, probe: ProcessProbe, signal: NodeJS.Signals = "SIGKILL",
): Promise<"killed" | "gone" | "mismatch" | "none"> {
  // child_pid <= 0 は spawn 失敗時の記録（onChildSpawned(child.pid ?? -1, ...)）。
  // process.kill(-1, ...) はプロセスグループ全体へのシグナルになり得るので、
  // ここで弾いて絶対に probe.kill へ渡さない。
  if (task.child_pid === null || task.child_pid <= 0 || task.child_started_at === null) return "none";
  const actual = await probe.startTimeOf(task.child_pid);
  if (actual === null) return "gone";
  if (!isSameChild({ pid: task.child_pid, startedAt: task.child_started_at }, actual)) {
    return "mismatch"; // pidが再利用されている。無関係のプロセスを殺さない
  }
  probe.kill(task.child_pid, signal);
  return "killed";
}

/**
 * 中断されたステップが agent か command かを判別する。
 *
 * claude_session_id の有無だけでは判別できない: engine.ts はステップを開始する
 * コミットで、ステップの種別を問わず（command でも）claude_session_id を
 * セットする（`task.claude_session_id ?? randomUUID()` を毎ステップ開始時に
 * 書き戻す）。そのため一度でも agent ステップを通過したタスクは、以降の
 * command ステップの最中に落ちても claude_session_id が非nullのままであり、
 * 「非nullなら agent」という判定はここで誤る。
 *
 * 正しい判別材料は current_step_id が指すステップの実際の型であり、
 * それはワークフロー定義からしか分からない。よってワークフロー定義を引ける
 * ときはそれを使う。引けない（YAML が消えた・壊れた、ステップが見つからない）
 * ときは、安全側（= 冪等であることが要件の command として再実行）に倒す。
 * agent を command として再実行しても新しい会話が始まるだけで worktree を
 * 壊さないが、逆に command を resume-agent 扱いする実害の方が大きい。
 */
function classifyInterruptedStep(
  task: TaskRow, lookupWorkflow: WorkflowLookup,
): "resume-agent" | "rerun-command" {
  if (task.current_step_id !== null) {
    const workflow = lookupWorkflow(task);
    const step = workflow?.steps.find((s) => s.id === task.current_step_id);
    if (step) return step.type === "agent" ? "resume-agent" : "rerun-command";
  }
  // ワークフロー定義が引けない（YAMLが消えた・壊れた等）、
  // またはステップが見つからない場合は判別材料が無いため、安全側に倒す。
  return "rerun-command";
}

/**
 * デーモンが死ねば子プロセスの stdout は誰も読んでいない。
 * よって起動時に running のタスクはすべて古い。
 *
 * lookupWorkflow は必須。省略できる形にすると、agent/command の判別材料を
 * 持たないまま呼び出せてしまい、全タスクが黙って rerun-command 扱いになる
 * （コンパイルも通り、テストでしか気づけない）。呼び出し側にワークフローの
 * 配線を強制するため、あえて省略不可にしている。
 */
export async function recoverOnStartup(
  db: DatabaseSync, probe: ProcessProbe, lookupWorkflow: WorkflowLookup,
): Promise<{ taskId: string; action: "resume-agent" | "rerun-command" }[]> {
  const actions: { taskId: string; action: "resume-agent" | "rerun-command" }[] = [];

  for (const task of listTasks(db, { state: "running" })) {
    await killStaleChild(task, probe, "SIGKILL");

    const action = classifyInterruptedStep(task, lookupWorkflow);

    // running -> queued は states.ts が明示的に許可している復帰専用の辺。
    // 遷移表を経由せず書き込むと、遷移が壊れた将来の変更を検査なしで通してしまう。
    assertTransition(task.state, "queued");
    commitStepBoundary(db, {
      taskId: task.id,
      taskPatch: { state: "queued", resumed: 1, child_pid: null, child_started_at: null },
    });
    actions.push({ taskId: task.id, action });
  }
  return actions;
}
