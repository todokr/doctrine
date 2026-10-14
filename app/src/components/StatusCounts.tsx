import { PROCESS_TONE, toneClass } from "../tone";
import { statusCounts, type PfdView } from "../pfd";

/** 状態ごとの件数（spec 3.5）。図の凡例を兼ねる。attention は Execution の人の番の件数で、押すと先頭へ飛ぶ（spec 6.3） */
export function StatusCounts({ view, attention }: { view: PfdView; attention?: { count: number; onJump: () => void } }) {
  const { counts, merged, total } = statusCounts(view);
  return (
    <div className="counts" aria-label="状態ごとの件数">
      {attention && (
        <button className={`count attn-jump ${toneClass("human")}`} disabled={attention.count === 0} onClick={attention.onJump}>
          <span className="lbl">要対応</span>
          {/* 数と「件」を 1 つの文字列にする。分けると静的な描画で間に <!-- --> が入る */}
          <span className="v">{`${attention.count} 件`}</span>
          <span className="b" />
        </button>
      )}
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
