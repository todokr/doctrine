import { rateLimitViews } from "../model";
import { useStore } from "../store";

export function RateLimit() {
  const { s } = useStore();
  const views = rateLimitViews(s);
  return (
    <section className="limits" aria-label="Claude の利用上限">
      {views.length === 0 && (
        <p className="limits-empty">利用上限の標本がまだありません（agent ステップが動くと届きます）</p>
      )}
      {views.map((v) => (
        <div className={`limit ${v.severity}${v.stale ? " stale" : ""}`} key={v.window}>
          <div className="limit-row">
            <span className="limit-name">{v.label}</span>
            <span
              className="limit-bar"
              role="meter"
              aria-label={`${v.label}の利用率`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(v.fill * 100)}
            >
              <span style={{ width: `${v.fill * 100}%` }} />
            </span>
            <span className="limit-pct">{v.percent}</span>
          </div>
          <div className="limit-meta">
            <span>{v.reset}</span>
            <span>{v.observed}</span>
          </div>
          {v.note && <p className="limit-note">{v.note}</p>}
        </div>
      ))}
    </section>
  );
}
