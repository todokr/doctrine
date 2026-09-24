import { type ReactNode, useLayoutEffect, useRef } from "react";
import { isAtBottom } from "../tailStick";

/**
 * ログの本文。行が増えたら末尾へ送る。遡っている間は動かさない（stick は人のスクロールで決まる）。
 * resetKey が変わった（別のタスク・別の実行を開いた）ときは、走っていなくても末尾から見せる。
 */
export function LogBlock(
  { lines, resetKey, empty }: { lines: string[] | undefined; resetKey: string; empty: ReactNode },
) {
  const ref = useRef<HTMLPreElement>(null);
  // 末尾に貼り付いているか。ターミナルと同じく、遡ったら止まり、末尾に戻せばまた追う
  const stick = useRef(true);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  useLayoutEffect(() => {
    const el = ref.current;
    stick.current = true;
    if (el) el.scrollTop = el.scrollHeight;
  }, [resetKey]);

  if (!lines || !lines.some((l) => l !== "")) {
    return <div className="box quiet"><p>{empty}</p></div>;
  }
  return (
    <pre
      className="block"
      ref={ref}
      onScroll={(e) => {
        stick.current = isAtBottom(e.currentTarget);
      }}
    >
      {lines.join("\n")}
    </pre>
  );
}
