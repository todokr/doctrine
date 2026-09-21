import type { CSSProperties, ReactNode } from "react";
import { findUnguided } from "../flow";
import { groupPaths, locationPaths, type GuideView } from "../guide";
import { clock, type Loaded } from "../model";
import type { DiffFile, Guide, Risk } from "../types";
import { DiagramView } from "./Diagrams";
import { Markdown } from "./text";

const sec = (i: number) => ({ "--gi": i }) as CSSProperties;

type Decision = Guide["decisions"][number];

export const RISK_LABEL: Record<Risk["kind"], string> = {
  breaks: "壊しうるもの",
  assumption: "置いた前提",
  unknown: "分かっていないこと",
  considered: "検討済み",
};

export const prose = (src: string) => <div className="g-md"><Markdown src={src} /></div>;

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

export function RiskItem({ risk }: { risk: Risk }) {
  return (
    <li>
      <b>{RISK_LABEL[risk.kind]}</b>
      {prose(risk.body)}
      {risk.locations.length > 0 && <span className="mono">{locationPaths(risk.locations).join(", ")}</span>}
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
  return (
    <div className="hunk-risk" role="note">
      {risks.map((r) => (
        <div key={r.id}>
          <b>{RISK_LABEL[r.kind]}</b>
          {prose(r.body)}
        </div>
      ))}
    </div>
  );
}

/**
 * 全体の把握。Why / What / How は開いて出し、Key Decisions / Risks / Tests は
 * （各グループの refs にも出るので）件数だけ見出しに出して畳む
 */
export function GuideOverview({ guide }: { guide: Guide }) {
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
      {guide.risks.length > 0 && (
        <details className="g-fold">
          <summary>Risks（{guide.risks.length}）</summary>
          <ul className="g-list">{guide.risks.map((r) => <RiskItem key={r.id} risk={r} />)}</ul>
        </details>
      )}
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
      <GuideOverview guide={guide} />
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
