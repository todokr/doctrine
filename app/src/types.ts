// 画面が扱う形。デーモンにつなぐときに shared/protocol.ts の型へ寄せる
import type { MovedBlock } from "../../shared/diff/moves.ts";
import type {
  CommandResult,
  DiffFileMeta,
  ReviewEntry,
  ReviewFile,
  TaskContext,
  TaskDiff,
  TaskGuide,
} from "../../shared/protocol.ts";
import type { Diagram, Guide } from "../../shared/guide/schema.ts";

export type { CommandResult, Diagram, Guide, MovedBlock, ReviewEntry, ReviewFile, TaskContext, TaskDiff, TaskGuide };

/**
 * デーモンが知らない状態を返したとき用。版のずれ（新しい dctld ＋ 古い画面）で起こりうる。
 * 捨てると画面から消えるか「終了」に紛れるので、見える状態として持つ。
 */
export type TaskState = "queued" | "running" | "suspended" | "paused" | "rate_limited"
  | "completed" | "failed" | "canceled" | "unknown";

export type Project = { id: string; color: string; path: string; def: string };

export type DiffHunk = {
  /** ガイドが指す hunk の id（shared/guide/hunkId.ts の listHunks と同じ値） */
  id: string;
  old: number;
  new: number;
  body: string;
};

/**
 * 画面が描く1ファイル。task.diff の files[] の1件（DiffFileMeta）に、
 * patch から取り出した hunk を足したもの。リネーム・バイナリの持ち方は
 * デーモンのまま引き継ぐので、「バイナリなのに行数」は型が作れない。
 */
export type DiffFile = DiffFileMeta & {
  hunks: DiffHunk[];
  /** patch が打ち切られて、このファイルの中身までは届かなかった */
  cutOff: boolean;
  /** このファイルが移動元（from）か移動先（to）に出るブロック。patch のテキストから検出したもの */
  moves: MovedBlock[];
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
  /** 上限待ちのタスクが再開してよい時刻。task.stateChanged では埋まらないので null になりうる */
  resumeAt?: number | null;
  dirty?: boolean;
  refused?: boolean;
  /**
   * 直近の差し戻し（step が非0で終わり、onFailure / onReject の goto で goto へ
   * 戻った）。ワークフローは続いているので失敗ではない。attempt は差し戻した側の
   * 試行回数＝差し戻しが何回目か。
   */
  bounce?: { step: string; goto: string; attempt: number };
};

/** 枠1つぶんの最新の標本。window はデーモンの生のキー（five_hour / seven_day / 未知の値）。 */
export type RateLimitWindow = {
  window: string;
  utilization: number;
  /** 枠が明ける時刻。読めない生値はデーモンが null にしてある */
  resetsAt: number | null;
  /** その標本を観測した時刻。古い値を「いま」と読ませないために持つ */
  observedAt: number;
};

export type LineComment = { path: string; line: number; quote: string; text: string };
export type Draft = { comments: LineComment[]; overall: string };
