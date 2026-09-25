import { z } from "zod";
import type { IssueRef, TrackerStatus } from "../../../shared/intake/tracker.ts";
import type { SubIssue, Tracker } from "../tracker/tracker.ts";
import { linearGraphql } from "./linear.ts";

const viewerSchema = z.object({ viewer: z.object({ id: z.string() }) });
const teamSchema = z.object({
  teams: z.object({ nodes: z.array(z.object({ id: z.string(), name: z.string() })) }),
});

const person = z.object({ displayName: z.string() }).nullable();

const listSchema = z.object({
  issues: z.object({
    nodes: z.array(z.object({
      url: z.string(),
      identifier: z.string(),
      title: z.string(),
      updatedAt: z.string(),
      assignee: person,
    })),
  }),
});

const readSchema = z.object({
  issue: z.object({
    id: z.string(),
    url: z.string(),
    title: z.string(),
    description: z.string().nullable(),
    comments: z.object({
      nodes: z.array(z.object({ body: z.string(), createdAt: z.string(), user: person })),
    }),
  }).nullable(),
});

const parentSchema = z.object({
  issue: z.object({
    team: z.object({ id: z.string() }),
    assignee: z.object({ id: z.string() }).nullable(),
  }).nullable(),
});

const createSchema = z.object({
  issueCreate: z.object({
    success: z.boolean(),
    issue: z.object({ id: z.string(), url: z.string() }).nullable(),
  }),
});

const childrenSchema = z.object({
  issue: z.object({
    children: z.object({
      nodes: z.array(z.object({
        id: z.string(),
        url: z.string(),
        description: z.string().nullable(),
        state: z.object({ type: z.string() }),
      })),
    }),
  }).nullable(),
});

const updateSchema = z.object({ issueUpdate: z.object({ success: z.boolean() }) });

const teamStatesSchema = z.object({
  issue: z.object({
    team: z.object({
      states: z.object({
        nodes: z.array(z.object({ id: z.string(), type: z.string(), position: z.number() })),
      }),
    }),
  }).nullable(),
});

const VIEWER = `query { viewer { id } }`;
const TEAM = `query($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id name } } }`;
const LIST_ISSUES =
  `query($filter: IssueFilter!) { issues(first: 100, filter: $filter, orderBy: updatedAt) { nodes { url identifier title updatedAt assignee { displayName } } } }`;
const READ_ISSUE =
  `query($id: String!) { issue(id: $id) { id url title description comments(first: 100) { nodes { body createdAt user { displayName } } } } }`;
const PARENT_OF_SUB_ISSUE =
  `query($id: String!) { issue(id: $id) { team { id } assignee { id } } }`;
const CREATE_ISSUE =
  `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id url } } }`;
const FIND_SUB_ISSUES =
  `query($id: String!) { issue(id: $id) { children(first: 100) { nodes { id url description state { type } } } } }`;
const UPDATE_ISSUE =
  `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`;
const TEAM_STATES_OF_ISSUE =
  `query($id: String!) { issue(id: $id) { team { states { nodes { id type position } } } } }`;

const CLOSED_TYPES = ["completed", "canceled"];
const STATE_TYPE = { completed: "completed", not_planned: "canceled" } as const;

const NO_API_KEY = "config.json に linearApiKey がありません";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Issue の URL（.../issue/ENG-123/slug）から識別子を取り出す。 */
export function identifierOf(url: string): string {
  const m = url.match(/\/issue\/([A-Za-z0-9]+-\d+)(?=[/?#]|$)/);
  if (!m) throw new Error(`${url} は Linear の Issue の URL ではありません`);
  return m[1];
}

export function linearTracker(o: {
  apiKey: string | undefined;
  team: string; // チームのキー（ENG など）
  fetch?: typeof fetch;
}): Tracker {
  const doFetch: typeof fetch = o.fetch ?? ((input, init) => fetch(input, init));

  function request<T>(
    query: string,
    variables: Record<string, unknown>,
    schema: z.ZodType<T>,
    label: string,
  ): Promise<T> {
    if (o.apiKey === undefined) return Promise.reject(new Error(NO_API_KEY));
    return linearGraphql({ apiKey: o.apiKey, fetch: doFetch }, query, variables, schema, label);
  }

  async function update(id: string, input: Record<string, unknown>): Promise<void> {
    const res = await request(UPDATE_ISSUE, { id, input }, updateSchema, "issueUpdate");
    if (!res.issueUpdate.success) throw new Error(`Issue ${id} を更新できませんでした`);
  }

  return {
    kind: "linear",
    closesViaPullRequest: false,
    async status(): Promise<TrackerStatus> {
      if (o.apiKey === undefined) {
        return { ok: false, reason: "no_api_key", message: NO_API_KEY };
      }
      try {
        await request(VIEWER, {}, viewerSchema, "viewer");
      } catch (e) {
        return { ok: false, reason: "invalid_api_key", message: message(e) };
      }
      const { teams } = await request(TEAM, { key: o.team }, teamSchema, "teams");
      const team = teams.nodes[0];
      if (!team) {
        return {
          ok: false,
          reason: "team_not_found",
          message: `チーム ${o.team} が見つかりません`,
        };
      }
      return { ok: true, target: { id: team.id, name: team.name } };
    },

    async listIssues(_projectPath, opts) {
      const filter: Record<string, unknown> = {
        team: { key: { eq: o.team } },
        state: { type: { nin: CLOSED_TYPES } },
      };
      if (opts.assignee === "me") filter.assignee = { isMe: { eq: true } };
      if (opts.search) filter.title = { containsIgnoreCase: opts.search };
      const { issues } = await request(LIST_ISSUES, { filter }, listSchema, "issues");
      return issues.nodes.map((n) => ({
        url: n.url,
        identifier: n.identifier,
        title: n.title,
        assignees: n.assignee ? [n.assignee.displayName] : [],
        updatedAt: n.updatedAt,
      }));
    },

    async readIssue(_projectPath, url) {
      const id = identifierOf(url);
      const { issue } = await request(READ_ISSUE, { id }, readSchema, "issue");
      if (!issue) throw new Error(`${url} の Issue が見つかりません`);
      const comments = [...issue.comments.nodes]
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map((c) => ({
          author: c.user?.displayName ?? null,
          body: c.body,
          createdAt: c.createdAt,
        }));
      return {
        url: issue.url,
        nodeId: issue.id,
        title: issue.title,
        body: issue.description ?? "",
        comments,
      };
    },

    async createSubIssue(_projectPath, parent, opts): Promise<IssueRef> {
      const { issue: found } = await request(
        PARENT_OF_SUB_ISSUE,
        { id: parent.nodeId },
        parentSchema,
        "issue",
      );
      if (!found) throw new Error(`${parent.url} の Issue が見つかりません`);
      const input: Record<string, unknown> = {
        teamId: found.team.id,
        parentId: parent.nodeId,
        title: opts.title,
        description: opts.body,
      };
      if (found.assignee) input.assigneeId = found.assignee.id;
      const { issueCreate } = await request(CREATE_ISSUE, { input }, createSchema, "issueCreate");
      if (!issueCreate.success || !issueCreate.issue) {
        throw new Error("sub-issue を作れませんでした");
      }
      return { url: issueCreate.issue.url, nodeId: issueCreate.issue.id };
    },

    async findSubIssues(_projectPath, parent): Promise<SubIssue[]> {
      const { issue } = await request(
        FIND_SUB_ISSUES,
        { id: parent.nodeId },
        childrenSchema,
        "issue",
      );
      if (!issue) throw new Error(`${parent.url} の Issue が見つかりません`);
      return issue.children.nodes.map((n) => ({
        ref: { url: n.url, nodeId: n.id },
        body: n.description ?? "",
        state: CLOSED_TYPES.includes(n.state.type) ? "CLOSED" : "OPEN",
      }));
    },

    async updateIssue(_projectPath, issue, opts) {
      await update(issue.nodeId, { title: opts.title, description: opts.body });
    },

    async closeIssue(_projectPath, issue, reason) {
      const { issue: found } = await request(
        TEAM_STATES_OF_ISSUE,
        { id: issue.nodeId },
        teamStatesSchema,
        "issue",
      );
      if (!found) throw new Error(`${issue.url} の Issue が見つかりません`);
      const type = STATE_TYPE[reason];
      const target = found.team.states.nodes
        .filter((s) => s.type === type)
        .sort((a, b) => a.position - b.position)[0];
      if (!target) throw new Error(`チームに種類が ${type} の状態がありません`);
      await update(issue.nodeId, { stateId: target.id });
    },
  };
}
