import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { StepRun, StepView, TaskDetail, TaskSummary } from "../../shared/protocol.ts";
import { WorkflowRail } from "./components/WorkflowRail";

const steps: StepView[] = [
  { id: "implement", type: "agent" },
  { id: "verify", type: "command" },
  { id: "review", type: "approval", title: "レビュー" },
];

const stepRun = (o: Partial<StepRun>): StepRun => ({
  id: 1,
  step_id: "implement",
  attempt: 1,
  status: "success",
  exit_code: 0,
  started_at: "2026-09-18T00:00:00.000Z",
  ended_at: "2026-09-18T00:01:00.000Z",
  permission_denials: null,
  ...o,
});

const detail = (currentStepId: string | null, stepRuns: StepRun[]): TaskDetail => ({
  task: { current_step_id: currentStepId } as unknown as TaskSummary,
  stepRuns,
  steps,
});

const classesOf = (html: string, id: string) => {
  const li = html.split("<li ").slice(1).find((b) => b.includes(`<span class="nm">${id}</span>`));
  return li ? li.match(/class="([^"]*)"/)![1] : null;
};

describe("WorkflowRail", () => {
  test("成功したステップは tone-ok", () => {
    const html = renderToStaticMarkup(
      <WorkflowRail detail={detail("verify", [stepRun({ step_id: "implement", status: "success" })])} legend={false} />,
    );
    expect(classesOf(html, "implement")).toContain("tone-ok");
  });

  test("いま動いているステップは tone-run と now", () => {
    const html = renderToStaticMarkup(
      <WorkflowRail detail={detail("implement", [stepRun({ step_id: "implement", status: "running" })])} legend={false} />,
    );
    const cls = classesOf(html, "implement")!;
    expect(cls).toContain("tone-run");
    expect(cls).toContain("now");
  });

  test("まだ run の無い approval ステップは gate（tone-idle）", () => {
    const html = renderToStaticMarkup(<WorkflowRail detail={detail("verify", [])} legend={false} />);
    const cls = classesOf(html, "review")!;
    expect(cls).toContain("gate");
    expect(cls).toContain("tone-idle");
  });

  test("awaiting の approval ステップは tone-human で gate ではない", () => {
    const html = renderToStaticMarkup(
      <WorkflowRail detail={detail("review", [stepRun({ step_id: "review", status: "awaiting" })])} legend={false} />,
    );
    const cls = classesOf(html, "review")!;
    expect(cls).toContain("tone-human");
    expect(cls).not.toContain("gate");
  });

  test("steps に無い step_id は unknown", () => {
    const html = renderToStaticMarkup(
      <WorkflowRail detail={detail("gone", [stepRun({ step_id: "gone", status: "failed" })])} legend={false} />,
    );
    expect(classesOf(html, "gone")).toContain("unknown");
  });

  test("legend={true} は 5 語の凡例を出す", () => {
    const html = renderToStaticMarkup(<WorkflowRail detail={detail("implement", [])} legend={true} />);
    for (const w of ["済み", "実行中", "失敗・差し戻し", "人の承認", "未実行"]) expect(html).toContain(w);
  });

  test("legend={false} は凡例を出さない", () => {
    const html = renderToStaticMarkup(<WorkflowRail detail={detail("implement", [])} legend={false} />);
    expect(html).not.toContain("wf-legend");
  });
});
