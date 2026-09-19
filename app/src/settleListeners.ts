/**
 * `listen()` は2本まとめて張るが、片方だけ失敗することがある（Tauri 側の
 * 一時的な不調など）。Promise.all だと丸ごと reject して、成功した方の
 * unsubscribe を握れないまま漏れる。ここでは登録できた分だけを拾い、
 * 何本失敗したかも返す。React / Tauri に依存しない純粋なロジックなので
 * store.tsx から切り出してテストする。
 */
export async function settleListeners(
  promises: Promise<() => void>[],
): Promise<{ registered: (() => void)[]; failedCount: number }> {
  const results = await Promise.allSettled(promises);
  const registered = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  return { registered, failedCount: results.length - registered.length };
}
