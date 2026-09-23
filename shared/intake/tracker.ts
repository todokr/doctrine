/** Issue の参照。番号を前提にしない（PRD 11 章）。 */
export type IssueRef = { url: string; nodeId: string };

export type GhStatus =
  | { ok: true; repo: { id: string; nameWithOwner: string } }
  | { ok: false; reason: "not_installed" | "not_logged_in" | "no_github_remote"; message: string };

/** Issue の一覧の 1 行（S-1）。number は表示のためだけに持つ。 */
export type IssueSummary = {
  url: string;
  number: number;
  title: string;
  assignees: string[]; // login
  updatedAt: string;
};

/** author が null なのは、削除されたユーザーのコメント。 */
export type IssueComment = { author: string | null; body: string; createdAt: string };

/** Issue の本文とコメント（S-2・Q-1）。 */
export type IssueDetail = IssueRef & { title: string; body: string; comments: IssueComment[] };
