import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { parsePfd } from "../src/model.ts";
import { EXAMPLE_YAML } from "./fixture.ts";

test("parsePfd: 例を読める", () => {
  const pfd = parsePfd(EXAMPLE_YAML);
  assert.equal(pfd.issue, 123);
  assert.deepEqual(pfd.goal, ["feature"]);
  assert.equal(pfd.artifacts.length, 5);
  assert.equal(pfd.processes.length, 4);
});

test("parsePfd: 引用符なしで書いたプロセスの id を文字列にする", () => {
  const pfd = parsePfd(EXAMPLE_YAML);
  assert.deepEqual(pfd.processes.map((p) => p.id), ["1", "2", "3", "4"]);
});

test("parsePfd: actor と given の既定値を埋める", () => {
  const pfd = parsePfd(EXAMPLE_YAML);
  assert.equal(pfd.processes[0].actor, "agent");
  assert.equal(pfd.processes[2].actor, "human");
  assert.equal(pfd.artifacts[0].given, true);
  assert.equal(pfd.artifacts[1].given, false);
});

test("parsePfd: 知らないキーを、場所を示して拒む", () => {
  const text = EXAMPLE_YAML.replace("    actor: human\n", "    actor: human\n    owner: me\n");
  assert.throws(() => parsePfd(text), /processes\.2/);
});

test("parsePfd: YAML として読めなければ、その旨を言う", () => {
  assert.throws(() => parsePfd("issue: [1"), /YAML として読めません/);
});

test("parsePfd: goal が空なら拒む", () => {
  assert.throws(() => parsePfd(EXAMPLE_YAML.replace("goal: [feature]", "goal: []")), /goal/);
});

test("parsePfd: 知らないキーのエラーは日本語で言う", () => {
  const text = EXAMPLE_YAML.replace("    actor: human\n", "    actor: human\n    owner: me\n");
  assert.throws(() => parsePfd(text), /知らないキーがあります: owner/);
});

test("parsePfd: goal が空のエラーは日本語で言う", () => {
  assert.throws(
    () => parsePfd(EXAMPLE_YAML.replace("goal: [feature]", "goal: []")),
    /要素が足りません/,
  );
});

test("parsePfd: 必須項目が無いエラーは日本語で言う", () => {
  const text = EXAMPLE_YAML.replace("    name: 画面を繋ぐ\n", "");
  assert.throws(() => parsePfd(text), /processes\.3\.name: 必須の項目がありません/);
});

test("parsePfd: enum 外の値のエラーは日本語で言う", () => {
  const text = EXAMPLE_YAML.replace("actor: human", "actor: robot");
  assert.throws(() => parsePfd(text), /次のいずれかが必要です: agent, human/);
});

test("parsePfd: 検証エラーのメッセージに zod の英語がそのまま出ない", () => {
  const text = EXAMPLE_YAML.replace("    actor: human\n", "    actor: human\n    owner: me\n");
  try {
    parsePfd(text);
    assert.fail("エラーが投げられるはず");
  } catch (err) {
    const message = (err as Error).message;
    assert.doesNotMatch(message, /Unrecognized|Required|Expected|Invalid/);
  }
});
