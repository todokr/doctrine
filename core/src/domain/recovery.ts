import { commitStepBoundary, type StepBoundary } from "../db/boundary.ts";
import { listTasks, type TaskRow } from "../db/tasks.ts";
import { listStepRuns } from "../db/stepRuns.ts";
import type { Db } from "../db/schema.ts";
import { assertTransition } from "./states.ts";
import type { Workflow } from "../workflow/schema.ts";
import { runCommand } from "../util/exec.ts";

/** 子プロセスに送るシグナル。復帰は SIGKILL、pause / cancel は SIGTERM だけを使う。 */
export type Signal = "SIGTERM" | "SIGKILL";

export type ProcessProbe = {
  startTimeOf(pid: number): Promise<string | null>;
  kill(pid: number, signal: Signal): void;
};

/**
 * タスクの current_step_id から、そのタスクが従うワークフロー定義を引く関数。
 * 復帰時にステップ種別（agent / command）を正しく判別するために使う。
 * ワークフローが引けない場合は undefined を返してよい（呼び出し側は安全側に倒す）。
 */
export type WorkflowLookup = (
  task: TaskRow,
) => Promise<Workflow | undefined> | Workflow | undefined;

/**
 * ps の lstart は秒精度なので、既定の許容は2秒。
 * これは受け入れ側（accept-side）のリスクを内包する: この許容時間内に同じpidが
 * 再利用されていれば、無関係の別プロセスを「同一の子」と誤認して殺してしまい得る。
 * 秒精度と正面から向き合う以上ここは避けられず、逆に許容を狭めると本物の一致まで
 * 弾いてしまう（gone/mismatch側に倒れ、生きた子を見逃す）ので、狭めない。
 */
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

/**
 * `ps -o lstart=` を実行するためのコマンドを組み立てる。
 * lstart の書式はロケール依存、`new Date(...)` によるパースはローカルタイムゾーン
 * 依存。child_started_at は `new Date().toISOString()`（UTC）で記録しているため、
 * ps 実行環境のロケール・タイムゾーンが記録時と食い違うと、パース結果がズレて
 * 誤ったマッチ／不一致を「静かに」生む（例外にならない）のが一番危険。
 * LC_ALL=C と TZ=UTC を強制し、書式とタイムゾーンを固定する。
 * ここで固定できるのは ps の「出力側」だけで、出力にタイムゾーン表記は付かない。
 * 「パース側」で UTC を明示するのは defaultProbe の責務。
 */
export function psLstartCommand(
  pid: number,
): { cmd: string; args: string[]; env: Record<string, string> } {
  return {
    cmd: "ps",
    args: ["-o", "lstart=", "-p", String(pid)],
    env: { ...Deno.env.toObject(), LC_ALL: "C", TZ: "UTC" },
  };
}

export function defaultProbe(): ProcessProbe {
  return {
    async startTimeOf(pid) {
      try {
        const { cmd, args, env } = psLstartCommand(pid);
        const { stdout } = await runCommand(cmd, args, { env });
        const t = stdout.trim();
        if (!t) return null;
        // ps は TZ=UTC で実行しているが、出力（例: "Fri Sep 18 11:58:53 2026"）には
        // タイムゾーン表記が無い。そのまま new Date に渡すとデーモンのローカル
        // タイムゾーンで解釈され、UTC 以外では時差ぶんずれて isSameChild が本物の子にも
        // false を返す（＝ kill が届かない）。パース側でも UTC を明示する。
        const parsed = new Date(`${t} UTC`);
        // パース結果が不正なら「同一ではない」側（gone）に倒れる。既存の安全側の挙動。
        return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
      } catch {
        return null; // プロセスが存在しない
      }
    },
    kill(pid, signal) {
      try {
        Deno.kill(pid, signal);
      } catch { /* 既に消えている */ }
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
  task: Pick<TaskRow, "child_pid" | "child_started_at">,
  probe: ProcessProbe,
  signal: Signal = "SIGKILL",
): Promise<"killed" | "gone" | "mismatch" | "none"> {
  // child_pid <= 0 は spawn 失敗時の記録（onChildSpawned(child.pid ?? -1, ...)）。
  // kill(2) に -1 を渡すと送れる全プロセスへのシグナルになり得るので、
  // ここで弾いて絶対に probe.kill へ渡さない。
  if (task.child_pid === null || task.child_pid <= 0 || task.child_started_at === null) {
    return "none";
  }
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
 * claude_session_id の有無だけでは判別できない: engine.ts が書くのは agent
 * ステップの開始時だけだが、この値はタスク全体で1つであり、一度立つと消えない。
 * そのため一度でも agent ステップを通過したタスクは、以降の command ステップの
 * 最中に落ちても claude_session_id が非nullのままであり、
 * 「非nullなら agent」という判定はここで誤る。
 *
 * 正しい判別材料は current_step_id が指すステップの実際の型であり、
 * それはワークフロー定義からしか分からない。よってワークフロー定義を引ける
 * ときはそれを使う。引けない（YAML が消えた・壊れた、ステップが見つからない）
 * ときは、安全側（= 冪等であることが要件の command として再実行）に倒す。
 * agent を command として再実行しても新しい会話が始まるだけで worktree を
 * 壊さないが、逆に command を resume-agent 扱いする実害の方が大きい。
 */
async function classifyInterruptedStep(
  task: TaskRow,
  lookupWorkflow: WorkflowLookup,
): Promise<"resume-agent" | "rerun-command"> {
  if (task.current_step_id !== null) {
    const workflow = await lookupWorkflow(task);
    const step = workflow?.steps.find((s) => s.id === task.current_step_id);
    if (step) {
      return step.type === "agent" || step.type === "guide" ? "resume-agent" : "rerun-command";
    }
  }
  // ワークフロー定義が引けない（YAMLが消えた・壊れた等）、
  // またはステップが見つからない場合は判別材料が無いため、安全側に倒す。
  return "rerun-command";
}

/**
 * 1件の復帰結果。recovered なら次のアクション、failed ならそのタスクを
 * 復帰できなかった理由（呼び出し側が起動ログに出せるように文字列で持つ）。
 * 判別ユニオンにしているのは、失敗を握りつぶさず、かつ成功と同じ配列で
 * 返せて呼び出し側が扱いやすいため。
 */
export type RecoveryResult =
  | { taskId: string; outcome: "recovered"; action: "resume-agent" | "rerun-command" }
  | { taskId: string; outcome: "failed"; error: string };

/**
 * 中断された時点で running のまま残っている step_runs 行を閉じる
 * （taskId につき「最後の running 行」を1つだけ、あれば）。
 *
 * 承認待ちの行は status が awaiting であり running ではないので、ここには
 * 掛からない。人を待っている最中のレビューを、デーモンの再起動だけで閉じては
 * ならない（待ち始めた時刻が失われる）。
 *
 * running の行が無ければ何もしない（呼び出し側はこれをエラー扱いしない）。
 */
async function closeDanglingStepRun(
  db: Db,
  taskId: string,
): Promise<Pick<StepBoundary, "stepRunUpdate">> {
  const runs = await listStepRuns(db, taskId);
  const dangling = [...runs].reverse().find((r) => r.status === "running");
  if (!dangling) return {};
  return {
    stepRunUpdate: {
      id: dangling.id,
      status: "interrupted",
      exit_code: null,
      ended_at: new Date().toISOString(),
    },
  };
}

/**
 * デーモンが死ねば子プロセスの stdout は誰も読んでいない。
 * よって起動時に running のタスクはすべて古い。
 *
 * lookupWorkflow は必須。省略できる形にすると、agent/command の判別材料を
 * 持たないまま呼び出せてしまい、全タスクが黙って rerun-command 扱いになる
 * （コンパイルも通り、テストでしか気づけない）。呼び出し側にワークフローの
 * 配線を強制するため、あえて省略不可にしている。
 *
 * このループは1タスクずつ独立させ、例外を外に漏らさない。ここは「デーモンが
 * 一度壊れた後の後始末」という最も守りに入るべき経路であり、1タスク分の
 * probe / lookupWorkflow の失敗（壊れたワークフローYAMLなど）で残り全部の
 * stale タスクが救済されないまま放置される方がずっと悪い。
 *
 * 復帰に失敗したタスクは running のまま残さない。running は global slot と
 * project slot の両方をライブに（カウンタを持たず毎回数え直して）専有する
 * 唯一の状態であり、再起動しても直らない失敗（壊れたワークフローYAMLなど）
 * を running のまま残すと、そのタスクは枠を握ったまま・プロジェクトの
 * max_concurrent（既定/フィクスチャは1）を永久に塞ぎ、しかも起動時ログの
 * 1行以外どこにも見えなくなる。failed は終端状態で両スロットを専有せず、
 * 一覧からも見える（=本当に気づける）ので、failed に倒す。
 * failed への書き込み自体が失敗しても掃討は続ける（二重に守る）。
 */
export async function recoverOnStartup(
  db: Db,
  probe: ProcessProbe,
  lookupWorkflow: WorkflowLookup,
): Promise<RecoveryResult[]> {
  const results: RecoveryResult[] = [];

  for (const task of await listTasks(db, { state: "running" })) {
    try {
      await killStaleChild(task, probe, "SIGKILL");

      const action = await classifyInterruptedStep(task, lookupWorkflow);

      // running -> queued は states.ts が明示的に許可している復帰専用の辺。
      // 遷移表を経由せず書き込むと、遷移が壊れた将来の変更を検査なしで通してしまう。
      assertTransition(task.state, "queued");
      // デーモンは復帰より先にソケットを開いているので、ここまでの await の間に
      // task.cancel などが届き得る。読んだ running のままであるときだけ書く。
      await commitStepBoundary(db, {
        taskId: task.id,
        requireState: task.state,
        taskPatch: { state: "queued", resumed: 1, child_pid: null, child_started_at: null },
        ...await closeDanglingStepRun(db, task.id),
      });
      results.push({ taskId: task.id, outcome: "recovered", action });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      try {
        assertTransition(task.state, "failed");
        await commitStepBoundary(db, {
          taskId: task.id,
          requireState: task.state,
          taskPatch: { state: "failed" },
          ...await closeDanglingStepRun(db, task.id),
        });
      } catch (e2) {
        // failed への書き込み自体が失敗しても、他タスクの掃討を止めない。
        console.error(
          `タスク ${task.id} を failed にできませんでした（復帰処理は継続します）:`,
          e2,
        );
      }
      results.push({ taskId: task.id, outcome: "failed", error });
    }
  }
  return results;
}
