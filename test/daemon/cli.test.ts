import { test } from "vitest";
import assert from "node:assert/strict";
import { parseArgv } from "../../src/cli/dctl.ts";

test("dctl add", () => {
  assert.deepEqual(
    parseArgv(["add", "--project", "/repo", "--title", "T", "--prompt", "直して"]),
    { method: "task.create", params: { project: "/repo", title: "T", prompt: "直して" } },
  );
});

test("dctl ls", () => {
  assert.deepEqual(parseArgv(["ls"]), { method: "task.list", params: {} });
  assert.deepEqual(parseArgv(["ls", "--state", "queued"]), { method: "task.list", params: { state: "queued" } });
});

test("dctl approve / reject", () => {
  assert.deepEqual(parseArgv(["approve", "t1"]), { method: "task.approve", params: { task_id: "t1" } });
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
  const { params } = parseArgv(["add", "--project", "/r", "--title", "T", "--prompt", "p", "--priority", "0"]);
  assert.equal(params.priority, 0);
});

test("未知のサブコマンドは落ちる", () => {
  assert.throws(() => parseArgv(["frobnicate"]), /未知のコマンド/);
});
