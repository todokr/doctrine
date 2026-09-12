import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { AgentStep, CommandStep } from "../workflow/schema.ts";
import { expand, type TemplateContext } from "../workflow/template.ts";
import type { AgentAdapter } from "../adapter/types.ts";

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
  db: DatabaseSync;
  adapter: AgentAdapter;
  logRoot: string;
  onChildSpawned?(pid: number, startedAt: string): void;
  onRateLimit?(s: { window: string; utilization: number; resetsAt: string | null }): void;
  onLogLine?(line: string): void;
};

/** ステップのログファイルパスを決める。エンジンはステップ開始前にこれを呼んで名前を知る。 */
export function logPathFor(logRoot: string, taskId: string, stepId: string, attempt: number): string {
  return join(logRoot, taskId, `${stepId}.${attempt}.log`);
}

async function openLog(path: string) {
  await mkdir(dirname(path), { recursive: true });
  return createWriteStream(path, { flags: "a" });
}

function closeLog(log: ReturnType<typeof createWriteStream>): Promise<void> {
  return new Promise((resolve, reject) => {
    log.end((err: Error | null | undefined) => (err ? reject(err) : resolve()));
  });
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
    const child = spawn("sh", ["-c", command], { cwd: o.cwd, stdio: ["ignore", "pipe", "pipe"] });
    o.deps.onChildSpawned?.(child.pid ?? -1, startedAt);

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => { stdout += c; log.write(c); o.deps.onLogLine?.(c); });
    child.stderr.on("data", (c: string) => { stderr += c; log.write(c); o.deps.onLogLine?.(c); });

    // "close" は stdio が完全に消費された後に発火する。"exit" はプロセス終了時点で
    // すぐ発火するが、パイプにまだ読み残しがある可能性があり、それだと出力を
    // 取りこぼす。だから "close" を使う。
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });

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
    await closeLog(log);
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
    o.deps.onChildSpawned?.(run.pid, run.startedAt);

    for await (const ev of run.events) {
      log.write(JSON.stringify(ev) + "\n");
      if (ev.kind === "rateLimit") {
        o.deps.onRateLimit?.({ window: ev.window, utilization: ev.utilization, resetsAt: ev.resetsAt });
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
    await closeLog(log);
  }
}
