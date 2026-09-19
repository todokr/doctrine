// 画面が扱う形。デーモンにつなぐときに src/daemon/protocol.ts の型へ寄せる

/**
 * デーモンが知らない状態を返したとき用。版のずれ（新しい dctld ＋ 古い画面）で起こりうる。
 * 捨てると画面から消えるか「終了」に紛れるので、見える状態として持つ。
 */
export type TaskState = "queued" | "running" | "suspended" | "paused"
  | "completed" | "failed" | "canceled" | "unknown";

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

// デーモン側（src/core/reviewFiles.ts）と同じ判別ユニオン。
export type ReviewFileStatus = "ok" | "missing" | "too_large" | "outside_worktree" | "binary";
export type ReviewFile =
  | { path: string; status: "ok"; content: string; size: number }
  | { path: string; status: "missing" }
  | { path: string; status: "too_large"; size: number }
  | { path: string; status: "outside_worktree" }
  | { path: string; status: "binary"; size: number };

// デーモンの ReviewEntry（4系統の判別ユニオン、src/core/taskContext.ts）とはまだ揃えていない。
// この Review はモックの単純な形のままで、揃えるのはデーモンと UI を繋ぐ変更（別対応）で行う。
export type Review = { at: number; comment: string };
export type CommandResult = { stepId: string; exitCode: number | null; stdout: string; stderr: string };

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
  reviewFiles?: ReviewFile[];
  lastCommand?: CommandResult | null;
  lastAgentMessage?: string | null;
  // どの画面も今は読まない。task.logs の follow（#47）で本物のログに置き換わるまでの残骸
  log?: string;
  dirty?: boolean;
  refused?: boolean;
  degraded?: string;
};

export type LineComment = { path: string; line: number; quote: string; text: string };
export type Draft = { comments: LineComment[]; overall: string };
