import type { IssueDetail } from "../../../shared/intake/github.ts";
import type { Tracker } from "../../src/github/tracker.ts";

/**
 * readIssue だけを実装した Tracker。呼ばれた URL を reads に積む。
 * ほかのメソッドは、使うテストが現れたときに足す。
 */
export function fakeTracker(issue: Partial<IssueDetail> = {}): Tracker & { reads: string[] } {
  const reads: string[] = [];
  const unimplemented = () => {
    throw new Error("fakeTracker では未実装です");
  };
  return {
    reads,
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
    status: unimplemented,
    listIssues: unimplemented,
    createSubIssue: unimplemented,
    findSubIssues: unimplemented,
    updateIssue: unimplemented,
    closeIssue: unimplemented,
  };
}
