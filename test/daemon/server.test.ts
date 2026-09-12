import { test, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { connect, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../src/daemon/server.ts";

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

test("既存のソケットファイルがあっても listen できる", async () => {
  const s1 = createServer(async () => "ok");
  await s1.listen(sock);
  await s1.close();
  const s2 = createServer(async () => "ok");
  servers.push(s2);
  await s2.listen(sock);
});
