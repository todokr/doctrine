import { test } from "@std/testing/bdd";
import { assertSnapshot } from "@std/testing/snapshot";
import assert from "node:assert/strict";
import { guideJsonSchema } from "../../../shared/guide/jsonSchema.ts";

type Node = Record<string, unknown>;

/** JSON Schema の全ノードを訪ねる。 */
function walk(node: unknown, visit: (node: Node) => void): void {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  visit(node as Node);
  for (const value of Object.values(node)) walk(value, visit);
}

function collect(): Node[] {
  const nodes: Node[] = [];
  walk(guideJsonSchema(), (node) => nodes.push(node));
  return nodes;
}

test("生成した JSON Schema がスナップショットと一致する", async (t) => {
  await assertSnapshot(t, JSON.stringify(guideJsonSchema(), null, 2));
});

test("$schema は draft-07 か、無い", () => {
  const declared = guideJsonSchema().$schema;
  assert.ok(
    declared === undefined || (typeof declared === "string" && declared.includes("draft-07")),
    `$schema = ${String(declared)}`,
  );
});

test("すべてのオブジェクトが additionalProperties false", () => {
  const objects = collect().filter((node) => node.type === "object");
  assert.ok(objects.length > 0);
  for (const node of objects) {
    assert.equal(node.additionalProperties, false, JSON.stringify(node).slice(0, 200));
  }
});

test("CLI が受け付けないキーワードが無い", () => {
  const banned = [
    "minLength",
    "maxLength",
    "minimum",
    "maximum",
    "pattern",
    "format",
    "$ref",
    "$defs",
  ];
  for (const node of collect()) {
    for (const key of banned) {
      assert.ok(!(key in node), `${key} が出ている: ${JSON.stringify(node).slice(0, 200)}`);
    }
  }
});

test("minItems は 0 か 1 だけ", () => {
  for (const node of collect()) {
    if ("minItems" in node) {
      assert.ok(node.minItems === 0 || node.minItems === 1, `minItems = ${node.minItems}`);
    }
  }
});

test("optional なプロパティは全体で 24 以下", () => {
  let optional = 0;
  for (const node of collect()) {
    if (typeof node.properties !== "object" || node.properties === null) continue;
    const required = Array.isArray(node.required) ? node.required : [];
    optional += Object.keys(node.properties).length - required.length;
  }
  assert.ok(optional <= 24, `optional なプロパティが ${optional} 個ある`);
});

test("anyOf と oneOf は合わせて 16 以下", () => {
  let unions = 0;
  for (const node of collect()) {
    if ("anyOf" in node) unions++;
    if ("oneOf" in node) unions++;
  }
  assert.ok(unions <= 16, `union が ${unions} 個ある`);
});
