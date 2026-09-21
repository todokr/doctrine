import type { GhStatus, IssueDetail, IssueSummary } from "../../../shared/intake/github.ts";
import type { Tracker } from "../../src/github/tracker.ts";

type ListOptions = Parameters<Tracker["listIssues"]>[1];

/**
 * readIssue・status・listIssues だけを実装した Tracker。呼ばれた URL を reads に、
 * listIssues に渡された条件を listCalls に積む。ほかのメソッドは、使うテストが現れたときに足す。
 */
export function fakeTracker(
  issue: Partial<IssueDetail> = {},
  o: { status?: GhStatus; issues?: IssueSummary[]; failList?: boolean } = {},
): Tracker & { reads: string[]; listCalls: ListOptions[] } {
  const reads: string[] = [];
  const listCalls: ListOptions[] = [];
  const unimplemented = () => {
    throw new Error("fakeTracker では未実装です");
  };
  return {
    reads,
    listCalls,
    readIssue: (_projectPath, url) => {
      reads.push(url);
      return Promise.resolve({
        url,
        nodeId: "N1",
        title: "T",
        body: "B",
        comments: [],
        ...issue,
      });
    },
    status: () =>
      Promise.resolve(
        o.status ?? { ok: true, repo: { id: "R1", nameWithOwner: "o/r" } },
      ),
    listIssues: (_projectPath, listOptions) => {
      listCalls.push(listOptions);
      if (o.failList) return Promise.reject(new Error("gh issue list に失敗しました"));
      return Promise.resolve(o.issues ?? []);
    },
    createSubIssue: unimplemented,
    findSubIssues: unimplemented,
    updateIssue: unimplemented,
    closeIssue: unimplemented,
  };
}
