import { getImage } from 'astro:assets';
import general from '../../assets/general.png';
import question from '../../assets/question.png';
import pfd from '../../assets/pfd.png';
import review from '../../assets/guided-review.png';
import type { FilmImage, FilmImages } from './FilmCanvas';

// 窓の中で最大 4 倍ほど寄るので、スクリーンショットは原寸に近い幅で残す。
const shrink = async (src: ImageMetadata, width: number): Promise<FilmImage> => {
  const image = await getImage({ src, width: Math.min(width, src.width), format: 'webp' });
  return { src: image.src, width: src.width, height: src.height };
};

export const loadFilmImages = async (): Promise<FilmImages> => ({
  general: await shrink(general, 800),
  question: await shrink(question, 4200),
  pfd: await shrink(pfd, 3000),
  review: await shrink(review, 4400),
});
