import { test } from "vitest";
import assert from "node:assert/strict";
import { parseWorkflow, WorkflowValidationError, type CommandStep } from "../../src/workflow/schema.ts";

const VALID = `
name: feature
steps:
  - id: implement
    type: agent
    prompt: "{{ task.prompt }}"
    permissionMode: acceptEdits
  - id: test
    type: command
    run: pnpm test
    onFailure:
      goto: implement
      maxAttempts: 3
      feed: "テストが失敗した"
  - id: review
    type: approval
    title: "差分を確認してください"
    onReject:
      goto: implement
      maxAttempts: 5
`;

test("3つのステップ型をパースする", () => {
  const { workflow } = parseWorkflow(VALID);
  assert.equal(workflow.name, "feature");
  assert.deepEqual(workflow.steps.map((s) => s.type), ["agent", "command", "approval"]);
  assert.equal((workflow.steps[1] as CommandStep).onFailure?.goto, "implement");
});

test("ステップidが重複したら落とす", () => {
  const yaml = `
name: dup
steps:
  - id: a
    type: command
    run: "true"
  - id: a
    type: command
    run: "true"
`;
  assert.throws(() => parseWorkflow(yaml), (e: unknown) => {
    assert.ok(e instanceof WorkflowValidationError);
    assert.match(e.issues.join("\n"), /重複.*a/);
    return true;
  });
});

test("予約語 setup をステップidにしたら落とす", () => {
  const yaml = `
name: bad
steps:
  - id: setup
    type: command
    run: "true"
`;
  assert.throws(() => parseWorkflow(yaml), (e: unknown) => {
    assert.ok(e instanceof WorkflowValidationError);
    assert.match(e.issues.join("\n"), /setup.*予約/);
    return true;
  });
});

test("goto の飛び先が存在しなければ落とす", () => {
  const yaml = `
name: bad
steps:
  - id: a
    type: command
    run: "true"
    onFailure:
      goto: nowhere
      maxAttempts: 2
`;
  assert.throws(() => parseWorkflow(yaml), (e: unknown) => {
    assert.ok(e instanceof WorkflowValidationError);
    assert.match(e.issues.join("\n"), /nowhere/);
    return true;
  });
});

test("非冪等なコマンドは警告するが落とさない", () => {
  const yaml = `
name: pr
steps:
  - id: open-pr
    type: command
    run: gh pr create --fill
`;
  const { workflow, warnings } = parseWorkflow(yaml);
  assert.equal(workflow.steps.length, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /open-pr/);
  assert.match(warnings[0], /再実行/);
});

test("ステップが空なら落とす", () => {
  assert.throws(() => parseWorkflow("name: empty\nsteps: []\n"), WorkflowValidationError);
});
