import { toneClass, type Tone } from "../tone";

/** 状態の色のドットと文言（spec 3.2）。ピルの代わり */
export function StatusDot({ tone, word }: { tone: Tone; word: string }) {
  return <span className={`st ${toneClass(tone)}`}><i aria-hidden="true" />{word}</span>;
}
