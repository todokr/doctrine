import { PROCESS_TONE, toneClass } from "../tone";
import { statusCounts, type PfdView } from "../pfd";

/** 状態ごとの件数（spec 3.5）。図の凡例を兼ねる */
export function StatusCounts({ view }: { view: PfdView }) {
  const { counts, merged, total } = statusCounts(view);
  return (
    <div className="counts" aria-label="状態ごとの件数">
      {counts.map((c) => (
        <div key={c.look} className={`count ${toneClass(PROCESS_TONE[c.look].tone)}${PROCESS_TONE[c.look].dashed ? " dashed" : ""}`}>
          <span className="lbl">{c.word}</span>
          <span className="v">{c.count}</span>
          <span className="b" />
        </div>
      ))}
      <div className={`count ${toneClass(PROCESS_TONE.merged.tone)}`}>
        <span className="lbl">マージ済み</span>
        <span className="v">{merged} / {total}</span>
        <span className="b" />
      </div>
    </div>
  );
}
