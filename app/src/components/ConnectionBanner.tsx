import { useStore } from "../store";

/** 接続が切れていることを見せる。復帰は Rust が勝手にやる（押すボタンは無い） */
export function ConnectionBanner() {
  const { s } = useStore();
  if (s.conn.status === "connected") return null;
  const message = s.conn.status === "connecting"
    ? "dctld に接続しています…"
    : "dctld に接続できません — 再接続しています";
  return (
    <div className="conn-banner" role="status">
      <span>{message}</span>
      {s.conn.detail && <span className="mono hint">{s.conn.detail}</span>}
    </div>
  );
}
