import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { decomposerJsonSchema, decomposerOutputSchema } from "../../../shared/intake/decomposer.ts";

test("decomposerJsonSchema はトップレベルが 1 つのオブジェクト", () => {
  const schema = decomposerJsonSchema();
  assert.equal(schema.type, "object");
  assert.equal("anyOf" in schema, false);
  assert.equal("oneOf" in schema, false);
  const properties = schema.properties as Record<string, unknown>;
  for (const key of ["kind", "questions", "assumptions", "pfd", "replies"]) {
    assert.ok(key in properties, key);
  }
});

test("質問の出力を読める", () => {
  const parsed = decomposerOutputSchema.safeParse({
    kind: "questions",
    questions: [],
    assumptions: [],
    pfd: null,
    replies: null,
  });
  assert.equal(parsed.success, true);
});

test("decomposerJsonSchema のプロセスに project がある", () => {
  assert.match(JSON.stringify(decomposerJsonSchema()), /"project"/);
});

test("project の無い agent のプロセスも形としては読める", () => {
  const pfd = {
    title: "t",
    goal: ["a"],
    artifacts: [{ id: "a", name: "a", given: false, verify: "v" }],
    processes: [
      {
        id: "1",
        name: "p",
        actor: "agent",
        inputs: [],
        outputs: ["a"],
      },
    ],
  };
  const parsed = decomposerOutputSchema.safeParse({
    kind: "pfd",
    questions: null,
    assumptions: null,
    pfd,
    replies: [],
  });
  assert.equal(parsed.success, true);
});
