import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { IntakeRow, WorkspaceFilterSelect } from "./components/Sidebar";
import { INTAKES, NOW, WORKSPACES } from "./fixtures";

const noop = () => {};

describe("WorkspaceFilterSelect", () => {
  test("workspace の名前で選び、aria-label は workspace で絞り込む", () => {
    const html = renderToStaticMarkup(
      <WorkspaceFilterSelect workspaces={WORKSPACES} value="all" allLabel="すべての workspace" onChange={noop} />,
    );
    expect(html).toContain('aria-label="workspace で絞り込む"');
    expect(html).toContain('<option value="all" selected="">すべての workspace</option>');
    expect(html).toContain('<option value="2">shop-api</option>');
    expect(html).not.toContain("プロジェクトで絞り込む");
  });

  test("選んでいる workspace に selected が付く", () => {
    const html = renderToStaticMarkup(
      <WorkspaceFilterSelect workspaces={WORKSPACES} value={2} allLabel="すべての workspace" onChange={noop} />,
    );
    expect(html).toContain('<option value="2" selected="">shop-api</option>');
  });
});

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
