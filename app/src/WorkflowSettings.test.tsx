import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn((..._: unknown[]) => Promise.resolve({})) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import type {
  WorkflowDetail,
  WorkflowSaveResult,
  WorkflowStepChange,
  WorkflowStepDetail,
} from "../../shared/protocol.ts";
import { rpc } from "./daemon/client";
import { StepFields, submitWorkflowStep, WorkflowDefinitionView, WorkflowList } from "./components/WorkflowSettings";
import { WORKFLOW_DEFAULT, WORKFLOW_LIST } from "./fixtures";
import { diffStepForm, toStepForm, type StepForm, type StepSaveErrors } from "./workflowEdit";
import type { WorkflowRpc } from "./store";

beforeEach(() => {
  invoke.mockClear();
});

const api = {
  get: (p: string, n: string): Promise<WorkflowDetail> => rpc("workflow.get", { project: p, name: n }),
  save: (p: string, n: string, c: WorkflowStepChange[]): Promise<WorkflowSaveResult> =>
    rpc("workflow.save", { project: p, name: n, changes: c }),
} satisfies WorkflowRpc;

const noop = () => {};
const NO_ERRORS: StepSaveErrors = { fields: {}, rest: null };

describe("WorkflowList", () => {
  test("一覧の名前を出し、既定に印を付ける", () => {
    const html = renderToStaticMarkup(
      <WorkflowList entries={WORKFLOW_LIST} defaultName="default" selected={null} onSelect={noop} />,
    );
    expect(html).toContain("broken");
    expect(html).toContain("default");
    expect(html).toContain("light");
    expect(html.match(/既定/g)).toHaveLength(1);
  });

  test("検証に落ちたものは選べず、理由を出す", () => {
    const html = renderToStaticMarkup(
      <WorkflowList entries={WORKFLOW_LIST} defaultName="default" selected={null} onSelect={noop} />,
    );
    const brokenBtn = html.match(/<button[^>]*>broken[^<]*<\/button>/)?.[0];
    expect(brokenBtn).toContain("disabled");
    expect(html).toContain("steps[1].goto: 存在しないステップ nowhere を指しています");
    expect(html).toMatch(/<p class="hint error">steps\[1\]/);
    const defaultBtn = html.match(/<button[^>]*>default[^<]*<\/button>/)?.[0];
    const lightBtn = html.match(/<button[^>]*>light<\/button>/)?.[0];
    expect(defaultBtn).not.toContain("disabled");
    expect(lightBtn).not.toContain("disabled");
  });

  test("選んだものに aria-pressed", () => {
    const html = renderToStaticMarkup(
      <WorkflowList entries={WORKFLOW_LIST} defaultName="default" selected="light" onSelect={noop} />,
    );
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    const lightBtn = html.match(/<button[^>]*>light<\/button>/)?.[0];
    expect(lightBtn).toContain('aria-pressed="true"');
  });

  test("0 件なら無いと出す", () => {
    const html = renderToStaticMarkup(
      <WorkflowList entries={[]} defaultName={null} selected={null} onSelect={noop} />,
    );
    expect(html).toContain("ワークフローがありません");
  });
});

describe("WorkflowDefinitionView", () => {
  test("ok なら図を描き、全ステップのノードが出る", () => {
    const html = renderToStaticMarkup(
      <WorkflowDefinitionView
        detail={WORKFLOW_DEFAULT}
        selectedStep={null}
        onSelectStep={noop}
        project="/repo/app"
        onSaved={noop}
      />,
    );
    expect(html.match(/role="button"/g)).toHaveLength(10);
    expect(html).toContain("ステップを選ぶと設定が出ます");
    expect(html).toContain("open-pr: 再実行で二重に効くコマンドがあります");
  });

  test("検証に落ちたら issues を出し、図は描かない", () => {
    const html = renderToStaticMarkup(
      <WorkflowDefinitionView
        detail={{ name: "broken", ok: false, issues: ["x がおかしい"] }}
        selectedStep={null}
        onSelectStep={noop}
        project="/repo/app"
        onSaved={noop}
      />,
    );
    expect(html).toContain("broken は検証に通りません");
    expect(html).toContain("x がおかしい");
    expect(html).not.toContain("<svg");
  });

  test("ステップを選ぶとその設定が出る", () => {
    const html = renderToStaticMarkup(
      <WorkflowDefinitionView
        detail={WORKFLOW_DEFAULT}
        selectedStep="plan"
        onSelectStep={noop}
        project="/repo/app"
        onSaved={noop}
      />,
    );
    expect(html).toContain('value="claude-opus-5"');
    expect(html).toContain('value="acceptEdits"');
    expect(html).toContain('value="planner"');
    expect(html).toContain("Bash(git diff:*)");
    expect(html).toContain("{{ task.prompt }}");
    expect(html).not.toContain("ステップを選ぶと設定が出ます");
  });
});

const stepById = (id: string) => WORKFLOW_DEFAULT.steps.find((s) => s.id === id)! as WorkflowStepDetail;
const STEP_IDS = WORKFLOW_DEFAULT.steps.map((s) => s.id);

function renderStep(
  id: string,
  over: Partial<{
    form: StepForm;
    saveErrors: StepSaveErrors;
    saved: boolean;
    warnings: string[];
    pending: boolean;
    step: WorkflowStepDetail;
  }> = {},
): string {
  const step = over.step ?? stepById(id);
  const form = over.form ?? toStepForm(step);
  return renderToStaticMarkup(
    <StepFields
      step={step}
      form={form}
      stepIds={STEP_IDS}
      saveErrors={over.saveErrors ?? NO_ERRORS}
      saved={over.saved ?? false}
      warnings={over.warnings ?? []}
      pending={over.pending ?? false}
      onChange={noop}
      onSave={noop}
    />,
  );
}

describe("StepFields", () => {
  test("agent はプロンプト・モデル・permissionMode・session・allowedTools を編集できる", () => {
    const html = renderStep("plan");
    expect(html).toMatch(/<textarea[^>]*id="wf-edit-prompt"/);
    expect(html).toMatch(/<input[^>]*id="wf-edit-model"[^>]*value="claude-opus-5"/);
    expect(html).toContain('id="wf-edit-permission-mode"');
    expect(html).toContain('id="wf-edit-session"');
    expect(html).toContain('id="wf-edit-allowed-tools"');
  });

  test("command は run、approval は review.files を編集できる", () => {
    const verifyHtml = renderStep("verify");
    expect(verifyHtml).toContain('id="wf-edit-run"');

    const reviewHtml = renderStep("review");
    expect(reviewHtml).toContain('id="wf-edit-review-files"');
    expect(reviewHtml).toContain("変更を確認してください");
  });

  test("分岐の goto はステップ id から選ぶ", () => {
    const html = renderStep("verify");
    expect(html.match(/<option/g)).toHaveLength(10);
    expect(html).toContain('id="wf-edit-goto"');
    expect(html).toContain('<option value="implement" selected="">');
    expect(html).toMatch(/id="wf-edit-max-attempts"[^>]*value="3"/);
    expect(html).toContain('id="wf-edit-feed"');
  });

  test("分岐の無いステップは分岐なしと出す", () => {
    const html = renderStep("open-pr");
    expect(html).toContain("分岐なし");
    expect(html).not.toContain('id="wf-edit-goto"');
  });

  test("guide は分岐だけ編集でき、既定の分岐はそうと分かる", () => {
    const html = renderStep("guide");
    expect(html).toContain("プロンプトは doctrine が組み立てます");
    expect(html).toContain("guide の既定の分岐");
    expect(html).not.toContain('id="wf-edit-model"');
    expect(html).toContain('id="wf-edit-goto"');
  });

  test("手引きに task / issue / steps の変数が出る", () => {
    const planHtml = renderStep("plan");
    expect(planHtml).toContain("{{ task.prompt }}");
    expect(planHtml).toContain("{{ issue.url }}");
    expect(planHtml).toContain("{{ steps.&lt;id&gt;.last_stdout }}");
    expect(planHtml).toContain("plan-gate");
    expect(planHtml.match(/\{\{ issue\.url \}\}/g)).toHaveLength(1);

    const verifyHtml = renderStep("verify");
    expect(verifyHtml.match(/\{\{ issue\.url \}\}/g)).toHaveLength(1);

    const noHintStep: WorkflowStepDetail = {
      id: "x",
      type: "approval",
      title: "t",
      reviewFiles: null,
      branch: null,
    };
    const noHintHtml = renderStep("x", { step: noHintStep, form: toStepForm(noHintStep) });
    expect(noHintHtml).not.toContain("{{ issue.url }}");
  });

  test("保存のエラーは該当する欄に出る", () => {
    const html = renderStep("plan", { saveErrors: { fields: { model: "モデルがおかしい" }, rest: null } });
    expect(html).toContain("モデルがおかしい");
    const modelIdx = html.indexOf('id="wf-edit-model"');
    const permissionModeIdx = html.indexOf('id="wf-edit-permission-mode"');
    const errorIdx = html.indexOf("モデルがおかしい");
    expect(errorIdx).toBeGreaterThan(modelIdx);
    expect(errorIdx).toBeLessThan(permissionModeIdx);
    expect(html).not.toContain("未コミット");
  });

  test("欄に当たらないエラーは保存の上に出る", () => {
    const html = renderStep("plan", { saveErrors: { fields: {}, rest: "YAMLとして読めません: x" } });
    expect(html).toContain('<p class="hint error">YAMLとして読めません: x</p>');
    const errorIdx = html.indexOf("YAMLとして読めません: x");
    const buttonIdx = html.indexOf(">保存</button>");
    expect(errorIdx).toBeLessThan(buttonIdx);
  });

  test("maxAttempts が不正なら保存を押せず、欄に理由を出す", () => {
    const step = stepById("verify");
    const form = { ...toStepForm(step), branch: { ...toStepForm(step).branch!, maxAttempts: "0" } };
    const html = renderStep("verify", { form });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>保存<\/button>/);
    expect(html).toContain("1 以上の整数を入れてください");
  });

  test("何も変えていなければ保存を押せない", () => {
    const unchangedHtml = renderStep("plan");
    expect(unchangedHtml).toMatch(/<button[^>]*disabled=""[^>]*>保存<\/button>/);

    const step = stepById("plan");
    const changedForm = { ...toStepForm(step), model: "claude-opus-5-5" };
    const changedHtml = renderStep("plan", { form: changedForm });
    expect(changedHtml).not.toMatch(/<button[^>]*disabled=""[^>]*>保存<\/button>/);
  });

  test("保存したら未コミットで次のタスクから効くと出す", () => {
    const html = renderStep("plan", { saved: true });
    expect(html).toContain("作業ツリーに書いた（未コミット）。次に作るタスクから効く");
  });

  test("保存の警告を出す", () => {
    const withWarnings = renderStep("open-pr", {
      warnings: ['ステップ "open-pr" のコマンドは再実行で二重に効く可能性があります: git push -u origin HEAD'],
    });
    expect(withWarnings).toMatch(
      /<div class="box attn">[\s\S]*ステップ &quot;open-pr&quot; のコマンドは再実行で二重に効く可能性があります/,
    );

    const withoutWarnings = renderStep("open-pr", { warnings: [] });
    expect(withoutWarnings).not.toContain("box attn");
  });

  test("保存中は保存を押せない", () => {
    const step = stepById("plan");
    const changedForm = { ...toStepForm(step), model: "claude-opus-5-5" };
    const html = renderStep("plan", { form: changedForm, pending: true });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>保存<\/button>/);
  });
});

describe("submitWorkflowStep", () => {
  test("agent のプロンプトとモデルを変えると workflow.save に変更を送る", async () => {
    const step = stepById("plan");
    const form = { ...toStepForm(step), prompt: "新しい計画\n", model: "claude-opus-5-5" };
    const change = diffStepForm(step, form)!;
    invoke.mockResolvedValueOnce({ ok: true, warnings: [] });

    const r = await submitWorkflowStep("/repo/app", "default", change, api.save);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("rpc", {
      method: "workflow.save",
      params: {
        project: "/repo/app",
        name: "default",
        changes: [{ id: "plan", prompt: "新しい計画\n", model: "claude-opus-5-5" }],
      },
    });
    expect(r).toEqual({ ok: true, warnings: [] });
  });

  test("警告を返す", async () => {
    invoke.mockResolvedValueOnce({ ok: true, warnings: ["w"] });
    const r = await submitWorkflowStep("/repo/app", "default", { id: "plan", model: "x" }, api.save);
    expect(r).toEqual({ ok: true, warnings: ["w"] });
  });

  test("検証エラーは欄に振り分け、保存済みにしない", async () => {
    invoke.mockResolvedValueOnce({
      ok: false,
      issues: [
        { stepId: "plan", field: "model", message: "m" },
        { stepId: null, field: null, message: "r" },
      ],
    });
    const r = await submitWorkflowStep("/repo/app", "default", { id: "plan", model: "x" }, api.save);
    expect(r).toEqual({ ok: false, fields: { model: "m" }, rest: "r" });
  });

  test("例外は rest に入る", async () => {
    invoke.mockRejectedValueOnce("ワークフローがありません: /x");
    const r = await submitWorkflowStep("/repo/app", "default", { id: "plan", model: "x" }, api.save);
    expect(r).toEqual({ ok: false, fields: {}, rest: "ワークフローがありません: /x" });
  });
});
