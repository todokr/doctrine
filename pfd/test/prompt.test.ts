import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { parsePfd } from "../src/model.ts";
import { buildPrompt } from "../src/prompt.ts";
import { emptyRecord } from "../src/store.ts";
import { EXAMPLE_YAML } from "./fixture.ts";

const pfd = parsePfd(EXAMPLE_YAML);
const issue = { url: "https://github.com/o/r/issues/123", title: "利用状況の集計を画面に出す" };

test("buildPrompt: 人の成果物を入力に取るプロセス", () => {
  const record = emptyRecord();
  record.done["3"] = { note: "ログイン 1 回を 1 利用と数える", at: "2026-09-20T00:00:00.000Z" };

  const expected = `https://github.com/o/r/issues/123 利用状況の集計を画面に出す

この作業は、上の Issue を分解したうちの 1 つである。

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
  assert.equal(buildPrompt(pfd, pfd.processes[1], record, issue), expected);
});

test("buildPrompt: 人の成果物が無ければ「人が決めたこと」を出さない", () => {
  const text = buildPrompt(pfd, pfd.processes[0], emptyRecord(), issue);
  assert.ok(!text.includes("人が決めたこと"));
  // description の無い成果物は名前だけ
  assert.ok(text.includes("すでに baseBranch にあるもの:\n- 既存スキーマ\n"));
});

test("buildPrompt: 人の成果物の note が無ければ失敗する", () => {
  assert.throws(
    () => buildPrompt(pfd, pfd.processes[1], emptyRecord(), issue),
    /集計の定義.*pfd done/,
  );
});
