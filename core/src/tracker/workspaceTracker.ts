import type { IssueSummary, TrackerKind, TrackerStatus } from "../../../shared/intake/tracker.ts";
import type { Tracker } from "./tracker.ts";

export type WorkspaceRef = { path: string; projects: { name: string; path: string }[] };

export interface WorkspaceTracker {
  readonly kind: TrackerKind;
  readonly tracker: Tracker;
  status(): Promise<(TrackerStatus & { project: string })[]>;
  /** GitHub は全プロジェクトを合わせて updatedAt の降順。一部が落ちても残りを返し、全部落ちたら投げる。
   *  プロジェクトが 2 つ以上なら identifier に "<name>#<n>" を使う。 */
  listIssues(o: { assignee: "me" | "any"; search?: string }): Promise<IssueSummary[]>;
  /** Issue を読み書きするときに gh を実行するプロジェクトのパス。GitHub は URL の owner/name が一致するプロジェクト、
   *  無ければ null。Linear は先頭のプロジェクト。 */
  projectPathFor(issueUrl: string): Promise<string | null>;
}

const GITHUB_ISSUE_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/\d+/;

export function workspaceTracker(ws: WorkspaceRef, tracker: Tracker): WorkspaceTracker {
  const projects = ws.projects;
  if (projects.length === 0) {
    throw new Error(`workspace ${ws.path} にプロジェクトがありません`);
  }
  const first = projects[0];

  if (tracker.kind === "linear") {
    return {
      kind: tracker.kind,
      tracker,
      async status() {
        return [{ ...(await tracker.status(first.path)), project: first.name }];
      },
      listIssues(o) {
        return tracker.listIssues(first.path, o);
      },
      projectPathFor() {
        return Promise.resolve(first.path);
      },
    };
  }

  return {
    kind: tracker.kind,
    tracker,
    async status() {
      const results = await Promise.all(
        projects.map(async (p) => ({ ...(await tracker.status(p.path)), project: p.name })),
      );
      return results;
    },
    async listIssues(o) {
      const settled = await Promise.allSettled(
        projects.map((p) => tracker.listIssues(p.path, o)),
      );
      const multi = projects.length > 1;
      const issues = settled.flatMap((r, i) => {
        if (r.status === "rejected") return [];
        return r.value.map((issue) => ({
          ...issue,
          identifier: multi ? `${projects[i].name}${issue.identifier}` : issue.identifier,
        }));
      });
      const allFailed = settled.every((r) => r.status === "rejected");
      if (allFailed) {
        const rejected = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
        throw rejected!.reason;
      }
      return issues.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    async projectPathFor(issueUrl) {
      const m = issueUrl.match(GITHUB_ISSUE_URL);
      if (!m) return null;
      const [, owner, name] = m;
      const wanted = `${owner}/${name}`.toLowerCase();
      if (!tracker.repoOf) {
        throw new Error("GitHub の Tracker が repoOf を持っていません");
      }
      let firstFailure: unknown;
      for (const p of projects) {
        try {
          const repo = await tracker.repoOf(p.path);
          if (repo.nameWithOwner.toLowerCase() === wanted) return p.path;
        } catch (e) {
          firstFailure ??= e;
        }
      }
      if (firstFailure !== undefined) throw firstFailure;
      return null;
    },
  };
}
