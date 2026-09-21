import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import type { Pfd } from "../../../shared/intake/pfd.ts";
import { parseSubIssueMarker, subIssueMarker } from "../../../shared/intake/subIssue.ts";
import {
  insertIntake,
  insertProcesses,
  listProcesses,
  updateProcess,
} from "../../src/db/intakes.ts";
import { openDb } from "../../src/db/migrate.ts";
import type { Db } from "../../src/db/schema.ts";
import { insertProject } from "../../src/db/tasks.ts";
import { ghTracker } from "../../src/github/ghTracker.ts";
import { type SubIssueSyncInput, syncSubIssues } from "../../src/intake/subIssueSync.ts";
import { fakeGh, parseGraphqlArgs } from "../helpers/gh.ts";
import { type FakeTracker, fakeTracker, type TrackerCall } from "../helpers/fakeTracker.ts";
import { example } from "./pfd/fixture.ts";

const PARENT_URL = "https://github.com/o/r/issues/1";
const PARENT = { url: PARENT_URL, nodeId: "I_1" };

async function fixture(processIds = ["1", "2", "3", "4"]) {
  const d: Db = await openDb(":memory:");
  const projectId = await insertProject(d, {
    path: "/repo",
    default_workflow: "f",
    max_concurrent: 1,
    base_branch: "main",
    setup: null,
  });
  await insertIntake(d, {
    id: "i1",
    project_id: projectId,
    issue_url: PARENT_URL,
    issue_node_id: "I_1",
    issue_title: "T",
  });
  await insertProcesses(d, "i1", processIds);
  const ft = fakeTracker();
  const input = (pfd: Pfd = example()): SubIssueSyncInput => ({
    projectPath: "/repo",
    intake: { id: "i1", issue_url: PARENT_URL, issue_node_id: "I_1" },
    pfd,
  });
  return { d, ft, input };
}

const count = (ft: FakeTracker, op: TrackerCall["op"], from = 0) =>
  ft.calls.slice(from).filter((c) => c.op === op).length;

async function row(d: Db, processId: string) {
  return (await listProcesses(d, "i1")).find((r) => r.process_id === processId)!;
}

function issueOf(ft: FakeTracker, url: string | null) {
  return ft.issues.find((i) => i.ref.url === url)!;
}

/** プロセス 4 と成果物 feature を取り除いた案。 */
function withoutProcess4(): Pfd {
  const pfd = example();
  pfd.processes = pfd.processes.filter((p) => p.id !== "4");
  pfd.artifacts = pfd.artifacts.filter((a) => a.id !== "feature");
  pfd.goal = ["endpoint"];
  return pfd;
}

const now = () => new Date().toISOString();

test("偽の gh: ghTracker を通して初回の sub-issue を作る", async () => {
  const { d, input } = await fixture();
  let n = 100;
  const gh = fakeGh((a) => {
    if (a[0] === "repo" && a[1] === "view") return JSON.stringify({ id: "R_1" });
    if (a[0] === "api" && a[1] === "graphql") {
      const { query } = parseGraphqlArgs(a);
      if (/subIssues/.test(query)) {
        return JSON.stringify({ data: { node: { subIssues: { nodes: [] } } } });
      }
      if (/createIssue/.test(query)) {
        n++;
        return JSON.stringify({
          data: {
            createIssue: {
              issue: { id: `I_${n}`, url: `https://github.com/o/r/issues/${n}` },
            },
          },
        });
      }
    }
  });
  const result = await syncSubIssues(d, ghTracker(gh.run), input());
  assert.deepEqual(result.failures, []);
  const creates = gh.calls
    .map((c) => parseGraphqlArgs(c.args))
    .filter((g) => /createIssue/.test(g.query));
  assert.equal(creates.length, 4);
  const processIds: string[] = [];
  for (const g of creates) {
    assert.equal(g.raw.parentIssueId, "I_1");
    const marker = parseSubIssueMarker(g.raw.body)!;
    processIds.push(marker.processId);
    assert.equal(g.raw.body.split("\n").at(-1), subIssueMarker("i1", marker.processId));
  }
  assert.deepEqual(processIds.toSorted(), ["1", "2", "3", "4"]);
  for (const r of await listProcesses(d, "i1")) assert.notEqual(r.sub_issue_url, null);
});

test("初回: 人のプロセスを含む全プロセスの sub-issue を作って記録する", async () => {
  const { d, ft, input } = await fixture();
  const result = await syncSubIssues(d, ft.tracker, input());
  assert.deepEqual(ft.calls.map((c) => c.op), [
    "findSubIssues",
    "createSubIssue",
    "createSubIssue",
    "createSubIssue",
    "createSubIssue",
  ]);
  const order = ft.calls.filter((c) => c.op === "createSubIssue")
    .map((c) => parseSubIssueMarker((c as { body: string }).body)!.processId);
  assert.ok(order.indexOf("1") < order.indexOf("2"));
  assert.ok(order.indexOf("3") < order.indexOf("2"));
  assert.ok(order.indexOf("2") < order.indexOf("4"));
  for (const r of await listProcesses(d, "i1")) {
    assert.notEqual(r.sub_issue_url, null);
    assert.notEqual(r.sub_issue_node_id, null);
    assert.notEqual(r.sub_issue_hash, null);
  }
  assert.equal(result.created.length, 4);
  assert.deepEqual(result.failures, []);
});

test("初回: 下流の本文に上流の sub-issue の URL が入る", async () => {
  const { d, ft, input } = await fixture();
  await syncSubIssues(d, ft.tracker, input());
  const body = issueOf(ft, (await row(d, "2")).sub_issue_url).body;
  assert.ok(body.includes((await row(d, "1")).sub_issue_url!));
  assert.ok(body.includes((await row(d, "3")).sub_issue_url!));
  assert.equal(count(ft, "updateIssue"), 0);
});

test("変わっていなければ gh を呼ばない", async () => {
  const { d, ft, input } = await fixture();
  await syncSubIssues(d, ft.tracker, input());
  const before = ft.calls.length;
  const result = await syncSubIssues(d, ft.tracker, input());
  assert.equal(ft.calls.length, before);
  assert.deepEqual(result, { created: [], adopted: [], updated: [], closed: [], failures: [] });
});

test("作成の後で落ちても、やり直しで重複を作らない", async () => {
  const { d, ft, input } = await fixture();
  ft.loseCreateResponseWhen((c) => c.title === "API を実装する");
  const first = await syncSubIssues(d, ft.tracker, input());
  assert.deepEqual(first.failures.map((f) => [f.processId, f.op]), [["2", "create"]]);
  assert.equal((await row(d, "2")).sub_issue_url, null);
  for (const id of ["1", "3", "4"]) assert.notEqual((await row(d, id)).sub_issue_url, null);
  const registered = ft.issues.find((i) => i.title === "API を実装する")!;

  ft.heal();
  const before = ft.calls.length;
  const second = await syncSubIssues(d, ft.tracker, input());
  assert.equal(count(ft, "createSubIssue", before), 0);
  assert.deepEqual(second.adopted, ["2"]);
  assert.equal((await row(d, "2")).sub_issue_url, registered.ref.url);
  assert.equal(ft.issues.filter((i) => i.parentUrl === PARENT_URL).length, 4);
  assert.deepEqual(second.failures, []);
});

test("採用した sub-issue は本文を 1 回揃え、その後は呼ばない", async () => {
  const { d, ft, input } = await fixture();
  ft.loseCreateResponseWhen((c) => c.title === "API を実装する");
  await syncSubIssues(d, ft.tracker, input());
  ft.heal();
  const before = ft.calls.length;
  const second = await syncSubIssues(d, ft.tracker, input());
  // 2 は採用でハッシュが null、4 は 1 回目に「未作成」の本文で作られた
  assert.equal(count(ft, "updateIssue", before), 2);
  assert.deepEqual(second.updated.toSorted(), ["2", "4"]);
  const after = ft.calls.length;
  await syncSubIssues(d, ft.tracker, input());
  assert.equal(ft.calls.length, after);
});

test("作成に失敗したら、次の回で作る", async () => {
  const { d, ft, input } = await fixture();
  ft.failWhen((c) => c.op === "createSubIssue" && c.title === "マイグレーションを書く");
  await syncSubIssues(d, ft.tracker, input());
  assert.equal((await row(d, "1")).sub_issue_url, null);
  const two = ft.issues.find((i) => i.title === "API を実装する")!;
  assert.ok(two.body.includes("マイグレーションを書く（sub-issue 未作成）"));

  ft.heal();
  const second = await syncSubIssues(d, ft.tracker, input());
  assert.deepEqual(second.created, ["1"]);
  assert.deepEqual(second.updated, ["2"]);
  assert.ok(two.body.includes((await row(d, "1")).sub_issue_url!));
});

test("別の Intake の目印は採用しない", async () => {
  const { d, ft, input } = await fixture();
  const old = ft.seed(PARENT, { body: `前の Intake\n${subIssueMarker("old", "1")}` });
  await syncSubIssues(d, ft.tracker, input());
  assert.equal(count(ft, "createSubIssue"), 4);
  assert.notEqual((await row(d, "1")).sub_issue_url, old.ref.url);
});

test("目印が同じなら既存を採用する", async () => {
  const { d, ft, input } = await fixture();
  const seeded = ft.seed(PARENT, { body: `前の回\n${subIssueMarker("i1", "1")}` });
  const result = await syncSubIssues(d, ft.tracker, input());
  assert.equal(count(ft, "createSubIssue"), 3);
  assert.equal((await row(d, "1")).sub_issue_url, seeded.ref.url);
  assert.deepEqual(result.adopted, ["1"]);
  const updates = ft.calls.filter((c) => c.op === "updateIssue");
  assert.equal(updates.length, 1);
  assert.equal((updates[0] as { url: string }).url, seeded.ref.url);
});

test("一覧が取れなければ作らない", async () => {
  const { d, ft, input } = await fixture();
  ft.failWhen((c) => c.op === "findSubIssues");
  const result = await syncSubIssues(d, ft.tracker, input());
  assert.equal(count(ft, "createSubIssue"), 0);
  assert.equal(result.failures.length, 4);
  assert.ok(result.failures.every((f) => f.op === "find"));
  for (const r of await listProcesses(d, "i1")) assert.equal(r.sub_issue_url, null);
});

test("改訂: 無くなったプロセスを取りやめとして閉じる", async () => {
  const { d, ft, input } = await fixture();
  await syncSubIssues(d, ft.tracker, input());
  const url4 = (await row(d, "4")).sub_issue_url!;
  await updateProcess(d, "i1", "4", { retired_at: now() });

  const before = ft.calls.length;
  const result = await syncSubIssues(d, ft.tracker, input(withoutProcess4()));
  const closes = ft.calls.slice(before).filter((c) => c.op === "closeIssue");
  assert.deepEqual(closes, [{ op: "closeIssue", url: url4, reason: "not_planned" }]);
  assert.equal((await row(d, "4")).sub_issue_closed, 1);
  assert.deepEqual(result.closed, ["4"]);

  const again = ft.calls.length;
  await syncSubIssues(d, ft.tracker, input(withoutProcess4()));
  assert.equal(count(ft, "closeIssue", again), 0);
});

test("改訂: 増えたプロセスを作る", async () => {
  const { d, ft, input } = await fixture();
  await syncSubIssues(d, ft.tracker, input());
  const pfd = example();
  pfd.artifacts.push({ id: "docs", name: "ドキュメント", given: false });
  pfd.goal = ["feature", "docs"];
  pfd.processes.push({
    id: "5",
    name: "ドキュメントを書く",
    actor: "agent",
    inputs: ["endpoint"],
    outputs: ["docs"],
  });
  await insertProcesses(d, "i1", ["5"]);

  const before = ft.calls.length;
  const result = await syncSubIssues(d, ft.tracker, input(pfd));
  assert.equal(count(ft, "createSubIssue", before), 1);
  assert.equal(count(ft, "findSubIssues", before), 1);
  assert.equal(count(ft, "updateIssue", before), 0);
  assert.deepEqual(result.created, ["5"]);
  const body = issueOf(ft, (await row(d, "5")).sub_issue_url).body;
  assert.ok(body.includes((await row(d, "2")).sub_issue_url!));
});

test("改訂: 変わったプロセスだけ本文を更新する", async () => {
  const { d, ft, input } = await fixture();
  await syncSubIssues(d, ft.tracker, input());
  const hash = (await row(d, "2")).sub_issue_hash;
  const pfd = example();
  pfd.processes[1].purpose = "新しい目的";

  const before = ft.calls.length;
  await syncSubIssues(d, ft.tracker, input(pfd));
  const updates = ft.calls.slice(before);
  assert.equal(updates.length, 1);
  const call = updates[0] as { op: string; url: string; body: string };
  assert.equal(call.op, "updateIssue");
  assert.equal(call.url, (await row(d, "2")).sub_issue_url);
  assert.ok(call.body.includes("新しい目的"));
  assert.notEqual((await row(d, "2")).sub_issue_hash, hash);
});

test("改訂: 名前だけ変わっても title を更新する", async () => {
  const { d, ft, input } = await fixture();
  await syncSubIssues(d, ft.tracker, input());
  const pfd = example();
  pfd.processes[3].name = "画面をつなぐ";

  const before = ft.calls.length;
  await syncSubIssues(d, ft.tracker, input(pfd));
  const updates = ft.calls.slice(before);
  assert.equal(updates.length, 1);
  const call = updates[0] as { op: string; url: string; title: string };
  assert.equal(call.op, "updateIssue");
  assert.equal(call.url, (await row(d, "4")).sub_issue_url);
  assert.equal(call.title, "画面をつなぐ");
});

test("更新に失敗したら、次の回でやり直す", async () => {
  const { d, ft, input } = await fixture();
  await syncSubIssues(d, ft.tracker, input());
  const hash = (await row(d, "2")).sub_issue_hash;
  const pfd = example();
  pfd.processes[1].purpose = "新しい目的";

  ft.failWhen((c) => c.op === "updateIssue");
  const second = await syncSubIssues(d, ft.tracker, input(pfd));
  assert.deepEqual(second.failures.map((f) => [f.processId, f.op]), [["2", "update"]]);
  assert.equal((await row(d, "2")).sub_issue_hash, hash);

  ft.heal();
  const before = ft.calls.length;
  const third = await syncSubIssues(d, ft.tracker, input(pfd));
  assert.equal(count(ft, "updateIssue", before), 1);
  assert.deepEqual(third.updated, ["2"]);
  assert.deepEqual(third.failures, []);
});

test("閉じるのに失敗しても他は進み、次の回でやり直す", async () => {
  const { d, ft, input } = await fixture();
  await syncSubIssues(d, ft.tracker, input());
  await updateProcess(d, "i1", "4", { retired_at: now() });
  const pfd = withoutProcess4();
  pfd.processes[1].purpose = "新しい目的";

  ft.failWhen((c) => c.op === "closeIssue");
  const second = await syncSubIssues(d, ft.tracker, input(pfd));
  assert.deepEqual(second.failures.map((f) => [f.processId, f.op]), [["4", "close"]]);
  assert.equal((await row(d, "4")).sub_issue_closed, 0);
  assert.deepEqual(second.updated, ["2"]);

  ft.heal();
  const before = ft.calls.length;
  await syncSubIssues(d, ft.tracker, input(pfd));
  assert.equal(count(ft, "closeIssue", before), 1);
  assert.equal((await row(d, "4")).sub_issue_closed, 1);
});

test("sub-issue の無いまま取りやめになったプロセスは何もしない", async () => {
  const { d, ft, input } = await fixture();
  await updateProcess(d, "i1", "4", { retired_at: now() });
  await syncSubIssues(d, ft.tracker, input(withoutProcess4()));
  assert.equal(count(ft, "closeIssue"), 0);
  assert.equal(count(ft, "createSubIssue"), 3);
});

test("行の無いプロセスは失敗として扱い、残りを進める", async () => {
  const { d, ft, input } = await fixture(["1", "2", "3"]);
  const result = await syncSubIssues(d, ft.tracker, input());
  assert.deepEqual(result.failures.map((f) => [f.processId, f.op]), [["4", "record"]]);
  assert.deepEqual(result.created.toSorted(), ["1", "2", "3"]);
});
