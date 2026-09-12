export type AgentEvent =
  | { kind: "system"; subtype: string }
  | { kind: "assistant"; text: string }
  | { kind: "rateLimit"; window: string; utilization: number; resetsAt: string | null }
  | { kind: "result" };

export type AgentResult = {
  ok: boolean;
  degraded: boolean;
  text: string;
  costUsd: number | null;
  numTurns: number | null;
  durationMs: number | null;
  permissionDenials: unknown[];
  exitCode: number | null;
  /** result 行が来ずに終わった実行を診断するための stderr 末尾（最大4KB）。 */
  stderrTail: string;
};

export type StartOptions = {
  cwd: string;
  sessionId: string;
  permissionMode?: string;
  model?: string;
};

export type AgentRun = {
  sessionId: string;
  pid: number;
  startedAt: string;
  events: AsyncIterable<AgentEvent>;
  result: Promise<AgentResult>;
  kill(): void;
};

export type AgentAdapter = {
  start(prompt: string, opts: StartOptions): AgentRun;
  resume(sessionId: string, prompt: string, opts: StartOptions): AgentRun;
};
