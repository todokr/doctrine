import { test } from "@std/testing/bdd";
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

/**
 * text を含む1行のUTF-8バイト列を作り、cutAt バイト目で2チャンクに割って読ませる。
 * setEncoding("utf8") が StringDecoder で不完全なバイト列を保留することの保証テスト
 * （割らずに1チャンクで流すと、この保留は一切働かないため検証にならない）。
 */
async function collectSplitAtByte(text: string, cutAt: number): Promise<unknown[]> {
  const line = JSON.stringify({ text }) + "\n";
  const buf = Buffer.from(line, "utf8");
  const part1 = buf.subarray(0, cutAt);
  const part2 = buf.subarray(cutAt);

  const out: unknown[] = [];
  const stream = new Readable({
    read() {
      this.push(part1);
      this.push(part2);
      this.push(null);
    },
  });
  for await (const v of readNdjson(stream)) out.push(v);
  return out;
}

test("3バイト文字（日本語）の途中でチャンクが分割されても復元する", async () => {
  const text = "こんにちは世界";
  const buf = Buffer.from(JSON.stringify({ text }) + "\n", "utf8");
  // "こ"（3バイト）の1バイト目の直後、つまりその3バイト列の途中で割る
  const koStart = buf.indexOf(Buffer.from("こ", "utf8"));
  const out = await collectSplitAtByte(text, koStart + 1);

  assert.deepEqual(out, [{ text }]);
  assert.ok(!(out[0] as { text: string }).text.includes("�"), "U+FFFD（置換文字）が混入していない");
});

test("4バイト文字（絵文字・サロゲートペア）の途中でチャンクが分割されても復元する", async () => {
  const text = "あいう🎉えお";
  const buf = Buffer.from(JSON.stringify({ text }) + "\n", "utf8");
  // 絵文字（4バイト）の2バイト目、つまりその4バイト列の途中で割る
  const emojiStart = buf.indexOf(Buffer.from("🎉", "utf8"));
  const out = await collectSplitAtByte(text, emojiStart + 1);

  assert.deepEqual(out, [{ text }]);
  assert.ok(!(out[0] as { text: string }).text.includes("�"), "U+FFFD（置換文字）が混入していない");
});
