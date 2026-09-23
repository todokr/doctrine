import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { applyWorkflowChanges } from "../../src/workflow/save.ts";
import { parseWorkflow } from "../../src/workflow/schema.ts";

async function readDefaultYaml(): Promise<string> {
  return await Deno.readTextFile(
    new URL("../../../.doctrine/workflows/default.yaml", import.meta.url),
  );
}

function commentLines(text: string): string[] {
  return text.split("\n").filter((l) => l.trim().startsWith("#"));
}

test("変更が空なら元のテキストと完全に一致する", async () => {
  const original = await readDefaultYaml();
  const result = applyWorkflowChanges(original, []);
  assert(result.ok);
  assert.equal(result.text, original);
  assert(result.warnings.length >= 1);
});

test("implement のモデルとプロンプトを変えると、その2か所だけが変わりコメントが全部残る", async () => {
  const original = await readDefaultYaml();
  const result = applyWorkflowChanges(original, [
    { id: "implement", model: "claude-opus-5", prompt: "新しいプロンプト\n" },
  ]);
  assert(result.ok);

  // model の書き換えは implement ステップの先頭付近にあるので、
  // 先に model を書き換えてから prompt の範囲を切り出して期待値を作る。
  const originalWithModel = original.replace(
    "    model: claude-sonnet-5\n",
    "    model: claude-opus-5\n",
  );
  const promptStart = originalWithModel.indexOf(
    "      {{ worktree.path }}/.doctrine-out/plan.md を読んでから実装してください。",
  );
  const promptEnd = originalWithModel.indexOf("\n  # deno test は失敗の詳細", promptStart);
  const expected = originalWithModel.slice(0, promptStart) +
    "      新しいプロンプト\n" +
    originalWithModel.slice(promptEnd);

  assert.equal(result.text, expected);

  const promptLineCountBefore = original.split("\n").filter((l) => l.trim() === "prompt: |").length;
  const promptLineCountAfter =
    result.text.split("\n").filter((l) => l.trim() === "prompt: |").length;
  assert.equal(promptLineCountAfter, promptLineCountBefore);

  assert.deepEqual(commentLines(result.text), commentLines(original));

  const { workflow } = parseWorkflow(result.text);
  const implement = workflow.steps.find((s) => s.id === "implement");
  assert.equal((implement as { model?: string }).model, "claude-opus-5");
  assert.equal((implement as { prompt?: string }).prompt, "新しいプロンプト\n");
});

test("null を渡した項目はキーごと消える", async () => {
  const original = await readDefaultYaml();
  const result = applyWorkflowChanges(original, [{ id: "plan", model: null }]);
  assert(result.ok);
  const { workflow } = parseWorkflow(result.text);
  const plan = workflow.steps.find((s) => s.id === "plan");
  assert.equal((plan as { model?: string }).model, undefined);
  const planReview = workflow.steps.find((s) => s.id === "plan-review");
  assert.equal((planReview as { model?: string }).model, "claude-opus-5-5");
  assert.deepEqual(commentLines(result.text), commentLines(original));
});

test("reviewFiles を null にすると review ごと消え、配列なら files を置き換える", async () => {
  const original = await readDefaultYaml();

  const removed = applyWorkflowChanges(original, [{ id: "review", reviewFiles: null }]);
  assert(removed.ok);
  const { workflow: w1 } = parseWorkflow(removed.text);
  const review1 = w1.steps.find((s) => s.id === "review");
  assert.equal((review1 as { review?: unknown }).review, undefined);

  const replaced = applyWorkflowChanges(original, [
    { id: "review", reviewFiles: [".doctrine-out/plan.md"] },
  ]);
  assert(replaced.ok);
  const { workflow: w2 } = parseWorkflow(replaced.text);
  const review2 = w2.steps.find((s) => s.id === "review");
  assert.deepEqual((review2 as { review?: { files: string[] } }).review?.files, [
    ".doctrine-out/plan.md",
  ]);
});

test("allowedTools を変えても残った要素の引用符は保たれる", async () => {
  const original = await readDefaultYaml();
  const result = applyWorkflowChanges(original, [
    {
      id: "plan",
      allowedTools: ["Bash(git status:*)", "Bash(git diff:*)"],
    },
  ]);
  assert(result.ok);
  assert(result.text.includes('      - "Bash(git status:*)"'));
  const { workflow } = parseWorkflow(result.text);
  const plan = workflow.steps.find((s) => s.id === "plan");
  assert.deepEqual((plan as { allowedTools?: string[] }).allowedTools, [
    "Bash(git status:*)",
    "Bash(git diff:*)",
  ]);
});

test("branch の goto・maxAttempts・feed を変え、feed を null で消せる", async () => {
  const original = await readDefaultYaml();
  const result = applyWorkflowChanges(original, [
    { id: "verify", branch: { goto: "plan", maxAttempts: 2, feed: null } },
  ]);
  assert(result.ok);
  const { workflow } = parseWorkflow(result.text);
  const verify = workflow.steps.find((s) => s.id === "verify");
  assert.deepEqual((verify as { onFailure?: unknown }).onFailure, {
    goto: "plan",
    maxAttempts: 2,
  });
});

test("guide の既定の分岐に変更を送ると明示的な onFailure になり、null で既定に戻る", async () => {
  const original = await readDefaultYaml();
  const result = applyWorkflowChanges(original, [{ id: "guide", branch: { maxAttempts: 5 } }]);
  assert(result.ok);
  const { workflow } = parseWorkflow(result.text);
  const guide = workflow.steps.find((s) => s.id === "guide");
  assert.deepEqual((guide as { onFailure?: unknown }).onFailure, {
    goto: "guide",
    maxAttempts: 5,
    feed: "{{ steps.guide.last_stderr }}",
  });

  const reverted = applyWorkflowChanges(result.text, [{ id: "guide", branch: null }]);
  assert(reverted.ok);
  const { workflow: w2 } = parseWorkflow(reverted.text);
  const guide2 = w2.steps.find((s) => s.id === "guide");
  assert.equal((guide2 as { onFailure?: unknown }).onFailure, undefined);
});

test("goto に存在しないステップを入れると ok: false で、ステップと項目が分かる", async () => {
  const original = await readDefaultYaml();
  const result = applyWorkflowChanges(original, [
    { id: "verify", branch: { goto: "nowhere" } },
  ]);
  assert(!result.ok);
  assert.deepEqual(
    result.issues.find((i) => i.stepId === "verify"),
    {
      stepId: "verify",
      field: "branch.goto",
      message: 'ステップ "verify" の goto が存在しないステップを指しています: nowhere',
    },
  );
});

test("スキーマに落ちる値は index ではなく id で返る", async () => {
  const original = await readDefaultYaml();

  const r1 = applyWorkflowChanges(original, [{ id: "guide", session: null }]);
  assert(!r1.ok);
  assert(r1.issues.some((i) => i.stepId === "guide" && i.field === "session"));

  const r2 = applyWorkflowChanges(original, [{ id: "review", reviewFiles: [] }]);
  assert(!r2.ok);
  assert(r2.issues.some((i) => i.stepId === "review" && i.field === "reviewFiles"));
});

test("ステップの種類に無い項目は、その項目名で返る", async () => {
  const original = await readDefaultYaml();
  const result = applyWorkflowChanges(original, [{ id: "verify", prompt: "x\n" }]);
  assert(!result.ok);
  assert(result.issues.some((i) => i.stepId === "verify" && i.field === "prompt"));
});

test("無いステップへの変更と、同じステップへの2つの変更は当てずに断る", async () => {
  const original = await readDefaultYaml();

  const r1 = applyWorkflowChanges(original, [{ id: "nope", model: "x" }]);
  assert(!r1.ok);
  assert.deepEqual(r1.issues, [
    { stepId: "nope", field: null, message: "ステップがありません: nope" },
  ]);

  const r2 = applyWorkflowChanges(original, [
    { id: "plan", model: "a" },
    { id: "plan", model: "b" },
  ]);
  assert(!r2.ok);
  assert(r2.issues.some((i) => i.stepId === "plan"));
});

test("gh pr create を含む run には警告が返る", () => {
  const yaml = 'name: w\nsteps:\n  - id: a\n    type: command\n    run: "true"\n';

  const before = applyWorkflowChanges(yaml, []);
  assert(before.ok);
  assert.equal(before.warnings.length, 0);

  const after = applyWorkflowChanges(yaml, [{ id: "a", run: "gh pr create --fill" }]);
  assert(after.ok);
  assert.equal(after.warnings.length, 1);
  assert(after.warnings[0].includes('ステップ "a"'));
  assert(after.warnings[0].includes("gh pr create"));
});

test("壊れた YAML は YAMLとして読めません で断る", () => {
  const result = applyWorkflowChanges("name: x\nsteps: [\n", []);
  assert(!result.ok);
  assert.equal(result.issues[0].stepId, null);
  assert.equal(result.issues[0].field, null);
  assert(result.issues[0].message.startsWith("YAMLとして読めません"));
});
