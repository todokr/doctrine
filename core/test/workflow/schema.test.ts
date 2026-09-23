import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import {
  type AgentStep,
  type ApprovalStep,
  branchOf,
  type CommandStep,
  type GuideStep,
  intervalMs,
  parseWorkflow,
  type PollStep,
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

test("agent の allowedTools を string[] として読む", () => {
  const yaml = `
name: allow
steps:
  - id: implement
    type: agent
    prompt: "やって"
    allowedTools:
      - "Bash(grep:*)"
      - "Bash(git diff:*)"
`;
  const { workflow } = parseWorkflow(yaml);
  assert.deepEqual((workflow.steps[0] as AgentStep).allowedTools, [
    "Bash(grep:*)",
    "Bash(git diff:*)",
  ]);
});

test("allowedTools に文字列単体を書いたら落とす", () => {
  const yaml = `
name: allow
steps:
  - id: implement
    type: agent
    prompt: "やって"
    allowedTools: "Bash(grep:*)"
`;
  assert.throws(() => parseWorkflow(yaml), (e: unknown) => {
    assert.ok(e instanceof WorkflowValidationError);
    return true;
  });
});

test("allowedTools に空文字の要素があったら落とす", () => {
  const yaml = `
name: allow
steps:
  - id: implement
    type: agent
    prompt: "やって"
    allowedTools:
      - ""
`;
  assert.throws(() => parseWorkflow(yaml), (e: unknown) => {
    assert.ok(e instanceof WorkflowValidationError);
    return true;
  });
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

const WITH_REVIEW = `
name: guided
steps:
  - id: plan
    type: agent
    prompt: "計画を書いて"
  - id: plan-approval
    type: approval
    title: "計画を確認してください"
    review:
      files:
        - .doctrine-out/plan.md
        - docs/adr/0001.md
`;

test("approval の review.files を読む", () => {
  const { workflow } = parseWorkflow(WITH_REVIEW);
  const step = workflow.steps[1] as ApprovalStep;
  assert.deepEqual(step.review?.files, [".doctrine-out/plan.md", "docs/adr/0001.md"]);
});

test("review を書かない approval は今までどおり通る", () => {
  const { workflow } = parseWorkflow(VALID);
  assert.equal((workflow.steps[2] as ApprovalStep).review, undefined);
});

const withFiles = (files: string) => `
name: g
steps:
  - id: a
    type: approval
    title: "見て"
    review:
      files: ${files}
`;

test("worktree の外を指せるパスは落とす", () => {
  for (
    const [files, pattern] of [
      ['["/etc/passwd"]', /絶対パス/],
      ['["../secrets.md"]', /\.\./],
      ['["a/../../b.md"]', /\.\./],
      ['["~/.ssh/id_rsa"]', /~/],
      ['[""]', /空/],
    ] as const
  ) {
    assert.throws(
      () => parseWorkflow(withFiles(files)),
      (e: Error) => e instanceof WorkflowValidationError && pattern.test(e.message),
      `落ちるべき: ${files}`,
    );
  }
});

test("files が空の宣言は落とす", () => {
  assert.throws(() => parseWorkflow(withFiles("[]")), WorkflowValidationError);
});

test("review に知らないキーがあれば落とす", () => {
  const yaml = `
name: g
steps:
  - id: a
    type: approval
    title: "見て"
    review:
      files: ["a.md"]
      diff: true
`;
  assert.throws(() => parseWorkflow(yaml), WorkflowValidationError);
});

// --- guide ステップ ---------------------------------------------------------

const guideWorkflow = (step: string) => `
name: g
steps:
  - id: implement
    type: agent
    prompt: "x"
${step}
`;

test("guide ステップを parse できる", () => {
  const { workflow } = parseWorkflow(guideWorkflow(`  - id: guide
    type: guide
    session: guide`));
  assert.deepEqual(workflow.steps[1], { id: "guide", type: "guide", session: "guide" });
});

test("guide ステップの session は必須", () => {
  const yaml = guideWorkflow(`  - id: guide
    type: guide`);
  assert.throws(() => parseWorkflow(yaml), (e: unknown) => {
    assert.ok(e instanceof WorkflowValidationError);
    assert.match(e.issues.join("\n"), /steps\.1\.session/);
    return true;
  });
});

test("guide ステップに prompt は書けない", () => {
  const yaml = guideWorkflow(`  - id: guide
    type: guide
    session: guide
    prompt: "自分で書く"`);
  assert.throws(() => parseWorkflow(yaml), (e: unknown) => {
    assert.ok(e instanceof WorkflowValidationError);
    assert.match(e.issues.join("\n"), /認識できないキー.*prompt/);
    return true;
  });
});

test("guide ステップの session の形式は agent と同じ", () => {
  const yaml = guideWorkflow(`  - id: guide
    type: guide
    session: "a b"`);
  assert.throws(() => parseWorkflow(yaml), WorkflowValidationError);
});

test("guide ステップに model / permissionMode / allowedTools を書ける", () => {
  const { workflow } = parseWorkflow(guideWorkflow(`  - id: guide
    type: guide
    session: implementer
    model: opus
    permissionMode: acceptEdits
    allowedTools: ["Bash(git diff:*)"]`));
  const step = workflow.steps[1] as GuideStep;
  assert.equal(step.model, "opus");
  assert.equal(step.permissionMode, "acceptEdits");
  assert.deepEqual(step.allowedTools, ["Bash(git diff:*)"]);
});

test("branchOf は onFailure を書かない guide ステップに既定の分岐を返す", () => {
  const { workflow } = parseWorkflow(guideWorkflow(`  - id: write-guide
    type: guide
    session: guide`));
  assert.deepEqual(branchOf(workflow.steps[1]), {
    goto: "write-guide",
    maxAttempts: 3,
    feed: "{{ steps.write-guide.last_stderr }}",
  });
});

test("guide ステップに書いた onFailure は既定を上書きする", () => {
  const { workflow } = parseWorkflow(guideWorkflow(`  - id: write-guide
    type: guide
    session: guide
    onFailure:
      goto: implement
      maxAttempts: 1`));
  assert.deepEqual(branchOf(workflow.steps[1]), { goto: "implement", maxAttempts: 1 });
});

test("poll ステップは interval を省略すると 1m になる", () => {
  const { workflow } = parseWorkflow(`
name: f
steps:
  - id: wait
    type: poll
    run: "exit 0"
`);
  const step = workflow.steps[0] as PollStep;
  assert.equal(step.type, "poll");
  assert.equal(step.interval, "1m");
});

test("interval は 30 秒未満や読めない書式を弾く", () => {
  for (const bad of ["10s", "1d", "5", "m"]) {
    assert.throws(
      () =>
        parseWorkflow(`
name: f
steps:
  - id: wait
    type: poll
    run: "exit 0"
    interval: "${bad}"
`),
      WorkflowValidationError,
      bad,
    );
  }
});

test("intervalMs は s / m / h をミリ秒にする", () => {
  assert.equal(intervalMs("30s"), 30_000);
  assert.equal(intervalMs("5m"), 300_000);
  assert.equal(intervalMs("2h"), 7_200_000);
});

test("onExhausted は fail / suspend だけを受け付ける", () => {
  const yaml = (v: string) => `
name: f
steps:
  - id: a
    type: command
    run: "true"
  - id: b
    type: command
    run: "false"
    onFailure: { goto: a, maxAttempts: 2, onExhausted: ${v} }
`;
  assert.equal(branchOf(parseWorkflow(yaml("suspend")).workflow.steps[1])?.onExhausted, "suspend");
  assert.throws(() => parseWorkflow(yaml("retry")), WorkflowValidationError);
});

test("approval の onReject に onExhausted: suspend は書けない", () => {
  const yaml = `
name: f
steps:
  - id: implement
    type: agent
    prompt: "p"
  - id: review
    type: approval
    title: "見て"
    onReject: { goto: implement, maxAttempts: 2, onExhausted: suspend }
`;
  assert.throws(
    () => parseWorkflow(yaml),
    (e: unknown) => {
      assert.ok(e instanceof WorkflowValidationError);
      assert.match(e.message, /review.+onReject.+onExhausted: suspend/s);
      return true;
    },
  );
});

test("poll ステップの二重に効くコマンドにも警告を出し、gh pr comment も対象にする", () => {
  const { warnings } = parseWorkflow(`
name: f
steps:
  - id: a
    type: command
    run: "gh pr comment --body x"
  - id: wait
    type: poll
    run: "git push"
`);
  assert.equal(warnings.length, 2);
});
