import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { notifierFor, notifySendArgs, osascriptArgs } from "../../src/notify/notifier.ts";

function fakeRun(fail?: Error) {
  const calls: { cmd: string; args: string[] }[] = [];
  const run = (cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    return fail ? Promise.reject(fail) : Promise.resolve({});
  };
  return { calls, run };
}

test("osascript の引数は -e と display notification の 1 文になる", () => {
  assert.deepEqual(osascriptArgs("doctrine", "本文"), [
    "-e",
    'display notification "本文" with title "doctrine"',
  ]);
});

test('osascript に埋め込む値の \\ と " をエスケープする', () => {
  assert.deepEqual(osascriptArgs('a"b', 'x\\y"z'), [
    "-e",
    'display notification "x\\\\y\\"z" with title "a\\"b"',
  ]);
});

test('\\ の直後の " も二重にエスケープしない', () => {
  const [, script] = osascriptArgs("t", '\\"');
  assert.equal(script, 'display notification "\\\\\\"" with title "t"');
});

test("notify-send の引数はアプリ名 doctrine とタイトル・本文", () => {
  assert.deepEqual(notifySendArgs('a"b', "本文"), ["-a", "doctrine", 'a"b', "本文"]);
});

test("darwin では osascript を引数の配列で起動する", async () => {
  const { calls, run } = fakeRun();
  await notifierFor("darwin", run).notify("doctrine", "x");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "osascript");
  assert.deepEqual(calls[0].args, osascriptArgs("doctrine", "x"));
});

test("linux では notify-send を起動する", async () => {
  const { calls, run } = fakeRun();
  await notifierFor("linux", run).notify("doctrine", "x");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "notify-send");
  assert.deepEqual(calls[0].args, notifySendArgs("doctrine", "x"));
});

test("darwin / linux 以外では何も起動しない", async () => {
  const { calls, run } = fakeRun();
  await notifierFor("windows", run).notify("doctrine", "x");
  assert.equal(calls.length, 0);
});

test("起動の失敗は notify の reject として返る", async () => {
  const { run } = fakeRun(new Error("not found"));
  await assert.rejects(notifierFor("linux", run).notify("doctrine", "x"), /not found/);
});
