import { describe, expect, test } from "vitest";
import type { WorkflowStepDetail } from "../../shared/protocol.ts";
import { WORKFLOW_DEFAULT } from "./fixtures";
import {
  assignSaveIssues,
  checkStepForm,
  diffStepForm,
  TEMPLATE_VARIABLES,
  toStepForm,
} from "./workflowEdit";

const stepById = (id: string) => WORKFLOW_DEFAULT.steps.find((s) => s.id === id)! as WorkflowStepDetail;

describe("toStepForm", () => {
  test("agent の値が欄の値になる", () => {
    const form = toStepForm(stepById("plan"));
    expect(form.model).toBe("claude-opus-5");
    expect(form.allowedTools).toBe("Bash(git diff:*)\nBash(grep:*)");
    expect(form.branch).toBeNull();
    expect(form.prompt).toBe("計画を立ててください\n{{ task.prompt }}");
  });

  test("null は空文字、分岐の maxAttempts は文字列になる", () => {
    const planReview = toStepForm(stepById("plan-review"));
    expect(planReview.permissionMode).toBe("");
    expect(planReview.allowedTools).toBe("");

    const verify = toStepForm(stepById("verify"));
    expect(verify.branch).toEqual({
      goto: "implement",
      maxAttempts: "3",
      feed: "テストが落ちた:\n{{ steps.verify.last_stdout }}",
    });
  });
});

describe("diffStepForm", () => {
  test("何も変えなければ null", () => {
    for (const step of WORKFLOW_DEFAULT.steps as WorkflowStepDetail[]) {
      expect(diffStepForm(step, toStepForm(step))).toBeNull();
    }
  });

  test("agent のプロンプトとモデルを変えるとその2つだけが入る", () => {
    const step = stepById("plan");
    const form = { ...toStepForm(step), prompt: "新しい計画\n", model: "claude-opus-5-5" };
    expect(diffStepForm(step, form)).toEqual({ id: "plan", prompt: "新しい計画\n", model: "claude-opus-5-5" });
  });

  test("プロンプトは trim しない", () => {
    const step = stepById("plan");
    const form = { ...toStepForm(step), prompt: "  a\n\n" };
    expect(diffStepForm(step, form)).toEqual({ id: "plan", prompt: "  a\n\n" });
  });

  test("モデルを空にすると null", () => {
    const step = stepById("plan");
    const form = { ...toStepForm(step), model: "" };
    expect(diffStepForm(step, form)).toEqual({ id: "plan", model: null });
  });

  test("allowedTools を空にすると null、行を並べ替えると配列", () => {
    const step = stepById("plan");
    const emptyForm = { ...toStepForm(step), allowedTools: "" };
    expect(diffStepForm(step, emptyForm)).toEqual({ id: "plan", allowedTools: null });

    const reorderedForm = { ...toStepForm(step), allowedTools: "Bash(grep:*)\n Bash(git diff:*) \n\n" };
    expect(diffStepForm(step, reorderedForm)).toEqual({
      id: "plan",
      allowedTools: ["Bash(grep:*)", "Bash(git diff:*)"],
    });
  });

  test("review.files を空にすると null", () => {
    const step = stepById("review");
    const form = { ...toStepForm(step), reviewFiles: "" };
    expect(diffStepForm(step, form)).toEqual({ id: "review", reviewFiles: null });
  });

  test("command の run が変わると run だけ", () => {
    const step = stepById("verify");
    const form = { ...toStepForm(step), run: "mise run test" };
    expect(diffStepForm(step, form)).toEqual({ id: "verify", run: "mise run test" });
  });

  test("分岐は変わった項目だけ", () => {
    const step = stepById("verify");
    const maxAttemptsForm = { ...toStepForm(step), branch: { ...toStepForm(step).branch!, maxAttempts: "5" } };
    expect(diffStepForm(step, maxAttemptsForm)).toEqual({ id: "verify", branch: { maxAttempts: 5 } });

    const feedForm = { ...toStepForm(step), branch: { ...toStepForm(step).branch!, feed: "" } };
    expect(diffStepForm(step, feedForm)).toEqual({ id: "verify", branch: { feed: null } });

    const gotoForm = { ...toStepForm(step), branch: { ...toStepForm(step).branch!, goto: "plan" } };
    expect(diffStepForm(step, gotoForm)).toEqual({ id: "verify", branch: { goto: "plan" } });
  });

  test("guide の既定の分岐を変えると branch が入る", () => {
    const step = stepById("guide");
    const form = { ...toStepForm(step), branch: { ...toStepForm(step).branch!, maxAttempts: "4" } };
    expect(diffStepForm(step, form)).toEqual({ id: "guide", branch: { maxAttempts: 4 } });
  });
});

describe("checkStepForm", () => {
  test("maxAttempts が整数でなければ送らない", () => {
    const step = stepById("verify");
    for (const bad of ["0", "abc"]) {
      const form = { ...toStepForm(step), branch: { ...toStepForm(step).branch!, maxAttempts: bad } };
      expect(checkStepForm(step, form)).toEqual({
        ok: false,
        errors: { "branch.maxAttempts": "1 以上の整数を入れてください" },
      });
    }
  });

  test("通れば差分を返す", () => {
    const step = stepById("plan");
    const changedForm = { ...toStepForm(step), model: "claude-opus-5-5" };
    const r = checkStepForm(step, changedForm);
    expect(r).toEqual({ ok: true, change: { id: "plan", model: "claude-opus-5-5" } });

    const unchanged = checkStepForm(step, toStepForm(step));
    expect(unchanged).toEqual({ ok: true, change: null });
  });
});

describe("assignSaveIssues", () => {
  test("そのステップの欄の issue は欄に入る", () => {
    const r = assignSaveIssues([{ stepId: "plan", field: "model", message: "m" }], "plan");
    expect(r).toEqual({ fields: { model: "m" }, rest: null });
  });

  test("branch は goto の欄に寄せる", () => {
    const r = assignSaveIssues([{ stepId: "plan", field: "branch", message: "b" }], "plan");
    expect(r.fields["branch.goto"]).toBe("b");
  });

  test("同じ欄の2件は、でつなぐ", () => {
    const r = assignSaveIssues(
      [
        { stepId: "plan", field: "model", message: "a" },
        { stepId: "plan", field: "model", message: "b" },
      ],
      "plan",
    );
    expect(r.fields.model).toBe("a、b");
  });

  test("別のステップ・field が null・欄の無い field は rest に入る", () => {
    const r = assignSaveIssues(
      [
        { stepId: "verify", field: "run", message: "x" },
        { stepId: null, field: null, message: "y" },
        { stepId: "plan", field: "title", message: "z" },
      ],
      "plan",
    );
    expect(r).toEqual({ fields: {}, rest: "x\ny\nz" });
  });
});

describe("TEMPLATE_VARIABLES", () => {
  test("template.ts が受け付ける変数を全部持つ", () => {
    expect(TEMPLATE_VARIABLES.map((v) => v.name)).toEqual([
      "{{ task.id }}",
      "{{ task.title }}",
      "{{ task.prompt }}",
      "{{ task.branch }}",
      "{{ issue.url }}",
      "{{ issue.parent_url }}",
      "{{ issue.closes }}",
      "{{ worktree.path }}",
      "{{ project.path }}",
      "{{ steps.<id>.last_stdout }}",
      "{{ steps.<id>.last_stderr }}",
      "{{ steps.<id>.exitCode }}",
    ]);
  });
});
