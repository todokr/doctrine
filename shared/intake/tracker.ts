/** Issue の参照。番号を前提にしない（PRD 11 章）。 */
export type IssueRef = { url: string; nodeId: string };

/** トラッカーが使えるか。target は Issue を置く先（GitHub はリポジトリ）。reason はトラッカーごとの失敗の種類 */
export type TrackerStatus =
  | { ok: true; target: { id: string; name: string } }
  | { ok: false; reason: string; message: string };

/** Issue の一覧の 1 行（S-1）。identifier は表示のためだけに持つ（GitHub は "#112"） */
export type IssueSummary = {
  url: string;
  identifier: string;
  title: string;
  assignees: string[]; // 表示名（GitHub は login、Linear は displayName）
  updatedAt: string;
};

/** author が null なのは、削除されたユーザーのコメント。 */
export type IssueComment = { author: string | null; body: string; createdAt: string };

/** Issue の本文とコメント（S-2・Q-1）。 */
export type IssueDetail = IssueRef & { title: string; body: string; comments: IssueComment[] };
