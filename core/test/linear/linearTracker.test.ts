import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { linearTracker } from "../../src/linear/linearTracker.ts";
import { fakeLinear } from "../helpers/linear.ts";

const P = "/repo";
const KEY = "lin_api_x";
const U1 = "https://linear.app/acme/issue/ENG-1/first";
const parent = { url: U1, nodeId: "uuid-parent" };
const issue = { url: U1, nodeId: "uuid-2" };

const t = (f: typeof fetch) => linearTracker({ apiKey: KEY, team: "ENG", fetch: f });
const has = (q: string, name: string) => q.includes(name);
const errors = (status: number, message: string) =>
  new Response(JSON.stringify({ errors: [{ message }] }), { status });

test("status: キーとチームが引ければ チームを target として返す", async () => {
  const { fetch, calls } = fakeLinear((q) => {
    if (has(q, "viewer")) return { viewer: { id: "u1" } };
    if (has(q, "teams")) return { teams: { nodes: [{ id: "team-1", name: "Engineering" }] } };
  });
  assert.deepEqual(await t(fetch).status(P), {
    ok: true,
    target: { id: "team-1", name: "Engineering" },
  });
  const teamCall = calls.find((c) => has(c.query, "teams"));
  assert.deepEqual(teamCall?.variables, { key: "ENG" });
});

test("status: API key が無ければ fetch せずに no_api_key", async () => {
  const { fetch, calls } = fakeLinear(() => undefined);
  const res = await linearTracker({ apiKey: undefined, team: "ENG", fetch }).status(P);
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.reason, "no_api_key");
  assert.equal(calls.length, 0);
});

test("status: viewer が引けなければ invalid_api_key", async () => {
  const { fetch, calls } = fakeLinear((q) => {
    if (has(q, "viewer")) return errors(400, "Authentication required");
  });
  const res = await t(fetch).status(P);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.reason, "invalid_api_key");
    assert.match(res.message, /Authentication required/);
  }
  assert.equal(calls.some((c) => has(c.query, "teams")), false);
});

test("status: チームのキーで引けなければ team_not_found", async () => {
  const { fetch } = fakeLinear((q) => {
    if (has(q, "viewer")) return { viewer: { id: "u1" } };
    if (has(q, "teams")) return { teams: { nodes: [] } };
  });
  const res = await t(fetch).status(P);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.reason, "team_not_found");
    assert.match(res.message, /ENG/);
  }
});

test("リクエスト: Authorization に API key をそのまま入れて POST する", async () => {
  const { fetch, calls } = fakeLinear(() => ({ issueUpdate: { success: true } }));
  await t(fetch).updateIssue(P, issue, { title: "T", body: "B" });
  assert.equal(calls[0].url, "https://api.linear.app/graphql");
  assert.equal(calls[0].headers.get("authorization"), KEY);
  assert.match(calls[0].headers.get("content-type") ?? "", /application\/json/);
});

const row = {
  url: U1,
  identifier: "ENG-1",
  title: "T",
  updatedAt: "2026-09-21T00:00:00Z",
  assignee: { displayName: "alice" },
};

test("listIssues: me ならチーム・未完了・自分の担当で絞る", async () => {
  const { fetch, calls } = fakeLinear(() => ({ issues: { nodes: [row] } }));
  const res = await t(fetch).listIssues(P, { assignee: "me" });
  assert.deepEqual(calls[0].variables.filter, {
    team: { key: { eq: "ENG" } },
    state: { type: { nin: ["completed", "canceled"] } },
    assignee: { isMe: { eq: true } },
  });
  assert.deepEqual(res, [{
    url: U1,
    identifier: "ENG-1",
    title: "T",
    assignees: ["alice"],
    updatedAt: "2026-09-21T00:00:00Z",
  }]);
});

test("listIssues: any なら担当者で絞らず、検索語でタイトルを絞る", async () => {
  const { fetch, calls } = fakeLinear(() => ({ issues: { nodes: [] } }));
  await t(fetch).listIssues(P, { assignee: "any", search: "bug" });
  const filter = calls[0].variables.filter as Record<string, unknown>;
  assert.equal("assignee" in filter, false);
  assert.deepEqual(filter.title, { containsIgnoreCase: "bug" });
});

test("listIssues: 空の検索語は渡さない", async () => {
  const { fetch, calls } = fakeLinear(() => ({ issues: { nodes: [] } }));
  await t(fetch).listIssues(P, { assignee: "me", search: "" });
  assert.equal("title" in (calls[0].variables.filter as object), false);
});

test("listIssues: 担当者がいなければ assignees は空", async () => {
  const { fetch } = fakeLinear(() => ({ issues: { nodes: [{ ...row, assignee: null }] } }));
  const res = await t(fetch).listIssues(P, { assignee: "any" });
  assert.deepEqual(res[0].assignees, []);
});

const detail = (over: Record<string, unknown> = {}) => ({
  issue: {
    id: "uuid-1",
    url: U1,
    title: "T",
    description: "B",
    comments: {
      nodes: [
        { body: "new", createdAt: "2026-09-21T01:00:00Z", user: { displayName: "alice" } },
        { body: "old", createdAt: "2026-09-21T00:00:00Z", user: null },
      ],
    },
    ...over,
  },
});

test("readIssue: URL の識別子で引き、本文とコメントを古い順で返す", async () => {
  const { fetch, calls } = fakeLinear(() => detail());
  const res = await t(fetch).readIssue(P, "https://linear.app/acme/issue/ENG-1/first#comment-9");
  assert.deepEqual(calls[0].variables, { id: "ENG-1" });
  assert.equal(res.url, U1);
  assert.equal(res.nodeId, "uuid-1");
  assert.equal(res.body, "B");
  assert.deepEqual(res.comments.map((c) => c.author), [null, "alice"]);
});

test("readIssue: 本文が null なら空文字", async () => {
  const { fetch } = fakeLinear(() => detail({ description: null }));
  assert.equal((await t(fetch).readIssue(P, U1)).body, "");
});

test("readIssue: Linear の Issue の URL でなければ fetch せずに投げる", async () => {
  const { fetch, calls } = fakeLinear(() => undefined);
  await assert.rejects(
    t(fetch).readIssue(P, "https://github.com/o/r/issues/1"),
    /Linear の Issue の URL ではありません/,
  );
  assert.equal(calls.length, 0);
});

test("readIssue: Issue が無ければ投げる", async () => {
  const { fetch } = fakeLinear(() => ({ issue: null }));
  await assert.rejects(t(fetch).readIssue(P, U1), /見つかりません/);
});

test("listIssues と readIssue は同じ Issue に同じ url を返す", async () => {
  const { fetch } = fakeLinear((q) => has(q, "issues(") ? { issues: { nodes: [row] } } : detail());
  const tr = t(fetch);
  const listed = await tr.listIssues(P, { assignee: "any" });
  const read = await tr.readIssue(P, "https://linear.app/acme/issue/ENG-1/old-slug");
  assert.equal(listed[0].url, read.url);
});

const createRes = {
  issueCreate: {
    success: true,
    issue: { id: "uuid-new", url: "https://linear.app/acme/issue/ENG-2/t" },
  },
};

test("createSubIssue: 親のチームと担当者で、親の子として作る", async () => {
  const { fetch, calls } = fakeLinear((q) => {
    if (has(q, "issueCreate")) return createRes;
    return { issue: { team: { id: "team-1" }, assignee: { id: "user-1" } } };
  });
  const res = await t(fetch).createSubIssue(P, parent, { title: "T", body: "B" });
  assert.deepEqual(calls[0].variables, { id: "uuid-parent" });
  assert.deepEqual(calls[1].variables.input, {
    teamId: "team-1",
    parentId: "uuid-parent",
    title: "T",
    description: "B",
    assigneeId: "user-1",
  });
  assert.deepEqual(res, { url: "https://linear.app/acme/issue/ENG-2/t", nodeId: "uuid-new" });
});

test("createSubIssue: 親に担当者がいなければ assigneeId を渡さない", async () => {
  const { fetch, calls } = fakeLinear((q) => {
    if (has(q, "issueCreate")) return createRes;
    return { issue: { team: { id: "team-1" }, assignee: null } };
  });
  await t(fetch).createSubIssue(P, parent, { title: "T", body: "B" });
  assert.equal("assigneeId" in (calls[1].variables.input as object), false);
});

test("createSubIssue: success が false なら投げる", async () => {
  const { fetch } = fakeLinear((q) => {
    if (has(q, "issueCreate")) return { issueCreate: { success: false, issue: null } };
    return { issue: { team: { id: "team-1" }, assignee: null } };
  });
  await assert.rejects(t(fetch).createSubIssue(P, parent, { title: "T", body: "B" }));
});

test("findSubIssues: 子を本文と状態つきで返し、completed と canceled は CLOSED", async () => {
  const child = (id: string, type: string, description: string | null = "b") => ({
    id,
    url: `https://linear.app/acme/issue/ENG-${id}/x`,
    description,
    state: { type },
  });
  const { fetch, calls } = fakeLinear(() => ({
    issue: {
      children: {
        nodes: [
          child("3", "started"),
          child("4", "unstarted", null),
          child("5", "completed"),
          child("6", "canceled"),
        ],
      },
    },
  }));
  const res = await t(fetch).findSubIssues(P, parent);
  assert.deepEqual(calls[0].variables, { id: "uuid-parent" });
  assert.deepEqual(res.map((s) => s.state), ["OPEN", "OPEN", "CLOSED", "CLOSED"]);
  assert.deepEqual(res[0].ref, { url: "https://linear.app/acme/issue/ENG-3/x", nodeId: "3" });
  assert.equal(res[1].body, "");
});

test("findSubIssues: Issue が無ければ投げる", async () => {
  const { fetch } = fakeLinear(() => ({ issue: null }));
  await assert.rejects(t(fetch).findSubIssues(P, parent), /見つかりません/);
});

test("updateIssue: タイトルと本文を id で更新する", async () => {
  const { fetch, calls } = fakeLinear(() => ({ issueUpdate: { success: true } }));
  await t(fetch).updateIssue(P, issue, { title: "T2", body: "B2" });
  assert.deepEqual(calls[0].variables, {
    id: "uuid-2",
    input: { title: "T2", description: "B2" },
  });
});

const states = (extra: object[] = []) => [
  { id: "s-done2", type: "completed", position: 5 },
  { id: "s-done", type: "completed", position: 2 },
  { id: "s-cancel", type: "canceled", position: 3 },
  { id: "s-todo", type: "unstarted", position: 0 },
  ...extra,
];
const closeFake = (nodes: object[]) =>
  fakeLinear((q) => {
    if (has(q, "issueUpdate")) return { issueUpdate: { success: true } };
    return { issue: { team: { states: { nodes } } } };
  });

test("closeIssue: completed は種類が completed の状態のうち position が最小のものへ移す", async () => {
  const { fetch, calls } = closeFake(states());
  await t(fetch).closeIssue(P, issue, "completed");
  assert.deepEqual(calls[1].variables, { id: "uuid-2", input: { stateId: "s-done" } });
});

test("closeIssue: not_planned は種類が canceled の状態へ移す", async () => {
  const { fetch, calls } = closeFake(states([{ id: "s-dup", type: "canceled", position: 4 }]));
  await t(fetch).closeIssue(P, issue, "not_planned");
  assert.deepEqual(calls[1].variables, { id: "uuid-2", input: { stateId: "s-cancel" } });
});

test("closeIssue: その種類の状態が無ければ投げる", async () => {
  const { fetch, calls } = closeFake([{ id: "s-todo", type: "unstarted", position: 0 }]);
  await assert.rejects(t(fetch).closeIssue(P, issue, "not_planned"), /canceled/);
  assert.equal(calls.some((c) => has(c.query, "issueUpdate")), false);
});

test("GraphQL の errors は Error にする", async () => {
  const { fetch } = fakeLinear(() => errors(200, "boom"));
  await assert.rejects(t(fetch).updateIssue(P, issue, { title: "T", body: "B" }), /boom/);
});

test("HTTP の失敗は Error にする", async () => {
  const { fetch } = fakeLinear(() => new Response("oops", { status: 500 }));
  await assert.rejects(t(fetch).updateIssue(P, issue, { title: "T", body: "B" }), /HTTP 500/);
});

test("形の違う応答は投げる", async () => {
  const { fetch } = fakeLinear(() => ({ issue: { id: 1 } }));
  await assert.rejects(t(fetch).readIssue(P, U1), /想定した形ではありません/);
});

test("API key が無ければ status 以外は投げる", async () => {
  const { fetch, calls } = fakeLinear(() => undefined);
  await assert.rejects(
    linearTracker({ apiKey: undefined, team: "ENG", fetch }).listIssues(P, { assignee: "any" }),
    /linearApiKey/,
  );
  assert.equal(calls.length, 0);
});
