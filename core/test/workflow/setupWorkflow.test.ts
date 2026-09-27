import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { type AgentStep, parseWorkflow } from "../../src/workflow/schema.ts";
import { expand, type TemplateContext } from "../../src/workflow/template.ts";
import { defaultWorkflowYamlFor, READ_ONLY_TOOLS } from "../../src/workflow/scaffold.ts";
import {
  SETUP_WORKFLOW_NAME,
  setupPrompt,
  setupWorkflowYaml,
} from "../../src/workflow/setupWorkflow.ts";
import type { SetupPolicy } from "../../../shared/protocol.ts";

const FULL: SetupPolicy = {
  plan: true,
  agentReview: true,
  guide: true,
  approval: "after_implement",
  pr: "open_and_wait",
  sync: true,
  models: {
    plan: "model-plan-x",
    implement: "model-impl-x",
    review: "model-review-x",
    guide: "model-guide-x",
  },
};

function draftStep(): AgentStep {
  const step = parseWorkflow(setupWorkflowYaml()).workflow.steps.find((s) => s.id === "draft");
  assert.ok(step && step.type === "agent");
  return step as AgentStep;
}

/** setupPrompt の出力から ```yaml のブロックを順に取り出す。 */
function yamlBlocks(text: string): string[] {
  return Array.from(text.matchAll(/```yaml\n([\s\S]*?)```/g), (m) => m[1]);
}

test("同梱ワークフローは parseWorkflow を通り、draft → validate → review → apply の順", () => {
  const { workflow } = parseWorkflow(setupWorkflowYaml());
  assert.equal(workflow.name, SETUP_WORKFLOW_NAME);
  assert.deepEqual(workflow.steps.map((s) => s.id), ["draft", "validate", "review", "apply"]);
  assert.deepEqual(workflow.steps.map((s) => s.type), ["agent", "command", "approval", "command"]);
});

test("draft の allowedTools は読み取り系だけ", () => {
  const tools = draftStep().allowedTools ?? [];
  assert.deepEqual(tools, READ_ONLY_TOOLS);
  assert.ok(!tools.some((t) => t.includes("git add") || t.includes("git commit")));
});

test("draft のプロンプトに雛形の default.yaml が入る", () => {
  // 雛形は task.prompt 経由で渡る。展開後のプロンプトに、雛形がそのまま（テンプレート変数も
  // 展開されずに）入ることを確かめる。
  const scaffold = defaultWorkflowYamlFor("main");
  const ctx: TemplateContext = {
    task: {
      id: "t1",
      title: "a のワークフローを作る",
      prompt: setupPrompt(FULL, "main"),
      branch: "b",
    },
    issue: { url: null, parent_url: null },
    worktree: { path: "/wt" },
    project: { path: "/repo" },
    steps: {},
  };
  const prompt = expand(draftStep().prompt, ctx);
  assert.ok(prompt.includes(scaffold), "雛形の全文が入る");
  assert.ok(prompt.includes("name: default\nsteps:\n"));
  assert.ok(prompt.includes("{{ steps.plan-gate.last_stdout }}"));
  assert.ok(prompt.includes("/wt/.doctrine-out/default.yaml"));
});

test("draft のプロンプトに展開される変数は task.prompt と worktree.path だけ", () => {
  const vars = Array.from(draftStep().prompt.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g), (m) => m[1]);
  assert.deepEqual([...new Set(vars)].sort(), ["task.prompt", "worktree.path"]);
});

test("setupPrompt の雛形は baseBranch で作る", () => {
  const blocks = yamlBlocks(setupPrompt(FULL, "develop"));
  assert.equal(blocks[0], defaultWorkflowYamlFor("develop"));
});

test("setupPrompt は方針を文章にする", () => {
  const off = setupPrompt({
    ...FULL,
    plan: false,
    agentReview: false,
    guide: false,
    pr: "branch_only",
    sync: false,
  }, "main");
  assert.ok(off.includes("計画を入れない"));
  assert.ok(off.includes("PR を開かない"));
  for (const m of Object.values(FULL.models)) assert.ok(off.includes(m), m);
  // PR を開かない方針ならステップの例は付けない
  assert.equal(yamlBlocks(off).length, 1);

  const on = setupPrompt({ ...FULL, approval: "after_plan_and_implement" }, "main");
  assert.ok(on.includes("計画を入れる"));
  assert.ok(on.includes("PR を開き"));
  assert.ok(on.includes("計画の後"));
});

test("PR を開く方針のステップの例は、雛形の後ろに足せば parseWorkflow を通る", () => {
  for (const sync of [true, false]) {
    const blocks = yamlBlocks(setupPrompt({ ...FULL, sync }, "develop"));
    assert.equal(blocks.length, 2);
    const combined = blocks[0] + "\n" + blocks[1];
    const { workflow } = parseWorkflow(combined);
    const ids = workflow.steps.map((s) => s.id);
    assert.deepEqual(
      ids.slice(ids.indexOf("review") + 1),
      sync ? ["sync", "verify-sync", "open-pr", "wait-merge"] : ["open-pr", "wait-merge"],
    );
    assert.ok(blocks[1].includes("--base develop"));
    assert.ok(blocks[1].includes("{{ issue.closes }}"));
  }
});

test("draft のプロンプトは worktree に無い .doctrine/ のファイルを読ませない", () => {
  // ウィザードの流れでは .doctrine/ は元のリポジトリで未追跡なので、worktree には無い
  assert.ok(!draftStep().prompt.includes(".doctrine/project.yaml"));
});

test("draft のプロンプトは baseBranch を変えたら例のブランチも揃え、setup-notes.md に書くよう言う", () => {
  const prompt = draftStep().prompt;
  assert.match(prompt, /--base/);
  assert.match(prompt, /wait-merge/);
  assert.match(prompt, /雛形のブランチと食い違っていた/);
});

test("sync しない wait-merge の例は、gh の失敗ですぐ suspend することと再開の仕方を書く", () => {
  const prompt = setupPrompt({ ...FULL, sync: false }, "main");
  const example = yamlBlocks(prompt)[1];
  assert.match(example, /すぐに suspend/);
  assert.match(example, /承認すると wait-merge から/);
});
