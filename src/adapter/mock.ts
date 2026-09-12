import type { AgentAdapter, AgentEvent, AgentResult, AgentRun, StartOptions } from "./types.ts";

export type MockScript = {
  events?: AgentEvent[];
  result: Partial<AgentResult>;
  /** 呼び出しごとに結果を変えたいとき。start/resume の通算回数で引く。 */
  sequence?: Partial<AgentResult>[];
  delayMs?: number;
};

export type MockAdapter = AgentAdapter & {
  calls: { kind: "start" | "resume"; prompt: string; sessionId: string; opts: StartOptions }[];
};

const DEFAULT: AgentResult = {
  ok: true, degraded: false, text: "", costUsd: 0, numTurns: 1,
  durationMs: 1, permissionDenials: [], exitCode: 0,
};

export function createMockAdapter(script: MockScript): MockAdapter {
  const calls: MockAdapter["calls"] = [];

  function make(kind: "start" | "resume", prompt: string, sessionId: string, opts: StartOptions): AgentRun {
    const n = calls.length;
    calls.push({ kind, prompt, sessionId, opts });
    const partial = script.sequence?.[n] ?? script.result;
    const events = script.events ?? [];
    return {
      sessionId,
      pid: 424242,
      startedAt: new Date().toISOString(),
      events: (async function* () { for (const e of events) yield e; })(),
      result: new Promise((resolve) =>
        setTimeout(() => resolve({ ...DEFAULT, ...partial }), script.delayMs ?? 0)),
      kill: () => {},
    };
  }

  return {
    calls,
    start: (prompt, opts) => make("start", prompt, opts.sessionId, opts),
    resume: (sessionId, prompt, opts) => make("resume", prompt, sessionId, opts),
  };
}
