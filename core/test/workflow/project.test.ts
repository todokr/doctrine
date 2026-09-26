import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import {
  applyProjectConfig,
  parseProjectConfig,
  withSetupStep,
} from "../../src/workflow/project.ts";
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
    tracker: { kind: "github" },
  });
});

test("maxConcurrent と baseBranch には既定値がある", () => {
  const cfg = parseProjectConfig("defaultWorkflow: feature\n");
  assert.equal(cfg.maxConcurrent, 1);
  assert.equal(cfg.baseBranch, "main");
  assert.equal(cfg.setup, undefined);
});

test("maxConcurrent が0以下なら落とす", () => {
  assert.throws(
    () => parseProjectConfig("defaultWorkflow: f\nmaxConcurrent: 0\n"),
    WorkflowValidationError,
  );
});

test("maxConcurrent が0以下の場合、エラーメッセージに日本語が含まれる", () => {
  try {
    parseProjectConfig("defaultWorkflow: f\nmaxConcurrent: 0\n");
    assert.fail("Should have thrown WorkflowValidationError");
  } catch (e) {
    assert(e instanceof WorkflowValidationError);
    const messageStr = e.issues.join("\n");
    // Check for Japanese characters (hiragana, katakana, or kanji)
    assert(
      /[ぁ-ん]|[ァ-ヴ]|[一-龥]/.test(messageStr),
      "Error message should contain Japanese characters",
    );
    // Check that maxConcurrent is mentioned
    assert(messageStr.includes("maxConcurrent"), "Error message should mention maxConcurrent");
  }
});

test("setup があればワークフローの先頭に command ステップとして挿入する", () => {
  const { workflow } = parseWorkflow(
    'name: f\nsteps:\n  - id: a\n    type: command\n    run: "true"\n',
  );
  const out = withSetupStep(workflow, "pnpm install --frozen-lockfile");
  assert.equal(out.steps.length, 2);
  assert.equal(out.steps[0].id, "setup");
  assert.equal(out.steps[0].type, "command");
  assert.equal((out.steps[0] as { run: string }).run, "pnpm install --frozen-lockfile");
  assert.equal(out.steps[1].id, "a");
});

test("setup がなければワークフローをそのまま返す", () => {
  const { workflow } = parseWorkflow(
    'name: f\nsteps:\n  - id: a\n    type: command\n    run: "true"\n',
  );
  const out = withSetupStep(workflow, undefined);
  assert.deepEqual(out, workflow);
});

test("setup 挿入は元のワークフローを破壊しない", () => {
  const { workflow } = parseWorkflow(
    'name: f\nsteps:\n  - id: a\n    type: command\n    run: "true"\n',
  );
  withSetupStep(workflow, "echo hi");
  assert.equal(workflow.steps.length, 1);
});

test("applyProjectConfig は値を当ててもコメントを残す", () => {
  const { text, config } = applyProjectConfig(
    "# ヘッダー\ndefaultWorkflow: feature # 既定\nmaxConcurrent: 1 # 並列数\nbaseBranch: main\n",
    { defaultWorkflow: "feature", maxConcurrent: 3, baseBranch: "develop" },
  );
  assert(text.includes("# ヘッダー"));
  assert(text.includes("# 既定"));
  assert(text.includes("# 並列数"));
  assert(text.includes("maxConcurrent: 3"));
  assert(text.includes("baseBranch: develop"));
  assert.deepEqual(config, {
    defaultWorkflow: "feature",
    maxConcurrent: 3,
    baseBranch: "develop",
    tracker: { kind: "github" },
  });
});

test("applyProjectConfig は setup が空ならキーを消し、あれば書く", () => {
  const removedEmpty = applyProjectConfig("defaultWorkflow: f\nsetup: pnpm i\n", {
    defaultWorkflow: "f",
    maxConcurrent: 1,
    baseBranch: "main",
    setup: "",
  });
  assert(!removedEmpty.text.includes("setup"));
  assert.equal(removedEmpty.config.setup, undefined);

  const removedNull = applyProjectConfig("defaultWorkflow: f\nsetup: pnpm i\n", {
    defaultWorkflow: "f",
    maxConcurrent: 1,
    baseBranch: "main",
    setup: null,
  });
  assert(!removedNull.text.includes("setup"));
  assert.equal(removedNull.config.setup, undefined);

  const added = applyProjectConfig("defaultWorkflow: f\n", {
    defaultWorkflow: "f",
    maxConcurrent: 1,
    baseBranch: "main",
    setup: "pnpm i",
  });
  assert(added.text.includes("setup: pnpm i"));
  assert.equal(added.config.setup, "pnpm i");
});

test("applyProjectConfig は長い setup を折り返さない", () => {
  const setup = ("pnpm install --frozen-lockfile && " + "pnpm run build ".repeat(6)).trim();
  const { text } = applyProjectConfig("defaultWorkflow: f\n", {
    defaultWorkflow: "f",
    maxConcurrent: 1,
    baseBranch: "main",
    setup,
  });
  assert(text.split("\n").some((line) => line.includes(`setup: ${setup}`)));
});

test("applyProjectConfig は maxConcurrent が0なら WorkflowValidationError を投げる", () => {
  assert.throws(
    () =>
      applyProjectConfig("defaultWorkflow: f\n", {
        defaultWorkflow: "f",
        maxConcurrent: 0,
        baseBranch: "main",
      }),
    WorkflowValidationError,
  );
});

test("applyProjectConfig は壊れた YAML なら WorkflowValidationError を投げる", () => {
  assert.throws(
    () =>
      applyProjectConfig("defaultWorkflow: [\n", {
        defaultWorkflow: "f",
        maxConcurrent: 1,
        baseBranch: "main",
      }),
    WorkflowValidationError,
  );
});

test("tracker を省略すると GitHub Issues を使う", () => {
  const cfg = parseProjectConfig("defaultWorkflow: f\n");
  assert.deepEqual(cfg.tracker, { kind: "github" });
});

test("tracker に github を書ける", () => {
  const cfg = parseProjectConfig("defaultWorkflow: f\ntracker:\n  kind: github\n");
  assert.deepEqual(cfg.tracker, { kind: "github" });
});

test("tracker に Linear のチームを書ける", () => {
  const cfg = parseProjectConfig(
    "defaultWorkflow: f\ntracker:\n  kind: linear\n  team: ENG\n",
  );
  assert.deepEqual(cfg.tracker, { kind: "linear", team: "ENG" });
});

const LINEAR_HEAD = "defaultWorkflow: f\ntracker:\n  kind: linear\n  team: ENG\n";

test("tracker: linear は段階ごとの状態の名前を持てる", () => {
  const cfg = parseProjectConfig(`${LINEAR_HEAD}  states:\n    inReview: レビュー中\n`);
  assert.deepEqual(cfg.tracker, {
    kind: "linear",
    team: "ENG",
    states: { inReview: "レビュー中" },
  });
});

test("tracker.states に知らない段階があれば弾く", () => {
  assert.throws(
    () => parseProjectConfig(`${LINEAR_HEAD}  states:\n    done: X\n`),
    WorkflowValidationError,
  );
});

test("tracker.states の名前が空なら弾く", () => {
  assert.throws(
    () => parseProjectConfig(`${LINEAR_HEAD}  states:\n    todo: ""\n`),
    WorkflowValidationError,
  );
});

test("Linear の tracker に team が無ければ落とす", () => {
  try {
    parseProjectConfig("defaultWorkflow: f\ntracker:\n  kind: linear\n");
    assert.fail("Should have thrown WorkflowValidationError");
  } catch (e) {
    assert(e instanceof WorkflowValidationError);
    assert(e.issues.some((i) => i.includes("tracker.team")));
  }
});

test("Linear の team が空文字なら落とす", () => {
  assert.throws(
    () => parseProjectConfig('defaultWorkflow: f\ntracker:\n  kind: linear\n  team: ""\n'),
    WorkflowValidationError,
  );
});

test("github の tracker に team を書くと落とす", () => {
  try {
    parseProjectConfig("defaultWorkflow: f\ntracker:\n  kind: github\n  team: ENG\n");
    assert.fail("Should have thrown WorkflowValidationError");
  } catch (e) {
    assert(e instanceof WorkflowValidationError);
    assert(e.issues.some((i) => i.includes("認識できないキー") && i.includes("team")));
  }
});

test("知らない kind は落とし、選べる値を示す", () => {
  try {
    parseProjectConfig("defaultWorkflow: f\ntracker:\n  kind: jira\n");
    assert.fail("Should have thrown WorkflowValidationError");
  } catch (e) {
    assert(e instanceof WorkflowValidationError);
    assert(
      e.issues.some((i) =>
        i.includes("tracker.kind") && i.includes("github") && i.includes("linear")
      ),
    );
  }
});

test("tracker が null なら落とす", () => {
  assert.throws(
    () => parseProjectConfig("defaultWorkflow: f\ntracker:\n"),
    WorkflowValidationError,
  );
});

test("applyProjectConfig は tracker を消さない", () => {
  const { text, config } = applyProjectConfig(
    "defaultWorkflow: f\ntracker:\n  kind: linear\n  team: ENG # チーム\n",
    { defaultWorkflow: "f", maxConcurrent: 2, baseBranch: "develop" },
  );
  assert.deepEqual(config.tracker, { kind: "linear", team: "ENG" });
  assert(text.includes("team: ENG"));
  assert(text.includes("# チーム"));
  assert.deepEqual(parseProjectConfig(text).tracker, { kind: "linear", team: "ENG" });
});
