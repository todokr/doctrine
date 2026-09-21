import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { groupPaths, locationPaths, type GuideView } from "../guide";
import { clock, unguidedFiles, type Loaded, type Scope } from "../model";
import { useStore } from "../store";
import type { DiffFile, Guide, Task } from "../types";
import { DiffFileBlock } from "./DiffFileBlock";
import { DiagramView } from "./Diagrams";
import { Markdown } from "./text";

const sec = (i: number) => ({ "--gi": i }) as CSSProperties;

type Risk = Guide["risks"][number];
type Decision = Guide["decisions"][number];

const RISK_LABEL: Record<Risk["kind"], string> = {
  breaks: "壊しうるもの",
  assumption: "置いた前提",
  unknown: "分かっていないこと",
  considered: "検討済み",
};

const prose = (src: string) => <div className="md"><Markdown src={src} /></div>;

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

function UnguidedNote({ files, guide }: { files: DiffFile[]; guide: Guide }) {
  const missing = unguidedFiles(files, guide);
  return missing.length ? (
    <p className="g-warn">
      ⚠ diff に含まれるがガイドが触れていないファイルが{missing.length}件:{" "}
      {missing.map((f, i) => <span key={f.path}>{i > 0 && "、"}<span className="mono">{f.path}</span></span>)}
    </p>
  ) : (
    <p className="g-ok">✓ diff の全ファイルがガイドに触れています</p>
  );
}

function RiskItem({ risk }: { risk: Risk }) {
  return (
    <li>
      <b>{RISK_LABEL[risk.kind]}</b>
      {prose(risk.body)}
      {risk.locations.length > 0 && <span className="mono">{locationPaths(risk.locations).join(", ")}</span>}
    </li>
  );
}

function DecisionItem({ d }: { d: Decision }) {
  return (
    <li>
      <b>{d.decision}</b>
      {prose(d.reason)}
      {d.source && <span className="hint mono">{sourceLabel(d.source)}</span>}
    </li>
  );
}

/** レビュー画面の右に置く Review Guide */
export function GuidePanel({ guide, files, scope }: { guide: Guide; files: DiffFile[]; scope: Scope }) {
  const { dispatch } = useStore();
  const diagram = (id: string | undefined) => guide.diagrams.find((d) => d.id === id);
  // 箇所は merge-base から tree までの diff に対して検証されているので、前回レビュー以降だけを見ている間は
  // 指す箇所が画面に無いことが正常に起こる
  const partial = scope === "since";
  return (
    <aside className="guide" aria-label="Review Guide">
      <div className="guide-head"><b>Review Guide</b></div>
      {partial && (
        <p className="g-warn">
          このガイドはブランチ全体の変更を説明しています。前回レビュー以降だけを見ている間は、ガイドが指す箇所が画面に無いことがあります
        </p>
      )}
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
      <section className="g-sec" style={sec(3)}>
        <h3>Reading Order</h3>
        {!partial && guide.readingOrder.length > 0 && (
          <button className="g-start" onClick={() => dispatch({ type: "step", idx: 0 })}>ガイドに沿って読む（{guide.readingOrder.length}ステップ）▸</button>
        )}
        <ol className="g-order">
          {guide.readingOrder.map((r, i) => (
            <li key={i}>
              {partial ? (
                <div className="g-order-item"><span>{r.title}</span><span className="nm hint">{groupPaths(r).join(", ")}</span></div>
              ) : (
                <button onClick={() => dispatch({ type: "step", idx: i })}>
                  <span>{r.title}</span>
                  <span className="nm hint">{groupPaths(r).join(", ")}</span>
                </button>
              )}
            </li>
          ))}
        </ol>
        <UnguidedNote files={files} guide={guide} />
      </section>
      {guide.decisions.length > 0 && (
        <section className="g-sec" style={sec(4)}>
          <h3>Key Decisions</h3>
          <ol className="g-list">{guide.decisions.map((d) => <DecisionItem key={d.id} d={d} />)}</ol>
        </section>
      )}
      {guide.risks.length > 0 && (
        <section className="g-sec" style={sec(5)}>
          <h3>Risks</h3>
          <ul className="g-list">{guide.risks.map((r) => <RiskItem key={r.id} risk={r} />)}</ul>
        </section>
      )}
      {guide.tests.length > 0 && (
        <section className="g-sec" style={sec(6)}>
          <h3>Tests</h3>
          <table className="g-table">
            <thead><tr><th>振る舞い</th><th>テスト</th></tr></thead>
            <tbody>
              {guide.tests.map((x) => (
                <tr key={x.id}><td>{x.behavior}</td><td className="mono">{x.path}<div>{x.name}</div></td></tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </aside>
  );
}

/** ガイドの Reading Order を1グループずつ読む表示 */
export function StepView({ t, guide, files: all, idx }: { t: Task; guide: Guide; files: DiffFile[]; idx: number }) {
  const { dispatch } = useStore();
  const ref = useRef<HTMLDivElement>(null);
  const steps = guide.readingOrder;
  const step = steps[idx];
  const paths = groupPaths(step);
  const files = paths.flatMap((p) => all.filter((f) => f.path === p));
  const absent = paths.filter((p) => !all.some((f) => f.path === p));
  const last = idx === steps.length - 1;
  const missing = unguidedFiles(all, guide);

  // グループが束ねる節。ガイド全体を探し直さなくても、そのステップの中で読める
  const decisions = guide.decisions.filter((d) => step.refs.decisions.includes(d.id));
  const risks = guide.risks.filter((r) => step.refs.risks.includes(r.id));
  const tests = guide.tests.filter((x) => step.refs.tests.includes(x.id));
  const diagrams = guide.diagrams.filter((d) => step.refs.diagrams.includes(d.id));

  // ステップを移ったときだけ先頭へ送る。タスクを開いた直後は経緯から読めるようにそのまま
  const shown = useRef({ task: t.id, idx });
  useEffect(() => {
    const prev = shown.current;
    shown.current = { task: t.id, idx };
    if (prev.task === t.id && prev.idx !== idx) ref.current?.scrollIntoView({ block: "start" });
  }, [t.id, idx]);

  return (
    <div className="stepmode" ref={ref}>
      <div className="step-bar">
        <b>ガイドに沿って読む</b>
        <span className="step-pills" role="group" aria-label="読むステップ">
          {steps.map((x, i) => (
            <button key={i} className={`step-pill ${i < idx ? "done" : ""}`} title={x.title} aria-current={i === idx ? "step" : undefined} onClick={() => dispatch({ type: "step", idx: i })}>
              {i + 1}
            </button>
          ))}
        </span>
        <span className="spacer" />
        <button className="btn sm" onClick={() => dispatch({ type: "step", idx: null })}>全体表示に戻る</button>
      </div>
      <section className="stepcard" aria-live="polite" key={idx}>
        <span className="eyebrow">STEP {idx + 1} / {steps.length}</span>
        <h2>{step.title}</h2>
        {prose(step.body)}
        {diagrams.map((d) => <div key={d.id} className="dg"><DiagramView diagram={d} /></div>)}
        {decisions.length > 0 && (
          <div><b>判断</b><ol className="g-list">{decisions.map((d) => <DecisionItem key={d.id} d={d} />)}</ol></div>
        )}
        {risks.length > 0 && (
          <div><b>リスク</b><ul className="g-list">{risks.map((r) => <RiskItem key={r.id} risk={r} />)}</ul></div>
        )}
        {tests.length > 0 && (
          <div>
            <b>テスト</b>
            <ul className="g-list">{tests.map((x) => <li key={x.id}>{x.behavior}<span className="mono">{x.path} · {x.name}</span></li>)}</ul>
          </div>
        )}
      </section>
      {absent.length > 0 && (
        <p className="g-warn">
          この箇所は今の diff にありません:{" "}
          {absent.map((p, i) => <span key={p}>{i > 0 && "、"}<span className="mono">{p}</span></span>)}
        </p>
      )}
      <div className="diffs">{files.map((f) => <DiffFileBlock key={f.path} t={t} file={f} />)}</div>
      {last && (
        <section className="step-done">
          <b>ガイドのステップはここまでです</b>
          {missing.length ? (
            <>
              <p className="g-warn">⚠ diff に含まれるがガイドが触れていないファイルが{missing.length}件あります。判断の前に目を通してください。</p>
              <div className="diffs">{missing.map((f) => <DiffFileBlock key={f.path} t={t} file={f} />)}</div>
            </>
          ) : (
            <p className="g-ok">✓ diff の全ファイルをガイドのステップで読みました</p>
          )}
          <p className="hint">説明がコードと一致していたかを振り返ってから、下で承認か差し戻しを決めてください。</p>
        </section>
      )}
      <div className="step-foot">
        <button className="btn" disabled={idx === 0} onClick={() => dispatch({ type: "step", idx: idx - 1 })}>← 前のステップ</button>
        {!last && (
          <button className="btn" style={{ borderColor: "var(--accent)" }} onClick={() => dispatch({ type: "step", idx: idx + 1 })}>
            次のステップ: {steps[idx + 1].title} →
          </button>
        )}
        <span className="hint"><kbd className="mono">[</kbd> <kbd className="mono">]</kbd> でも移動できます</span>
      </div>
    </div>
  );
}
