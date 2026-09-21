import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { buildFeedback } from "../../../shared/intake/feedback.ts";
import { example } from "./pfd/fixture.ts";

test("コメントに 1 からの番号と、指す要素の名前が付く", () => {
  const text = buildFeedback(example(), [
    { target_kind: "process", target_id: "2", body: "コメントA" },
    { target_kind: "whole", target_id: null, body: "コメントB" },
  ]);
  const at = (s: string) => text.indexOf(s);
  assert.ok(at("1") >= 0);
  assert.ok(at("API を実装する") > 0);
  assert.ok(at("コメントA") > at("API を実装する"));
  assert.ok(at("計画全体") > at("コメントA"));
  assert.ok(at("コメントB") > at("計画全体"));
  assert.match(text, /2\D*計画全体/s);
});

test("存在しない要素を指しても投げない", () => {
  const text = buildFeedback(example(), [
    { target_kind: "artifact", target_id: "zzz", body: "x" },
  ]);
  assert.match(text, /zzz/);
});

test("同じ入力なら同じ文面", () => {
  const comments = [{ target_kind: "whole" as const, target_id: null, body: "B" }];
  assert.equal(buildFeedback(example(), comments), buildFeedback(example(), comments));
});
