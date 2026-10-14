import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { ExecPanel, splitDrag } from "./components/ExecPanel";

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

describe("splitDrag", () => {
  const setup = (height = 300) => {
    const drag = { current: null as { y: number; h: number } | null };
    const resized: number[] = [];
    const ended: number[] = [];
    const h = splitDrag(drag, { height, onResize: (x) => resized.push(x), onResizeEnd: (x) => ended.push(x) });
    const ev = (clientY: number) =>
      ({ clientY, pointerId: 1, currentTarget: { setPointerCapture: () => {} } }) as unknown as React.PointerEvent<HTMLDivElement>;
    return { drag, resized, ended, h, ev };
  };

  test("上へ引くと高くなり、離したら止まる", () => {
    const { drag, resized, ended, h, ev } = setup();
    h.onPointerDown(ev(500));
    h.onPointerMove(ev(450));
    h.onPointerUp(ev(400));
    expect(resized).toEqual([350]);
    expect(ended).toEqual([400]);
    expect(drag.current).toBeNull();
  });

  test("離した後にキャプチャを失っても、もう一度は止めない", () => {
    const { ended, h, ev } = setup();
    h.onPointerDown(ev(500));
    h.onPointerUp(ev(400));
    h.onLostPointerCapture();
    expect(ended).toEqual([400]);
  });

  test("中断されたらいまの高さで止め、その後の移動を拾わない", () => {
    for (const end of ["onPointerCancel", "onLostPointerCapture"] as const) {
      const { drag, resized, ended, h, ev } = setup(320);
      h.onPointerDown(ev(500));
      h[end]();
      h.onPointerMove(ev(450));
      expect(ended).toEqual([320]);
      expect(resized).toEqual([]);
      expect(drag.current).toBeNull();
    }
  });
});
