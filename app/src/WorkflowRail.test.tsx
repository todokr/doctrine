import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type {
  StepRun,
  StepView,
  TaskDetail,
  TaskSummary,
} from "../../shared/protocol.ts";
import {
  WorkflowDefinitionRail,
  WorkflowRail,
} from "./components/WorkflowRail";
import { WORKFLOW_DEFAULT } from "./fixtures";

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

const detail = (
  currentStepId: string | null,
  stepRuns: StepRun[],
): TaskDetail => ({
  task: { current_step_id: currentStepId } as unknown as TaskSummary,
  stepRuns,
  steps,
});

const classesOf = (html: string, id: string) => {
  const li = html.split("<li ").slice(1).find((b) =>
    b.includes(`<span class="nm">${id}</span>`)
  );
  return li ? li.match(/class="([^"]*)"/)![1] : null;
};

describe("WorkflowRail", () => {
  test("成功したステップは tone-ok", () => {
    const html = renderToStaticMarkup(
      <WorkflowRail
        detail={detail("verify", [
          stepRun({ step_id: "implement", status: "success" }),
        ])}
        legend={false}
      />,
    );
    expect(classesOf(html, "implement")).toContain("tone-ok");
  });

  test("いま動いているステップは tone-run と now", () => {
    const html = renderToStaticMarkup(
      <WorkflowRail
        detail={detail("implement", [
          stepRun({ step_id: "implement", status: "running" }),
        ])}
        legend={false}
      />,
    );
    const cls = classesOf(html, "implement")!;
    expect(cls).toContain("tone-run");
    expect(cls).toContain("now");
  });

  test("まだ run の無い approval ステップは gate（tone-idle）", () => {
    const html = renderToStaticMarkup(
      <WorkflowRail detail={detail("verify", [])} legend={false} />,
    );
    const cls = classesOf(html, "review")!;
    expect(cls).toContain("gate");
    expect(cls).toContain("tone-idle");
  });

  test("awaiting の approval ステップは tone-human で gate ではない", () => {
    const html = renderToStaticMarkup(
      <WorkflowRail
        detail={detail("review", [
          stepRun({ step_id: "review", status: "awaiting" }),
        ])}
        legend={false}
      />,
    );
    const cls = classesOf(html, "review")!;
    expect(cls).toContain("tone-human");
    expect(cls).not.toContain("gate");
  });

  test("steps に無い step_id は unknown", () => {
    const html = renderToStaticMarkup(
      <WorkflowRail
        detail={detail("gone", [
          stepRun({ step_id: "gone", status: "failed" }),
        ])}
        legend={false}
      />,
    );
    expect(classesOf(html, "gone")).toContain("unknown");
  });

  test("legend={true} は 5 語の凡例を出す", () => {
    const html = renderToStaticMarkup(
      <WorkflowRail detail={detail("implement", [])} legend={true} />,
    );
    for (
      const w of ["済み", "実行中", "失敗・差し戻し", "人の承認", "未実行"]
    ) expect(html).toContain(w);
  });

  test("legend={false} は凡例を出さない", () => {
    const html = renderToStaticMarkup(
      <WorkflowRail detail={detail("implement", [])} legend={false} />,
    );
    expect(html).not.toContain("wf-legend");
  });
});

describe("WorkflowDefinitionRail", () => {
  const noop = () => {};

  test("全ステップのノードと種類を描く", () => {
    const html = renderToStaticMarkup(
      <WorkflowDefinitionRail
        steps={WORKFLOW_DEFAULT.steps}
        selected={null}
        onSelect={noop}
      />,
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
      <WorkflowDefinitionRail
        steps={WORKFLOW_DEFAULT.steps}
        selected={null}
        onSelect={noop}
      />,
    );
    expect(html.match(/wr-back/g)).toHaveLength(5);
    expect(html).toContain("→ plan 最大 3 回");
    expect(html).toContain("→ implement 最大 5 回");
    expect(html).toContain("→ guide 最大 3 回（既定）");
  });

  test("実行の状態を持たない", () => {
    const html = renderToStaticMarkup(
      <WorkflowDefinitionRail
        steps={WORKFLOW_DEFAULT.steps}
        selected={null}
        onSelect={noop}
      />,
    );
    for (
      const cls of [
        "wr-ok",
        "wr-run",
        "wr-attn",
        "wr-danger",
        "wr-muted",
        "aria-current",
        "wr-badge",
      ]
    ) {
      expect(html).not.toContain(cls);
    }
    expect(html).not.toMatch(/\d+\/\d+/);
    expect(html).not.toContain('id="wr-arrow"');
    expect(html).toMatch(/id="wr-def-arrow/);
  });

  test("選んだステップだけ強調する", () => {
    const html = renderToStaticMarkup(
      <WorkflowDefinitionRail
        steps={WORKFLOW_DEFAULT.steps}
        selected="verify"
        onSelect={noop}
      />,
    );
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    const verifyTag = html.match(/<g class="wr-node wr-def selected"[^>]*>/)
      ?.[0];
    expect(verifyTag).toContain('aria-label="command verify"');

    const htmlNone = renderToStaticMarkup(
      <WorkflowDefinitionRail
        steps={WORKFLOW_DEFAULT.steps}
        selected={null}
        onSelect={noop}
      />,
    );
    expect(htmlNone).not.toContain(" selected");
  });
});
