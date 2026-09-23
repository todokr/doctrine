import { dirname, join } from "@std/path";
import type { Db } from "../db/schema.ts";
import type { AgentStep, CommandStep, GuideStep } from "../workflow/schema.ts";
import { expand, type TemplateContext } from "../workflow/template.ts";
import type {
  AgentAdapter,
  AgentResult,
  AgentRun,
  RateLimitObservation,
  StartOptions,
} from "../adapter/types.ts";
import { renderEvent } from "../adapter/render.ts";
import { exitCodeOf } from "../util/exec.ts";
import type { PermissionDenial } from "../../../shared/protocol.ts";
import type { Guide } from "../../../shared/guide/schema.ts";
import type { GuideHunk } from "../../../shared/guide/hunkId.ts";
import { guideJsonSchema } from "../../../shared/guide/jsonSchema.ts";
import { validateGuide } from "../../../shared/guide/validate.ts";
import { BUILTIN_APPEND_SYSTEM_PROMPT } from "./systemPrompt.ts";
import type { DiffFile } from "./diff.ts";
import { checkGuideLocations, writeGuideFile } from "./guideFile.ts";
import { collectGuideInputs } from "./guideInputs.ts";
import { buildGuidePrompt } from "./guidePrompt.ts";
import type { CommandResult } from "./taskContext.ts";

export type StepOutcome = {
  status: "success" | "failed" | "suspended";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  costUsd: number | null;
  numTurns: number | null;
  durationMs: number | null;
  startedAt: string;
  endedAt: string;
  logPath: string;
  /**
   * この実行中に受け取った rate_limit_event（window ごとの最新）。
   * command ステップはアダプタを通らないので常に空。
   */
  rateLimits: RateLimitObservation[];
  /** この実行で権限に拒否された操作。command ステップはアダプタを通らないので常に空。 */
  permissionDenials: PermissionDenial[];
};

export type RunnerDeps = {
  db: Db;
  adapter: AgentAdapter;
  logRoot: string;
  /** DBに書く呼び出し側がいるので待つ。待たないと書き込みの順序も失敗も宙に浮く。 */
  onChildSpawned?(pid: number, startedAt: string): void | Promise<void>;
  onRateLimit?(s: RateLimitObservation): void | Promise<void>;
  /** 出力のチャンクごとに同期で呼ぶ。ここでDBを触らないこと（待てない）。 */
  onLogLine?(line: string): void;
};

/** ステップのログファイルパスを決める。エンジンはステップ開始前にこれを呼んで名前を知る。 */
export function logPathFor(
  logRoot: string,
  taskId: string,
  stepId: string,
  attempt: number,
): string {
  return join(logRoot, taskId, `${stepId}.${attempt}.log`);
}

export type Log = { write(chunk: string): void; close(): Promise<void> };

/**
 * 行頭の時刻。イベント自身も timestamp を持つが、ログに要るのは
 * 「ここで手が止まっていた」が分かる粒度で、書いた時刻で足りる。
 * 日付まで入れるのは、日をまたいで止まっていた実行を後から読むため。
 */
export function stamp(at = new Date()): string {
  const p2 = (n: number) => String(n).padStart(2, "0");
  const date = `${at.getFullYear()}-${p2(at.getMonth() + 1)}-${p2(at.getDate())}`;
  return `${date} ${p2(at.getHours())}:${p2(at.getMinutes())}:${p2(at.getSeconds())}`;
}

/** 1行をログファイルと log.line の両方へ。時刻はここでだけ付ける。 */
export function emitLine(log: Log, deps: RunnerDeps, line: string): void {
  const stamped = `${stamp()} ${line}`;
  // log.line はアプリ側で1要素=1行として貯めるので改行を付けない。
  log.write(stamped + "\n");
  deps.onLogLine?.(stamped);
}

/**
 * チャンクを行に切り直す。プロセスの出力はどこで切れて届くか決まっていないので、
 * 改行が来るまで貯める。最後に残った改行なしの端数は flush で出す。
 */
function lineBuffer(emit: (line: string) => void): { push(c: string): void; flush(): void } {
  let rest = "";
  return {
    push(chunk) {
      const parts = (rest + chunk).split("\n");
      rest = parts.pop() ?? "";
      for (const line of parts) emit(line);
    },
    flush() {
      if (rest === "") return;
      emit(rest);
      rest = "";
    },
  };
}

/**
 * ログファイルを開く。ディスクが満杯・ログ用ディレクトリの権限喪失・
 * 実行中の削除などでファイルに書けなくなることがあるが、それはステップの
 * 実行結果（コマンド/エージェントの成否）とは無関係であるべき。
 * このためログの書き込み失敗は握りつぶし、以降の write を無視するだけに
 * とどめる — 例外を投げて daemon 全体（他タスクも含む）を落とすことは絶対にしない。
 */
export async function openLog(path: string): Promise<Log> {
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
            console.error(
              `ログファイルへの書き込みに失敗しました（ステップの実行は継続します）: ${path}`,
              e,
            );
          }
          failed = true;
        });
    },
    async close(): Promise<void> {
      if (!file) return;
      // ここでも reject しない: close 時点でファイルが壊れていても
      // ステップの結果には影響させない。
      await pending;
      try {
        file.close();
      } catch { /* 既に閉じている */ }
    },
  };
}

/** 子プロセスの出力を読み切る。マルチバイト文字の途中で割れたチャンクは次のチャンクまで保留する。 */
async function drain(
  stream: ReadableStream<Uint8Array>,
  onText: (text: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    const text = decoder.decode(chunk, { stream: true });
    if (text) onText(text);
  }
  const rest = decoder.decode();
  if (rest) onText(rest);
}

export async function runCommandStep(
  step: Pick<CommandStep, "id" | "run">,
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
        args: ["-c", command],
        cwd: o.cwd,
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
    } catch (e) {
      // 起動失敗（cwd が無いなど）は同期例外で来る。pid は -1 として通知してから伝播させる。
      await o.deps.onChildSpawned?.(-1, startedAt);
      throw e;
    }
    await o.deps.onChildSpawned?.(child.pid, startedAt);

    let stdout = "";
    let stderr = "";
    // 時刻は行頭に付くので、チャンクのまま書くと途中に時刻が割り込む。
    const outLines = lineBuffer((l) => emitLine(log, o.deps, l));
    const errLines = lineBuffer((l) => emitLine(log, o.deps, l));
    // 終了ステータスだけでなく stdout / stderr を読み切るまで待つ。プロセスの終了時点では
    // パイプにまだ読み残しがある可能性があり、先に確定させると出力を取りこぼす。
    const [status] = await Promise.all([
      child.status,
      drain(child.stdout, (c) => {
        stdout += c;
        outLines.push(c);
      }),
      drain(child.stderr, (c) => {
        stderr += c;
        errLines.push(c);
      }),
    ]);
    outLines.flush();
    errLines.flush();
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
      rateLimits: [],
      permissionDenials: [],
    };
  } finally {
    await log.close();
  }
}

export async function runAgentStep(
  step: AgentStep,
  ctx: TemplateContext,
  o: {
    cwd: string;
    taskId: string;
    attempt: number;
    sessionId: string;
    resume: boolean;
    /** goto で戻ってきたときの feed。engine が goto の時点で展開済みなので、ここでは展開しない。 */
    feed?: string | null;
    deps: RunnerDeps;
  },
): Promise<StepOutcome> {
  // expand は未知の変数や壊れたプレースホルダーで TemplateError を投げる。
  // ここでは意図的に握りつぶさない — ワークフロー作者に見える形で伝播させる。
  // feed には前のステップの出力（plan-review.md など）が入っており、中の {{ }} は変数ではない。
  const prompt = o.feed ?? expand(step.prompt, ctx);
  const logPath = logPathFor(o.deps.logRoot, o.taskId, step.id, o.attempt);
  const log = await openLog(logPath);
  const opts = {
    cwd: o.cwd,
    sessionId: o.sessionId,
    permissionMode: step.permissionMode,
    model: step.model,
    allowedTools: step.allowedTools,
    appendSystemPrompt: BUILTIN_APPEND_SYSTEM_PROMPT,
  };

  try {
    const { run, result, rateLimits } = await driveAgent(o, prompt, opts, log);

    // 権限で拒否された操作があっても成功は成功。拒否の中身は permissionDenials
    // として step_runs に残るので、status には出さない。
    const status: StepOutcome["status"] = result.ok ? "success" : "failed";
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
      rateLimits,
      permissionDenials: result.permissionDenials,
    };
  } finally {
    await log.close();
  }
}

/**
 * アダプタを呼び、イベントをログへ流し、結果が出るまで待つ。agent と guide で共通。
 * 子プロセスの通知と rate_limit_event の収集もここで行う。
 */
export async function driveAgent(
  o: {
    sessionId: string;
    resume: boolean;
    deps: RunnerDeps;
  },
  prompt: string,
  opts: StartOptions,
  log: Log,
): Promise<{ run: AgentRun; result: AgentResult; rateLimits: RateLimitObservation[] }> {
  const run = o.resume
    ? o.deps.adapter.resume(o.sessionId, prompt, opts)
    : o.deps.adapter.start(prompt, opts);
  await o.deps.onChildSpawned?.(run.pid, run.startedAt);

  // window ごとの最新だけを持つ。同じ枠の古い値を混ぜると、明けた後の
  // 実行で飽和していた時点の値が判定に残る。
  const rateLimits = new Map<string, RateLimitObservation>();

  for await (const ev of run.events) {
    // ファイルと onLogLine には同じ文字列を流す。アプリは保存されたログと
    // 流れてくる log.line を1つの画面につなげて出すので、形式が割れると読めない。
    const line = renderEvent(ev);
    if (line !== null) emitLine(log, o.deps, line);
    if (ev.kind === "rateLimit") {
      const observation = {
        window: ev.window,
        utilization: ev.utilization,
        resetsAt: ev.resetsAt,
      };
      rateLimits.set(ev.window, observation);
      await o.deps.onRateLimit?.(observation);
    }
  }

  return { run, result: await run.result, rateLimits: [...rateLimits.values()] };
}

/**
 * ガイド作成ステップを実行する。プロンプトは doctrine が組み立てる。
 *
 * 順序: 入力を集める（hunk 一覧の書き出しと tree の確定）→ プロンプト → アダプタ →
 * 構造化出力の検証 → 通ったときだけ guide.json を書く。封筒の tree は最初に取った値で、
 * 検証後に取り直さない（hunk 一覧を作ったツリーとずれるため）。
 * 検証に落ちたときは status を failed にして理由を stderr に入れる。feed で戻すのは
 * engine の onFailure の仕事で、ここに別のループは持たない。
 */
export async function runGuideStep(
  step: GuideStep,
  ctx: TemplateContext,
  o: {
    cwd: string;
    taskId: string;
    attempt: number;
    sessionId: string;
    resume: boolean;
    baseBranch: string;
    /** buildGuidePrompt に渡す、DB にしか無い入力。 */
    lastCommand: CommandResult | null;
    rejections: string[];
    /** onFailure の feed で戻ってきた文字列。無ければ null。 */
    feed: string | null;
    deps: RunnerDeps;
  },
): Promise<StepOutcome> {
  const inputs = await collectGuideInputs({ worktreePath: o.cwd, baseBranch: o.baseBranch });
  let prompt = buildGuidePrompt({
    ctx,
    mergeBase: inputs.mergeBase,
    tree: inputs.tree,
    lastCommand: o.lastCommand,
    rejections: o.rejections,
  });
  if (o.feed !== null) {
    prompt += `\n## 前回の出力が受け付けられなかった理由\n\n${o.feed}\n`;
  }

  const logPath = logPathFor(o.deps.logRoot, o.taskId, step.id, o.attempt);
  const log = await openLog(logPath);
  const opts = {
    cwd: o.cwd,
    sessionId: o.sessionId,
    permissionMode: step.permissionMode,
    model: step.model,
    allowedTools: step.allowedTools,
    appendSystemPrompt: BUILTIN_APPEND_SYSTEM_PROMPT,
    jsonSchema: guideJsonSchema(),
  };

  try {
    const { run, result, rateLimits } = await driveAgent(o, prompt, opts, log);

    let status: StepOutcome["status"] = result.ok ? "success" : "failed";
    let stderr = result.stderrTail;

    if (result.ok) {
      const checked = checkOutput(result.structuredOutput, inputs);
      if ("guide" in checked) {
        // 書くのは検証を全部通ったときだけ。
        await writeGuideFile(o.cwd, {
          tree: inputs.tree,
          createdAt: new Date().toISOString(),
          guide: checked.guide,
        });
      } else {
        // exitCode は CLI 自体のものをそのまま写す。
        status = "failed";
        stderr = checked.issues.join("\n");
      }
    }

    return {
      status,
      exitCode: result.exitCode,
      stdout: result.text,
      stderr,
      costUsd: result.costUsd,
      numTurns: result.numTurns,
      durationMs: result.durationMs,
      startedAt: run.startedAt,
      endedAt: new Date().toISOString(),
      logPath,
      rateLimits,
      permissionDenials: result.permissionDenials,
    };
  } finally {
    await log.close();
  }
}

/** 構造化出力を、形・id・参照先・指す hunk とパスの順に確かめる。 */
function checkOutput(
  output: Record<string, unknown> | null,
  inputs: { hunks: GuideHunk[]; files: DiffFile[] },
): { guide: Guide } | { issues: string[] } {
  if (output === null) {
    return {
      issues: [
        "構造化出力が返りませんでした。最終応答に、スキーマに沿ったガイドの JSON を返してください。",
      ],
    };
  }
  const validation = validateGuide(output);
  if (!validation.ok) return { issues: validation.issues };
  const issues = checkGuideLocations(validation.guide, inputs);
  return issues.length > 0 ? { issues } : { guide: validation.guide };
}
