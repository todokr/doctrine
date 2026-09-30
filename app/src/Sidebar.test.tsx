import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { IntakeRow } from "./components/Sidebar";
import { INTAKES, NOW, WORKSPACES } from "./fixtures";

const noop = () => {};

function row(o: Partial<Parameters<typeof IntakeRow>[0]>) {
  return renderToStaticMarkup(
    <IntakeRow intake={INTAKES[0]} workspace={WORKSPACES[1]} selected={false} now={NOW} onSelect={noop} {...o} />,
  );
}

describe("IntakeRow", () => {
  test("プロジェクト 1 つの workspace の点と名前を出す", () => {
    expect(row({})).toContain('<span class="pj"><span class="pjdot" style="background:#AA3A2C"></span>shop-api</span>');
  });

  test("プロジェクト 3 つの workspace の点と名前を出す", () => {
    const html = row({ intake: { ...INTAKES[0], workspace_id: 4 }, workspace: WORKSPACES[3] });
    expect(html).toContain('<span class="pj"><span class="pjdot" style="background:hsl(210 45% 38%)"></span>work</span>');
    expect(html).not.toContain("background:#666");
  });

  test("workspace が見つからなければ灰色の点で名前は空", () => {
    expect(row({ workspace: undefined })).toContain('<span class="pj"><span class="pjdot" style="background:#666"></span></span>');
  });

  test("状態の語とタイトルは今までどおり出す", () => {
    const html = row({});
    expect(html).toContain("分解中");
    expect(html).toContain("Issue 4 のタイトル");
    expect(html).toContain("#4");
  });

  test("選ばれた行は aria-current を立てる", () => {
    expect(row({ selected: true })).toContain('aria-current="true"');
    expect(row({ selected: false })).toContain('aria-current="false"');
  });
});
