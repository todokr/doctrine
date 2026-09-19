import { afterEach, beforeEach, test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { connect, type Socket } from "node:net";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, resolveSocketPath } from "../../src/daemon/server.ts";

let root: string;
let sock: string;
const servers: { close(): Promise<void> }[] = [];
const sockets: Socket[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "doctrine-sock-"));
  sock = join(root, "dctld.sock");
});
afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  for (const s of servers.splice(0)) await s.close();
  await rm(root, { recursive: true, force: true });
});

function client(path: string) {
  const socket = connect(path);
  sockets.push(socket);
  const lines: string[] = [];
  let buf = "";
  socket.setEncoding("utf8");
  socket.on("data", (c: string) => {
    buf += c;
    let i: number;
    while ((i = buf.indexOf("\n")) !== -1) {
      lines.push(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  });
  return {
    socket,
    lines,
    send: (o: unknown) => socket.write(JSON.stringify(o) + "\n"),
    async next(pred: (o: Record<string, unknown>) => boolean, timeoutMs = 2000) {
      const until = Date.now() + timeoutMs;
      while (Date.now() < until) {
        for (const l of lines.splice(0)) {
          const o = JSON.parse(l) as Record<string, unknown>;
          if (pred(o)) return o;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error("タイムアウト: 期待するメッセージが届きませんでした");
    },
  };
}

test("リクエストにレスポンスを返す", async () => {
  const s = createServer(async (method, params) => ({ echoed: method, params }));
  servers.push(s);
  await s.listen(sock);
  const c = client(sock);
  c.send({ id: 1, method: "ping", params: { a: 1 } });
  const res = await c.next((o) => o.id === 1);
  assert.equal(res.ok, true);
  assert.deepEqual((res.result as { echoed: string }).echoed, "ping");
  c.socket.end();
});

test("ハンドラの例外はエラーレスポンスになり、接続は切れない", async () => {
  const s = createServer(async (method) => {
    if (method === "boom") throw new Error("こわれた");
    return "ok";
  });
  servers.push(s);
  await s.listen(sock);
  const c = client(sock);
  c.send({ id: 1, method: "boom" });
  const err = await c.next((o) => o.id === 1);
  assert.equal(err.ok, false);
  assert.match(String(err.error), /こわれた/);
  c.send({ id: 2, method: "fine" });
  assert.equal((await c.next((o) => o.id === 2)).ok, true);
  c.socket.end();
});

test("イベントを全クライアントにプッシュする", async () => {
  const s = createServer(async () => "ok");
  servers.push(s);
  await s.listen(sock);
  const a = client(sock);
  const b = client(sock);
  await new Promise((r) => setTimeout(r, 50));
  s.broadcast({ event: "task.stateChanged", task_id: "t1", from: "queued", to: "running" });
  for (const c of [a, b]) {
    const ev = await c.next((o) => o.event === "task.stateChanged");
    assert.equal(ev.to, "running");
  }
  a.socket.end();
  b.socket.end();
});

test("log.line は follow 中のクライアントにだけ流れる", async () => {
  const s = createServer(async (method, params, conn) => {
    if (method === "task.logs" && params.follow) conn.follow(String(params.task_id));
    return "ok";
  });
  servers.push(s);
  await s.listen(sock);
  const follower = client(sock);
  const idle = client(sock);
  follower.send({ id: 1, method: "task.logs", params: { task_id: "t1", follow: true } });
  await follower.next((o) => o.id === 1);
  s.broadcast(
    { event: "log.line", task_id: "t1", step_run_id: 1, line: "hello" },
    { taskId: "t1", followersOnly: true },
  );
  await follower.next((o) => o.event === "log.line");
  await assert.rejects(() => idle.next((o) => o.event === "log.line", 200));
  follower.socket.end();
  idle.socket.end();
});

test("follow は1接続につき1タスク。次を追い始めた時点で前のタスクは流れなくなる", async () => {
  const s = createServer(async (method, params, conn) => {
    if (method === "task.logs" && params.follow) conn.follow(String(params.task_id));
    return "ok";
  });
  servers.push(s);
  await s.listen(sock);
  const c = client(sock);
  c.send({ id: 1, method: "task.logs", params: { task_id: "t1", follow: true } });
  await c.next((o) => o.id === 1);
  c.send({ id: 2, method: "task.logs", params: { task_id: "t2", follow: true } });
  await c.next((o) => o.id === 2);

  s.broadcast(
    { event: "log.line", task_id: "t2", step_run_id: 2, line: "新しい方" },
    { followersOnly: true },
  );
  await c.next((o) => o.event === "log.line");
  s.broadcast(
    { event: "log.line", task_id: "t1", step_run_id: 1, line: "前の方" },
    { followersOnly: true },
  );
  await assert.rejects(
    () => c.next((o) => o.event === "log.line" && o.line === "前の方", 200),
    /タイムアウト/,
    "画面を切り替えた後も前のタスクのログが流れ続ける",
  );
  c.socket.end();
});

test("listen: パスに古いファイルが残っていても bind できる（事前unlinkの許容性）", async () => {
  // 生きたソケットではなく、ただのファイルを置く。close()を経由しない。
  await writeFile(sock, "stale");
  const s = createServer(async () => "ok");
  servers.push(s);
  await s.listen(sock);
});

test("close: 使ったパスをファイルシステムから実際に解放する", async () => {
  const s = createServer(async () => "ok");
  await s.listen(sock);
  await s.close();
  // servers配列には入れない: close済みなのでafterEachでの二重closeは不要。
  await assert.rejects(() => stat(sock));
});

test("followersOnly は opts.taskId が省略されてもイベント自身の task_id で絞り込む", async () => {
  const s = createServer(async (method, params, conn) => {
    if (method === "task.logs" && params.follow) conn.follow(String(params.task_id));
    return "ok";
  });
  servers.push(s);
  await s.listen(sock);
  const follower = client(sock);
  const idle = client(sock);
  follower.send({ id: 1, method: "task.logs", params: { task_id: "t1", follow: true } });
  await follower.next((o) => o.id === 1);
  // opts.taskId を渡さない呼び出し（呼び出し側の指定漏れを想定）。
  // task_id を持たないイベントで followersOnly を使う場合は誰にも配らない（fail closed）。
  s.broadcast(
    { event: "ratelimit.sample", window: "1h", utilization: 0.5, resets_at: null },
    { followersOnly: true },
  );
  await assert.rejects(
    () => follower.next((o) => o.event === "ratelimit.sample", 200),
    /タイムアウト/,
  );
  // task_id を持つイベントなら、opts.taskId 省略でもイベント自身の task_id で絞り込まれる。
  s.broadcast(
    { event: "log.line", task_id: "t1", step_run_id: 1, line: "hi" },
    { followersOnly: true },
  );
  await follower.next((o) => o.event === "log.line");
  await assert.rejects(() => idle.next((o) => o.event === "log.line", 200));
  follower.socket.end();
  idle.socket.end();
});

test("JSONとして読めない行はidなしのエラー応答になり、接続は生きたまま次のリクエストに応答する", async () => {
  const s = createServer(async () => "ok");
  servers.push(s);
  await s.listen(sock);
  const c = client(sock);
  c.socket.write("これはJSONではない\n");
  const err = await c.next((o) => o.ok === false);
  assert.equal(err.id, null);
  assert.match(String(err.error), /JSON/);
  c.send({ id: 1, method: "fine" });
  const ok = await c.next((o) => o.id === 1);
  assert.equal(ok.ok, true);
  c.socket.end();
});

test("行の長さに上限がなく、巨大な1行でもフレーミングが壊れない", async () => {
  const big = "x".repeat(1_000_000);
  const s = createServer(async () => big);
  servers.push(s);
  await s.listen(sock);
  const c = client(sock);
  c.send({ id: 1, method: "big" });
  const res = await c.next((o) => o.id === 1, 5000);
  assert.equal(res.ok, true);
  assert.equal((res.result as string).length, 1_000_000);
  c.socket.end();
});

const socketEnv = (o: Partial<import("../../src/daemon/server.ts").SocketEnv> = {}) => ({
  stateRoot: () => "/home/u/.local/state/doctrine",
  uid: 501,
  os: "linux" as const,
  ...o,
});

test("resolveSocketPath: DOCTRINE_SOCKET があればそれを使う", () => {
  assert.equal(
    resolveSocketPath(socketEnv({ doctrineSocket: "/tmp/x.sock", xdgRuntimeDir: "/run/user/1" })),
    "/tmp/x.sock",
  );
});

test("resolveSocketPath: XDG_RUNTIME_DIR があれば OS によらずその下", () => {
  assert.equal(
    resolveSocketPath(socketEnv({ xdgRuntimeDir: "/run/user/501", os: "darwin" })),
    "/run/user/501/doctrine/dctld.sock",
  );
});

test("resolveSocketPath: Linux で XDG_RUNTIME_DIR が無ければ /run/user/<uid>", () => {
  assert.equal(resolveSocketPath(socketEnv()), "/run/user/501/doctrine/dctld.sock");
});

test("resolveSocketPath: macOS で XDG_RUNTIME_DIR が無ければ状態ディレクトリ", () => {
  // macOS には XDG_RUNTIME_DIR が無く /run は read-only なので、/run/user には作れない
  assert.equal(
    resolveSocketPath(socketEnv({ os: "darwin" })),
    "/home/u/.local/state/doctrine/dctld.sock",
  );
});

test("resolveSocketPath: 空文字の環境変数は未設定として扱う", () => {
  assert.equal(
    resolveSocketPath(socketEnv({ doctrineSocket: "", xdgRuntimeDir: "" })),
    "/run/user/501/doctrine/dctld.sock",
  );
});

test("resolveSocketPath: XDG_RUNTIME_DIR があれば stateRoot を解決しない", () => {
  const boom = () => {
    throw new Error("呼ばれてはいけません");
  };
  assert.equal(
    resolveSocketPath({ xdgRuntimeDir: "/run/user/501", stateRoot: boom, uid: 501, os: "linux" }),
    "/run/user/501/doctrine/dctld.sock",
  );
});
