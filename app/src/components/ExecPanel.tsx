import { type ReactNode, useRef } from "react";

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
  const drag = useRef<{ y: number; h: number } | null>(null);
  // 境目を上へ引くとパネルが高くなる
  const heightAt = (clientY: number, d: { y: number; h: number }) => d.h - (clientY - d.y);
  return (
    <section className={p.maximized ? "exec-panel max" : "exec-panel"} style={p.maximized ? undefined : { height: p.height }} aria-label="詳細">
      {!p.maximized && (
        <div
          className="exec-split"
          role="separator"
          aria-orientation="horizontal"
          aria-label="パネルの高さ"
          tabIndex={0}
          aria-valuenow={p.height}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = { y: e.clientY, h: p.height };
          }}
          onPointerMove={(e) => {
            if (drag.current) p.onResize(heightAt(e.clientY, drag.current));
          }}
          onPointerUp={(e) => {
            if (!drag.current) return;
            const h = heightAt(e.clientY, drag.current);
            drag.current = null;
            p.onResizeEnd(h);
          }}
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
