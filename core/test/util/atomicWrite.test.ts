import { afterEach, beforeEach, test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeTextFileAtomic } from "../../src/util/atomicWrite.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "doctrine-atomicwrite-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("writeTextFileAtomic は対象ファイルにテキストを書く", async () => {
  const target = join(dir, "out.txt");
  await writeTextFileAtomic(target, "hello\n");
  assert.equal(await readFile(target, "utf8"), "hello\n");
});

test("writeTextFileAtomic は一時ファイルを残さない", async () => {
  const target = join(dir, "out.txt");
  await writeTextFileAtomic(target, "hello\n");
  const entries = await readdir(dir);
  assert.deepEqual(entries, ["out.txt"]);
});

test("writeTextFileAtomic は既存のファイルを上書きする", async () => {
  const target = join(dir, "out.txt");
  await writeTextFileAtomic(target, "first\n");
  await writeTextFileAtomic(target, "second\n");
  assert.equal(await readFile(target, "utf8"), "second\n");
});
