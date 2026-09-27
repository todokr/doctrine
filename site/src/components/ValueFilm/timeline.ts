// 動画はすべて時刻 t（秒）の純関数として描く。コマ撮りで同じ t なら同じ絵になるように、
// CSS のアニメーションやタイマーには頼らない。
export const DURATION = 30;
export const FPS = 30;
export const WIDTH = 1920;
export const HEIGHT = 1080;

export const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export const easeInOut = (x: number) => {
  const c = clamp01(x);
  return c < 0.5 ? 4 * c * c * c : 1 - (-2 * c + 2) ** 3 / 2;
};

export const easeOut = (x: number) => 1 - (1 - clamp01(x)) ** 3;

/** [from, to] の区間で 0→1 に進む。 */
export const progress = (t: number, from: number, to: number) => clamp01((t - from) / (to - from));

/** [from, to] の区間だけ見え、前後 fade 秒で出入りする不透明度。 */
export const window01 = (t: number, from: number, to: number, fade = 0.4) =>
  Math.min(progress(t, from, from + fade), 1 - progress(t, to - fade, to));

export const lerp = (a: number, b: number, x: number) => a + (b - a) * x;

/** スクリーンショットのどこを窓に映すか。cx・cy は中心、w は窓の幅に収める画像上の幅（いずれも画像に対する比）。 */
export type View = { cx: number; cy: number; w: number };

export const lerpView = (a: View, b: View, x: number): View => ({
  cx: lerp(a.cx, b.cx, x),
  cy: lerp(a.cy, b.cy, x),
  w: lerp(a.w, b.w, x),
});

/** 窓（W×H）に view を映したときの画像の位置と大きさ。aspect は画像の幅÷高さ。 */
export const placeImage = (view: View, W: number, H: number, aspect: number) => {
  const width = W / view.w;
  const height = width / aspect;
  return { left: W / 2 - view.cx * width, top: H / 2 - view.cy * height, width, height };
};
