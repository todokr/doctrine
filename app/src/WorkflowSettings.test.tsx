import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve({})) }));

import { StepSettings, WorkflowDefinitionView, WorkflowList } from "./components/WorkflowSettings";
import { WORKFLOW_DEFAULT, WORKFLOW_LIST } from "./fixtures";

const noop = () => {};

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
      <WorkflowDefinitionView detail={WORKFLOW_DEFAULT} selectedStep={null} onSelectStep={noop} />,
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
      />,
    );
    expect(html).toContain("broken は検証に通りません");
    expect(html).toContain("x がおかしい");
    expect(html).not.toContain("<svg");
  });

  test("ステップを選ぶとその設定が出る", () => {
    const html = renderToStaticMarkup(
      <WorkflowDefinitionView detail={WORKFLOW_DEFAULT} selectedStep="plan" onSelectStep={noop} />,
    );
    expect(html).toContain("claude-opus-5");
    expect(html).toContain("acceptEdits");
    expect(html).toContain("planner");
    expect(html).toContain("Bash(git diff:*)");
    expect(html).toContain("{{ task.prompt }}");
    expect(html).not.toContain("ステップを選ぶと設定が出ます");
  });
});

const stepById = (id: string) => WORKFLOW_DEFAULT.steps.find((s) => s.id === id)!;

describe("StepSettings", () => {
  test("command は run と onFailure の分岐を出す", () => {
    const html = renderToStaticMarkup(<StepSettings step={stepById("plan-gate")} />);
    expect(html).toContain("grep -q");
    expect(html).toContain("onFailure");
    expect(html).toContain("plan");
    expect(html).toContain("3");
    expect(html).toContain("{{ steps.plan-gate.last_stdout }}");
  });

  test("approval は title と review.files と onReject を出す", () => {
    const html = renderToStaticMarkup(<StepSettings step={stepById("review")} />);
    expect(html).toContain("変更を確認してください");
    expect(html).toContain(".doctrine-out/review.md");
    expect(html).toContain(".doctrine-out/plan.md");
    expect(html).toContain("onReject");
    expect(html).toContain("5");
    expect(html).not.toContain("onFailure");
  });

  test("guide の既定の分岐はそうと分かる", () => {
    const html = renderToStaticMarkup(<StepSettings step={stepById("guide")} />);
    expect(html).toContain("guide の既定の分岐");
    expect(html).toContain("プロンプトは doctrine が組み立てます");
  });

  test("分岐の無いステップは分岐なしと出す", () => {
    const html = renderToStaticMarkup(<StepSettings step={stepById("open-pr")} />);
    expect(html).toContain("分岐なし");
  });

  test("指定の無い欄は指定なしと出す", () => {
    const html = renderToStaticMarkup(<StepSettings step={stepById("plan-review")} />);
    expect(html).toContain("指定なし");
  });

  test("読み取り専用", () => {
    for (const step of WORKFLOW_DEFAULT.steps) {
      const html = renderToStaticMarkup(<StepSettings step={step} />);
      expect(html).not.toContain("<input");
      expect(html).not.toContain("<textarea");
    }
  });
});
