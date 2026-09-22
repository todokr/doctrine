import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { StepRun, StepView, TaskDetail, TaskSummary } from "../../shared/protocol.ts";
import { WorkflowRail } from "./components/WorkflowRail";

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
