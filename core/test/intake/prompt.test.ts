import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import {
  buildInitialPrompt,
  buildInvalidOutputMessage,
  buildNoQuestionsMessage,
  buildRevisionPrompt,
} from "../../src/intake/prompt.ts";
import { frozenPart } from "../../src/intake/pfd/validate.ts";
import { buildFeedback } from "../../../shared/intake/feedback.ts";
import { example } from "./pfd/fixture.ts";

const issue = {
  url: "https://github.com/o/r/issues/1",
  nodeId: "N1",
  title: "集計を出す",
  body: "本文 {{ steps.x.stdout }}",
  comments: [{ author: "alice", body: "コメント本文", createdAt: "2026-09-01T00:00:00Z" }],
};

test("初回の prompt に Issue の本文とコメント、分解の規則、論点の規則が載る", () => {
  const text = buildInitialPrompt({ issue });
  assert.match(text, /集計を出す/);
  assert.match(text, /alice/);
  assert.match(text, /コメント本文/);
  assert.match(text, /割りすぎを避ける/);
  assert.match(text, /actor: "human"/);
  assert.match(text, /自分で決められるものも含めて\*\*すべて\*\*洗い出し/);
  assert.match(text, /推奨は書かない/);
  assert.match(text, /影響が大きい順/);
  assert.match(text, /kind: "questions"/);
});

test("Issue 本文の {{ }} はテンプレートとして展開せずそのまま載せる", () => {
  assert.ok(buildInitialPrompt({ issue }).includes("{{ steps.x.stdout }}"));
});

test("調査の検証落ちには、質問と仮定だけを返す旨が添わる", () => {
  assert.match(buildInvalidOutputMessage("investigate", ["a"]), /質問と仮定だけ/);
  assert.doesNotMatch(buildInvalidOutputMessage("decompose", ["a"]), /質問と仮定だけ/);
});

test("質問が無かったときの文面は PFD を返させる", () => {
  assert.match(buildNoQuestionsMessage(), /kind: "pfd"/);
});

test("buildRevisionPrompt: 承認済みの計画・固定された部分・決定・コメントを載せる", () => {
  const text = buildRevisionPrompt({
    issue,
    approved: example(),
    frozen: frozenPart(example(), new Set(["1"])),
    retiredProcessIds: ["9"],
    decisions: { q1: "選んだ選択肢: 案A（a）" },
    feedback: buildFeedback(example(), [
      { target_kind: "process", target_id: "4", body: "画面を分けて" },
    ]),
  });
  assert.match(text, /## 承認済みの計画/);
  assert.match(text, /## 固定された部分/);
  assert.match(text, /マイグレーションを書く/);
  assert.match(text, /new-table/);
  assert.match(text, /schema/);
  assert.match(text, /## 使えない id/);
  assert.match(text, /- 9/);
  assert.match(text, /q1: 選んだ選択肢: 案A（a）/);
  assert.match(text, /画面を分けて/);
  assert.match(text, /集計を出す/);
  assert.match(text, /割りすぎを避ける/);
  assert.match(text, /推奨は書かない/);
});

test("buildRevisionPrompt: 固定された部分が無ければそう書く", () => {
  const text = buildRevisionPrompt({
    issue,
    approved: example(),
    frozen: { processes: [], artifacts: [] },
    retiredProcessIds: [],
    decisions: {},
    feedback: "コメント",
  });
  assert.match(text, /固定された部分はありません/);
  assert.doesNotMatch(text, /## 使えない id/);
});
