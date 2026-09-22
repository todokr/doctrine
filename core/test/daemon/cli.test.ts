import { afterEach, beforeEach, test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call, followLogs, parseArgv } from "../../src/cli/dctl.ts";

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

test("dctl intake ls / get", () => {
  assert.deepEqual(parseArgv(["intake", "ls"]), { method: "intake.list", params: {} });
  assert.deepEqual(
    parseArgv(["intake", "ls", "--project", "/r", "--include_closed"]),
    { method: "intake.list", params: { project: "/r", include_closed: true } },
  );
  assert.deepEqual(
    parseArgv(["intake", "get", "i1"]),
    { method: "intake.get", params: { intake_id: "i1" } },
  );
});

test("dctl に Intake の操作は無い", () => {
  for (
    const argv of [
      ["intake", "approve", "i1"],
      ["intake", "start"],
      ["intake", "reject", "i1"],
      ["intake", "complete", "i1"],
      ["intake", "redispatch", "i1"],
      ["intake", "cancel", "i1"],
    ]
  ) {
    assert.throws(() => parseArgv(argv), /未知のコマンドです/);
  }
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
  assert.deepEqual(
    parseArgv(["gc", "--path", "/s/worktrees/r/x"]),
    { method: "worktree.remove", params: { path: "/s/worktrees/r/x" } },
  );
  assert.deepEqual(
    parseArgv(["gc", "--path", "/p", "--force"]),
    { method: "worktree.remove", params: { path: "/p", force: true } },
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

test("dctl logs --follow", () => {
  assert.deepEqual(parseArgv(["logs", "t1", "--follow"]), {
    method: "task.logs",
    params: { task_id: "t1", follow: true },
  });
});

/** 最初に届いたリクエスト（1 行 JSON）を読んで、parse したものを渡す。 */
function onRequest(socket: Socket, handler: (request: unknown) => void): void {
  socket.once("data", (data) => handler(JSON.parse(data.toString().split("\n")[0])));
}

const logLine = (task_id: string, step_run_id: number, line: string) =>
  JSON.stringify({ event: "log.line", task_id, step_run_id, line }) + "\n";

test("followLogs: 末尾を出した後、そのタスクの log.line だけを届いた順に出す", async () => {
  let request: unknown;
  await fakeDaemon((socket) => {
    onRequest(socket, (req) => {
      request = req;
      socket.write(logLine("t1", 1, "応答前"));
      socket.write(
        JSON.stringify({
          id: 1,
          ok: true,
          result: { step_run_id: 1, log_path: "/x", lines: ["a", "", "b", ""] },
        }) + "\n",
      );
      socket.write(logLine("t1", 1, "c"));
      socket.write(
        JSON.stringify({
          event: "task.stateChanged",
          task_id: "t1",
          from: "queued",
          to: "running",
        }) +
          "\n",
      );
      socket.write(logLine("t2", 9, "他タスク"));
      socket.write(logLine("t1", 2, "d"));
      socket.end();
    });
  });
  const got: string[] = [];
  await assert.rejects(
    followLogs(
      sock,
      { task_id: "t1", follow: true },
      (l) => got.push(l),
      new AbortController().signal,
    ),
    /デーモンが接続を閉じました/,
  );
  assert.deepEqual(got, ["a", "", "b", "c", "d"]);
  assert.deepEqual(request, {
    id: 1,
    method: "task.logs",
    params: { task_id: "t1", follow: true },
  });
});

test("followLogs: 中断すると接続を閉じて resolve する", async () => {
  await fakeDaemon((socket) => {
    onRequest(socket, () => {
      socket.write(
        JSON.stringify({
          id: 1,
          ok: true,
          result: { step_run_id: 1, log_path: "/x", lines: ["a"] },
        }) + "\n",
      );
      socket.write(logLine("t1", 1, "b"));
      // 閉じない。追従中のデーモンを模す。
    });
  });
  const controller = new AbortController();
  const got: string[] = [];
  await followLogs(sock, { task_id: "t1", follow: true }, (l) => {
    got.push(l);
    if (l === "b") controller.abort();
  }, controller.signal);
  assert.deepEqual(got, ["a", "b"]);
});

test("followLogs: 最初の応答が来ないとタイムアウトする", async () => {
  await fakeDaemon(() => {
    // 何も書き込まない。応答を返さないデーモンを模す。
  });
  await assert.rejects(
    followLogs(sock, { task_id: "t1", follow: true }, () => {}, new AbortController().signal, 50),
    /応答がありません/,
  );
});

test("followLogs: 失敗の応答はそのまま投げる", async () => {
  await fakeDaemon((socket) => {
    onRequest(socket, () => {
      socket.write(JSON.stringify({ id: 1, ok: false, error: "ステップ実行がありません" }) + "\n");
    });
  });
  const got: string[] = [];
  await assert.rejects(
    followLogs(
      sock,
      { task_id: "t1", follow: true },
      (l) => got.push(l),
      new AbortController().signal,
    ),
    /ステップ実行がありません/,
  );
  assert.deepEqual(got, []);
});
