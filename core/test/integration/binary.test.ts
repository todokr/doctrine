import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnChild } from "../../src/util/exec.ts";
import { call } from "../helpers/rpc.ts";

const DCTLD = fileURLToPath(new URL("../../dist/dctld", import.meta.url));

// ビルドに時間がかかるので、DOCTRINE_TEST_BINARY=1（pnpm run test:binary）のときだけ走らせる。
test("SEA の dctld が起動し、ソケット越しの RPC に応答する", {
  skip: process.env.DOCTRINE_TEST_BINARY !== "1",
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), "doctrine-bin-"));
  const sock = join(dir, "dctld.sock");
  const env = {
    ...process.env,
    DOCTRINE_SOCKET: sock,
    DOCTRINE_STATE_DIR: join(dir, "state"),
    DOCTRINE_CONFIG_DIR: join(dir, "config"),
  } as Record<string, string>;
  const daemon = await spawnChild(DCTLD, [], { env });
  daemon.stdout.resume();
  daemon.stderr.resume();
  try {
    let slots: unknown = null;
    for (let i = 0; i < 50 && slots === null; i++) {
      slots = await call(sock, "daemon.slots", {}).catch(async () => {
        await new Promise((r) => setTimeout(r, 100));
        return null;
      });
    }
    assert.ok(slots !== null, "dctld がソケットで応答しなかった");
  } finally {
    daemon.kill("SIGTERM");
    await daemon.status;
    await rm(dir, { recursive: true, force: true });
  }
});
