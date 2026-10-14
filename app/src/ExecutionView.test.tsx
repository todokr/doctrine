import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { ExecutionRow } from "./components/ExecutionSidebar";
import { INTAKES, NOW, WORKSPACES } from "./fixtures";

const noop = () => {};
const active = INTAKES.find((i) => i.id === "i2")!;

const row = (o: Partial<Parameters<typeof ExecutionRow>[0]> = {}) =>
  renderToStaticMarkup(
    <ExecutionRow intake={active} workspace={WORKSPACES[1]} attention={false} selected={false} now={NOW} onSelect={noop} {...o} />,
  );

describe("ExecutionRow", () => {
  test("種類の印を出す", () => {
    expect(row()).toContain(">Plan<");
    expect(row({ intake: { ...active, mode: "direct" } })).toContain(">Direct<");
  });

  test("人の番なら点を出し、行を human の色にする", () => {
    const html = row({ attention: true });
    expect(html).toContain('aria-label="あなたの番"');
    expect(html).toContain("tone-human");
    expect(row()).not.toContain('aria-label="あなたの番"');
  });

  test("完了は ok の色", () => {
    expect(row({ intake: { ...active, state: "completed" } })).toContain("tone-ok");
  });
});
