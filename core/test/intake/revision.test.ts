import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { listProcesses, updateProcess } from "../../src/db/intakes.ts";
import { dispatchIntake } from "../../src/intake/dispatch.ts";
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
