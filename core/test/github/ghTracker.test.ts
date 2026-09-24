import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { ghTracker } from "../../src/github/ghTracker.ts";
import { fakeGh, parseGraphqlArgs } from "../helpers/gh.ts";

const P = "/repo";
const isRepoView = (a: string[]) => a[0] === "repo" && a[1] === "view";
const isGraphql = (a: string[]) => a[0] === "api" && a[1] === "graphql";

test("status: 3 つとも通れば repo を target として返す", async () => {
  const { run, calls } = fakeGh((a) => {
    if (a[0] === "--version" || a[0] === "auth") return "";
    if (isRepoView(a)) return JSON.stringify({ id: "R_1", nameWithOwner: "o/r" });
  });
  const s = await ghTracker(run).status(P);
  assert.deepEqual(s, { ok: true, target: { id: "R_1", name: "o/r" } });
  assert.deepEqual(calls.map((c) => c.args), [
    ["--version"],
    ["auth", "status"],
    ["repo", "view", "--json", "id,nameWithOwner"],
  ]);
  assert.ok(calls.every((c) => c.cwd === P));
});

test("status: gh が無ければ not_installed", async () => {
  const { run, calls } = fakeGh(() => new Deno.errors.NotFound("gh"));
  const s = await ghTracker(run).status(P);
  assert.equal(s.ok, false);
  if (!s.ok) assert.equal(s.reason, "not_installed");
  assert.equal(calls.length, 1);
});

test("status: 未ログインなら not_logged_in", async () => {
  const { run, calls } = fakeGh((a) => {
    if (a[0] === "--version") return "";
    if (a[0] === "auth") {
      return new Error("Command failed: gh auth status\nYou are not logged into any GitHub hosts");
    }
  });
  const s = await ghTracker(run).status(P);
  assert.equal(s.ok, false);
  if (!s.ok) {
    assert.equal(s.reason, "not_logged_in");
    assert.match(s.message, /not logged into any GitHub hosts/);
  }
  assert.ok(!calls.some((c) => isRepoView(c.args)));
});

test("status: GitHub の remote が無ければ no_github_remote", async () => {
  const { run } = fakeGh((a) => {
    if (a[0] === "--version" || a[0] === "auth") return "";
    if (isRepoView(a)) return new Error("Command failed: gh repo view\nno git remotes found");
  });
  const s = await ghTracker(run).status(P);
  assert.equal(s.ok, false);
  if (!s.ok) assert.equal(s.reason, "no_github_remote");
});

const LIST_ARGS = [
  "issue",
  "list",
  "--state",
  "open",
  "--json",
  "url,number,title,assignees,updatedAt",
  "--limit",
  "100",
];

const issueRow = {
  url: "https://github.com/o/r/issues/1",
  number: 1,
  title: "T",
  assignees: [{ login: "a" }],
  updatedAt: "2026-09-21T00:00:00Z",
};

test("listIssues: 既定は自分の担当で絞る", async () => {
  const { run, calls } = fakeGh(() => JSON.stringify([issueRow]));
  const rows = await ghTracker(run).listIssues(P, { assignee: "me" });
  assert.deepEqual(calls[0].args, [...LIST_ARGS, "--assignee", "@me"]);
  assert.equal(calls[0].cwd, P);
  assert.deepEqual(rows, [{
    url: issueRow.url,
    identifier: "#1",
    title: issueRow.title,
    assignees: ["a"],
    updatedAt: issueRow.updatedAt,
  }]);
});

test("listIssues: any なら担当者で絞らず、検索語を渡す", async () => {
  const { run, calls } = fakeGh(() => "[]");
  await ghTracker(run).listIssues(P, { assignee: "any", search: "label:bug" });
  assert.ok(!calls[0].args.includes("--assignee"));
  const i = calls[0].args.indexOf("--search");
  assert.equal(calls[0].args[i + 1], "label:bug");
});

test("listIssues: 空の検索語は渡さない", async () => {
  const { run, calls } = fakeGh(() => "[]");
  await ghTracker(run).listIssues(P, { assignee: "me", search: "" });
  assert.ok(!calls[0].args.includes("--search"));
});

const URL1 = "https://github.com/o/r/issues/1";

test("readIssue: 本文とコメントを読む", async () => {
  const { run, calls } = fakeGh(() =>
    JSON.stringify({
      url: URL1,
      id: "I_1",
      title: "T",
      body: "B",
      comments: [
        { author: { login: "a" }, body: "c1", createdAt: "2026-09-21T00:00:00Z" },
        { author: null, body: "c2", createdAt: "2026-09-21T01:00:00Z" },
      ],
    })
  );
  const d = await ghTracker(run).readIssue(P, URL1);
  assert.deepEqual(calls[0].args, ["issue", "view", URL1, "--json", "url,id,title,body,comments"]);
  assert.equal(calls[0].cwd, P);
  assert.equal(d.nodeId, "I_1");
  assert.equal(d.url, URL1);
  assert.deepEqual(d.comments.map((c) => c.author), ["a", null]);
});

test("readIssue: JSON でない出力はラベル付きで投げる", async () => {
  const { run } = fakeGh(() => "not json");
  await assert.rejects(ghTracker(run).readIssue(P, URL1), /gh issue view/);
});

test("readIssue: 形の違う出力は投げる", async () => {
  const { run } = fakeGh(() => JSON.stringify({ url: "u" }));
  await assert.rejects(ghTracker(run).readIssue(P, URL1), Error);
});

const created = JSON.stringify({
  data: { createIssue: { issue: { id: "I_new", url: "https://github.com/o/r/issues/2" } } },
});
const parent = { url: URL1, nodeId: "I_parent" };

function creatingGh() {
  return fakeGh((a) => {
    if (a[0] === "--version" || a[0] === "auth") return "";
    if (isRepoView(a)) {
      return JSON.stringify(
        a.includes("id,nameWithOwner") ? { id: "R_1", nameWithOwner: "o/r" } : { id: "R_1" },
      );
    }
    if (isGraphql(a)) return created;
  });
}

test("createSubIssue: 親の node id と repo id を渡して 1 回で作る", async () => {
  const { run, calls } = creatingGh();
  const t = ghTracker(run);
  await t.status(P);
  calls.length = 0;
  const ref = await t.createSubIssue(P, parent, { title: "T", body: "B" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cwd, P);
  const g = parseGraphqlArgs(calls[0].args);
  assert.equal(g.raw.repositoryId, "R_1");
  assert.equal(g.raw.parentIssueId, "I_parent");
  assert.equal(g.raw.title, "T");
  assert.match(g.query, /createIssue/);
  assert.deepEqual(ref, { url: "https://github.com/o/r/issues/2", nodeId: "I_new" });
});

test("createSubIssue: repo id を知らなければ gh repo view で引いて覚える", async () => {
  const { run, calls } = creatingGh();
  const t = ghTracker(run);
  await t.createSubIssue(P, parent, { title: "A", body: "" });
  await t.createSubIssue(P, parent, { title: "B", body: "" });
  const views = calls.filter((c) => isRepoView(c.args));
  assert.equal(views.length, 1);
  assert.deepEqual(views[0].args, ["repo", "view", "--json", "id"]);
});

test("createSubIssue: @ で始まる本文も文字列のまま渡す", async () => {
  const { run, calls } = creatingGh();
  await ghTracker(run).createSubIssue(P, parent, { title: "T", body: "@file の話" });
  const g = parseGraphqlArgs(calls.find((c) => isGraphql(c.args))!.args);
  assert.equal(g.raw.body, "@file の話");
  assert.ok(!("body" in g.typed));
});

test("findSubIssues: 親の sub-issue を本文と状態つきで返す", async () => {
  const { run, calls } = fakeGh(() =>
    JSON.stringify({
      data: {
        node: {
          subIssues: {
            nodes: [
              { id: "I_a", url: "https://github.com/o/r/issues/3", state: "OPEN", body: "x" },
              { id: "I_b", url: "https://github.com/o/r/issues/4", state: "CLOSED", body: "y" },
            ],
          },
        },
      },
    })
  );
  const subs = await ghTracker(run).findSubIssues(P, parent);
  assert.equal(calls[0].cwd, P);
  assert.equal(parseGraphqlArgs(calls[0].args).raw.id, "I_parent");
  assert.deepEqual(subs, [
    { ref: { url: "https://github.com/o/r/issues/3", nodeId: "I_a" }, body: "x", state: "OPEN" },
    { ref: { url: "https://github.com/o/r/issues/4", nodeId: "I_b" }, body: "y", state: "CLOSED" },
  ]);
});

test("findSubIssues: Issue でない node は投げる", async () => {
  const { run } = fakeGh(() => JSON.stringify({ data: { node: null } }));
  await assert.rejects(ghTracker(run).findSubIssues(P, parent), /Issue ではありません/);
});

test("updateIssue: タイトルと本文を node id で更新する", async () => {
  const { run, calls } = fakeGh(() =>
    JSON.stringify({ data: { updateIssue: { issue: { id: "I_2" } } } })
  );
  await ghTracker(run).updateIssue(P, { url: URL1, nodeId: "I_2" }, { title: "T2", body: "B2" });
  assert.equal(calls[0].cwd, P);
  const g = parseGraphqlArgs(calls[0].args);
  assert.match(g.query, /updateIssue/);
  assert.equal(g.raw.id, "I_2");
  assert.equal(g.raw.title, "T2");
  assert.equal(g.raw.body, "B2");
});

test("closeIssue: 理由を stateReason に写す", async () => {
  const { run, calls } = fakeGh(() =>
    JSON.stringify({ data: { closeIssue: { issue: { id: "I_2" } } } })
  );
  const t = ghTracker(run);
  const ref = { url: URL1, nodeId: "I_2" };
  await t.closeIssue(P, ref, "completed");
  await t.closeIssue(P, ref, "not_planned");
  const gs = calls.map((c) => parseGraphqlArgs(c.args));
  assert.deepEqual(gs.map((g) => g.raw.reason), ["COMPLETED", "NOT_PLANNED"]);
  assert.ok(gs.every((g) => /closeIssue/.test(g.query) && g.raw.id === "I_2"));
  assert.ok(calls.every((c) => c.cwd === P));
});

test("gh の失敗はそのまま投げる", async () => {
  const err = new Error("Command failed: gh api graphql\nboom");
  const { run } = fakeGh(() => err);
  await assert.rejects(
    ghTracker(run).updateIssue(P, { url: URL1, nodeId: "I_2" }, { title: "T", body: "B" }),
    (e) => e === err,
  );
});
