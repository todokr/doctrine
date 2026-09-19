import { useEffect, useRef, type CSSProperties } from "react";
import { unguidedFiles } from "../model";
import { useStore } from "../store";
import type { DiffFile, Guide, Task } from "../types";
import { DiffFileBlock } from "./DiffFileBlock";
import { RelationSvg, SequenceSvg } from "./Diagrams";

const sec = (i: number) => ({ "--gi": i }) as CSSProperties;

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

/** レビュー画面の右に置く Review Guide */
export function GuidePanel({ guide, files }: { guide: Guide; files: DiffFile[] }) {
  const { dispatch } = useStore();
  return (
    <aside className="guide" aria-label="Review Guide">
      <div className="guide-head"><b>Review Guide</b></div>
      <section className="g-sec" style={sec(0)}><h3>Why</h3><p>{guide.why}</p></section>
      <section className="g-sec" style={sec(1)}>
        <h3>What</h3>
        <table className="g-table">
          <thead><tr><th>ファイル</th><th>変更</th></tr></thead>
          <tbody>{guide.what.map((w) => <tr key={w.path}><td className="mono">{w.path}</td><td>{w.desc}</td></tr>)}</tbody>
        </table>
      </section>
      <section className="g-sec" style={sec(2)}>
        <h3>How</h3>
        <p className="hint">差し戻し復帰時にセッションを解決する流れ</p>
        <SequenceSvg seq={guide.sequence} />
        <p className="hint">セッションを役割ごとに分けて持つ形</p>
        <RelationSvg />
      </section>
      <section className="g-sec" style={sec(3)}>
        <h3>Reading Order</h3>
        <button className="g-start" onClick={() => dispatch({ type: "step", idx: 0 })}>ガイドに沿って読む（{guide.readingOrder.length}ステップ）▸</button>
        <ol className="g-order">
          {guide.readingOrder.map((r, i) => (
            <li key={i}>
              <button onClick={() => dispatch({ type: "step", idx: i })}>
                <span>{r.title}</span>
                <span className="nm hint">{r.paths.join(", ")}</span>
              </button>
            </li>
          ))}
        </ol>
        <UnguidedNote files={files} guide={guide} />
      </section>
      <section className="g-sec" style={sec(4)}>
        <h3>Key Decisions</h3>
        <ol className="g-list">{guide.decisions.map((d) => <li key={d.title}><b>{d.title}</b><span>{d.body}</span></li>)}</ol>
      </section>
      <section className="g-sec" style={sec(5)}>
        <h3>Risks</h3>
        <ul className="g-list">{guide.risks.map((r) => <li key={r}>{r}</li>)}</ul>
      </section>
      <section className="g-sec" style={sec(6)}>
        <h3>Tests</h3>
        <table className="g-table">
          <thead><tr><th>振る舞い</th><th>テスト</th></tr></thead>
          <tbody>{guide.tests.map((x) => <tr key={x.behavior}><td>{x.behavior}</td><td className="mono">{x.test}</td></tr>)}</tbody>
        </table>
      </section>
    </aside>
  );
}

/** ガイドの Reading Order を1ステップずつ読む表示 */
export function StepView({ t, guide, files: all, idx }: { t: Task; guide: Guide; files: DiffFile[]; idx: number }) {
  const { dispatch } = useStore();
  const ref = useRef<HTMLDivElement>(null);
  const steps = guide.readingOrder;
  const step = steps[idx];
  const files = step.paths.flatMap((p) => all.filter((f) => f.path === p));
  const last = idx === steps.length - 1;
  const missing = unguidedFiles(all, guide);

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
        <p>{step.explain}</p>
        {step.diagram && <div className="dg">{step.diagram === "sequence" ? <SequenceSvg seq={guide.sequence} /> : <RelationSvg />}</div>}
      </section>
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
