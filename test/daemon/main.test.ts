import { test, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon } from "../../src/daemon/main.ts";

let root: string;
const daemons: { stop(): Promise<void> }[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "doctrine-main-"));
});
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop();
  await rm(root, { recursive: true, force: true });
});

test("生きているデーモンのソケットは横取りせず、二重起動を拒否する", async () => {
  const sock = join(root, "dctld.sock");
  const d1 = await startDaemon({
    dbPath: join(root, "a.db"), socketPath: sock, logRoot: join(root, "logs-a"), tickMs: 1_000_000,
  });
  daemons.push(d1);

  await assert.rejects(
    () => startDaemon({
      dbPath: join(root, "b.db"), socketPath: sock, logRoot: join(root, "logs-b"), tickMs: 1_000_000,
    }),
    /既に動作しています/,
  );
});

test("古いソケットファイルは掃除して起動できる", async () => {
  const sock = join(root, "dctld.sock");

  // 「デーモンが死んだ（＝SIGKILL などでソケットの unlink を実行できないまま
  // 消えた）が、ソケットファイルは残っている」状態を再現する。net サーバを
  // 正常に listen/close させると node 自身がパスを unlink してしまい、
  // stale の状態を作れない（実際に試して確認済み）ので、ここでは同じ場所に
  // 中身の無い通常ファイルを置き、「ソケットとして繋がらないパスが存在する」
  // という同じ条件を作る。
  await writeFile(sock, "");

  // 前提の確認: ファイルが存在する。これが無いと assertSocketNotLive の
  // 「stat が成功する」分岐に到達せず、以下のアサーションは何も検証しない
  // まま緑になってしまう。
  await stat(sock);

  const d = await startDaemon({
    dbPath: join(root, "c.db"), socketPath: sock, logRoot: join(root, "logs-c"), tickMs: 1_000_000,
  });
  daemons.push(d);
  assert.ok(d);
});
