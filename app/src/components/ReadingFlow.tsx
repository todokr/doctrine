import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { readingFlow, risksAt, type FlowChunk, type FlowGroup } from "../flow";
import { sortRisks } from "../guide";
import type { DiffView } from "../model";
import type { DiffFile, Guide, Task } from "../types";
import { DiagramView } from "./Diagrams";
import { DiffFileBlock } from "./DiffFileBlock";
import { DecisionItem, GuideOverview, RiskItem, RiskNote, prose } from "./Guide";

/** key: "overview" | "g<index>" | "unguided" */
export const flowSectionAnchor = (key: string) => `flow-${key}`;

const scrollToSection = (key: string) =>
  document.getElementById(flowSectionAnchor(key))?.scrollIntoView({ block: "start", behavior: "smooth" });

/** 「続き」と、そのファイルの何番目の hunk か。ファイルの hunk を全部出すときは何も足さない */
function chunkHead(chunk: FlowChunk): ReactNode {
  const total = chunk.file.hunks.length;
  const partial = chunk.hunks.length > 0 && chunk.hunks.length < total;
  if (!chunk.continued && !partial) return null;
  return (
    <>
      {chunk.continued && <span className="flow-cont">続き</span>}
      {partial && <span className="hint">hunk {chunk.hunks.map((i) => i + 1).join(", ")} / {total}</span>}
    </>
  );
}

export function ReadingFlow({ t, guide, view }: { t: Task; guide: Guide; view: DiffView }) {
  const { files, meta } = view;
  const flow = useMemo(() => readingFlow(guide, files, meta.truncated), [guide, files, meta.truncated]);
  const risks = useMemo(() => risksAt(guide), [guide]);
  const rootRef = useRef<HTMLDivElement>(null);

  const keys = useMemo(() => ["overview", ...flow.groups.map((g) => `g${g.index}`), "unguided"], [flow]);
  // 今いる節。読んだ位置はスクロール位置そのもので、State には入れない
  const [current, setCurrent] = useState("overview");

  useEffect(() => {
    const main = rootRef.current?.closest("main");
    if (!main) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const top = main.getBoundingClientRect().top + 8;
      let now = keys[0];
      for (const key of keys) {
        const el = document.getElementById(flowSectionAnchor(key));
        if (el && el.getBoundingClientRect().top <= top) now = key;
      }
      setCurrent(now);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    main.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      main.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [keys]);

  const fileRisks = (file: DiffFile, chunk: FlowChunk) => {
    if (chunk.continued) return null;
    const list = [...(risks.byPath.get(file.path) ?? [])];
    if (file.status === "R" && file.old_path) list.push(...(risks.byPath.get(file.old_path) ?? []));
    return <RiskNote risks={list} />;
  };

  const chunkView = (chunk: FlowChunk, i: number, extra?: ReactNode) => (
    <DiffFileBlock
      key={`${chunk.file.path}#${i}`}
      t={t}
      files={files}
      file={chunk.file}
      only={chunk.hunks}
      anchored={false}
      head={chunkHead(chunk)}
      note={<>{fileRisks(chunk.file, chunk)}{extra}</>}
      hunkNote={(h) => <RiskNote risks={risks.byHunk.get(h.id)} />}
    />
  );

  const groupView = (g: FlowGroup) => {
    const { refs } = g.group;
    const decisions = guide.decisions.filter((d) => refs.decisions.includes(d.id));
    const riskItems = sortRisks(guide.risks.filter((r) => refs.risks.includes(r.id)));
    const tests = guide.tests.filter((x) => refs.tests.includes(x.id));
    const diagrams = guide.diagrams.filter((d) => refs.diagrams.includes(d.id));
    return (
      <section className="flow-sec" id={flowSectionAnchor(`g${g.index}`)} key={g.index} aria-label={g.group.title}>
        <header className="flow-head">
          <span className="lbl human">Group {g.index + 1} / {flow.groups.length}</span>
          <h2>{g.group.title}</h2>
        </header>
        <div className="flow-note">
          {prose(g.group.body)}
          {diagrams.map((d) => <div key={d.id} className="dg"><DiagramView diagram={d} /></div>)}
          {decisions.length > 0 && (
            <div><span className="lbl">判断</span><ol className="g-list">{decisions.map((d) => <DecisionItem key={d.id} d={d} />)}</ol></div>
          )}
          {riskItems.length > 0 && (
            <div><span className="lbl">リスク</span><ul className="g-list">{riskItems.map((r) => <RiskItem key={r.id} risk={r} files={files} />)}</ul></div>
          )}
          {tests.length > 0 && (
            <div>
              <span className="lbl">テスト</span>
              <ul className="g-list">{tests.map((x) => <li key={x.id}>{x.behavior}<span className="mono">{x.path} · {x.name}</span></li>)}</ul>
            </div>
          )}
        </div>
        {g.absent.length > 0 && (
          <p className="g-warn">
            この箇所は今の diff にありません:{" "}
            {g.absent.map((l, i) => <span key={i}>{i > 0 && "、"}<span className="mono">{l.path}{l.hunk ? ` (${l.hunk})` : ""}</span></span>)}
          </p>
        )}
        {g.repeats.map((r, i) => (
          <p className="hint" key={i}>
            <span className="mono">{r.location.path}</span> のこの箇所はグループ {r.at + 1} で出ています{" "}
            <button className="btn sm" onClick={() => scrollToSection(`g${r.at}`)}>グループ {r.at + 1} へ</button>
          </p>
        ))}
        <div className="diffs">{g.chunks.map((c, i) => chunkView(c, i))}</div>
      </section>
    );
  };

  const { unguided } = flow.tail;
  const heading = unguided.truncated ? "ガイドが触れていない可能性がある変更" : "ガイドが触れていない変更";
  const cutOffNote = <p className="hint" style={{ padding: "6px 10px" }}>diff が打ち切られたため中身が届いておらず、照合できません</p>;

  return (
    <div className="rv-body" ref={rootRef}>
      <nav className="flowtoc" aria-label="ガイドの目次">
        <header className="lbl">Guide · ガイドの順</header>
        {keys.map((key, i) => {
          const at = keys.indexOf(current);
          const g = key.startsWith("g") ? flow.groups[Number(key.slice(1))] : null;
          const label = key === "overview" ? "全体の把握" : g ? `${g.index + 1}. ${g.group.title}` : `${heading}（${unguided.items.length}）`;
          const hunks = g ? g.chunks.reduce((n, c) => n + Math.max(c.hunks.length, 1), 0) : 0;
          return (
            <button
              key={key}
              className={`fl ${i < at ? "passed" : ""}`}
              aria-current={key === current ? "true" : undefined}
              onClick={() => scrollToSection(key)}
            >
              <span className="nm">{label}</span>
              {g && <span className="st">{hunks} 件</span>}
            </button>
          );
        })}
      </nav>
      <div className="flow">
        <section className="flow-sec" id={flowSectionAnchor("overview")} aria-label="全体の把握">
          <header className="flow-head"><h2>全体の把握</h2></header>
          <div className="flow-overview"><GuideOverview guide={guide} files={files} /></div>
        </section>
        {flow.groups.map(groupView)}
        <section className="flow-sec" id={flowSectionAnchor("unguided")} aria-label={heading}>
          <header className="flow-head"><h2>{heading}</h2></header>
          <p className="hint">ガイドの読む順に入っていない変更です。Risks がこの箇所に触れている場合は、hunk の上に出します</p>
          {unguided.truncated && (
            <p className="g-warn">diff が途中で打ち切られているため、ここにあるものがガイドの見落としとは限りません</p>
          )}
          {flow.tail.chunks.length === 0 ? (
            <p className="g-ok">✓ diff のすべての変更がガイドの読む順に入っています</p>
          ) : (
            <div className="diffs">
              {flow.tail.chunks.map((c, i) => chunkView(c, i, c.file.cutOff && c.hunks.length === 0 ? cutOffNote : null))}
            </div>
          )}
        </section>
        <section className="flow-end">
          <b>ガイドの読む順はここまでです</b>
          <p className="hint">説明がコードと一致していたかを振り返ってから、下で承認か差し戻しを決めてください。</p>
        </section>
      </div>
    </div>
  );
}
