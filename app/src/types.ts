// 画面が扱う形。デーモンにつなぐときに src/daemon/protocol.ts の型へ寄せる

export type TaskState = "queued" | "running" | "suspended" | "paused" | "completed" | "failed" | "canceled";

export type Project = { id: string; color: string; path: string; def: string };

export type StepDef = {
  id: string;
  type: "command" | "agent" | "approval";
  title?: string;
  onReject?: string;
  review?: { files: string[] };
};

export type Hunk = { old: number; new: number; body: string };
export type DiffFile = { path: string; hunks: Hunk[]; since?: Hunk[] };

export type Review = { at: number; comment: string };
export type CommandResult = { step: string; exitCode: number; stdout: string; stderr: string };

export type SequenceDiagram = { actors: string[]; messages: { from: string; to: string; label: string }[] };
export type ReadingStep = { title: string; paths: string[]; diagram: "sequence" | "relation" | null; explain: string };
export type Guide = {
  why: string;
  what: { path: string; desc: string }[];
  sequence: SequenceDiagram;
  readingOrder: ReadingStep[];
  decisions: { title: string; body: string }[];
  risks: string[];
  tests: { behavior: string; test: string }[];
};

export type Task = {
  id: string;
  wf: string;
  project: string;
  title: string;
  prompt: string;
  branch: string;
  worktree: string | null;
  state: TaskState;
  step: string | null;
  attempt: number;
  prio: number;
  since: number;
  diff: DiffFile[];
  reviews: Review[];
  guide?: Guide;
  reviewFiles?: Record<string, string>;
  lastCommand?: CommandResult | null;
  lastAgentMessage?: string;
  log?: string;
  dirty?: boolean;
  refused?: boolean;
  degraded?: string;
};

export type LineComment = { path: string; line: number; quote: string; text: string };
export type Draft = { comments: LineComment[]; overall: string };
