import { Fragment } from "react";
import { diffLines, diffStats, draftOf } from "../model";
import { useStore } from "../store";
import type { DiffFile, Task } from "../types";
import { Highlight } from "./text";

export const fileAnchor = (path: string) => `file-${path}`;

function LineComments({ t, path, line }: { t: Task; path: string; line: number }) {
  const { s, dispatch } = useStore();
  const comments = draftOf(s, t.id).comments;
  const e = s.editing;
  return (
    <>
      {comments.map((c, i) =>
        c.path === path && c.line === line ? (
          <div className="lc" key={i}>
            <span className="who">あなた · 送信前の下書き</span>
            <div>{c.text}</div>
            <div className="actions"><button className="btn sm" onClick={() => dispatch({ type: "comment.delete", index: i })}>削除</button></div>
          </div>
        ) : null,
      )}
      {e && e.task === t.id && e.path === path && e.line === line && (
        <div className="lc">
          <span className="who">{path}:{line} にコメント</span>
          <textarea autoFocus placeholder="エージェントへの指摘" value={e.text} onChange={(ev) => dispatch({ type: "comment.text", text: ev.target.value })} />
          <div className="actions">
            <button className="btn sm primary" onClick={() => dispatch({ type: "comment.save" })}>下書きに追加</button>
            <button className="btn sm" onClick={() => dispatch({ type: "comment.cancel" })}>やめる</button>
          </div>
        </div>
      )}
    </>
  );
}

export function DiffFileBlock({ t, file }: { t: Task; file: DiffFile }) {
  const { dispatch } = useStore();
  const { add, del } = diffStats(file);
  return (
    <section className="file" id={fileAnchor(file.path)}>
      <header>
        <span className="nm">{file.path}</span>
        <span className="add mono">+{add}</span>
        <span className="del mono">−{del}</span>
      </header>
      <div className="code">
        {file.hunks.map((h, hi) => (
          <Fragment key={hi}>
            <div className="hunk">@@ -{h.old} +{h.new} @@</div>
            {diffLines(h).map((l, li) => (
              <Fragment key={li}>
                <div className={`ln ${l.kind}`}>
                  <span className="o">{l.old ?? ""}</span>
                  <span className="n">{l.new ?? ""}</span>
                  <button className="cm" aria-label={`${l.line}行目にコメント`} onClick={() => dispatch({ type: "comment.new", path: file.path, line: l.line, quote: l.text.trim() })}>+</button>
                  <span className="c"><Highlight code={l.text} /></span>
                </div>
                <LineComments t={t} path={file.path} line={l.line} />
              </Fragment>
            ))}
          </Fragment>
        ))}
      </div>
    </section>
  );
}
