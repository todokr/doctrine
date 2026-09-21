import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import {
  getIntake,
  insertDraft,
  latestApproval,
  listProcesses,
  updateIntake,
  updateProcess,
} from "../../src/db/intakes.ts";
import { approveIntake } from "../../src/intake/commands.ts";
import { dispatchIntake } from "../../src/intake/dispatch.ts";
import { pfdHash } from "../../src/intake/pfd/hash.ts";
import { canonicalJson } from "../../../shared/intake/pfd.ts";
import {
  frozenProcessIds,
  loadRevisionConstraints,
  processRowChanges,
} from "../../src/intake/revision.ts";
import { example, revised } from "./pfd/fixture.ts";
import { seedActive } from "./watchFixture.ts";

const SUB = (n: number) => `https://github.com/o/r/issues/${n + 1}`;

/** プロセス 1 を投入済み、プロセス 3 を完了記録済みにする。 */
async function freeze(db: Awaited<ReturnType<typeof seedActive>>["db"]): Promise<void> {
  for (const id of ["1", "2", "3", "4"]) {
    await updateProcess(db, "i1", id, { sub_issue_url: SUB(Number(id)) });
  }
  const report = await dispatchIntake(db, "i1");
  assert.deepEqual(report.created.map((c) => c.processId), ["1"]);
  await updateProcess(db, "i1", "3", { human_done_at: "2026-09-21T00:00:00.000Z" });
}

test("frozenProcessIds: 投入済みと完了記録済みのプロセスだけを固定する", async () => {
  const { db } = await seedActive();
  await freeze(db);
  assert.deepEqual(frozenProcessIds(await listProcesses(db, "i1")), new Set(["1", "3"]));

  await updateProcess(db, "i1", "4", { retired_at: "t" });
  await updateProcess(db, "i1", "1", { retired_at: "t" });
  assert.deepEqual(
    frozenProcessIds(await listProcesses(db, "i1")),
    new Set(["3"]),
    "取りやめた行は含めない",
  );
});

test("loadRevisionConstraints: 固定の成果物と取りやめた id を集める", async () => {
  const { db } = await seedActive();
  await freeze(db);
  await updateProcess(db, "i1", "4", { retired_at: "t" });

  const c = await loadRevisionConstraints(db, "i1");
  assert.deepEqual(c.frozen.processes.map((p) => p.id), ["1", "3"]);
  assert.deepEqual(c.frozen.artifacts.map((a) => a.id), [
    "schema",
    "new-table",
    "metric-definition",
  ]);
  assert.deepEqual(c.retiredProcessIds, new Set(["4"]));
  assert.equal(c.approved.pfd.title, example().title);
});

test("loadRevisionConstraints: 承認が無ければ投げる", async () => {
  const { db } = await seedActive();
  await db.deleteFrom("intake_approvals").execute();
  await assert.rejects(() => loadRevisionConstraints(db, "i1"), /承認/);
});

test("approveIntake: 改訂中は、固定された部分を変えた案の承認を拒む", async () => {
  const { db, runId } = await seedActive();
  await freeze(db);
  await updateIntake(db, "i1", { state: "reviewing", revising: 1 });
  const changed = example();
  changed.processes[0].steps = "別の手順にする";
  const draft = await insertDraft(db, {
    intake_id: "i1",
    run_id: runId,
    pfd: canonicalJson(changed),
    hash: await pfdHash(changed),
    replies: "[]",
  });

  await assert.rejects(
    () => approveIntake(db, { intakeId: "i1", draftId: draft.id, hash: draft.hash }),
    /frozen_changed 1/,
  );
  const approvals = await db.selectFrom("intake_approvals").selectAll().execute();
  assert.equal(approvals.length, 1);
  assert.equal((await getIntake(db, "i1"))!.state, "reviewing");
});

test("approveIntake: 再承認で行を揃え、状態を active に戻す", async () => {
  const { db, runId } = await seedActive();
  await freeze(db);
  await updateIntake(db, "i1", { state: "reviewing", revising: 1, revision_run_id: runId });
  const pfd = revised();
  const draft = await insertDraft(db, {
    intake_id: "i1",
    run_id: runId,
    pfd: canonicalJson(pfd),
    hash: await pfdHash(pfd),
    replies: "[]",
  });

  const t = await approveIntake(db, { intakeId: "i1", draftId: draft.id, hash: draft.hash });

  assert.deepEqual(t, { intakeId: "i1", from: "reviewing", to: "active", revising: false });
  const intake = (await getIntake(db, "i1"))!;
  assert.equal(intake.state, "active");
  assert.equal(intake.revising, 0);
  assert.equal(intake.revision_run_id, null);
  const rows = await listProcesses(db, "i1");
  assert.deepEqual(rows.map((r) => [r.process_id, r.retired_at !== null]), [
    ["1", false],
    ["2", false],
    ["3", false],
    ["4", true],
    ["4b", false],
  ]);
  assert.equal((await latestApproval(db, "i1"))!.draft_id, draft.id);
});

test("processRowChanges: 増えた id を挿入し、消えた生きた id を取りやめる", async () => {
  const { db } = await seedActive();
  const rows = await listProcesses(db, "i1");
  assert.deepEqual(processRowChanges(rows, revised()), { insert: ["4b"], retire: ["4"] });

  assert.deepEqual(processRowChanges([], example()), {
    insert: ["1", "2", "3", "4"],
    retire: [],
  });

  await updateProcess(db, "i1", "4", { retired_at: "t" });
  assert.deepEqual(
    processRowChanges(await listProcesses(db, "i1"), revised()),
    { insert: ["4b"], retire: [] },
    "取りやめ済みの行は、もう一度取りやめない",
  );
});
