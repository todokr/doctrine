import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import {
  buildSubIssue,
  parseSubIssueMarker,
  subIssueMarker,
  upstreamProcessIds,
} from "../../../shared/intake/subIssue.ts";
import { example, withDecision } from "./pfd/fixture.ts";

const U1 = "https://github.com/o/r/issues/101";
const U3 = "https://github.com/o/r/issues/103";

function build(processId: string, urls: [string, string][] = []) {
  return buildSubIssue({
    pfd: example(),
    intakeId: "i1",
    processId,
    upstreamUrls: new Map(urls),
  });
}

test("subIssueMarker: 目印を読み戻せる", () => {
  const body = `本文\n\n${subIssueMarker("i1", "2")}`;
  assert.deepEqual(parseSubIssueMarker(body), { intakeId: "i1", processId: "2" });
});

test("parseSubIssueMarker: 目印が無ければ null", () => {
  assert.equal(parseSubIssueMarker("本文だけ"), null);
});

test("parseSubIssueMarker: process=1 と process=10 を取り違えない", () => {
  const found = parseSubIssueMarker(`本文\n${subIssueMarker("i1", "10")}`);
  assert.equal(found?.processId, "10");
});

test("upstreamProcessIds: 入力を作るプロセスを返し、given は数えない", () => {
  const pfd = example();
  assert.deepEqual(upstreamProcessIds(pfd, "2"), ["1", "3"]);
  assert.deepEqual(upstreamProcessIds(pfd, "1"), []);
  assert.deepEqual(upstreamProcessIds(pfd, "4"), ["2"]);
});

test("buildSubIssue: title はプロセスの名前で、目印が最後の行にある", () => {
  const { title, body } = build("1");
  assert.equal(title, "マイグレーションを書く");
  assert.equal(body.split("\n").at(-1), subIssueMarker("i1", "1"));
});

test("buildSubIssue: 目的・入出力・確かめ方・完了条件を載せる", () => {
  const { body } = build("1");
  for (
    const s of [
      "集計結果を置く場所を用意する",
      "- 既存スキーマ",
      "- 集計テーブル: 日次の利用回数を持つテーブルとマイグレーション",
      "確かめ方: マイグレーションが適用でき、テーブル定義のテストが通る",
      "マイグレーションが適用でき、テストが通る",
    ]
  ) {
    assert.ok(body.includes(s), s);
  }
});

test("buildSubIssue: 上流の sub-issue の URL を並べる", () => {
  const { body } = build("2", [["1", U1], ["3", U3]]);
  assert.ok(body.includes(`- ${U1} マイグレーションを書く`));
  assert.ok(body.includes(`- ${U3} 集計の定義を決める`));
});

test("buildSubIssue: URL の無い上流は未作成と書く", () => {
  const { body } = build("2", [["1", U1]]);
  assert.ok(body.includes("集計の定義を決める（sub-issue 未作成）"));
});

test("buildSubIssue: 上流が無ければ節を出さない", () => {
  assert.ok(!build("1").body.includes("## 先に終わっている必要があるもの"));
});

test("buildSubIssue: 人のプロセスはそう書く", () => {
  assert.ok(build("3").body.includes("このプロセスは人が行う"));
  assert.ok(!build("1").body.includes("このプロセスは人が行う"));
});

test("buildSubIssue: 決定の成果物は名前だけを並べる", () => {
  const pfd = withDecision();
  pfd.artifacts.find((a) => a.id === "policy")!.description = "回答の写し";
  const { body } = buildSubIssue({ pfd, intakeId: "i1", processId: "2", upstreamUrls: new Map() });
  assert.ok(body.split("\n").includes("- 集計の方針"));
  assert.ok(!body.includes("回答の写し"));
});

test("buildSubIssue: 案に無いプロセスは投げる", () => {
  assert.throws(() => build("9"));
});
