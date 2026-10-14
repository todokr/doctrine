import { type PointerEvent, type ReactNode, useRef } from "react";

type Drag = { y: number; h: number };

/** 境目のドラッグの手当て。中断（pointercancel・キャプチャを失う）でも止め、そのときはいまの高さで終える */
export function splitDrag(
  drag: { current: Drag | null },
  p: { height: number; onResize: (height: number) => void; onResizeEnd: (height: number) => void },
) {
  // 境目を上へ引くとパネルが高くなる
  const heightAt = (clientY: number, d: Drag) => d.h - (clientY - d.y);
  // 中断のイベントの座標は当てにならない
  const abort = () => {
    if (!drag.current) return;
    drag.current = null;
    p.onResizeEnd(p.height);
  };
  return {
    onPointerDown: (e: PointerEvent<HTMLDivElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { y: e.clientY, h: p.height };
    },
    onPointerMove: (e: PointerEvent<HTMLDivElement>) => {
      if (drag.current) p.onResize(heightAt(e.clientY, drag.current));
    },
    onPointerUp: (e: PointerEvent<HTMLDivElement>) => {
      if (!drag.current) return;
      const h = heightAt(e.clientY, drag.current);
      drag.current = null;
      p.onResizeEnd(h);
    },
    onPointerCancel: abort,
    onLostPointerCapture: abort,
  };
}

/** Execution の下のパネルの枠（spec 6.5）。高さは親が持ち、境目のドラッグは差分を onResize に渡すだけ */
export function ExecPanel(p: {
  height: number;
  maximized: boolean;
  title: ReactNode;
  onResize: (height: number) => void;
  onResizeEnd: (height: number) => void;
  onMaximize: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const drag = useRef<Drag | null>(null);
  return (
    <section className={p.maximized ? "exec-panel max" : "exec-panel"} style={p.maximized ? undefined : { height: p.height }} aria-label="詳細">
      {!p.maximized && (
        <div
          className="exec-split"
          role="separator"
          aria-orientation="horizontal"
          aria-label="パネルの高さ"
          {...splitDrag(drag, p)}
        />
      )}
      <div className="exec-panel-head">
        <span className="exec-panel-title">{p.title}</span>
        <span className="spacer" />
        <button type="button" className="btn sm" aria-pressed={p.maximized} onClick={p.onMaximize}>
          {p.maximized ? "元に戻す" : "最大化"}
        </button>
        <button type="button" className="btn sm" onClick={p.onClose}>
          閉じる
        </button>
      </div>
      <div className="exec-panel-body">{p.children}</div>
    </section>
  );
}
