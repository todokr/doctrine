import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { needsHuman } from "../../src/intake/view.ts";
import type { IntakeState } from "../../../shared/intake/state.ts";
import type { ProcessStatus } from "../../../shared/intake/processStatus.ts";

test("人の入力を待つ状態は needsHuman になる", () => {
  for (const s of ["answering", "reviewing", "needs_attention"] as IntakeState[]) {
    assert.equal(needsHuman(s, []), true, s);
  }
});

test("投入前後の状態は、プロセスの状態によらず needsHuman にならない", () => {
  const statuses: ProcessStatus[] = [{ state: "your_turn" }];
  for (
    const s of ["investigating", "decomposing", "completed", "canceled"] as IntakeState[]
  ) {
    assert.equal(needsHuman(s, statuses), false, s);
  }
});

test("active は、あなたの番か要確認のプロセスがあるときだけ needsHuman になる", () => {
  assert.equal(needsHuman("active", [{ state: "waiting", missing: ["x"] }]), false);
  assert.equal(needsHuman("active", []), false);
  assert.equal(needsHuman("active", [{ state: "your_turn" }]), true);
  assert.equal(
    needsHuman("active", [{ state: "needs_attention", taskId: "t", reason: "no_pr" }]),
    true,
  );
});
