import { useEffect, useRef, useState } from 'react';
import { FilmCanvas, type FilmImages } from './FilmCanvas';
import { DURATION, WIDTH } from './timeline';
import '@fontsource/ibm-plex-sans-jp/700.css';
import './film.css';

export function ValueFilm({ images }: { images: FilmImages }) {
  const playerRef = useRef<HTMLDivElement>(null);
  const [t, setT] = useState(0);
  const [scale, setScale] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [onScreen, setOnScreen] = useState(false);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setPlaying(false);
      setT(27.5);
    }
  }, []);

  useEffect(() => {
    const el = playerRef.current;
    if (!el) return;
    const resize = new ResizeObserver(([entry]) => setScale(entry.contentRect.width / WIDTH));
    const intersect = new IntersectionObserver(([entry]) => setOnScreen(entry.isIntersecting));
    resize.observe(el);
    intersect.observe(el);
    return () => {
      resize.disconnect();
      intersect.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!playing || !onScreen) return;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      // タブが裏に回っている間は rAF が止まる。戻ったときに大きく飛ばないよう dt を抑える。
      setT((prev) => (prev + Math.min(dt, 0.1)) % DURATION);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, onScreen]);

  return (
    <div
      ref={playerRef}
      className="vf vf-player not-content"
      data-paused={playing ? undefined : ''}
      role="region"
      aria-label="doctrine の価値を 30 秒で紹介するアニメーション"
    >
      <div className="vf-stage" style={{ transform: `scale(${scale})`, visibility: scale ? 'visible' : 'hidden' }}>
        <FilmCanvas t={t} images={images} lazy />
      </div>
      <div className="vf-controls">
        <button
          type="button"
          className="vf-play"
          aria-label={playing ? '一時停止' : '再生'}
          onClick={() => setPlaying((p) => !p)}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            {playing ? (
              <path d="M3 2h3v10H3zM8 2h3v10H8z" fill="currentColor" />
            ) : (
              <path d="M3 1.5v11l9-5.5z" fill="currentColor" />
            )}
          </svg>
        </button>
        <input
          className="vf-seek"
          type="range"
          min={0}
          max={DURATION}
          step={0.01}
          value={t}
          aria-label="再生位置"
          onChange={(e) => setT(Number(e.currentTarget.value))}
        />
      </div>
    </div>
  );
}
