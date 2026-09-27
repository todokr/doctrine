import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { ghTracker } from "../../src/github/ghTracker.ts";
import { workspaceTracker } from "../../src/tracker/workspaceTracker.ts";
import type { WorkspaceRef } from "../../src/tracker/workspaceTracker.ts";
import { fakeGh } from "../helpers/gh.ts";
import { fakeTracker } from "../helpers/tracker.ts";

const WS: WorkspaceRef = {
  path: "/ws",
  projects: [
    { name: "a", path: "/ws/a" },
    { name: "b", path: "/ws/b" },
    { name: "c", path: "/ws/c" },
  ],
};

function withProjects(names: string[]): WorkspaceRef {
  return { path: WS.path, projects: WS.projects.filter((p) => names.includes(p.name)) };
}

const A_ISSUES = [
  {
    url: "https://github.com/o/a/issues/1",
    number: 1,
    title: "A1",
    assignees: [] as { login: string }[],
    updatedAt: "2026-09-20T00:00:00Z",
  },
];
const B_ISSUES = [
  {
    url: "https://github.com/o/b/issues/2",
    number: 2,
    title: "B2",
    assignees: [{ login: "me" }],
    updatedAt: "2026-09-22T00:00:00Z",
  },
];

function fakeGhTracker() {
  const { run, calls } = fakeGh((args, cwd) => {
    if (args[0] === "--version" || args[0] === "auth") return "";
    if (args[0] === "repo" && args[1] === "view") {
      if (cwd === "/ws/a") return JSON.stringify({ id: "R_a", nameWithOwner: "o/a" });
      if (cwd === "/ws/b") return JSON.stringify({ id: "R_b", nameWithOwner: "o/b" });
      if (cwd === "/ws/c") return new Error("no git remotes found");
    }
    if (args[0] === "issue" && args[1] === "list") {
      if (cwd === "/ws/a") return JSON.stringify(A_ISSUES);
      if (cwd === "/ws/b") return JSON.stringify(B_ISSUES);
      if (cwd === "/ws/c") return new Error("HTTP 404");
    }
    return undefined;
  });
  return { tracker: ghTracker(run), calls };
}

test("GitHub の一覧は全プロジェクトを updatedAt の降順で合わせ、識別子に名前を付ける", async () => {
  const { tracker } = fakeGhTracker();
  const wt = workspaceTracker(withProjects(["a", "b"]), tracker);
  const issues = await wt.listIssues({ assignee: "any" });
  assert.deepEqual(issues.map((i) => i.url), [
    "https://github.com/o/b/issues/2",
    "https://github.com/o/a/issues/1",
  ]);
  assert.deepEqual(issues.map((i) => i.identifier), ["b#2", "a#1"]);
  assert.deepEqual(issues.map((i) => i.assignees), [["me"], []]);
});

test("3 つのうち 1 つのリポジトリが落ちても一覧は残りを返し、status にその 1 つの失敗が出る", async () => {
  const { tracker } = fakeGhTracker();
  const wt = workspaceTracker(WS, tracker);
  const issues = await wt.listIssues({ assignee: "any" });
  assert.deepEqual(issues.map((i) => i.identifier), ["b#2", "a#1"]);
  const status = await wt.status();
  assert.deepEqual(status, [
    { ok: true, target: { id: "R_a", name: "o/a" }, project: "a" },
    { ok: true, target: { id: "R_b", name: "o/b" }, project: "b" },
    {
      ok: false,
      reason: "no_github_remote",
      project: "c",
      message: status[2].ok === false ? status[2].message : "",
    },
  ]);
  assert.ok(status[2].ok === false && status[2].message.includes("no git remotes found"));
});

test("すべてのリポジトリが落ちたら投げる", async () => {
  const { run } = fakeGh((args, cwd) => {
    if (args[0] === "--version" || args[0] === "auth") return "";
    if (args[0] === "repo" && args[1] === "view") {
      return JSON.stringify({ id: `R_${cwd}`, nameWithOwner: `o/${cwd}` });
    }
    if (args[0] === "issue" && args[1] === "list") return new Error("HTTP 404");
    return undefined;
  });
  const wt = workspaceTracker(withProjects(["a", "b"]), ghTracker(run));
  await assert.rejects(wt.listIssues({ assignee: "any" }));
});

test("projectPathFor は URL の owner/name でプロジェクトを選び、無ければ null", async () => {
  const { tracker, calls } = fakeGhTracker();
  const wt = workspaceTracker(withProjects(["a", "b"]), tracker);
  assert.equal(await wt.projectPathFor("https://github.com/o/b/issues/3"), "/ws/b");
  assert.equal(await wt.projectPathFor("https://github.com/O/A/issues/9"), "/ws/a");
  assert.equal(await wt.projectPathFor("https://github.com/x/y/issues/1"), null);
  assert.equal(await wt.projectPathFor("https://linear.app/acme/issue/ENG-1/x"), null);
  const before = calls.filter((c) => c.args[0] === "repo" && c.args[1] === "view").length;
  await wt.projectPathFor("https://github.com/o/b/issues/3");
  const after = calls.filter((c) => c.args[0] === "repo" && c.args[1] === "view").length;
  assert.equal(after, before);
});

test("repoOf が失敗したプロジェクトしか残らなければ projectPathFor は投げる", async () => {
  const { tracker } = fakeGhTracker();
  const wt = workspaceTracker(withProjects(["c"]), tracker);
  await assert.rejects(
    wt.projectPathFor("https://github.com/o/c/issues/1"),
    /no git remotes found/,
  );
});

test("プロジェクト 1 つの workspace では識別子がいまと同じ #<n>", async () => {
  const { tracker } = fakeGhTracker();
  const wt = workspaceTracker(withProjects(["a"]), tracker);
  const issues = await wt.listIssues({ assignee: "any" });
  assert.deepEqual(issues.map((i) => i.identifier), ["#1"]);
});

test("Linear は先頭のプロジェクトで 1 回だけ引き、status の project は先頭の名前", async () => {
  const ft = fakeTracker({}, {
    kind: "linear",
    status: { ok: true, target: { id: "T1", name: "Eng" } },
    issues: [
      {
        url: "https://linear.app/acme/issue/ENG-1/x",
        identifier: "ENG-1",
        title: "X",
        assignees: [],
        updatedAt: "2026-09-20T00:00:00Z",
      },
    ],
  });
  const wt = workspaceTracker(withProjects(["a", "b"]), ft);
  assert.deepEqual(await wt.status(), [{
    ok: true,
    target: { id: "T1", name: "Eng" },
    project: "a",
  }]);
  await wt.listIssues({ assignee: "any" });
  assert.equal(ft.listCalls.length, 1);
  assert.equal(await wt.projectPathFor("https://linear.app/acme/issue/ENG-1/x"), "/ws/a");
});
