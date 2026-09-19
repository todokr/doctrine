import { afterEach, beforeEach, test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call, parseArgv } from "../../src/cli/dctl.ts";

let root: string;
let sock: string;
const servers: Server[] = [];
const sockets: Socket[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "doctrine-cli-"));
  sock = join(root, "dctld.sock");
});
afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  for (const s of servers.splice(0)) await new Promise<void>((resolve) => s.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

test("dctl add", () => {
  assert.deepEqual(
    parseArgv(["add", "--project", "/repo", "--title", "T", "--prompt", "直して"]),
    { method: "task.create", params: { project: "/repo", title: "T", prompt: "直して" } },
  );
});

test("dctl diff", () => {
  assert.deepEqual(
    parseArgv(["diff", "abc123"]),
    { method: "task.diff", params: { task_id: "abc123" } },
  );
  assert.deepEqual(
    parseArgv(["diff", "abc123", "--since", "last_review"]),
    { method: "task.diff", params: { task_id: "abc123", since: "last_review" } },
  );
});

test("dctl ls", () => {
  assert.deepEqual(parseArgv(["ls"]), { method: "task.list", params: {} });
  assert.deepEqual(parseArgv(["ls", "--state", "queued"]), {
    method: "task.list",
    params: { state: "queued" },
  });
});

test("dctl approve / reject", () => {
  assert.deepEqual(parseArgv(["approve", "t1"]), {
    method: "task.approve",
    params: { task_id: "t1" },
  });
  assert.deepEqual(
    parseArgv(["reject", "t1", "--comment", "命名が変"]),
    { method: "task.reject", params: { task_id: "t1", comment: "命名が変" } },
  );
});

test("dctl gc は worktree.remove", () => {
  assert.deepEqual(
    parseArgv(["gc", "t1", "--force"]),
    { method: "worktree.remove", params: { task_id: "t1", force: true } },
  );
});

test("priority は数値になる", () => {
  const { params } = parseArgv([
    "add",
    "--project",
    "/r",
    "--title",
    "T",
    "--prompt",
    "p",
    "--priority",
    "0",
  ]);
  assert.equal(params.priority, 0);
});

test("未知のサブコマンドは使い方を添えて落ちる", () => {
  assert.throws(() => parseArgv(["frobnicate"]), /未知のコマンドです: frobnicate[\s\S]*使い方/);
});

test("引数なし・help・--help は使い方を出す", () => {
  for (const argv of [[], ["help"], ["--help"], ["-h"]]) {
    assert.throws(() => parseArgv(argv), /^Error: 使い方: dctl/);
  }
});

test("値が繰り返されても positional を誤判定しない（indexOf バグの再発防止）", () => {
  assert.deepEqual(
    parseArgv(["reject", "t1", "--comment", "t1"]),
    { method: "task.reject", params: { task_id: "t1", comment: "t1" } },
  );
});

test("数値フラグに数値でない値を渡すと落ちる", () => {
  assert.throws(
    () =>
      parseArgv(["add", "--project", "/r", "--title", "T", "--prompt", "p", "--priority", "abc"]),
    /--priority.*数値/,
  );
});

// --- call() はソケットでデーモンとやり取りする。ここではテスト用の使い捨てサーバを
// 一時ディレクトリ上のソケットで立て、call() の挙動（イベント無視・null id・
// 不正JSON・タイムアウト）を検証する。実ソケットパス（socketPath()）には触れない。

/** 接続してきたソケットに、渡した行（JSON文字列化前提の生テキスト）を順番に流す使い捨てサーバ。 */
function fakeDaemon(onConnect: (socket: Socket) => void): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer((socket) => {
      sockets.push(socket);
      onConnect(socket);
    });
    servers.push(server);
    server.listen(sock, () => resolve(server));
  });
}

test("call: null id の応答は確定的に reject する（ハングしない）", async () => {
  await fakeDaemon((socket) => {
    socket.write(JSON.stringify({ id: null, ok: false, error: "JSONとして読めません" }) + "\n");
  });
  await assert.rejects(call(sock, "task.list", {}), /JSONとして読めません/);
});

test("call: 応答の前に来たイベントは無視し、本来の応答で resolve する", async () => {
  await fakeDaemon((socket) => {
    socket.write(
      JSON.stringify({ event: "task.stateChanged", task_id: "t1", from: "queued", to: "running" }) +
        "\n",
    );
    socket.write(JSON.stringify({ id: 1, ok: true, result: { ok: true } }) + "\n");
  });
  const result = await call(sock, "task.list", {});
  assert.deepEqual(result, { ok: true });
});

test("call: JSONとして読めない応答は reject する（プロセスを落とさない）", async () => {
  await fakeDaemon((socket) => {
    socket.write("これはJSONではない\n");
  });
  await assert.rejects(call(sock, "task.list", {}), /JSONとして読めません/);
});

test("call: ソケットが存在しないとデーモン未起動を示すメッセージで reject する", async () => {
  const missing = join(root, "no-such.sock");
  await assert.rejects(
    call(missing, "task.list", {}),
    new RegExp(`デーモンが起動していないようです.*${missing}`),
  );
});

test("call: 応答が来ないままタイムアウトする（短いタイムアウトを注入）", async () => {
  await fakeDaemon(() => {
    // 何も書き込まない。応答を返さないデーモンを模す。
  });
  await assert.rejects(call(sock, "task.list", {}, 50), /応答がありません/);
});
