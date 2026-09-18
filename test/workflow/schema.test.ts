import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import {
  type AgentStep,
  type CommandStep,
  parseWorkflow,
  WorkflowValidationError,
} from "../../src/workflow/schema.ts";

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

test("未知のステップtypeは日本語で有効な型名を案内する", () => {
  const yaml = `
name: bad
steps:
  - id: a
    type: agnet
    run: "true"
`;
  assert.throws(() => parseWorkflow(yaml), (e: unknown) => {
    assert.ok(e instanceof WorkflowValidationError);
    const msg = e.issues.join("\n");
    assert.match(msg, /command/);
    assert.match(msg, /agent/);
    assert.match(msg, /approval/);
    return true;
  });
});

test("ステップ内の未知のキーは日本語でキー名を案内する", () => {
  const yaml = `
name: bad
steps:
  - id: a
    type: command
    runn: pnpm test
`;
  assert.throws(() => parseWorkflow(yaml), (e: unknown) => {
    assert.ok(e instanceof WorkflowValidationError);
    assert.match(e.issues.join("\n"), /runn/);
    return true;
  });
});

test("maxAttempts が0以下なら日本語で最小値を案内する", () => {
  const yaml = `
name: bad
steps:
  - id: a
    type: command
    run: "true"
    onFailure:
      goto: a
      maxAttempts: 0
`;
  assert.throws(() => parseWorkflow(yaml), (e: unknown) => {
    assert.ok(e instanceof WorkflowValidationError);
    const msg = e.issues.join("\n");
    assert.match(msg, /maxAttempts/);
    assert.match(msg, /[぀-ヿ一-鿿]/);
    return true;
  });
});

test("name がなければ日本語でnameを案内する", () => {
  const yaml = `
steps:
  - id: a
    type: command
    run: "true"
`;
  assert.throws(() => parseWorkflow(yaml), (e: unknown) => {
    assert.ok(e instanceof WorkflowValidationError);
    const msg = e.issues.join("\n");
    assert.match(msg, /name/);
    assert.match(msg, /[぀-ヿ一-鿿]/);
    return true;
  });
});

test("agent ステップの session を読める", () => {
  const yaml = `
name: roles
steps:
  - id: plan
    type: agent
    session: planner
    prompt: "計画してください"
  - id: review
    type: approval
    title: "確認してください"
`;
  const { workflow } = parseWorkflow(yaml);
  assert.equal((workflow.steps[0] as AgentStep).session, "planner");
});

test("session を省略した agent ステップは undefined のまま", () => {
  const { workflow } = parseWorkflow(VALID);
  assert.equal((workflow.steps[0] as AgentStep).session, undefined);
});

test("session に使えない文字は日本語で案内する", () => {
  const yaml = `
name: bad
steps:
  - id: plan
    type: agent
    session: "plan ner"
    prompt: "x"
`;
  assert.throws(() => parseWorkflow(yaml), (e: unknown) => {
    assert.ok(e instanceof WorkflowValidationError);
    assert.match(e.issues.join("\n"), /session/);
    return true;
  });
});

test("command ステップに session を書くと弾かれる", () => {
  const yaml = `
name: bad
steps:
  - id: a
    type: command
    run: "true"
    session: x
`;
  assert.throws(() => parseWorkflow(yaml), WorkflowValidationError);
});
