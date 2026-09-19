/**
 * 取り直し（refresh）は同時に何本も走る（イベント・15秒タイマー・再接続）。
 * 古い応答が新しい応答の後に届くと、画面が一度古い状態に巻き戻ってしまう。
 * 最後に始めた1本だけを勝たせるための、副作用の無い純粋なロジック。
 * store.tsx から切り出してあるのは、React / Tauri を持ち込まずにテストできるようにするため。
 */
export function createRefreshGate() {
  let seq = 0;
  return {
    /** 取り直しを1本始めるときに呼ぶ。戻り値をその1本のトークンとして持っておく */
    begin(): number {
      return ++seq;
    },
    /** 応答が届いたとき、そのトークンがまだ最新かどうか */
    isLatest(token: number): boolean {
      return token === seq;
    },
  };
}
