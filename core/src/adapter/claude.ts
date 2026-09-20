import { readNdjson } from "./ndjson.ts";
import { exitCodeOf } from "../util/exec.ts";
import type { AgentAdapter, AgentEvent, AgentResult, AgentRun, StartOptions } from "./types.ts";

/**
 * spec 6章の実測契約。1つでも欠けると実行時にしか壊れない。
 *
 * 再開時の引数順序（`-p --resume <id> <prompt> --output-format ...`、
 * プロンプトが `--resume <id>` の直後・残りのフラグの前に来る）は
 * 2026-09-12 に実バイナリ（claude v2.1.269）で検証済み: 同一セッションを
 * `--resume` で再開し、この順序で渡したプロンプトが正しく認識されて
 * 返答に反映されることを確認した（詳細はTask 8レポート参照）。
 */
export function buildArgs(prompt: string, opts: StartOptions, resumeSessionId?: string): string[] {
  const args = ["-p"];
  if (resumeSessionId) args.push("--resume", resumeSessionId);
  args.push(prompt, "--output-format", "stream-json", "--verbose");
  if (!resumeSessionId) args.push("--session-id", opts.sessionId);
  if (opts.permissionMode) args.push("--permission-mode", opts.permissionMode);
  args.push("--permission-prompts", "none");
  if (opts.model) args.push("--model", opts.model);
  // --allowedTools が可変長なので、これより後ろに置くとスキーマがツール名として食われる。
  if (opts.jsonSchema) args.push("--json-schema", JSON.stringify(opts.jsonSchema));
  // `Bash(git diff:*)` のように空白を含むパターンがあるので、カンマで連結せず
  // 1要素を1つの argv として渡す。
  if (opts.allowedTools && opts.allowedTools.length > 0) {
    args.push("--allowedTools", ...opts.allowedTools);
  }
  return args;
}

/**
 * NDJSON の1行を AgentEvent に正規化する。
 * rate_limit_event は5時間枠・7日枠それぞれについて1件ずつ生成するため配列を返す。
 */
export function normalize(line: unknown): AgentEvent[] {
  if (typeof line !== "object" || line === null) return [];
  const o = line as Record<string, unknown>;
  switch (o.type) {
    case "system":
      return [{ kind: "system", subtype: String(o.subtype ?? "") }];
    case "assistant":
      return [{ kind: "assistant", text: extractText(o) }];
    case "result":
      return [{ kind: "result" }];
    case "rate_limit_event": {
      const info = (o.rate_limit_info ?? {}) as Record<string, unknown>;
      const windows = (info.unifiedWindows ?? {}) as Record<
        string,
        { utilization?: number; resetsAt?: string }
      >;
      return Object.entries(windows).map(([window, w]) => ({
        kind: "rateLimit" as const,
        window,
        utilization: Number(w.utilization ?? 0),
        resetsAt: w.resetsAt ?? null,
      }));
    }
    default:
      return [];
  }
}

function extractText(o: Record<string, unknown>): string {
  const msg = o.message as { content?: { type: string; text?: string }[] } | undefined;
  if (!msg?.content) return "";
  return msg.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
}

/**
 * result 行が権威。終了コードは補助。
 * --permission-prompts none の下では、権限で弾かれた実行も is_error: false で帰ってくる。
 */
export function resultFrom(
  resultLine: unknown,
  exitCode: number | null,
  stderrTail = "",
): AgentResult {
  if (typeof resultLine !== "object" || resultLine === null) {
    return {
      ok: false,
      degraded: false,
      text: "",
      costUsd: null,
      numTurns: null,
      durationMs: null,
      permissionDenials: [],
      exitCode,
      stderrTail,
      structuredOutput: null,
    };
  }
  const o = resultLine as Record<string, unknown>;
  const denials = Array.isArray(o.permission_denials) ? o.permission_denials : [];
  return {
    ok: o.is_error !== true,
    degraded: denials.length > 0,
    text: typeof o.result === "string" ? o.result : "",
    costUsd: typeof o.total_cost_usd === "number" ? o.total_cost_usd : null,
    numTurns: typeof o.num_turns === "number" ? o.num_turns : null,
    durationMs: typeof o.duration_ms === "number" ? o.duration_ms : null,
    permissionDenials: denials,
    exitCode,
    stderrTail,
    structuredOutput: null,
  };
}

export function createClaudeAdapter(bin = "claude"): AgentAdapter {
  function launch(args: string[], opts: StartOptions, runSessionId: string): AgentRun {
    const startedAt = new Date().toISOString();
    let child: Deno.ChildProcess;
    try {
      child = new Deno.Command(bin, {
        args,
        cwd: opts.cwd,
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
    } catch (e) {
      // 起動失敗（バイナリや cwd が無い）は同期例外で来る。呼び出し側は
      // 「pid -1 で通知され、result が reject される」形で扱うので、それに揃える。
      const result = Promise.reject(e);
      result.catch(() => {}); // 呼び出し側が await するまでの間に未処理扱いされないように
      return {
        sessionId: runSessionId,
        pid: -1,
        startedAt,
        events: (async function* () {})(),
        result,
        kill: () => {},
      };
    }
    // stderr を消費しないとパイプが埋まって子プロセスがブロックし、
    // headless でハングしないという契約が壊れる。診断用に末尾だけ残す。
    let stderrTail = "";
    const stderrDone = (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of child.stderr) {
        stderrTail = (stderrTail + decoder.decode(chunk, { stream: true })).slice(-4096);
      }
    })();

    let resultLine: unknown;
    const queue: AgentEvent[] = [];
    const waiter: { notify: (() => void) | null } = { notify: null };
    let done = false;

    const pump = (async () => {
      for await (const line of readNdjson(child.stdout)) {
        if ((line as { type?: string }).type === "result") resultLine = line;
        for (const ev of normalize(line)) queue.push(ev);
        waiter.notify?.();
      }
      done = true;
      waiter.notify?.();
    })();

    const events: AsyncIterable<AgentEvent> = {
      async *[Symbol.asyncIterator]() {
        while (true) {
          while (queue.length > 0) yield queue.shift()!;
          if (done) return;
          await new Promise<void>((r) => {
            waiter.notify = r;
          });
          waiter.notify = null;
        }
      },
    };

    // 終了ステータスだけでなく stdout / stderr を読み切るまで待つ。
    // 先に確定させると、パイプに残った result 行や stderr の末尾を取りこぼす。
    const result: Promise<AgentResult> = Promise.all([child.status, pump, stderrDone])
      .then(([status]) => resultFrom(resultLine, exitCodeOf(status), stderrTail));

    return {
      sessionId: runSessionId,
      pid: child.pid,
      startedAt,
      events,
      result,
      kill: () => {
        try {
          child.kill("SIGTERM");
        } catch { /* 既に終了している */ }
      },
    };
  }

  return {
    start: (prompt, opts) => launch(buildArgs(prompt, opts), opts, opts.sessionId),
    resume: (sessionId, prompt, opts) =>
      launch(buildArgs(prompt, opts, sessionId), opts, sessionId),
  };
}
