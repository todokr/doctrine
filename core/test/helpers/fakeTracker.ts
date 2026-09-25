import type { IssuePhase, IssueRef, TrackerKind } from "../../../shared/intake/tracker.ts";
import type { SubIssue, Tracker } from "../../src/tracker/tracker.ts";

export type FakeIssue = {
  ref: IssueRef;
  parentUrl: string;
  title: string;
  body: string;
  state: "OPEN" | "CLOSED";
  closeReason: "completed" | "not_planned" | null;
};

export type TrackerCall =
  | { op: "createSubIssue"; parentUrl: string; title: string; body: string }
  | { op: "findSubIssues"; parentUrl: string }
  | { op: "updateIssue"; url: string; title: string; body: string }
  | { op: "closeIssue"; url: string; reason: "completed" | "not_planned" }
  | { op: "advanceIssue"; url: string; phase: IssuePhase };

type CreateCall = Extract<TrackerCall, { op: "createSubIssue" }>;

export type FakeTracker = {
  tracker: Tracker;
  /** 作った順。seed で入れたものも含む。 */
  issues: FakeIssue[];
  calls: TrackerCall[];
  /** 親に sub-issue を最初から置く。作った FakeIssue を返す。 */
  seed(parent: IssueRef, o: { title?: string; body: string; state?: "OPEN" | "CLOSED" }): FakeIssue;
  /** 該当する呼び出しを、状態を変えずに reject する。 */
  failWhen(pred: (call: TrackerCall) => boolean): void;
  /** 該当する createSubIssue は Issue を登録してから reject する（作成と記録の間で落ちたことの再現）。 */
  loseCreateResponseWhen(pred: (call: CreateCall) => boolean): void;
  /** failWhen / loseCreateResponseWhen を外す。 */
  heal(): void;
};

/** Tracker を直接実装した、状態を持つ偽物。listIssues は使わない。 */
export function fakeTracker(o: { kind?: TrackerKind } = {}): FakeTracker {
  const issues: FakeIssue[] = [];
  const calls: TrackerCall[] = [];
  let failing: ((call: TrackerCall) => boolean) | null = null;
  let losing: ((call: CreateCall) => boolean) | null = null;
  // 親の 1 と混ざらないように 100 から振る
  let seq = 100;

  const register = (parentUrl: string, title: string, body: string, state: "OPEN" | "CLOSED") => {
    const n = seq++;
    const issue: FakeIssue = {
      ref: { url: `https://github.com/o/r/issues/${n}`, nodeId: `I_${n}` },
      parentUrl,
      title,
      body,
      state,
      closeReason: null,
    };
    issues.push(issue);
    return issue;
  };

  const find = (ref: IssueRef): FakeIssue => {
    const issue = issues.find((i) => i.ref.url === ref.url);
    if (!issue) throw new Error(`偽の tracker に無い Issue: ${ref.url}`);
    return issue;
  };

  const record = (call: TrackerCall): void => {
    calls.push(call);
    if (failing?.(call)) throw new Error(`偽の tracker の失敗: ${call.op}`);
  };

  const unexpected = (name: string) => () => Promise.reject(new Error(`想定外の呼び出し: ${name}`));

  // 同期の throw も reject として返す
  const settle = <T>(f: () => T): Promise<T> => new Promise((resolve) => resolve(f()));

  const tracker: Tracker = {
    kind: o.kind ?? "github",
    // calls に積まない。積むと subIssueSync.test.ts の calls の検査が崩れる
    status: () => Promise.resolve({ ok: true, target: { id: "R_1", name: "o/r" } }),
    listIssues: unexpected("listIssues"),
    readIssue: (_projectPath, url) =>
      Promise.resolve({ url, nodeId: "I_1", title: "T", body: "B", comments: [] }),
    createSubIssue: (_projectPath, parent, o) =>
      settle(() => {
        const call: CreateCall = {
          op: "createSubIssue",
          parentUrl: parent.url,
          title: o.title,
          body: o.body,
        };
        record(call);
        const issue = register(parent.url, o.title, o.body, "OPEN");
        if (losing?.(call)) throw new Error("偽の tracker: 作成の応答が届かなかった");
        return issue.ref;
      }),
    findSubIssues: (_projectPath, parent) =>
      settle((): SubIssue[] => {
        record({ op: "findSubIssues", parentUrl: parent.url });
        return issues.filter((i) => i.parentUrl === parent.url)
          .map((i) => ({ ref: i.ref, body: i.body, state: i.state }));
      }),
    updateIssue: (_projectPath, issue, o) =>
      settle(() => {
        record({ op: "updateIssue", url: issue.url, title: o.title, body: o.body });
        const target = find(issue);
        target.title = o.title;
        target.body = o.body;
      }),
    closeIssue: (_projectPath, issue, reason) =>
      settle(() => {
        record({ op: "closeIssue", url: issue.url, reason });
        const target = find(issue);
        target.state = "CLOSED";
        target.closeReason = reason;
      }),
    advanceIssue: (_projectPath, issue, phase) =>
      settle(() => {
        record({ op: "advanceIssue", url: issue.url, phase });
      }),
  };

  return {
    tracker,
    issues,
    calls,
    seed(parent, o) {
      return register(parent.url, o.title ?? "seed", o.body, o.state ?? "OPEN");
    },
    failWhen(pred) {
      failing = pred;
    },
    loseCreateResponseWhen(pred) {
      losing = pred;
    },
    heal() {
      failing = null;
      losing = null;
    },
  };
}
