import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { realPorts, type Run } from "../src/ports.ts";

interface Call {
  cmd: string;
  args: string[];
  cwd?: string;
}

function fakeRun(stdout: string): { run: Run; calls: Call[] } {
  const calls: Call[] = [];
  const run: Run = (cmd, args, cwd) => {
    calls.push({ cmd, args, cwd });
    return Promise.resolve(stdout);
  };
  return { run, calls };
}

test("listTasks: dctl ls を呼び、必要な列だけを返す", async () => {
  const { run, calls } = fakeRun(JSON.stringify([
    { id: "t1", title: "[pfd:123/1] x", state: "running", branch: "doctrine/t1-x", prompt: "長い" },
  ]));
  const tasks = await realPorts(run).listTasks("/work/repo");
  assert.deepEqual(calls, [{
    cmd: "dctl",
    args: ["ls", "--project", "/work/repo"],
    cwd: undefined,
  }]);
  assert.deepEqual(tasks, [
    { id: "t1", title: "[pfd:123/1] x", state: "running", branch: "doctrine/t1-x" },
  ]);
});

test("addTask: dctl add を呼び、id と branch を返す", async () => {
  const { run, calls } = fakeRun(JSON.stringify({ id: "t2", branch: "doctrine/t2", warnings: [] }));
  const created = await realPorts(run).addTask("/work/repo", "[pfd:123/2] y", "本文");
  assert.deepEqual(calls[0].args, [
    "add",
    "--project",
    "/work/repo",
    "--title",
    "[pfd:123/2] y",
    "--prompt",
    "本文",
  ]);
  assert.deepEqual(created, { id: "t2", branch: "doctrine/t2" });
});

test("prState: マージ済みの PR が 1 つでもあれば merged", async () => {
  const { run, calls } = fakeRun(JSON.stringify([{ state: "CLOSED" }, { state: "MERGED" }]));
  assert.equal(await realPorts(run).prState("/work/repo", "doctrine/t1"), "merged");
  assert.deepEqual(calls[0], {
    cmd: "gh",
    args: ["pr", "list", "--head", "doctrine/t1", "--state", "all", "--json", "state"],
    cwd: "/work/repo",
  });
});

test("prState: 開いている PR だけなら open", async () => {
  const { run } = fakeRun(JSON.stringify([{ state: "OPEN" }]));
  assert.equal(await realPorts(run).prState("/work/repo", "b"), "open");
});

test("prState: PR が無い、または閉じられた PR だけなら none", async () => {
  assert.equal(await realPorts(fakeRun("[]").run).prState("/work/repo", "b"), "none");
  const closed = fakeRun(JSON.stringify([{ state: "CLOSED" }]));
  assert.equal(await realPorts(closed.run).prState("/work/repo", "b"), "none");
});

test("issue: gh issue view を対象リポジトリの中で呼ぶ", async () => {
  const { run, calls } = fakeRun(
    JSON.stringify({ url: "https://github.com/o/r/issues/123", title: "集計" }),
  );
  const issue = await realPorts(run).issue("/work/repo", 123);
  assert.deepEqual(calls[0], {
    cmd: "gh",
    args: ["issue", "view", "123", "--json", "url,title"],
    cwd: "/work/repo",
  });
  assert.deepEqual(issue, { url: "https://github.com/o/r/issues/123", title: "集計" });
});

test("JSON として読めない出力は、どのコマンドのものかを示して失敗する", async () => {
  await assert.rejects(realPorts(fakeRun("not json").run).listTasks("/work/repo"), /dctl ls/);
});
