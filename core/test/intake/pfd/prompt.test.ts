import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { buildTaskPrompt } from "../../../src/intake/pfd/prompt.ts";
import { example, withDecision } from "./fixture.ts";

const parentIssue = {
  url: "https://github.com/o/r/issues/123",
  title: "利用状況の集計を画面に出す",
};
const humanNotes = { "3": "ログイン 1 回を 1 利用と数える" };

const rest = `この作業は、上の Issue を分解したうちの 1 つである。

## 目的
集計テーブルの数字を外から読めるようにする

## 前提
すでに baseBranch にあるもの:
- 集計テーブル: 日次の利用回数を持つテーブルとマイグレーション

人が決めたこと:
- 集計の定義: ログイン 1 回を 1 利用と数える

## 作るもの
- 集計 API: 日次の利用回数を返す GET /usage
  確かめ方: API のテストが通る

## 手順
GET /usage を足し、集計テーブルを読んで返す

## 完了条件
API のテストが通る

## 範囲
この作業の出力は上の「作るもの」だけである。Issue の残りの部分は別の作業が担う。
`;

test("buildTaskPrompt: sub-issue が無ければ PFD spec 7.2 の形そのまま", () => {
  const text = buildTaskPrompt({
    pfd: example(),
    processId: "2",
    parentIssue,
    subIssueUrl: null,
    humanNotes,
    decisions: {},
  });
  assert.equal(
    text,
    `https://github.com/o/r/issues/123 利用状況の集計を画面に出す\n\n${rest}`,
  );
});

test("buildTaskPrompt: sub-issue があれば親 Issue の次の行に載せる", () => {
  const text = buildTaskPrompt({
    pfd: example(),
    processId: "2",
    parentIssue,
    subIssueUrl: "https://github.com/o/r/issues/201",
    humanNotes,
    decisions: {},
  });
  assert.equal(
    text,
    "https://github.com/o/r/issues/123 利用状況の集計を画面に出す\n" +
      "この作業の sub-issue: https://github.com/o/r/issues/201\n\n" +
      rest,
  );
});

test("buildTaskPrompt: 人の成果物が無ければ「人が決めたこと」を出さない", () => {
  const text = buildTaskPrompt({
    pfd: example(),
    processId: "1",
    parentIssue,
    subIssueUrl: null,
    humanNotes: {},
    decisions: {},
  });
  assert.ok(!text.includes("人が決めたこと"));
  // description の無い成果物は名前だけ
  assert.ok(text.includes("すでに baseBranch にあるもの:\n- 既存スキーマ\n"));
});

test("buildTaskPrompt: 決定の成果物は回答を「人が決めたこと」に載せる", () => {
  const text = buildTaskPrompt({
    pfd: withDecision(),
    processId: "2",
    parentIssue,
    subIssueUrl: null,
    humanNotes,
    decisions: { q1: "月単位で集計する" },
  });
  assert.ok(
    text.includes(
      "人が決めたこと:\n- 集計の定義: ログイン 1 回を 1 利用と数える\n- 集計の方針: 月単位で集計する",
    ),
  );
  const onBase = text.slice(
    text.indexOf("すでに baseBranch にあるもの"),
    text.indexOf("人が決めたこと"),
  );
  assert.ok(!onBase.includes("集計の方針"));
});

test("buildTaskPrompt: 人のプロセスの note が無ければ失敗する", () => {
  assert.throws(
    () =>
      buildTaskPrompt({
        pfd: example(),
        processId: "2",
        parentIssue,
        subIssueUrl: null,
        humanNotes: {},
        decisions: {},
      }),
    /集計の定義/,
  );
});

test("buildTaskPrompt: 決定の回答が無ければ失敗する", () => {
  assert.throws(
    () =>
      buildTaskPrompt({
        pfd: withDecision(),
        processId: "2",
        parentIssue,
        subIssueUrl: null,
        humanNotes,
        decisions: {},
      }),
    /集計の方針.*q1/,
  );
});

test("buildTaskPrompt: 案に無いプロセスは失敗する", () => {
  assert.throws(
    () =>
      buildTaskPrompt({
        pfd: example(),
        processId: "9",
        parentIssue,
        subIssueUrl: null,
        humanNotes,
        decisions: {},
      }),
    /プロセス 9/,
  );
});
