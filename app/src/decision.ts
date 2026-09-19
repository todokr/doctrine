/**
 * 承認・差し戻し・中止のボタンは、送信が実際に成功したときだけ
 * reducer のブックキーピング（下書きの破棄・トーストなど）を行ってよい。
 * 失敗（デーモン切断など）なら、レビュアーが書いた下書きは残さなければならない
 * （設計spec: 「コメントは…承認・差し戻しで破棄する」＝送れなかった試みでは破棄しない）。
 * この判定自体は React / Tauri を持ち込まない純粋なロジックなので、
 * store.tsx / 各コンポーネントから切り出してテストする。
 */
export type DecisionResult = { ok: true } | { ok: false; message: string };

export async function sendDecision(send: Promise<unknown>, failed: string): Promise<DecisionResult> {
  try {
    await send;
    return { ok: true };
  } catch (e) {
    return { ok: false, message: `${failed}: ${String(e)}` };
  }
}
