import type {
  IssueDetail,
  IssueRef,
  IssueSummary,
  TrackerKind,
  TrackerStatus,
} from "../../../shared/intake/tracker.ts";
import type { PrFact } from "../../../shared/intake/processStatus.ts";

export type SubIssue = { ref: IssueRef; body: string; state: "OPEN" | "CLOSED" };

/** Issue の参照は URL で持ち、番号を前提にしない（PRD 11 章）。 */
export interface Tracker {
  readonly kind: TrackerKind;
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
}

/** プロジェクトのパスから、そのプロジェクトが使う Tracker を返す。project.yaml が読めなければ投げる。 */
export type TrackerOf = (projectPath: string) => Promise<Tracker>;

export interface PrWatcher {
  /** 渡したブランチはすべて Map のキーになる。PR が無ければ空配列。 */
  pullRequests(projectPath: string, branches: string[]): Promise<Map<string, PrFact[]>>;
}
