import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { ghPrWatcher, PR_ALIASES_PER_QUERY } from "../../src/github/ghPrWatcher.ts";
import { fakeGh, parseGraphqlArgs } from "../helpers/gh.ts";

const P = "/repo";

type Node = {
  number: number;
  url: string;
  state: string;
  baseRefName: string;
  mergedAt: string | null;
  mergeCommit: { oid: string } | null;
};

const merged: Node = {
  number: 7,
  url: "https://github.com/o/r/pull/7",
  state: "MERGED",
  baseRefName: "main",
  mergedAt: "2026-09-21T00:00:00Z",
  mergeCommit: { oid: "abc" },
};

function response(byAlias: Record<string, Node[]>): string {
  const repository: Record<string, unknown> = {};
  for (const [k, nodes] of Object.entries(byAlias)) repository[k] = { nodes };
  return JSON.stringify({ data: { repository } });
}

test("ブランチが無ければ gh を呼ばない", async () => {
  const { run, calls } = fakeGh(() => "");
  const m = await ghPrWatcher(run).pullRequests(P, []);
  assert.equal(m.size, 0);
  assert.equal(calls.length, 0);
});

test("複数のブランチを 1 回で引き、別名ごとに振り分ける", async () => {
  const { run, calls } = fakeGh(() => response({ b0: [merged], b1: [] }));
  const branches = ["doctrine/a-ログイン", "doctrine/b"];
  const m = await ghPrWatcher(run).pullRequests(P, branches);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cwd, P);
  const g = parseGraphqlArgs(calls[0].args);
  assert.deepEqual(g.typed, { owner: "{owner}", name: "{repo}" });
  assert.deepEqual(g.raw, { h0: "doctrine/a-ログイン", h1: "doctrine/b" });
  assert.ok(!g.query.includes("doctrine/"));
  assert.deepEqual(m.get("doctrine/a-ログイン"), [{
    number: 7,
    url: "https://github.com/o/r/pull/7",
    state: "MERGED",
    baseRef: "main",
    mergedAt: "2026-09-21T00:00:00Z",
    mergeCommit: "abc",
  }]);
  assert.deepEqual(m.get("doctrine/b"), []);
});

test("開いている PR は mergeCommit と mergedAt が null", async () => {
  const open: Node = { ...merged, state: "OPEN", mergedAt: null, mergeCommit: null };
  const { run } = fakeGh(() => response({ b0: [open] }));
  const m = await ghPrWatcher(run).pullRequests(P, ["x"]);
  const [pr] = m.get("x")!;
  assert.equal(pr.state, "OPEN");
  assert.equal(pr.mergeCommit, null);
  assert.equal(pr.mergedAt, null);
});

function manyBranches(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `doctrine/t${i}`);
}

function emptyForArgs(args: string[]): string {
  const { raw } = parseGraphqlArgs(args);
  const byAlias: Record<string, Node[]> = {};
  for (const k of Object.keys(raw)) byAlias[`b${k.slice(1)}`] = [];
  return response(byAlias);
}

test("別名が 50 を超えたら分けて引く", async () => {
  assert.equal(PR_ALIASES_PER_QUERY, 50);
  const { run, calls } = fakeGh(emptyForArgs);
  const m = await ghPrWatcher(run).pullRequests(P, manyBranches(51));
  assert.equal(calls.length, 2);
  const first = parseGraphqlArgs(calls[0].args).raw;
  assert.deepEqual(Object.keys(first), Array.from({ length: 50 }, (_, i) => `h${i}`));
  assert.deepEqual(parseGraphqlArgs(calls[1].args).raw, { h0: "doctrine/t50" });
  assert.equal(m.size, 51);
});

test("同じブランチは 1 回だけ引く", async () => {
  const { run, calls } = fakeGh(emptyForArgs);
  const m = await ghPrWatcher(run).pullRequests(P, ["x", "x"]);
  assert.deepEqual(parseGraphqlArgs(calls[0].args).raw, { h0: "x" });
  assert.equal(m.size, 1);
});

test("マージ先が baseBranch 以外でもそのまま返す", async () => {
  const { run } = fakeGh(() => response({ b0: [{ ...merged, baseRefName: "release" }] }));
  const m = await ghPrWatcher(run).pullRequests(P, ["x"]);
  assert.equal(m.get("x")![0].baseRef, "release");
});

test("塊のどれかが失敗したら投げる", async () => {
  let n = 0;
  const { run } = fakeGh((a) => (++n === 2 ? new Error("boom") : emptyForArgs(a)));
  await assert.rejects(ghPrWatcher(run).pullRequests(P, manyBranches(51)), /boom/);
});
