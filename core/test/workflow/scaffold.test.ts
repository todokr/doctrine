import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { defaultWorkflowYamlFor } from "../../src/workflow/scaffold.ts";
import {
  type AgentStep,
  type ApprovalStep,
  branchOf,
  type CommandStep,
  type GuideStep,
  parseWorkflow,
  type Step,
} from "../../src/workflow/schema.ts";
import { expand, type TemplateContext } from "../../src/workflow/template.ts";

function stepsOf(baseBranch: string | undefined = "main"): Step[] {
  return parseWorkflow(defaultWorkflowYamlFor(baseBranch)).workflow.steps;
}

function byId(steps: Step[], id: string): Step {
  const s = steps.find((x) => x.id === id);
  assert.ok(s, `ステップ ${id} がある`);
  return s;
}

test("雛形のワークフローはスキーマ検証を通り、警告も出ない", () => {
  const { warnings } = parseWorkflow(defaultWorkflowYamlFor("main"));
  assert.deepEqual(warnings, [], "再実行で二重に効くコマンドを雛形に入れない");
});

test("雛形は 4 章の手順の順に並んでいる", () => {
  assert.deepEqual(stepsOf().map((s) => s.id), [
    "plan",
    "plan-review",
    "plan-gate",
    "implement",
    "verify",
    "agent-review",
    "review-gate",
    "guide",
    "review",
  ]);
});

test("役割はエージェントごとに分かれている", () => {
  const steps = stepsOf();
  const roleOf = (id: string) => (byId(steps, id) as AgentStep | GuideStep).session;
  assert.equal(roleOf("plan"), "planner");
  assert.equal(roleOf("plan-review"), "plan-reviewer");
  assert.equal(roleOf("implement"), "implementer");
  assert.equal(roleOf("agent-review"), "code-reviewer");
  assert.equal(roleOf("guide"), "guide");
});

test("差し戻しは前の工程へ戻る", () => {
  const steps = stepsOf();
  const gotoOf = (id: string) => branchOf(byId(steps, id))?.goto;
  assert.equal(gotoOf("plan-gate"), "plan");
  assert.equal(gotoOf("verify"), "implement");
  assert.equal(gotoOf("review-gate"), "implement");
  assert.equal(gotoOf("review"), "implement");
  assert.equal(gotoOf("guide"), "guide", "guide は既定の分岐で自分へ戻る");
});

test("ゲートは審査結果の1行目の verdict を見る", () => {
  const steps = stepsOf();
  const planGate = byId(steps, "plan-gate") as CommandStep;
  assert.ok(planGate.run.includes(".doctrine-out/plan-review.md"));
  assert.ok(planGate.run.includes("^verdict: approve"));
  const reviewGate = byId(steps, "review-gate") as CommandStep;
  assert.ok(reviewGate.run.includes(".doctrine-out/review.md"));
  assert.ok(reviewGate.run.includes("escalate"), "実装者に直せない指摘は人のレビューへ進める");
});

test("人のレビューには計画・実装メモ・レビュー結果を見せる", () => {
  const review = byId(stepsOf(), "review") as ApprovalStep;
  assert.deepEqual(review.review?.files, [
    ".doctrine-out/review.md",
    ".doctrine-out/implement-notes.md",
    ".doctrine-out/plan.md",
  ]);
});

test("guide ステップは diff を読めるだけの許可を持つ", () => {
  const guide = byId(stepsOf(), "guide") as GuideStep;
  assert.ok(guide.allowedTools?.includes("Bash(git diff:*)"));
});

test("雛形のプロンプトと feed はテンプレート展開を通る", () => {
  // ステップidの打ち間違いは parseWorkflow では捕まらず、実行時に落ちる
  const steps = stepsOf();
  const empty = { last_stdout: "", last_stderr: "", exitCode: "0" };
  const ctx: TemplateContext = {
    task: { id: "t", title: "T", prompt: "P", branch: "b" },
    issue: { url: null, parent_url: null },
    worktree: { path: "/w" },
    project: { path: "/p" },
    steps: Object.fromEntries(steps.map((s) => [s.id, empty])),
  };
  for (const s of steps) {
    if (s.type === "agent") expand(s.prompt, ctx);
    const feed = branchOf(s)?.feed;
    if (feed !== undefined) expand(feed, ctx);
  }
});

test("baseBranch が agent-review の diff の範囲に入る", () => {
  const review = byId(stepsOf("develop"), "agent-review") as AgentStep;
  assert.ok(review.prompt.includes("develop...HEAD"));
});

test("baseBranch が取れなければ main にする", () => {
  const review = byId(stepsOf(undefined), "agent-review") as AgentStep;
  assert.ok(review.prompt.includes("main...HEAD"));
});
