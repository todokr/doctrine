import { afterEach, beforeEach, test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readDaemonConfig,
  validateGlobalLimit,
  writeDaemonConfig,
} from "../../src/daemon/config.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "doctrine-config-"));
});
afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await rm(root, { recursive: true, force: true });
});

test("設定ファイルが無ければ全体の実行枠は 4 で、警告は出さない", async () => {
  const got = await readDaemonConfig(join(root, "missing", "config.json"));
  assert.deepEqual(got, { config: { globalLimit: 4 }, warning: null });
});

test("globalLimit があればその値を使う", async () => {
  const path = join(root, "config.json");
  await writeFile(path, JSON.stringify({ globalLimit: 7 }));
  const got = await readDaemonConfig(path);
  assert.deepEqual(got, { config: { globalLimit: 7 }, warning: null });
});

test("globalLimit の無い設定ファイルは既定値で、警告は出さない", async () => {
  const path = join(root, "config.json");
  await writeFile(path, JSON.stringify({}));
  const got = await readDaemonConfig(path);
  assert.deepEqual(got, { config: { globalLimit: 4 }, warning: null });
});

test("JSON として読めない設定ファイルは既定値にして警告を返す", async () => {
  const path = join(root, "config.json");
  await writeFile(path, "{");
  const got = await readDaemonConfig(path);
  assert.equal(got.config.globalLimit, 4);
  assert.ok(got.warning?.includes(path));
});

for (const bad of [0, -1, 1.5, "4", null]) {
  test(`不正な globalLimit (${JSON.stringify(bad)}) は既定値にして警告を返す`, async () => {
    const path = join(root, "config.json");
    await writeFile(path, JSON.stringify({ globalLimit: bad }));
    const got = await readDaemonConfig(path);
    assert.equal(got.config.globalLimit, 4);
    assert.ok(got.warning !== null);
  });
}

test("知らないキーは既定値にして警告を返す", async () => {
  const path = join(root, "config.json");
  await writeFile(path, JSON.stringify({ globallimit: 3 }));
  const got = await readDaemonConfig(path);
  assert.equal(got.config.globalLimit, 4);
  assert.ok(got.warning !== null);
});

test("validateGlobalLimit は 1 以上の整数だけを通す", () => {
  assert.equal(validateGlobalLimit(1), 1);
  assert.equal(validateGlobalLimit(4), 4);
  assert.equal(validateGlobalLimit(1000), 1000);
  for (const bad of [0, -1, 1.5, "3", null, undefined, NaN, Infinity]) {
    assert.throws(() => validateGlobalLimit(bad), /1 以上の整数/);
  }
});

test("writeDaemonConfig は親ディレクトリを作って保存し、読み戻せる", async () => {
  const path = join(root, "a", "b", "config.json");
  await writeDaemonConfig(path, { globalLimit: 6 });
  const got = await readDaemonConfig(path);
  assert.equal(got.config.globalLimit, 6);
  const dirStat = await stat(join(root, "a", "b"));
  assert.equal(dirStat.mode & 0o777, 0o700);
  const entries = await readdir(join(root, "a", "b"));
  assert.deepEqual(entries, ["config.json"]);
});

test("writeDaemonConfig は既存のファイルを置き換える", async () => {
  const path = join(root, "config.json");
  await writeDaemonConfig(path, { globalLimit: 3 });
  await writeDaemonConfig(path, { globalLimit: 5 });
  const text = await readFile(path, "utf8");
  assert.deepEqual(JSON.parse(text), { globalLimit: 5 });
});
