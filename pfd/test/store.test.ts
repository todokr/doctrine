import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { join } from "@std/path";
import {
  emptyRecord,
  hashOf,
  pfdDir,
  projectKey,
  readRecord,
  stateRoot,
  writeRecord,
} from "../src/store.ts";

async function withStateDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const prev = Deno.env.get("DOCTRINE_STATE_DIR");
  const dir = await Deno.makeTempDir();
  Deno.env.set("DOCTRINE_STATE_DIR", dir);
  try {
    await fn(dir);
  } finally {
    if (prev === undefined) Deno.env.delete("DOCTRINE_STATE_DIR");
    else Deno.env.set("DOCTRINE_STATE_DIR", prev);
    await Deno.remove(dir, { recursive: true });
  }
}

test("stateRoot: DOCTRINE_STATE_DIR を使う", async () => {
  await withStateDir((dir) => {
    assert.equal(stateRoot(), dir);
    return Promise.resolve();
  });
});

test("stateRoot: 空文字なら未指定として扱う", () => {
  const prev = Deno.env.get("DOCTRINE_STATE_DIR");
  Deno.env.set("DOCTRINE_STATE_DIR", "");
  try {
    assert.ok(stateRoot().endsWith("/.local/state/doctrine"));
  } finally {
    if (prev === undefined) Deno.env.delete("DOCTRINE_STATE_DIR");
    else Deno.env.set("DOCTRINE_STATE_DIR", prev);
  }
});

test("projectKey: ディレクトリ名とハッシュ 8 文字", async () => {
  assert.match(await projectKey("/work/doctrine"), /^doctrine-[0-9a-f]{8}$/);
});

test("projectKey: 同じ名前でも場所が違えば別のキーになる", async () => {
  assert.notEqual(await projectKey("/a/doctrine"), await projectKey("/b/doctrine"));
});

test("pfdDir: 状態ディレクトリ配下に issue ごとの場所を返す", async () => {
  await withStateDir(async (dir) => {
    const key = await projectKey("/work/doctrine");
    assert.equal(await pfdDir("/work/doctrine", 123), join(dir, "pfd", key, "123"));
  });
});

test("readRecord: ファイルが無ければ空の記録", async () => {
  const dir = await Deno.makeTempDir();
  try {
    assert.deepEqual(await readRecord(dir), emptyRecord());
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("writeRecord → readRecord: 書いたものが読める", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const record = emptyRecord();
    record.approved = { hash: "abc", at: "2026-09-20T00:00:00.000Z" };
    record.tasks["1"] = { task_id: "t1", branch: "doctrine/t1", at: "2026-09-20T00:00:01.000Z" };
    record.done["3"] = { note: "決めた", at: "2026-09-20T00:00:02.000Z" };
    await writeRecord(dir, record);
    assert.deepEqual(await readRecord(dir), record);
    // 一時ファイルを残さない
    const names = [];
    for await (const e of Deno.readDir(dir)) names.push(e.name);
    assert.deepEqual(names, ["dispatch.json"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("hashOf: 同じ文字列は同じハッシュ、違えば違うハッシュ", async () => {
  assert.equal(await hashOf("a"), await hashOf("a"));
  assert.notEqual(await hashOf("a"), await hashOf("b"));
  assert.match(await hashOf("a"), /^[0-9a-f]{64}$/);
});
