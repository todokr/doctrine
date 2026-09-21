import type { Guide } from "./guide/schema.ts";

export type Request = { id: number; method: string; params?: Record<string, unknown> };

export type Response =
  | { id: number; ok: true; result: unknown }
  | { id: number | null; ok: false; error: string };

export type ServerEvent =
  | { event: "task.stateChanged"; task_id: string; from: string; to: string }
  | { event: "stepRun.started"; task_id: string; step_run_id: number; step_id: string }
  | {
    event: "stepRun.finished";
    task_id: string;
    step_run_id: number;
    step_id: string;
    /** step_runs.status に記録した値。差し戻しは "bounced"（"failed" ではない）。 */
    status: string;
    /** status が "bounced" のときの差し戻し先。それ以外は null。 */
    goto_step_id: string | null;
    /** このステップの何回目の実行か。差し戻しなら「差し戻しが何回目か」でもある。 */
    attempt: number;
  }
  | { event: "log.line"; task_id: string; step_run_id: number; line: string }
  | {
    event: "task.cleanedUp";
    task_id: string;
    /** removed = worktree を消した / refused = 消さずに残した（理由は warning） */
    outcome: "removed" | "refused";
    worktree_path: string | null;
    warning?: string;
  }
  | { event: "daemon.warning"; at: string; message: string; task_id?: string }
  | {
    event: "ratelimit.sample";
    /** five_hour / seven_day。claude が枠を増やせば未知の値も来る。 */
    window: string;
    utilization: number;
    /** 枠が明ける時刻（ISO 8601）。デーモンが生値を正規化してあり、読めない生値は null。 */
    resets_at: string | null;
  };

export type TaskState =
  | "queued"
  | "running"
  | "suspended"
  | "paused"
  | "rate_limited"
  | "completed"
  | "failed"
  | "canceled";

/**
 * task.* が返すタスク1件。デーモンは DB の行をそのまま返すので実際には
 * これより多くの列が載るが、UI に見せてよいのはここに書いた分だけである。
 */
export type TaskSummary = {
  id: string;
  project_id: number;
  title: string;
  prompt: string;
  workflow_name: string;
  state: TaskState;
  current_step_id: string | null;
  branch: string;
  worktree_path: string | null;
  /** state が rate_limited の間だけ入る、再開してよい時刻（ISO 8601）。 */
  rate_limited_until: string | null;
  priority: number;
  created_at: string;
  updated_at: string;
};

/**
 * 権限で拒否された操作1件。
 * 形は Claude Agent SDK の型定義（tool_name / tool_use_id / tool_input）に
 * 合わせてあるが、実バイナリの出力では未確認。input は SDK の tool_input。
 */
export type PermissionDenial = {
  tool_name: string;
  tool_use_id: string | null;
  input: Record<string, unknown>;
};

/** step_runs.permission_denials。denials は先頭 20 件で、total は実際に起きた件数。 */
export type StepRunDenials = { total: number; denials: PermissionDenial[] };

/** task.get が返すステップ実行1回ぶん。step_runs の行のうち UI に見せる分。 */
export type StepRun = {
  id: number;
  step_id: string;
  attempt: number;
  /** step_runs.status。bounced は差し戻し、rate_limited は利用上限で打ち切られ再開待ち。 */
  status:
    | "running"
    | "awaiting"
    | "success"
    | "failed"
    | "interrupted"
    | "bounced"
    | "rate_limited";
  exit_code: number | null;
  started_at: string;
  ended_at: string | null;
  /**
   * 権限で拒否された操作。拒否が無かった実行は null。
   * success / failed / rate_limited のどの行にも入り得る。
   * この列だけはデーモンが JSON をパースして返す（他の列は DB の生値）。
   */
  permission_denials: StepRunDenials | null;
};

/**
 * ワークフローの1ステップのうち、帯が描くために要る分だけ。
 * prompt / run / allowedTools / feed は出さない。
 */
export type StepView = {
  id: string;
  type: "command" | "agent" | "approval" | "guide";
  title?: string;
  branch?: { goto: string; maxAttempts: number };
};

/**
 * steps は setup を差し込んだ後の、実際に走る列。null は「ワークフロー YAML が
 * 読めない」の意味で、読み取り専用の経路をワークフローの不備で失敗させないための
 * 扱い（task.context と同じ理由）。それ以外の用途には使わない。
 */
export type TaskDetail = { task: TaskSummary; stepRuns: StepRun[]; steps: StepView[] | null };

export type TaskLogs = { step_run_id: number | null; log_path: string | null; lines: string[] };

/** daemon.warnings が返す1件。イベントの daemon.warning と同じ形。 */
export type Warning = { at: string; message: string; task_id?: string };

/** ratelimit.recent が返す1件。resets_at は ISO 8601 か null（読めない生値は null）。 */
export type RateLimitSample = {
  observed_at: string;
  window: string;
  utilization: number;
  resets_at: string | null;
};

export type ProjectSummary = {
  id: number;
  path: string;
  default_workflow: string;
  max_concurrent: number;
  base_branch: string;
  setup: string | null;
};

/**
 * task.diff が返すファイル1件（core/src/domain/diff.ts の DiffFile と同じ形）。
 * リネームだけが old_path を持ち、バイナリだけが行数を持たない。
 * どちらも交差型で表すので、「R でないのに old_path」「バイナリなのに additions」
 * という読み方を型が許さない。
 */
export type DiffFileMeta =
  & { path: string }
  & ({ status: "R"; old_path: string } | { status: "A" | "M" | "D" })
  & ({ binary: false; additions: number; deletions: number } | { binary: true });

/** task.diff の応答（core/src/domain/diff.ts の TaskDiff）。 */
export type TaskDiff = {
  /** since を渡したかにかかわらず常にブランチ全体の基準。 */
  base: { branch: string; merge_base: string };
  /**
   * since=last_review で実際に基準にした却下レビュー。null は「前回が無いので
   * 全体を返した」という意味であり、画面は「前回レビュー以降」と名乗ってはいけない。
   */
  since_step_run_id: number | null;
  files: DiffFileMeta[];
  patch: string;
  truncated: boolean;
};

/** core/src/domain/reviewFiles.ts の ReviewFile。 */
export type ReviewFile =
  | { path: string; status: "ok"; content: string; size: number }
  | { path: string; status: "missing" }
  | { path: string; status: "too_large"; size: number }
  | { path: string; status: "outside_worktree" }
  | { path: string; status: "binary"; size: number };

/**
 * task.guide の応答。
 *
 * none はワークフローにガイドを作るステップが無いこと（このタスクにガイドは出ない）。
 * missing はファイルが無いこと。ワークフロー定義が読めないときも missing に倒す
 * （定義の不備を根拠に「ガイドは無いもの」と断言しない）。
 * broken の issues は shared/guide/validate.ts の issues と同じ形で、画面はガイドを
 * 出さずに「壊れている」と示す。
 * guide は TaskState と同じでコンパイル時の注釈にすぎない（版のずれで形が違う
 * ことがありうる）。だから画面はもう一度 validateGuide を通す。
 * stale は「ガイドが説明しているツリー（tree）と、この応答を作った時点の
 * worktree のツリー（worktreeTree）が違う」という意味。どちらのハッシュも載せる。
 */
export type TaskGuide =
  | { status: "none" }
  | { status: "missing" }
  | { status: "too_large"; size: number }
  | { status: "broken"; issues: string[] }
  | {
    status: "ok";
    guide: Guide;
    createdAt: string;
    tree: string;
    worktreeTree: string;
    stale: boolean;
  };

type ReviewBase = {
  stepRunId: number;
  stepId: string;
  attempt: number;
  startedAt: string;
  /** 記録できなかった回は null。この回を「前回レビュー」の基準にはできない。 */
  reviewTree: string | null;
};

/** レビュー1回（core/src/domain/taskContext.ts の ReviewEntry）。 */
export type ReviewEntry =
  | (ReviewBase & { status: "awaiting" })
  | (ReviewBase & { status: "approved"; endedAt: string })
  | (ReviewBase & { status: "rejected"; endedAt: string; comment: string })
  | (ReviewBase & { status: "interrupted"; endedAt: string });

export type CommandResult = {
  stepId: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

/** task.context の応答（core/src/domain/taskContext.ts の TaskContext）。 */
export type TaskContext = {
  prompt: string;
  reviews: ReviewEntry[];
  lastCommand: CommandResult | null;
  lastAgentMessage: string | null;
  reviewFiles: ReviewFile[];
};

/**
 * UI が呼ぶメソッドの表。増えたらここに足す。Rust の中継はこの表を知らない
 * （method を素通しするだけ）。
 */
export type Methods = {
  "task.list": { params: { project?: string; state?: TaskState }; result: TaskSummary[] };
  "project.list": { params: Record<string, never>; result: ProjectSummary[] };
  "task.diff": { params: { task_id: string; since?: "last_review" }; result: TaskDiff };
  "task.context": { params: { task_id: string }; result: TaskContext };
  "task.guide": { params: { task_id: string }; result: TaskGuide };
  "task.approve": { params: { task_id: string }; result: TaskSummary };
  "task.reject": { params: { task_id: string; comment: string }; result: TaskSummary };
  "task.cancel": { params: { task_id: string }; result: TaskSummary };
  "task.get": { params: { task_id: string }; result: TaskDetail };
  /**
   * step_run_id を省くと最新のステップ実行の末尾を返す。follow は接続の追従先を
   * 指定したタスクへ移し、false で追従をやめる（1接続につき1タスク）。
   */
  "task.logs": {
    params: { task_id: string; step_run_id?: number; tail?: number; follow?: boolean };
    result: TaskLogs;
  };
  "daemon.warnings": { params: Record<string, never>; result: Warning[] };
  "ratelimit.recent": { params: { limit?: number }; result: RateLimitSample[] };
};

export type Method = keyof Methods;
export type ParamsOf<M extends Method> = Methods[M]["params"];
export type ResultOf<M extends Method> = Methods[M]["result"];
