import { test } from "vitest";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { readNdjson } from "../../src/adapter/ndjson.ts";

async function collect(chunks: string[]): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const v of readNdjson(Readable.from(chunks))) out.push(v);
  return out;
}

test("1行1JSONを読む", async () => {
  assert.deepEqual(await collect(['{"a":1}\n{"a":2}\n']), [{ a: 1 }, { a: 2 }]);
});

test("チャンク境界が行の途中でも復元する", async () => {
  assert.deepEqual(await collect(['{"a":', '1}\n{"b"', ':2}\n']), [{ a: 1 }, { b: 2 }]);
});

test("行長に上限を仮定しない（1MB超の1行を読む）", async () => {
  const big = "y".repeat(1024 * 1024);
  const out = await collect([JSON.stringify({ text: big }) + "\n"]);
  assert.equal((out[0] as { text: string }).text.length, big.length);
});

test("最終行に改行がなくても読む", async () => {
  assert.deepEqual(await collect(['{"a":1}']), [{ a: 1 }]);
});

test("空行は飛ばす", async () => {
  assert.deepEqual(await collect(['{"a":1}\n\n\n{"a":2}\n']), [{ a: 1 }, { a: 2 }]);
});

test("壊れた行は飛ばして続きを読む", async () => {
  assert.deepEqual(await collect(['not json\n{"a":1}\n']), [{ a: 1 }]);
});
