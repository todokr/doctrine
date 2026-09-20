/**
 * ログの末尾追従。ターミナルと同じ振る舞いにする:
 * 既定では末尾に貼り付き、人が遡っている間だけ止まり、末尾に戻せばまた貼り付く。
 *
 * 貼り付くかどうかは「人がスクロールした時点」で決める。中身が増えた後に測ると、
 * 1行増えただけで末尾から離れて見えるため、遡っていないのに追従が外れる。
 * React / DOM を持ち込まずにテストできるよう、判定だけを切り出してある。
 */

/** 末尾から何px以内なら「末尾を見ている」とみなすか。行1つ分の高さくらい。 */
const NEAR_BOTTOM = 24;

export type Viewport = { scrollTop: number; scrollHeight: number; clientHeight: number };

export function isAtBottom(v: Viewport): boolean {
  return v.scrollHeight - v.scrollTop - v.clientHeight <= NEAR_BOTTOM;
}
