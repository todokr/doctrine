import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { pollVerdict } from "../../src/domain/poll.ts";

test("poll の終了コードを判定に写す", () => {
  assert.equal(pollVerdict(0), "done");
  assert.equal(pollVerdict(75), "wait");
  assert.equal(pollVerdict(2), "abandon");
  assert.equal(pollVerdict(1), "failed");
  assert.equal(pollVerdict(null), "failed", "起動できなかった・シグナルで落ちた");
});
