import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { ExecPanel } from "./components/ExecPanel";

const noop = () => {};
const render = (maximized: boolean) =>
  renderToStaticMarkup(
    <ExecPanel height={300} maximized={maximized} title="API を作る" onResize={noop} onResizeEnd={noop} onMaximize={noop} onClose={noop}>
      <p>中身</p>
    </ExecPanel>,
  );

describe("ExecPanel", () => {
  test("高さを持ち、境目と最大化・閉じるを出す", () => {
    const html = render(false);
    expect(html).toContain("height:300px");
    expect(html).toContain('role="separator"');
    expect(html).toContain(">最大化</button>");
    expect(html).toContain(">閉じる</button>");
    expect(html).toContain("API を作る");
    expect(html).toContain('<div class="exec-panel-body"><p>中身</p></div>');
  });

  test("最大化中は高さと境目を持たず、元に戻すを出す", () => {
    const html = render(true);
    expect(html).toContain('class="exec-panel max"');
    expect(html).not.toContain("height:300px");
    expect(html).not.toContain('role="separator"');
    expect(html).toContain(">元に戻す</button>");
  });
});
