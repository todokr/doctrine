import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { StatusCounts } from "./components/StatusCounts";
import { PFD_SAMPLE, PFD_STATUSES_B } from "./fixtures";
import { buildPfdView } from "./pfd";

const view = buildPfdView(PFD_SAMPLE, { statuses: PFD_STATUSES_B });

describe("StatusCounts", () => {
  test("attention を渡すと「要対応 N 件」のボタンを先頭に出す", () => {
    const html = renderToStaticMarkup(<StatusCounts view={view} attention={{ count: 2, onJump: () => {} }} />);
    expect(html).toMatch(/<button[^>]*class="count attn-jump[^"]*"[^>]*>.*要対応.*2 件/);
    expect(html.indexOf("attn-jump")).toBeLessThan(html.indexOf("入力待ち"));
  });

  test("0 件ならボタンを押せない", () => {
    const html = renderToStaticMarkup(<StatusCounts view={view} attention={{ count: 0, onJump: () => {} }} />);
    expect(html).toMatch(/<button[^>]*class="count attn-jump[^"]*"[^>]*disabled=""/);
  });

  test("attention を渡さなければボタンを出さない", () => {
    expect(renderToStaticMarkup(<StatusCounts view={view} />)).not.toContain("attn-jump");
  });
});
