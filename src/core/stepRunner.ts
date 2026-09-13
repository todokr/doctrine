import { dirname, join } from "@std/path";
import type { Db } from "../db/schema.ts";
import type { AgentStep, CommandStep } from "../workflow/schema.ts";
import { expand, type TemplateContext } from "../workflow/template.ts";
import type { AgentAdapter } from "../adapter/types.ts";
import { exitCodeOf } from "../util/exec.ts";

export type StepOutcome = {
  status: "success" | "failed" | "degraded" | "suspended";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  costUsd: number | null;
  numTurns: number | null;
  durationMs: number | null;
  startedAt: string;
  endedAt: string;
  logPath: string;
};

export type RunnerDeps = {
  db: Db;
  adapter: AgentAdapter;
  logRoot: string;
  /** DBに書く呼び出し側がいるので待つ。待たないと書き込みの順序も失敗も宙に浮く。 */
  onChildSpawned?(pid: number, startedAt: string): void | Promise<void>;
  onRateLimit?(s: { window: string; utilization: number; resetsAt: string | null }): void | Promise<void>;
  /** 出力のチャンクごとに同期で呼ぶ。ここでDBを触らないこと（待てない）。 */
  onLogLine?(line: string): void;
};

/** ステップのログファイルパスを決める。エンジンはステップ開始前にこれを呼んで名前を知る。 */
export function logPathFor(logRoot: string, taskId: string, stepId: string, attempt: number): string {
  return join(logRoot, taskId, `${stepId}.${attempt}.log`);
}

type Log = { write(chunk: string): void; close(): Promise<void> };

/**
 * ログファイルを開く。ディスクが満杯・ログ用ディレクトリの権限喪失・
 * 実行中の削除などでファイルに書けなくなることがあるが、それはステップの
 * 実行結果（コマンド/エージェントの成否）とは無関係であるべき。
 * このためログの書き込み失敗は握りつぶし、以降の write を無視するだけに
 * とどめる — 例外を投げて daemon 全体（他タスクも含む）を落とすことは絶対にしない。
 */
async function openLog(path: string): Promise<Log> {
  let file: Deno.FsFile | null = null;
  let failed = false;

  try {
    await Deno.mkdir(dirname(path), { recursive: true });
    file = await Deno.open(path, { append: true, create: true });
  } catch (e) {
    failed = true;
    console.error(`ログファイルを開けませんでした（ステップの実行は継続します）: ${path}`, e);
  }

  // 書き込みは非同期なので、順序を保つために直列につなぐ。
  const encoder = new TextEncoder();
  let pending: Promise<void> = Promise.resolve();

  return {
    write(chunk: string) {
      if (failed || !file) return;
      const f = file;
      const bytes = encoder.encode(chunk);
      pending = pending
        .then(async () => {
          if (failed) return;
          let offset = 0;
          while (offset < bytes.length) offset += await f.write(bytes.subarray(offset));
        })
        .catch((e) => {
          if (!failed) {
            console.error(`ログファイルへの書き込みに失敗しました（ステップの実行は継続します）: ${path}`, e);
          }
          failed = true;
        });
    },
    async close(): Promise<void> {
      if (!file) return;
      // ここでも reject しない: close 時点でファイルが壊れていても
      // ステップの結果には影響させない。
      await pending;
      try { file.close(); } catch { /* 既に閉じている */ }
    },
  };
}

/** 子プロセスの出力を読み切る。マルチバイト文字の途中で割れたチャンクは次のチャンクまで保留する。 */
async function drain(stream: ReadableStream<Uint8Array>, onText: (text: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    const text = decoder.decode(chunk, { stream: true });
    if (text) onText(text);
  }
  const rest = decoder.decode();
  if (rest) onText(rest);
}

export async function runCommandStep(
  step: CommandStep,
  ctx: TemplateContext,
  o: { cwd: string; taskId: string; attempt: number; deps: RunnerDeps },
): Promise<StepOutcome> {
  // expand は未知の変数や壊れたプレースホルダーで TemplateError を投げる。
  // ここでは意図的に握りつぶさない — ワークフロー作者に見える形で伝播させる。
  const command = expand(step.run, ctx);
  const logPath = logPathFor(o.deps.logRoot, o.taskId, step.id, o.attempt);
  const log = await openLog(logPath);
  const startedAt = new Date().toISOString();

  try {
    let child: Deno.ChildProcess;
    try {
      child = new Deno.Command("sh", {
        args: ["-c", command], cwd: o.cwd, stdin: "null", stdout: "piped", stderr: "piped",
      }).spawn();
    } catch (e) {
      // 起動失敗（cwd が無いなど）は同期例外で来る。pid は -1 として通知してから伝播させる。
      await o.deps.onChildSpawned?.(-1, startedAt);
      throw e;
    }
    await o.deps.onChildSpawned?.(child.pid, startedAt);

    let stdout = "";
    let stderr = "";
    // 終了ステータスだけでなく stdout / stderr を読み切るまで待つ。プロセスの終了時点では
    // パイプにまだ読み残しがある可能性があり、先に確定させると出力を取りこぼす。
    const [status] = await Promise.all([
      child.status,
      drain(child.stdout, (c) => { stdout += c; log.write(c); o.deps.onLogLine?.(c); }),
      drain(child.stderr, (c) => { stderr += c; log.write(c); o.deps.onLogLine?.(c); }),
    ]);
    const exitCode = exitCodeOf(status);

    return {
      status: exitCode === 0 ? "success" : "failed",
      exitCode,
      stdout,
      stderr,
      costUsd: null,
      numTurns: null,
      durationMs: null,
      startedAt,
      endedAt: new Date().toISOString(),
      logPath,
    };
  } finally {
    await log.close();
  }
}

export async function runAgentStep(
  step: AgentStep,
  ctx: TemplateContext,
  o: {
    cwd: string; taskId: string; attempt: number;
    sessionId: string; resume: boolean; deps: RunnerDeps;
  },
): Promise<StepOutcome> {
  // expand は未知の変数や壊れたプレースホルダーで TemplateError を投げる。
  // ここでは意図的に握りつぶさない — ワークフロー作者に見える形で伝播させる。
  const prompt = expand(step.prompt, ctx);
  const logPath = logPathFor(o.deps.logRoot, o.taskId, step.id, o.attempt);
  const log = await openLog(logPath);
  const opts = {
    cwd: o.cwd, sessionId: o.sessionId,
    permissionMode: step.permissionMode, model: step.model,
  };

  try {
    const run = o.resume
      ? o.deps.adapter.resume(o.sessionId, prompt, opts)
      : o.deps.adapter.start(prompt, opts);
    await o.deps.onChildSpawned?.(run.pid, run.startedAt);

    for await (const ev of run.events) {
      log.write(JSON.stringify(ev) + "\n");
      if (ev.kind === "rateLimit") {
        await o.deps.onRateLimit?.({ window: ev.window, utilization: ev.utilization, resetsAt: ev.resetsAt });
      }
      if (ev.kind === "assistant" && ev.text) o.deps.onLogLine?.(ev.text);
    }

    const result = await run.result;

    // ワークフローは止めない。判断材料を出すところまでがステップ実行器の責務。
    // degraded（権限で止められたが is_error: false で「成功」に見える）は
    // success に丸めてはいけない — 次のタスクが step_runs.status に記録し、
    // 人間が見分けられるようにする。
    const status: StepOutcome["status"] = !result.ok ? "failed" : result.degraded ? "degraded" : "success";
    return {
      status,
      exitCode: result.exitCode,
      stdout: result.text,
      // result 行が来ずに終わった実行を診断するため、stderr の末尾を返す。
      // DEFAULT の stderrTail は "" なので、既存の成功系テストの挙動は変わらない。
      stderr: result.stderrTail,
      costUsd: result.costUsd,
      numTurns: result.numTurns,
      durationMs: result.durationMs,
      startedAt: run.startedAt,
      endedAt: new Date().toISOString(),
      logPath,
    };
  } finally {
    await log.close();
  }
}
