import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { renderEvent } from "../../src/adapter/render.ts";

test("ツール呼び出しは道具の名前と、何を相手にしたかを1行で出す", () => {
  assert.equal(
    renderEvent({ kind: "toolUse", name: "Bash", input: { command: "ls -A /wt" } }),
    "Bash  ls -A /wt",
  );
  assert.equal(
    renderEvent({ kind: "toolUse", name: "Read", input: { file_path: "core/src/x.ts" } }),
    "Read  core/src/x.ts",
  );
  assert.equal(
    renderEvent({ kind: "toolUse", name: "Grep", input: { pattern: "log", path: "core/src" } }),
    "Grep  log  core/src",
  );
});

test("複数行のコマンドは1行目だけを出す", () => {
  assert.equal(
    renderEvent({ kind: "toolUse", name: "Bash", input: { command: "cd /wt\nls -A" } }),
    "Bash  cd /wt…",
  );
});

test("知らないツールは名前と入力の要約で出す", () => {
  assert.equal(
    renderEvent({ kind: "toolUse", name: "mcp__linear__get_issue", input: { id: "ENG-1" } }),
    'mcp__linear__get_issue  {"id":"ENG-1"}',
  );
});

test("入力が空のツールは名前だけ出す", () => {
  assert.equal(renderEvent({ kind: "toolUse", name: "ListAgents", input: {} }), "ListAgents");
});

test("ツールの結果は成否がひと目で分かる1行にする", () => {
  assert.equal(
    renderEvent({ kind: "toolResult", isError: false, content: "err.txt\nraw.ndjson" }),
    "  → err.txt raw.ndjson",
  );
  assert.equal(
    renderEvent({ kind: "toolResult", isError: true, content: "File does not exist" }),
    "  ✗ File does not exist",
  );
});

test("長い結果は切り詰める。全文はログを読む目的ではない", () => {
  const line = renderEvent({ kind: "toolResult", isError: false, content: "あ".repeat(500) });
  assert.ok(line!.length < 140, `切り詰めていない: ${line!.length}文字`);
  assert.ok(line!.endsWith("…"));
});

test("出力のないツール結果は行を作らない", () => {
  assert.equal(renderEvent({ kind: "toolResult", isError: false, content: "   " }), null);
});

test("エージェントの発話はそのまま出す", () => {
  assert.equal(renderEvent({ kind: "assistant", text: "原因はここです" }), "原因はここです");
});

test("空の発話は行を作らない。plan ではこれが大半を占めていた", () => {
  assert.equal(renderEvent({ kind: "assistant", text: "" }), null);
});

test("利用上限の観測は枠と消費率を出す", () => {
  assert.equal(
    renderEvent({
      kind: "rateLimit",
      window: "five_hour",
      utilization: 0.14,
      resetsAt: "2026-09-12T05:00:00Z",
    }),
    "枠 five_hour 14%",
  );
});

test("system と result は行を作らない。hook や thinking_tokens は読む側に何も伝えない", () => {
  assert.equal(renderEvent({ kind: "system", subtype: "thinking_tokens" }), null);
  assert.equal(renderEvent({ kind: "system", subtype: "init" }), null);
  assert.equal(renderEvent({ kind: "result" }), null);
});
