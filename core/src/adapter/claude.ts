import { readNdjson } from "./ndjson.ts";
import { exitCodeOf } from "../util/exec.ts";
import type { PermissionDenial } from "../../../shared/protocol.ts";
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
  // --allowedTools が可変長なので、これより後ろに置くとスキーマやシステムプロンプトが
  // ツール名として食われる。
  if (opts.appendSystemPrompt) args.push("--append-system-prompt", opts.appendSystemPrompt);
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
      return assistantEvents(o);
    case "user":
      return toolResults(o);
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

type ContentBlock = {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  is_error?: unknown;
};

function blocksOf(o: Record<string, unknown>): ContentBlock[] {
  const content = (o.message as { content?: unknown } | undefined)?.content;
  return Array.isArray(content) ? content as ContentBlock[] : [];
}

/**
 * assistant 行はテキストと tool_use を1つの message に混ぜて運ぶ。
 * 出た順に並べる — ログでは「こう言ってからこれを呼んだ」の順序が手がかりになる。
 * thinking ブロックも来るが、本文は空で signature だけが入っている
 * （2026-09-20 に claude v2 の plan モードで実測）。読む材料にならないので拾わない。
 */
function assistantEvents(o: Record<string, unknown>): AgentEvent[] {
  const out: AgentEvent[] = [];
  for (const b of blocksOf(o)) {
    if (b.type === "text") out.push({ kind: "assistant", text: b.text ?? "" });
    if (b.type === "tool_use") {
      out.push({
        kind: "toolUse",
        name: typeof b.name === "string" ? b.name : "",
        input: typeof b.input === "object" && b.input !== null && !Array.isArray(b.input)
          ? b.input as Record<string, unknown>
          : {},
      });
    }
  }
  return out;
}

/**
 * ツールの返りは user 行として戻ってくる（2026-09-20 に claude v2 で実測）。
 * 人間の追加入力も同じ type なので、tool_result ブロックだけを拾う。
 */
function toolResults(o: Record<string, unknown>): AgentEvent[] {
  return blocksOf(o)
    .filter((b) => b.type === "tool_result")
    .map((b) => ({
      kind: "toolResult" as const,
      isError: b.is_error === true,
      content: flattenContent(b.content),
    }));
}

/** tool_result の content は文字列のことも、テキストブロックの配列のこともある。 */
function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => (typeof c === "object" && c !== null ? String((c as ContentBlock).text ?? "") : ""))
    .join("");
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
    permissionDenials: denialsFrom(denials),
    exitCode,
    stderrTail,
    structuredOutput: structuredOutputOf(o),
  };
}

/**
 * result 行の permission_denials を1要素1件で構造化する。要素は捨てない —
 * degraded は生配列の長さで決まるので、欠けた項目で落とすと「degraded なのに
 * 拒否が0件」になる。読めない項目は空の既定値で埋める。
 *
 * 未実測。要素の形（tool_name / tool_use_id / tool_input）は Claude Agent SDK の
 * 型定義（SDKPermissionDenial）に拠る。実際の result 行を見て直すこと。
 */
function denialsFrom(raw: unknown[]): PermissionDenial[] {
  return raw.map((e) => {
    const d = typeof e === "object" && e !== null ? e as Record<string, unknown> : {};
    const input = d.tool_input;
    return {
      tool_name: typeof d.tool_name === "string" ? d.tool_name : "",
      tool_use_id: typeof d.tool_use_id === "string" ? d.tool_use_id : null,
      input: typeof input === "object" && input !== null && !Array.isArray(input)
        ? input as Record<string, unknown>
        : {},
    };
  });
}

/**
 * --json-schema の出力を result 行から取る。オブジェクトのときだけ返し、無い・null・
 * 文字列・数値・配列は null。スキーマへの適合はここでは確かめない（呼び出し元の責務）。
 *
 * 未実測。`claude --help` の `--json-schema` の記載から `structured_output` と仮置きしている。
 * 呼び出し元を作る作業で実際の result 行を見て直すこと。
 */
function structuredOutputOf(o: Record<string, unknown>): Record<string, unknown> | null {
  const v = o.structured_output;
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? v as Record<string, unknown>
    : null;
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
