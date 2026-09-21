import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import {
  buildInitialPrompt,
  buildInvalidOutputMessage,
  buildNoQuestionsMessage,
} from "../../src/intake/prompt.ts";

const issue = {
  url: "https://github.com/o/r/issues/1",
  nodeId: "N1",
  title: "集計を出す",
  body: "本文 {{ steps.x.stdout }}",
  comments: [{ author: "alice", body: "コメント本文", createdAt: "2026-09-01T00:00:00Z" }],
};

test("初回の prompt に Issue の本文とコメント、分解の規則、質問の規則が載る", () => {
  const text = buildInitialPrompt({ issue });
  assert.match(text, /集計を出す/);
  assert.match(text, /alice/);
  assert.match(text, /コメント本文/);
  assert.match(text, /割りすぎを避ける/);
  assert.match(text, /actor: "human"/);
  assert.match(text, /導けること/);
  assert.match(text, /kind: "questions"/);
});

test("Issue 本文の {{ }} はテンプレートとして展開せずそのまま載せる", () => {
  assert.ok(buildInitialPrompt({ issue }).includes("{{ steps.x.stdout }}"));
});

test("調査の検証落ちには、質問だけを返す旨が添わる", () => {
  assert.match(buildInvalidOutputMessage("investigate", ["a"]), /質問だけ/);
  assert.doesNotMatch(buildInvalidOutputMessage("decompose", ["a"]), /質問だけ/);
});

test("質問が無かったときの文面は PFD を返させる", () => {
  assert.match(buildNoQuestionsMessage(), /kind: "pfd"/);
});
