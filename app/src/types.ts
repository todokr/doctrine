// 画面が扱う形。デーモンにつなぐときに shared/protocol.ts の型へ寄せる
import type {
  CommandResult,
  DiffFileMeta,
  ReviewEntry,
  ReviewFile,
  TaskContext,
  TaskDiff,
} from "../../shared/protocol.ts";

export type { CommandResult, ReviewEntry, ReviewFile, TaskContext, TaskDiff };

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

export type DiffHunk = { old: number; new: number; body: string };

/**
 * 画面が描く1ファイル。task.diff の files[] の1件（DiffFileMeta）に、
 * patch から取り出した hunk を足したもの。リネーム・バイナリの持ち方は
 * デーモンのまま引き継ぐので、「バイナリなのに行数」は型が作れない。
 */
export type DiffFile = DiffFileMeta & {
  hunks: DiffHunk[];
  /** patch が打ち切られて、このファイルの中身までは届かなかった */
  cutOff: boolean;
};

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
  guide?: Guide;
  // どの画面も今は読まない。task.logs の follow（#47）で本物のログに置き換わるまでの残骸
  log?: string;
  dirty?: boolean;
  refused?: boolean;
  degraded?: string;
};

export type LineComment = { path: string; line: number; quote: string; text: string };
export type Draft = { comments: LineComment[]; overall: string };
