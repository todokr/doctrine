import { useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import { FilmCanvas, type FilmImages } from './FilmCanvas';
import './film.css';

declare global {
  interface Window {
    __setTime?: (t: number) => void;
  }
}

export function FilmStage({ images }: { images: FilmImages }) {
  const [t, setT] = useState(0);

  useEffect(() => {
    // 書き出しスクリプトは、呼んだ直後の DOM をそのまま撮る。
    window.__setTime = (next) => flushSync(() => setT(next));
    return () => {
      delete window.__setTime;
    };
  }, []);

  return (
    <div className="vf">
      <FilmCanvas t={t} images={images} />
    </div>
  );
}
