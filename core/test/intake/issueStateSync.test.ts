import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import type { PrFact } from "../../../shared/intake/processStatus.ts";
import { getIntake, listProcesses, updateProcess } from "../../src/db/intakes.ts";
import type { Db } from "../../src/db/schema.ts";
import {
  advanceParentIssue,
  desiredSubIssuePhase,
  syncIssueStates,
} from "../../src/intake/issueStateSync.ts";
import type { ProcessProgress } from "../../src/intake/pfd/status.ts";
import { fakeTracker } from "../helpers/fakeTracker.ts";
import { PARENT_URL, seedActive } from "./watchFixture.ts";

const P = "/repo";

const pr = (state: PrFact["state"]): PrFact => ({
  number: 7,
  url: "https://github.com/o/r/pull/7",
  state,
  baseRef: "main",
  mergedAt: null,
  mergeCommit: null,
});
const progress = (o: Partial<ProcessProgress>): ProcessProgress => ({
  task: null,
  pr: null,
  subIssueUrl: null,
  humanDone: null,
  ...o,
});
const task = { id: "t1", state: "running" as const };

const subUrl = (id: string) => `https://github.com/o/r/issues/${100 + Number(id)}`;

/** プロセス 1〜4 に sub-issue の URL を入れ、i1 の行を返す。 */
async function seed(db: Db) {
  for (const id of ["1", "2", "3", "4"]) {
    await updateProcess(db, "i1", id, {
      sub_issue_url: subUrl(id),
      sub_issue_node_id: `I_${id}`,
    });
  }
  return (await getIntake(db, "i1"))!;
}

const advances = (ft: ReturnType<typeof fakeTracker>) =>
  ft.calls.filter((c) => c.op === "advanceIssue");

test("desiredSubIssuePhase: タスクが無ければ todo", () => {
  assert.equal(desiredSubIssuePhase(undefined), "todo");
  assert.equal(desiredSubIssuePhase(progress({ task: null })), "todo");
});

test("desiredSubIssuePhase: タスクがあれば inProgress", () => {
  assert.equal(desiredSubIssuePhase(progress({ task })), "inProgress");
});

test("desiredSubIssuePhase: PR が OPEN か MERGED なら inReview", () => {
  assert.equal(desiredSubIssuePhase(progress({ task, pr: pr("OPEN") })), "inReview");
  assert.equal(desiredSubIssuePhase(progress({ task, pr: pr("MERGED") })), "inReview");
});

test("desiredSubIssuePhase: PR が閉じられただけなら inProgress", () => {
  assert.equal(desiredSubIssuePhase(progress({ task, pr: pr("CLOSED") })), "inProgress");
});

test("syncIssueStates: GitHub では何も呼ばない", async () => {
  const { db } = await seedActive();
  const intake = await seed(db);
  const ft = fakeTracker();
  const res = await syncIssueStates(db, ft.tracker, { projectPath: P, intake });
  assert.deepEqual(res, { advanced: [], failures: [] });
  assert.equal(advances(ft).length, 0);
  assert.equal((await getIntake(db, "i1"))!.issue_phase, null);
  assert.ok((await listProcesses(db, "i1")).every((r) => r.sub_issue_phase === null));
});

test("syncIssueStates: 記録と同じ段階なら呼ばない", async () => {
  const { db } = await seedActive();
  const intake = await seed(db);
  const ft = fakeTracker({ kind: "linear" });
  const first = await syncIssueStates(db, ft.tracker, { projectPath: P, intake });
  // 親 1 件 + sub-issue 4 件
  assert.equal(first.advanced.length, 5);
  const count = advances(ft).length;
  const second = await syncIssueStates(db, ft.tracker, {
    projectPath: P,
    intake: (await getIntake(db, "i1"))!,
  });
  assert.deepEqual(second.advanced, []);
  assert.equal(advances(ft).length, count);
});

test("syncIssueStates: 失敗した Issue は記録せず、残りを続ける", async () => {
  const { db } = await seedActive();
  const intake = await seed(db);
  const ft = fakeTracker({ kind: "linear" });
  ft.failWhen((c) => c.op === "advanceIssue" && c.url === subUrl("1"));
  const res = await syncIssueStates(db, ft.tracker, { projectPath: P, intake });
  assert.equal(res.failures.length, 1);
  assert.equal(res.failures[0].url, subUrl("1"));
  const rows = await listProcesses(db, "i1");
  assert.equal(rows.find((r) => r.process_id === "1")!.sub_issue_phase, null);
  assert.equal(rows.find((r) => r.process_id === "2")!.sub_issue_phase, "todo");
});

test("syncIssueStates: 取りやめ・閉じた・sub-issue の無い行は触らない", async () => {
  const { db } = await seedActive();
  const intake = await seed(db);
  await updateProcess(db, "i1", "4", { retired_at: "2026-01-01T00:00:00Z" });
  await updateProcess(db, "i1", "2", { sub_issue_closed: 1 });
  await updateProcess(db, "i1", "3", { sub_issue_url: null, sub_issue_node_id: null });
  const ft = fakeTracker({ kind: "linear" });
  await syncIssueStates(db, ft.tracker, { projectPath: P, intake });
  const urls = advances(ft).map((c) => (c as { url: string }).url);
  assert.ok(!urls.includes(subUrl("4")));
  assert.ok(!urls.includes(subUrl("2")));
  assert.ok(!urls.includes(subUrl("3")));
  assert.ok(urls.includes(subUrl("1")));
});

test("advanceParentIssue: 親を inProgress に進めて記録し、二度目は呼ばない", async () => {
  const { db } = await seedActive();
  const ft = fakeTracker({ kind: "linear" });
  const o = async () => ({ projectPath: P, intake: (await getIntake(db, "i1"))! });
  assert.equal(await advanceParentIssue(db, ft.tracker, await o()), true);
  assert.equal(await advanceParentIssue(db, ft.tracker, await o()), false);
  assert.deepEqual(advances(ft), [{ op: "advanceIssue", url: PARENT_URL, phase: "inProgress" }]);
  assert.equal((await getIntake(db, "i1"))!.issue_phase, "inProgress");
});
