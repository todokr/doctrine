import type { PermissionDenial } from "../../../shared/protocol.ts";

/** rate_limit_event が伝える、ある枠（window）の消費率と明ける時刻。 */
export type RateLimitObservation = {
  window: string;
  utilization: number;
  resetsAt: string | null;
};

export type AgentEvent =
  | { kind: "system"; subtype: string }
  | { kind: "assistant"; text: string }
  /** エージェントが道具を呼んだ。input はツールごとに形が違うので素のまま持つ。 */
  | { kind: "toolUse"; name: string; input: Record<string, unknown> }
  /** 道具が返した。content はブロック配列で来ることもあるので文字列に均してある。 */
  | { kind: "toolResult"; isError: boolean; content: string }
  | ({ kind: "rateLimit" } & RateLimitObservation)
  | { kind: "result" };

export type AgentResult = {
  ok: boolean;
  degraded: boolean;
  text: string;
  costUsd: number | null;
  numTurns: number | null;
  durationMs: number | null;
  permissionDenials: PermissionDenial[];
  exitCode: number | null;
  /** result 行が来ずに終わった実行を診断するための stderr 末尾（最大4KB）。 */
  stderrTail: string;
  /** --json-schema で得た構造化出力。CLI が返さなかった・オブジェクトでなかったときは null。 */
  structuredOutput: Record<string, unknown> | null;
};

export type StartOptions = {
  cwd: string;
  sessionId: string;
  permissionMode?: string;
  model?: string;
  allowedTools?: string[];
  /** 渡すと claude -p に --json-schema が付く。JSON Schema のオブジェクトをそのまま渡す。 */
  jsonSchema?: Record<string, unknown>;
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
