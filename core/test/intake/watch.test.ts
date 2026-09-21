import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import type { PrFact } from "../../../shared/intake/github.ts";
import { getPrObservation, updateProcess } from "../../src/db/intakes.ts";
import type { Db } from "../../src/db/schema.ts";
import { getProject, listTasks } from "../../src/db/tasks.ts";
import { dispatchIntake } from "../../src/intake/dispatch.ts";
import { choosePr, observePullRequests } from "../../src/intake/watch.ts";
import { fakePrWatcher } from "../helpers/prWatcher.ts";
import { seedActive } from "./watchFixture.ts";

function pr(number: number, state: PrFact["state"], baseRef = "main"): PrFact {
  return {
    number,
    url: `https://github.com/o/r/pull/${number}`,
    state,
    baseRef,
    mergedAt: state === "MERGED" ? "2026-09-21T00:00:00.000Z" : null,
    mergeCommit: state === "MERGED" ? `c${number}` : null,
  };
}

test("choosePr: baseBranch へマージされたものを最優先に選ぶ", () => {
  const chosen = choosePr([pr(3, "CLOSED"), pr(2, "MERGED"), pr(4, "OPEN")], "main");
  assert.equal(chosen?.number, 2);
});

test("choosePr: baseBranch 以外へのマージより OPEN を選ぶ", () => {
  const chosen = choosePr([pr(3, "CLOSED"), pr(4, "OPEN"), pr(5, "MERGED", "release")], "main");
  assert.equal(chosen?.number, 4);
});

test("choosePr: PR が無ければ null", () => {
  assert.equal(choosePr([], "main"), null);
});

async function seedDispatched(): Promise<{ db: Db; projectId: number; branch: string }> {
  const { db, projectId } = await seedActive();
  await updateProcess(db, "i1", "1", { sub_issue_url: "https://github.com/o/r/issues/101" });
  await dispatchIntake(db, "i1");
  return { db, projectId, branch: (await listTasks(db))[0].branch };
}

test("observePullRequests: 選んだ PR を記録し、変わらなければ changed に入れない", async () => {
  const { db, projectId, branch } = await seedDispatched();
  const project = (await getProject(db, projectId))!;
  const pw = fakePrWatcher();
  pw.prs.set(branch, [pr(7, "OPEN")]);

  const first = await observePullRequests(db, pw.prWatcher, project);
  assert.deepEqual([...first.changedIntakeIds], ["i1"]);
  const taskId = (await listTasks(db))[0].id;
  assert.equal((await getPrObservation(db, taskId))?.state, "OPEN");

  const second = await observePullRequests(db, pw.prWatcher, project);
  assert.equal(second.changedIntakeIds.size, 0);
  assert.deepEqual(pw.calls, [[branch], [branch]]);
});

test("observePullRequests: baseBranch へのマージを観測したタスクは、以後引かない", async () => {
  const { db, projectId, branch } = await seedDispatched();
  const project = (await getProject(db, projectId))!;
  const pw = fakePrWatcher();
  pw.prs.set(branch, [pr(7, "MERGED")]);
  await observePullRequests(db, pw.prWatcher, project);
  await observePullRequests(db, pw.prWatcher, project);
  assert.equal(pw.calls.length, 1);
});

test("observePullRequests: 対象が無ければ gh を呼ばない", async () => {
  const { db, projectId } = await seedActive();
  const pw = fakePrWatcher();
  await observePullRequests(db, pw.prWatcher, (await getProject(db, projectId))!);
  assert.equal(pw.calls.length, 0);
});

test("observePullRequests: pullRequests の失敗は投げる", async () => {
  const { db, projectId } = await seedDispatched();
  const pw = fakePrWatcher();
  pw.failing.on = true;
  await assert.rejects(observePullRequests(db, pw.prWatcher, (await getProject(db, projectId))!));
});
