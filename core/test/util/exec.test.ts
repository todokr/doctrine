import { test } from "node:test";
import assert from "node:assert/strict";
import { exitCodeOf, runCommand, spawnChild } from "../../src/util/exec.ts";

test("runCommand は 1MB を超える出力を切り詰めずに返す", async () => {
  const { stdout } = await runCommand("sh", ["-c", "head -c 3000000 /dev/zero | tr '\\0' a"]);
  assert.equal(stdout.length, 3_000_000);
});

test("runCommand は env を親の環境に重ねる", async () => {
  process.env.DOCTRINE_EXEC_PARENT = "p";
  try {
    const { stdout } = await runCommand("sh", ["-c", 'echo "$DOCTRINE_EXEC_PARENT-$X"'], {
      env: { X: "x" },
    });
    assert.equal(stdout.trim(), "p-x");
  } finally {
    delete process.env.DOCTRINE_EXEC_PARENT;
  }
});

test("runCommand は clearEnv のとき env に渡したものだけを環境にする", async () => {
  process.env.DOCTRINE_EXEC_PARENT = "p";
  try {
    const { stdout } = await runCommand(
      "/bin/sh",
      ["-c", 'echo "[$DOCTRINE_EXEC_PARENT]-$X"'],
      { env: { X: "x" }, clearEnv: true },
    );
    assert.equal(stdout.trim(), "[]-x");
  } finally {
    delete process.env.DOCTRINE_EXEC_PARENT;
  }
});

test("runCommand は非0終了を stderr 付きの例外にする", async () => {
  await assert.rejects(runCommand("sh", ["-c", "echo boom >&2; exit 3"]), /boom/);
});

test("spawnChild は存在しないコマンドで reject し、プロセスは落ちない", async () => {
  await assert.rejects(
    spawnChild("doctrine-no-such-binary", [], {}),
    (e: NodeJS.ErrnoException) => e.code === "ENOENT",
  );
});

test("spawnChild は存在しない cwd で reject する", async () => {
  await assert.rejects(spawnChild("sh", ["-c", "true"], { cwd: "/nonexistent/doctrine" }));
});

test("spawnChild の status はシグナルで殺されたとき exitCodeOf が null になる", async () => {
  const child = await spawnChild("sleep", ["10"], {});
  child.kill("SIGTERM");
  const status = await child.status;
  assert.equal(status.signal, "SIGTERM");
  assert.equal(exitCodeOf(status), null);
});

test("spawnChild は stdout をマルチバイト文字ごと読み切れる", async () => {
  const child = await spawnChild("sh", ["-c", "printf 'あいう'"], {});
  const chunks: Buffer[] = [];
  for await (const c of child.stdout) chunks.push(c as Buffer);
  assert.equal(Buffer.concat(chunks).toString("utf8"), "あいう");
  assert.equal(exitCodeOf(await child.status), 0);
});
