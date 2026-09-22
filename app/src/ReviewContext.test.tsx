import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { Feedback, Prompt } from "./components/ReviewView";
import type { TaskContext } from "./types";

const NOW = Date.parse("2026-09-22T12:00:00.000Z");
const rejected = (stepRunId: number, comment: string) => ({
  stepRunId,
  stepId: "review",
  status: "rejected" as const,
  endedAt: `2026-09-22T0${stepRunId}:00:00.000Z`,
  comment,
});
const ctx = (reviews: unknown[]) =>
  ({ prompt: "p", reviews, lastCommand: null, lastAgentMessage: null, reviewFiles: [] }) as unknown as TaskContext;

describe("Feedback", () => {
  test("差し戻しが 0 件なら何も出さない", () => {
    expect(renderToStaticMarkup(<Feedback c={ctx([])} now={NOW} />)).toBe("");
  });

  test("1 件なら前回のフィードバックだけを出し、それ以前は出さない", () => {
    const html = renderToStaticMarkup(<Feedback c={ctx([rejected(1, "直して")])} now={NOW} />);
    expect(html).toContain("前回のフィードバック");
    expect(html).toContain("直して");
    expect(html).not.toContain("それ以前");
  });

  test("3 件なら最新を開いて出し、残り 2 件を新しい順に畳む", () => {
    const html = renderToStaticMarkup(
      <Feedback c={ctx([rejected(1, "一回目"), rejected(2, "二回目"), rejected(3, "三回目")])} now={NOW} />,
    );
    const latest = html.indexOf("三回目");
    const fold = html.indexOf("それ以前の 2 件");
    expect(latest).toBeGreaterThan(-1);
    expect(fold).toBeGreaterThan(latest);
    expect(html.indexOf("二回目")).toBeGreaterThan(fold);
    expect(html.indexOf("一回目")).toBeGreaterThan(html.indexOf("二回目"));
  });
});

describe("Prompt", () => {
  test("指示を 4 行で畳んだ状態で出す", () => {
    const html = renderToStaticMarkup(<Prompt text={"一行目\n二行目"} />);
    expect(html).toContain("指示");
    expect(html).toContain('class="prompt clamp"');
  });

  test("サーバー描画（測る前）ではトグルを出さない", () => {
    const html = renderToStaticMarkup(<Prompt text={"短い"} />);
    expect(html).not.toContain("全文を表示");
  });
});
