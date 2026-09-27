import type {
  IssueDetail,
  IssuePhase,
  IssueRef,
  IssueSummary,
  TrackerKind,
  TrackerStatus,
} from "../../../shared/intake/tracker.ts";
import type { PrFact } from "../../../shared/intake/processStatus.ts";
import type { WorkspaceRef, WorkspaceTracker } from "./workspaceTracker.ts";

export type SubIssue = { ref: IssueRef; body: string; state: "OPEN" | "CLOSED" };

/** Issue の参照は URL で持ち、番号を前提にしない（PRD 11 章）。 */
export interface Tracker {
  readonly kind: TrackerKind;
  /** PR 本文の Closes がマージ時に sub-issue を閉じるか。false なら Intake がマージを検知して閉じる。 */
  readonly closesViaPullRequest: boolean;
  /** GitHub だけが持つ。プロジェクトのリポジトリ。パスごとに覚える。 */
  repoOf?(projectPath: string): Promise<{ id: string; nameWithOwner: string }>;
  status(projectPath: string): Promise<TrackerStatus>;
  listIssues(
    projectPath: string,
    o: { assignee: "me" | "any"; search?: string },
  ): Promise<IssueSummary[]>;
  /** 本文とコメント。 */
  readIssue(projectPath: string, url: string): Promise<IssueDetail>;
  createSubIssue(
    projectPath: string,
    parent: IssueRef,
    o: { title: string; body: string },
  ): Promise<IssueRef>;
  findSubIssues(projectPath: string, parent: IssueRef): Promise<SubIssue[]>;
  updateIssue(
    projectPath: string,
    issue: IssueRef,
    o: { title: string; body: string },
  ): Promise<void>;
  closeIssue(
    projectPath: string,
    issue: IssueRef,
    reason: "completed" | "not_planned",
  ): Promise<void>;
  /** Issue をその段階の状態へ進める。すでに同じか先の状態なら何もしない。GitHub は何もしない。 */
  advanceIssue(projectPath: string, issue: IssueRef, phase: IssuePhase): Promise<void>;
}

/** workspace.yaml を読んで作る。無い・読めないときは WorkspaceConfigError を投げる。 */
export type TrackerOf = (ws: WorkspaceRef) => Promise<WorkspaceTracker>;

export class WorkspaceConfigError extends Error {
  constructor(
    readonly reason: "workspace_config_missing" | "workspace_config_invalid",
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceConfigError";
  }
}

export interface PrWatcher {
  /** 渡したブランチはすべて Map のキーになる。PR が無ければ空配列。 */
  pullRequests(projectPath: string, branches: string[]): Promise<Map<string, PrFact[]>>;
}
