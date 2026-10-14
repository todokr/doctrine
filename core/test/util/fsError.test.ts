import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isNotFound } from "../../src/util/fsError.ts";

test("存在しないファイルの読み込みエラーは NotFound と判定する", async () => {
  const err = await readFile("/nonexistent/doctrine-test").catch((e) => e);
  assert.equal(isNotFound(err), true);
});

test("ENOENT 以外のエラーは NotFound と判定しない", async () => {
  const err = await readFile("/").catch((e) => e); // EISDIR
  assert.equal(isNotFound(err), false);
  assert.equal(isNotFound(new Error("x")), false);
  assert.equal(isNotFound(null), false);
});
