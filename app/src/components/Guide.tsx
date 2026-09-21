import type { CSSProperties, ReactNode } from "react";
import { findUnguided } from "../flow";
import { groupPaths, IMPACT_ORDER, locationAnchor, splitRisks, type GuideView } from "../guide";
import { clock, type Loaded } from "../model";
import type { DiffFile, Guide, Risk } from "../types";
import { DiagramView } from "./Diagrams";
import { scrollToAnchor } from "./DiffFileBlock";
import { Markdown } from "./text";

const sec = (i: number) => ({ "--gi": i }) as CSSProperties;

type Decision = Guide["decisions"][number];

export const RISK_LABEL: Record<Risk["kind"], string> = {
  breaks: "壊しうるもの",
  assumption: "置いた前提",
  unknown: "分かっていないこと",
  considered: "検討済み",
};

export const IMPACT_LABEL: Record<Risk["impact"], string> = {
  high: "影響 大",
  medium: "影響 中",
  low: "影響 小",
};

export const prose =(src: string) => <div className="g-md"><Markdown src={src} /></div>;

const sourceLabel = (s: NonNullable<Decision["source"]>) => (s.kind === "step" ? `ステップ ${s.value}` : s.value);

/**
 * ガイドを出せないとき、あるいは出していても当てにならないときに、理由を出す。diff の上に置く。
 * ガイドを作るステップが無いワークフロー（none）は、ガイドなしの画面として普通に開くので何も出さない。
 */
export function GuideNotice({ view }: { view: Loaded<GuideView> | undefined }): ReactNode {
  if (view === undefined || view.kind === "loading") return <p className="hint">ガイドを読み込んでいます…</p>;
  if (view.kind === "error") {
    return (
      <div className="box danger">
        <b>ガイド（task.guide）を取れませんでした</b>
        <p className="mono">{view.message}</p>
      </div>
    );
  }
  const g = view.value;
  switch (g.kind) {
    case "none":
      return null;
    case "missing":
      return (
        <div className="box quiet">
          <b>このワークフローはガイドを作りますが、まだありません</b>
          <p className="hint">ガイドなしで diff を読めます。</p>
        </div>
      );
    case "too_large":
      return (
        <div className="box quiet">
          <b>ガイドが大きすぎるため出していません（{g.size} バイト）</b>
        </div>
      );
    case "broken":
      return (
        <div className="box danger">
          <b>ガイドが壊れているため出していません</b>
          <p className="hint">diff はそのまま読めます。</p>
          <ul className="g-list">{g.issues.map((issue, i) => <li key={i} className="mono">{issue}</li>)}</ul>
        </div>
      );
    case "ok": {
      if (!g.stale) return null;
      const at = Date.parse(g.createdAt);
      return (
        <div className="box attn">
          <b>このガイドは古いです</b>
          <p>
            このガイドは作成時点（{Number.isNaN(at) ? g.createdAt : clock(at)}）の worktree を説明しています。
            そのあと worktree が変わっているので、指している箇所が無いことがあります。
          </p>
        </div>
      );
    }
  }
}

function UnguidedNote({ files, guide, truncated }: { files: DiffFile[]; guide: Guide; truncated: boolean }) {
  const { items } = findUnguided(files, guide, truncated);
  if (items.length === 0) return <p className="g-ok">✓ diff のすべての変更がガイドの読む順に入っています</p>;
  return (
    <>
      <p className="g-warn">⚠ ガイドの読む順に入っていない変更が{items.length}件あります</p>
      {truncated && <p className="hint">diff が打ち切られているため、ガイドの見落としとは限りません</p>}
    </>
  );
}

/** 影響の段階。文字そのもので段階が分かるので、色に頼らない */
function ImpactBadge({ impact }: { impact: Risk["impact"] }) {
  return <span className={`impact impact-${impact}`}>{IMPACT_LABEL[impact]}</span>;
}

/** Risk が指す箇所。今の diff にある箇所はその場所へ飛ぶボタン、無い箇所は文字だけ */
function RiskLocations({ locations, files }: { locations: Risk["locations"]; files: readonly DiffFile[] }) {
  if (locations.length === 0) return <span className="hint">変更全体に関わる</span>;
  const seen = new Set<string>();
  return (
    <span className="risk-locs">
      {locations.map((loc) => {
        const at = locationAnchor(files, loc);
        const key = at?.anchor ?? `absent:${loc.path}:${loc.hunk ?? ""}`;
        if (seen.has(key)) return null;
        seen.add(key);
        if (!at) return <span key={key} className="hint mono">{loc.path}（今の diff にありません）</span>;
        return (
          <button key={key} className="risk-loc mono" onClick={() => scrollToAnchor(at.anchor)}>
            {at.file.path}
            {at.hunk !== null && ` hunk ${at.hunk + 1} / ${at.file.hunks.length}`}
          </button>
        );
      })}
    </span>
  );
}

export function RiskItem({ risk, files }: { risk: Risk; files: readonly DiffFile[] }) {
  return (
    <li>
      <div className="risk-head"><ImpactBadge impact={risk.impact} /><b>{RISK_LABEL[risk.kind]}</b></div>
      {prose(risk.body)}
      <RiskLocations locations={risk.locations} files={files} />
    </li>
  );
}

export function DecisionItem({ d }: { d: Decision }) {
  return (
    <li>
      <b>{d.decision}</b>
      {prose(d.reason)}
      {d.source && <span className="hint mono">{sourceLabel(d.source)}</span>}
    </li>
  );
}

/** hunk の真上（またはファイル見出しの下）に出す、その箇所に紐づくリスク */
export function RiskNote({ risks }: { risks: Risk[] | undefined }): ReactNode {
  if (!risks?.length) return null;
  const { shown, folded } = splitRisks(risks);
  return (
    <div className="hunk-risk" role="note">
      {shown.map((r) => (
        <div key={r.id}>
          <div className="risk-head"><ImpactBadge impact={r.impact} /><b>{RISK_LABEL[r.kind]}</b></div>
          {prose(r.body)}
        </div>
      ))}
      {folded.map((r) => (
        <details key={r.id} className="risk-fold">
          <summary><ImpactBadge impact={r.impact} /> <b>{RISK_LABEL[r.kind]}</b></summary>
          {prose(r.body)}
        </details>
      ))}
    </div>
  );
}

/** 影響の段階ごとの件数。0 件の段階は出さない */
const impactCounts = (risks: readonly Risk[]) =>
  IMPACT_ORDER.map((i) => ({ impact: i, n: risks.filter((r) => r.impact === i).length })).filter((c) => c.n > 0);

/**
 * 全体把握の Risks。影響の強い順に並べ、considered と影響 小 は入れ子の畳みに入れる。
 * 畳んでいないものがあれば開いて出す
 */
function RiskSection({ risks, files }: { risks: Risk[]; files: readonly DiffFile[] }) {
  const { shown, folded } = splitRisks(risks);
  const counts = impactCounts(risks).map((c) => `${IMPACT_LABEL[c.impact].replace("影響 ", "")} ${c.n}`).join(" · ");
  return (
    <details className="g-fold" open={shown.length > 0}>
      <summary>Risks（{risks.length}）<span className="hint"> 影響 {counts}</span></summary>
      <ul className="g-list">{shown.map((r) => <RiskItem key={r.id} risk={r} files={files} />)}</ul>
      {folded.length > 0 && (
        <details className="g-fold">
          <summary>影響 小・検討済み（{folded.length}）</summary>
          <ul className="g-list">{folded.map((r) => <RiskItem key={r.id} risk={r} files={files} />)}</ul>
        </details>
      )}
    </details>
  );
}

/**
 * 全体の把握。Why / What / How は開いて出し、Key Decisions / Tests は
 * （各グループの refs にも出るので）件数だけ見出しに出して畳む。
 * Risks は畳まないもの（考慮済みでも影響 小でもないもの）があれば開いて出す
 */
export function GuideOverview({ guide, files }: { guide: Guide; files: readonly DiffFile[] }) {
  const diagram = (id: string | undefined) => guide.diagrams.find((d) => d.id === id);
  return (
    <>
      <section className="g-sec" style={sec(0)}><h3>Why</h3>{prose(guide.why)}</section>
      {guide.what.length > 0 && (
        <section className="g-sec" style={sec(1)}>
          <h3>What</h3>
          <table className="g-table">
            <thead><tr><th>概念</th><th>変更</th></tr></thead>
            <tbody>
              {guide.what.map((w, i) => (
                <tr key={i}>
                  <td><b>{w.name}</b>{w.paths.length > 0 && <div className="mono hint">{w.paths.join(", ")}</div>}</td>
                  <td>{prose(w.summary)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {guide.how.length > 0 && (
        <section className="g-sec" style={sec(2)}>
          <h3>How</h3>
          {guide.how.map((h, i) => {
            const d = diagram(h.diagram);
            return <div key={i}>{prose(h.body)}{d && <DiagramView diagram={d} />}</div>;
          })}
        </section>
      )}
      {guide.decisions.length > 0 && (
        <details className="g-fold">
          <summary>Key Decisions（{guide.decisions.length}）</summary>
          <ol className="g-list">{guide.decisions.map((d) => <DecisionItem key={d.id} d={d} />)}</ol>
        </details>
      )}
      {guide.risks.length > 0 && <RiskSection risks={guide.risks} files={files} />}
      {guide.tests.length > 0 && (
        <details className="g-fold">
          <summary>Tests（{guide.tests.length}）</summary>
          <table className="g-table">
            <thead><tr><th>振る舞い</th><th>テスト</th></tr></thead>
            <tbody>
              {guide.tests.map((x) => (
                <tr key={x.id}><td>{x.behavior}</td><td className="mono">{x.path}<div>{x.name}</div></td></tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </>
  );
}

/**
 * ファイル順の表示で、diff の右に置く Review Guide。onJump があるとき（ガイドの順に並べられるとき）は、
 * Reading Order の各項目が「ガイドの順へ切り替えてそのグループへ飛ぶ」ボタンになる
 */
export function GuidePanel({ guide, files, truncated, partial, onJump }: {
  guide: Guide;
  files: DiffFile[];
  truncated: boolean;
  partial: boolean;
  onJump?: (group: number) => void;
}) {
  return (
    <aside className="guide" aria-label="Review Guide">
      <div className="guide-head"><b>Review Guide</b></div>
      {partial && (
        <p className="g-warn">
          このガイドはブランチ全体の変更を説明しています。前回レビュー以降だけを見ている間は、ガイドが指す箇所が画面に無いことがあります
        </p>
      )}
      <GuideOverview guide={guide} files={files} />
      <section className="g-sec" style={sec(3)}>
        <h3>Reading Order</h3>
        <ol className="g-order">
          {guide.readingOrder.map((r, i) => (
            <li key={i}>
              {onJump ? (
                <button onClick={() => onJump(i)}>
                  <span>{r.title}</span>
                  <span className="nm hint">{groupPaths(r).join(", ")}</span>
                </button>
              ) : (
                <div className="g-order-item"><span>{r.title}</span><span className="nm hint">{groupPaths(r).join(", ")}</span></div>
              )}
            </li>
          ))}
        </ol>
        <UnguidedNote files={files} guide={guide} truncated={truncated} />
      </section>
    </aside>
  );
}
