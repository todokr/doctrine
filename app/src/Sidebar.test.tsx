import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { WorkspaceFilterSelect } from "./components/Sidebar";
import { WORKSPACES } from "./fixtures";

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
