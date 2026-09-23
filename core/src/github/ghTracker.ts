import { z } from "zod";
import type { GhStatus, IssueRef } from "../../../shared/intake/tracker.ts";
import { defaultGhRun, type GhRun, graphqlArgs, parseGhJson } from "./gh.ts";
import type { SubIssue, Tracker } from "../tracker/tracker.ts";

const repoSchema = z.object({ id: z.string(), nameWithOwner: z.string() });
const repoIdSchema = z.object({ id: z.string() });

const listSchema = z.array(z.object({
  url: z.string(),
  number: z.number(),
  title: z.string(),
  assignees: z.array(z.object({ login: z.string() })),
  updatedAt: z.string(),
}));

const viewSchema = z.object({
  url: z.string(),
  id: z.string(),
  title: z.string(),
  body: z.string(),
  comments: z.array(z.object({
    author: z.object({ login: z.string() }).nullable(),
    body: z.string(),
    createdAt: z.string(),
  })),
});

const issueNode = z.object({ id: z.string(), url: z.string() });

const createSchema = z.object({
  data: z.object({ createIssue: z.object({ issue: issueNode }) }),
});

const subIssuesSchema = z.object({
  data: z.object({
    node: z.object({
      subIssues: z.object({
        nodes: z.array(issueNode.extend({ state: z.enum(["OPEN", "CLOSED"]), body: z.string() })),
      }).optional(),
    }).nullable(),
  }),
});

const mutationSchema = (name: string) =>
  z.object({ data: z.object({ [name]: z.object({ issue: z.object({ id: z.string() }) }) }) });

const CREATE_SUB_ISSUE =
  `mutation($repositoryId: ID!, $parentIssueId: ID!, $title: String!, $body: String!) { createIssue(input: { repositoryId: $repositoryId, parentIssueId: $parentIssueId, title: $title, body: $body }) { issue { id url } } }`;
const FIND_SUB_ISSUES =
  `query($id: ID!) { node(id: $id) { ... on Issue { subIssues(first: 100) { nodes { id url state body } } } } }`;
const UPDATE_ISSUE =
  `mutation($id: ID!, $title: String!, $body: String!) { updateIssue(input: { id: $id, title: $title, body: $body }) { issue { id } } }`;
const CLOSE_ISSUE =
  `mutation($id: ID!, $reason: IssueClosedStateReason!) { closeIssue(input: { issueId: $id, stateReason: $reason }) { issue { id } } }`;

const STATE_REASON = { completed: "COMPLETED", not_planned: "NOT_PLANNED" } as const;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function ghTracker(run: GhRun = defaultGhRun): Tracker {
  /** projectPath → リポジトリの node id。createSubIssue の repositoryId に使う。 */
  const repoIds = new Map<string, string>();

  async function repoIdOf(projectPath: string): Promise<string> {
    const known = repoIds.get(projectPath);
    if (known !== undefined) return known;
    const { id } = parseGhJson(
      repoIdSchema,
      await run(["repo", "view", "--json", "id"], projectPath),
      "gh repo view",
    );
    repoIds.set(projectPath, id);
    return id;
  }

  return {
    async status(projectPath): Promise<GhStatus> {
      try {
        await run(["--version"], projectPath);
      } catch (e) {
        return { ok: false, reason: "not_installed", message: message(e) };
      }
      try {
        await run(["auth", "status"], projectPath);
      } catch (e) {
        return { ok: false, reason: "not_logged_in", message: message(e) };
      }
      let out: string;
      try {
        out = await run(["repo", "view", "--json", "id,nameWithOwner"], projectPath);
      } catch (e) {
        return { ok: false, reason: "no_github_remote", message: message(e) };
      }
      const repo = parseGhJson(repoSchema, out, "gh repo view");
      repoIds.set(projectPath, repo.id);
      return { ok: true, repo };
    },

    async listIssues(projectPath, o) {
      const args = [
        "issue",
        "list",
        "--state",
        "open",
        "--json",
        "url,number,title,assignees,updatedAt",
        "--limit",
        "100",
      ];
      if (o.assignee === "me") args.push("--assignee", "@me");
      if (o.search) args.push("--search", o.search);
      const rows = parseGhJson(listSchema, await run(args, projectPath), "gh issue list");
      return rows.map((r) => ({ ...r, assignees: r.assignees.map((a) => a.login) }));
    },

    async readIssue(projectPath, url) {
      const args = ["issue", "view", url, "--json", "url,id,title,body,comments"];
      const v = parseGhJson(viewSchema, await run(args, projectPath), "gh issue view");
      return {
        url: v.url,
        nodeId: v.id,
        title: v.title,
        body: v.body,
        comments: v.comments.map((c) => ({
          author: c.author?.login ?? null,
          body: c.body,
          createdAt: c.createdAt,
        })),
      };
    },

    async createSubIssue(projectPath, parent, o) {
      const repositoryId = await repoIdOf(projectPath);
      const args = graphqlArgs(CREATE_SUB_ISSUE, {
        repositoryId,
        parentIssueId: parent.nodeId,
        title: o.title,
        body: o.body,
      });
      const res = parseGhJson(
        createSchema,
        await run(args, projectPath),
        "gh api graphql createIssue",
      );
      const { id, url } = res.data.createIssue.issue;
      return { url, nodeId: id };
    },

    async findSubIssues(projectPath, parent): Promise<SubIssue[]> {
      const args = graphqlArgs(FIND_SUB_ISSUES, { id: parent.nodeId });
      const res = parseGhJson(
        subIssuesSchema,
        await run(args, projectPath),
        "gh api graphql subIssues",
      );
      const subIssues = res.data.node?.subIssues;
      if (!subIssues) throw new Error(`${parent.url} は Issue ではありません`);
      return subIssues.nodes.map((n) => ({
        ref: { url: n.url, nodeId: n.id } satisfies IssueRef,
        body: n.body,
        state: n.state,
      }));
    },

    async updateIssue(projectPath, issue, o) {
      const args = graphqlArgs(UPDATE_ISSUE, { id: issue.nodeId, title: o.title, body: o.body });
      parseGhJson(
        mutationSchema("updateIssue"),
        await run(args, projectPath),
        "gh api graphql updateIssue",
      );
    },

    async closeIssue(projectPath, issue, reason) {
      // enum も -f の文字列で渡す。GraphQL の変数の強制変換で IssueClosedStateReason になる。
      const args = graphqlArgs(CLOSE_ISSUE, { id: issue.nodeId, reason: STATE_REASON[reason] });
      parseGhJson(
        mutationSchema("closeIssue"),
        await run(args, projectPath),
        "gh api graphql closeIssue",
      );
    },
  };
}
