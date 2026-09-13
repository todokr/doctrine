import { test } from "vitest";
import assert from "node:assert/strict";
import { parseProjectConfig, withSetupStep } from "../../src/workflow/project.ts";
import { parseWorkflow, WorkflowValidationError } from "../../src/workflow/schema.ts";

test("project.yaml を既定値つきで読む", () => {
  const cfg = parseProjectConfig(`
setup: pnpm install --frozen-lockfile
defaultWorkflow: feature
maxConcurrent: 1
baseBranch: main
`);
  assert.deepEqual(cfg, {
    setup: "pnpm install --frozen-lockfile",
    defaultWorkflow: "feature",
    maxConcurrent: 1,
    baseBranch: "main",
  });
});

test("maxConcurrent と baseBranch には既定値がある", () => {
  const cfg = parseProjectConfig("defaultWorkflow: feature\n");
  assert.equal(cfg.maxConcurrent, 1);
  assert.equal(cfg.baseBranch, "main");
  assert.equal(cfg.setup, undefined);
});

test("maxConcurrent が0以下なら落とす", () => {
  assert.throws(() => parseProjectConfig("defaultWorkflow: f\nmaxConcurrent: 0\n"), WorkflowValidationError);
});

test("maxConcurrent が0以下の場合、エラーメッセージに日本語が含まれる", () => {
  try {
    parseProjectConfig("defaultWorkflow: f\nmaxConcurrent: 0\n");
    assert.fail("Should have thrown WorkflowValidationError");
  } catch (e) {
    assert(e instanceof WorkflowValidationError);
    const messageStr = e.issues.join("\n");
    // Check for Japanese characters (hiragana, katakana, or kanji)
    assert(/[ぁ-ん]|[ァ-ヴ]|[一-龥]/.test(messageStr), "Error message should contain Japanese characters");
    // Check that maxConcurrent is mentioned
    assert(messageStr.includes("maxConcurrent"), "Error message should mention maxConcurrent");
  }
});

test("setup があればワークフローの先頭に command ステップとして挿入する", () => {
  const { workflow } = parseWorkflow("name: f\nsteps:\n  - id: a\n    type: command\n    run: \"true\"\n");
  const out = withSetupStep(workflow, "pnpm install --frozen-lockfile");
  assert.equal(out.steps.length, 2);
  assert.equal(out.steps[0].id, "setup");
  assert.equal(out.steps[0].type, "command");
  assert.equal((out.steps[0] as { run: string }).run, "pnpm install --frozen-lockfile");
  assert.equal(out.steps[1].id, "a");
});

test("setup がなければワークフローをそのまま返す", () => {
  const { workflow } = parseWorkflow("name: f\nsteps:\n  - id: a\n    type: command\n    run: \"true\"\n");
  const out = withSetupStep(workflow, undefined);
  assert.deepEqual(out, workflow);
});

test("setup 挿入は元のワークフローを破壊しない", () => {
  const { workflow } = parseWorkflow("name: f\nsteps:\n  - id: a\n    type: command\n    run: \"true\"\n");
  withSetupStep(workflow, "echo hi");
  assert.equal(workflow.steps.length, 1);
});
