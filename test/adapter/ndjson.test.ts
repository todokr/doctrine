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

test("マルチバイト文字の途中でチャンクが分割されても復元する", async () => {
  // 日本語（3バイト）と絵文字（サロゲートペア、4バイト）を含む行を作り、
  // そのUTF-8バイト列をマルチバイト文字の途中で2つに割って別チャンクとして流す。
  // setEncoding("utf8") が StringDecoder で不完全なバイト列を保留することの保証テスト。
  const text = "こんにちは😀世界";
  const line = JSON.stringify({ text }) + "\n";
  const buf = Buffer.from(line, "utf8");

  // "こんにちは" の3バイト目（"こ"の途中）で分割する
  const jIdx = buf.indexOf(Buffer.from("こんにちは", "utf8"));
  const splitAt = jIdx + 1; // "こ" の1バイト目の直後（マルチバイト文字の途中）
  const part1 = buf.subarray(0, splitAt);
  const part2 = buf.subarray(splitAt);

  const out: unknown[] = [];
  const stream = new Readable({
    read() {
      this.push(part1);
      this.push(part2);
      this.push(null);
    },
  });
  for await (const v of readNdjson(stream)) out.push(v);

  assert.deepEqual(out, [{ text }]);
  const got = (out[0] as { text: string }).text;
  assert.ok(!got.includes("�"), "U+FFFD（置換文字）が混入していない");
});
