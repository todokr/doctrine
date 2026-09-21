import type { Guide } from "./guide/schema.ts";
import type { AttentionReason, CommentReply } from "./intake/decomposer.ts";
import type { FeedbackComment } from "./intake/feedback.ts";
import type { GhStatus, IssueDetail, IssueSummary } from "./intake/github.ts";
import type { Pfd } from "./intake/pfd.ts";
import type { ProcessStatus } from "./intake/processStatus.ts";
import type { Answer, Question } from "./intake/question.ts";
import type { IntakeRunPurpose, IntakeRunStatus, IntakeState } from "./intake/state.ts";

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
  }
  | {
    event: "intake.stateChanged";
    intake_id: string;
    from: IntakeState;
    to: IntakeState;
    revising: boolean;
  }
  /** 状態以外（プロセスの状態・sub-issue・観測した PR・見張りの失敗）が変わった。アプリは intake.get を取り直す。 */
  | { event: "intake.updated"; intake_id: string };

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
  /** Intake から投入されたタスクだけが持つ。intake_id と intake_process_id は両方 null か両方非 null。 */
  intake_id: string | null;
  intake_process_id: string | null;
  /** このタスクが実装する sub-issue の URL。 */
  issue_url: string | null;
  /** sub-issue の親 Issue の URL。 */
  parent_issue_url: string | null;
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
 * リネーム（R）とコピー（C）だけが old_path を持ち、バイナリだけが行数を持たない。
 * どちらも交差型で表すので、「R / C でないのに old_path」「バイナリなのに additions」
 * という読み方を型が許さない。
 */
export type DiffFileMeta =
  & { path: string }
  & ({ status: "R" | "C"; old_path: string } | { status: "A" | "M" | "D" })
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

/** 見張りの健康状態（spec 11.6）。プロジェクトごとにメモリに持ち、再起動で消える。 */
export type WatchHealth = {
  lastSucceededAt: string | null;
  consecutiveFailures: number;
  lastError: string | null;
};

/** intake.reject のコメント 1 件。 */
export type NewComment = FeedbackComment;

/** intake.list の 1 行（V-2）。UI に見せてよい列だけを宣言する。 */
export type IntakeSummary = {
  id: string;
  project_id: number;
  issue_url: string;
  issue_title: string;
  state: IntakeState;
  revising: boolean;
  attention_reason: AttentionReason | null;
  dispatch_paused: boolean;
  rate_limited_until: string | null;
  progress: { done: number; total: number };
  needs_human: boolean;
  watch: WatchHealth;
  created_at: string;
  updated_at: string;
};

/** 案 1 件の中身。UI spec 13 章の intake.draft の応答と同じ形。 */
export type PfdDraft = {
  id: number;
  seq: number;
  pfd: Pfd;
  hash: string;
  replies: CommentReply[];
  created_at: string;
};

export type IntakeQuestionSet = {
  id: number;
  run_id: number;
  questions: Question[];
  answers: Answer[] | null;
  created_at: string;
  answered_at: string | null;
};

export type IntakeComment = NewComment & { id: number; draft_id: number; created_at: string };

export type IntakeApproval = { id: number; draft_id: number; hash: string; approved_at: string };

export type IntakeRun = {
  id: number;
  purpose: IntakeRunPurpose;
  attempt: number;
  status: IntakeRunStatus;
  started_at: string | null;
  ended_at: string | null;
  cost_usd: number | null;
  num_turns: number | null;
  duration_ms: number | null;
  issues: string[] | null;
  permission_denials: StepRunDenials | null;
};

export type IntakeProcessView =
  & { id: string }
  & ProcessStatus
  & { sub_issue_url: string | null; task_ids: string[] };

/**
 * intake.get の応答。drafts は全部の案の見出しだけを持つ。中身は最新の案（latest_draft）だけに
 * 入れる（spec 13 章）。processes は承認の前は空配列になる。
 */
export type IntakeDetail = IntakeSummary & {
  drafts: { id: number; seq: number; created_at: string }[];
  latest_draft: PfdDraft | null;
  approval: IntakeApproval | null;
  question_sets: IntakeQuestionSet[];
  comments: IntakeComment[];
  processes: IntakeProcessView[];
  runs: IntakeRun[];
};

export type GithubIssue = IssueSummary & { intake_id: string | null };

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
  "github.status": { params: { project: string }; result: GhStatus };
  "github.issues": {
    params: { project: string; assignee?: "me" | "any"; search?: string };
    result: GithubIssue[];
  };
  "github.issue": { params: { project: string; url: string }; result: IssueDetail };
  "intake.start": {
    params: { project: string; issue_url: string };
    result: IntakeSummary & { alreadyActive: boolean };
  };
  "intake.list": {
    params: { project?: string; include_closed?: boolean };
    result: IntakeSummary[];
  };
  "intake.get": { params: { intake_id: string }; result: IntakeDetail };
  "intake.answer": {
    params: { intake_id: string; question_set_id: number; answers: Answer[] };
    result: IntakeSummary;
  };
  "intake.reject": {
    params: { intake_id: string; draft_id: number; comments: NewComment[] };
    result: IntakeSummary;
  };
  /** hash はアプリが表示していた案の intake_drafts.hash。承認は人だけが行い、dctl にこの操作は無い（spec 6 章 R-9）。 */
  "intake.approve": {
    params: { intake_id: string; draft_id: number; hash: string };
    result: IntakeSummary;
  };
  "intake.draft": { params: { intake_id: string; draft_id: number }; result: PfdDraft };
  /** 承認前でも呼べる。入力の決定や人の完了が無ければ、投入と同じ理由で失敗する（R-3）。 */
  "intake.processPrompt": {
    params: { intake_id: string; draft_id: number; process_id: string };
    result: { prompt: string };
  };
  "intake.cancel": {
    params: { intake_id: string; mode: "leave" | "stop" };
    result: IntakeSummary;
  };
  /** 人のプロセスの完了の記録。note は必須。人だけが行い、dctl にこの操作は無い（spec 11.6 H-4）。 */
  "intake.completeHumanProcess": {
    params: { intake_id: string; process_id: string; note: string };
    result: IntakeDetail;
  };
  /** 要確認のプロセスに新しいタスクを作る。古いタスクは経緯として残る（C-6）。 */
  "intake.redispatch": { params: { intake_id: string; process_id: string }; result: IntakeDetail };
  /** 見張りの周期を待たずに 1 周回す（W-4）。 */
  "intake.refresh": { params: { intake_id: string }; result: IntakeDetail };
  "intake.setDispatchPaused": {
    params: { intake_id: string; paused: boolean };
    result: IntakeSummary;
  };
  /** completed の Intake の親 Issue を閉じる（W-11）。 */
  "intake.closeIssue": { params: { intake_id: string }; result: IntakeSummary };
};

export type Method = keyof Methods;
export type ParamsOf<M extends Method> = Methods[M]["params"];
export type ResultOf<M extends Method> = Methods[M]["result"];
