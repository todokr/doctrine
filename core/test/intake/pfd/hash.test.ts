import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { pfdHash, sha256Hex } from "../../../src/intake/pfd/hash.ts";
import { example } from "./fixture.ts";

test("sha256Hex: 既知の値", async () => {
  assert.equal(
    await sha256Hex(""),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
});

test("pfdHash: キーの順が違っても同じ値", async () => {
  const a = example();
  const b = example();
  b.processes[0] = Object.fromEntries(
    Object.entries(b.processes[0]).reverse(),
  ) as typeof b.processes[0];
  assert.equal(await pfdHash(a), await pfdHash(b));
});

test("pfdHash: 中身が変われば値が変わる", async () => {
  const b = example();
  b.title = "別のタイトル";
  assert.notEqual(await pfdHash(example()), await pfdHash(b));
});
