import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { StepRun, StepView, TaskDetail, TaskSummary } from "../../shared/protocol.ts";
import { WorkflowDefinitionRail, WorkflowRail } from "./components/WorkflowRail";
import { WORKFLOW_DEFAULT } from "./fixtures";

const steps: StepView[] = [
  { id: "setup", type: "command" },
  { id: "plan", type: "agent" },
  { id: "implement", type: "agent" },
  { id: "verify", type: "command", branch: { goto: "implement", maxAttempts: 3 } },
  { id: "review", type: "approval", title: "レビュー", branch: { goto: "implement", maxAttempts: 5 } },
];

const stepRun = (o: Partial<StepRun>): StepRun => ({
  id: 1,
  step_id: "verify",
  attempt: 1,
  status: "success",
  exit_code: 0,
  started_at: "2026-09-18T00:00:00.000Z",
  ended_at: "2026-09-18T00:01:00.000Z",
  permission_denials: null,
  ...o,
});

const stepRuns: StepRun[] = [
  stepRun({ id: 1, step_id: "verify", attempt: 1, status: "bounced" }),
  stepRun({ id: 2, step_id: "verify", attempt: 2, status: "bounced" }),
  stepRun({ id: 3, step_id: "verify", attempt: 3, status: "success" }),
  stepRun({ id: 4, step_id: "implement", attempt: 3, status: "success" }),
];

const detail: TaskDetail = {
  task: { current_step_id: "review" } as TaskSummary,
  stepRuns,
  steps,
};

describe("WorkflowRail（タスク画面）", () => {
  test("隣接の辺と戻りの弧を描き、弧に使用回数を出す", () => {
    const html = renderToStaticMarkup(<WorkflowRail detail={detail} />);
    expect(html.match(/wr-edge/g)).toHaveLength(4);
    expect(html).toContain("→ implement 2/3");
    expect(html).toContain("→ implement 0/5");
    expect(html).toContain("url(#wr-arrow)");
    expect(html).toContain('id="wr-arrow"');
  });

  test("実行の状態で塗り分け、今のステップに aria-current を付ける", () => {
    const html = renderToStaticMarkup(<WorkflowRail detail={detail} />);
    expect(html.match(/aria-current="step"/g)).toHaveLength(1);
    expect(html).toContain('aria-current="step"');
    expect(html).toContain("wr-ok");
    expect(html).toContain("×3");
  });

  test("ノードは押せない", () => {
    const html = renderToStaticMarkup(<WorkflowRail detail={detail} />);
    expect(html).not.toContain("role=\"button\"");
    expect(html).toContain('role="img"');
  });
});

describe("WorkflowDefinitionRail", () => {
  const noop = () => {};

  test("全ステップのノードと種類を描く", () => {
    const html = renderToStaticMarkup(
      <WorkflowDefinitionRail steps={WORKFLOW_DEFAULT.steps} selected={null} onSelect={noop} />,
    );
    expect(html.match(/role="button"/g)).toHaveLength(10);
    expect(html).toContain('aria-label="agent plan"');
    expect(html).toContain('aria-label="command plan-gate"');
    expect(html).toContain('aria-label="approval review"');
    expect(html).toContain('aria-label="guide guide"');
    expect(html).toContain(">command<");
    expect(html).toContain(">agent<");
    expect(html).toContain(">approval<");
    expect(html).toContain(">guide<");
  });

  test("goto の戻りの弧と maxAttempts を描く", () => {
    const html = renderToStaticMarkup(
      <WorkflowDefinitionRail steps={WORKFLOW_DEFAULT.steps} selected={null} onSelect={noop} />,
    );
    expect(html.match(/wr-back/g)).toHaveLength(5);
    expect(html).toContain("→ plan 最大 3 回");
    expect(html).toContain("→ implement 最大 5 回");
    expect(html).toContain("→ guide 最大 3 回（既定）");
  });

  test("実行の状態を持たない", () => {
    const html = renderToStaticMarkup(
      <WorkflowDefinitionRail steps={WORKFLOW_DEFAULT.steps} selected={null} onSelect={noop} />,
    );
    for (const cls of ["wr-ok", "wr-run", "wr-attn", "wr-danger", "wr-muted", "aria-current", "wr-badge"]) {
      expect(html).not.toContain(cls);
    }
    expect(html).not.toMatch(/\d+\/\d+/);
    expect(html).not.toContain('id="wr-arrow"');
    expect(html).toMatch(/id="wr-def-arrow/);
  });

  test("選んだステップだけ強調する", () => {
    const html = renderToStaticMarkup(
      <WorkflowDefinitionRail steps={WORKFLOW_DEFAULT.steps} selected="verify" onSelect={noop} />,
    );
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    const verifyTag = html.match(/<g class="wr-node wr-def selected"[^>]*>/)?.[0];
    expect(verifyTag).toContain('aria-label="command verify"');

    const htmlNone = renderToStaticMarkup(
      <WorkflowDefinitionRail steps={WORKFLOW_DEFAULT.steps} selected={null} onSelect={noop} />,
    );
    expect(htmlNone).not.toContain(" selected");
  });
});
