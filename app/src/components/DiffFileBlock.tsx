import { Fragment, useMemo, type ReactNode } from "react";
import { highlightHunk, languageOf } from "../highlight";
import { diffLines, draftOf } from "../model";
import { useStore } from "../store";
import type { DiffFile, DiffHunk, Task } from "../types";

export const fileAnchor = (path: string) => `file-${path}`;

/** ファイル一覧に出す増減。バイナリは行数を持たない（数えられない）ので、そう書く */
export function fileStat(f: DiffFile): ReactNode {
  if (f.binary) return <span className="hint">バイナリ</span>;
  return <><span className="add">+{f.additions}</span><span className="del">−{f.deletions}</span></>;
}

const STATUS_LABEL: Record<DiffFile["status"], string> = {
  A: "追加", M: "変更", D: "削除", R: "移動",
};

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

function Hunk({ t, path, hunk, language }: { t: Task; path: string; hunk: DiffHunk; language: string | null }) {
  const { dispatch } = useStore();
  // hunk 1つをまとめて解析する。行ごとに呼ぶと、行をまたぐトークンが解けない
  const lines = useMemo(() => diffLines(hunk), [hunk]);
  const tokens = useMemo(() => highlightHunk(lines, language), [lines, language]);
  return (
    <>
      <div className="hunk">@@ -{hunk.old} +{hunk.new} @@</div>
      {lines.map((l, li) => (
        <Fragment key={li}>
          <div className={`ln ${l.kind}`}>
            <span className="o">{l.old ?? ""}</span>
            <span className="n">{l.new ?? ""}</span>
            <button className="cm" aria-label={`${l.line}行目にコメント`} onClick={() => dispatch({ type: "comment.new", path, line: l.line, quote: l.text.trim() })}>+</button>
            <span className="c">
              {tokens[li].map((p, pi) => (
                p.cls ? <span key={pi} className={`tk-${p.cls}`}>{p.text}</span> : <Fragment key={pi}>{p.text}</Fragment>
              ))}
            </span>
          </div>
          <LineComments t={t} path={path} line={l.line} />
        </Fragment>
      ))}
    </>
  );
}

export function DiffFileBlock({ t, file }: { t: Task; file: DiffFile }) {
  const language = useMemo(() => languageOf(file.path), [file.path]);
  return (
    <section className="file" id={fileAnchor(file.path)}>
      <header>
        <span className="nm">{file.path}</span>
        {file.status === "R" && <span className="hint mono">← {file.old_path}</span>}
        <span className="hint">{STATUS_LABEL[file.status]}</span>
        {fileStat(file)}
      </header>
      <div className="code">
        {file.binary
          ? <p className="hint" style={{ padding: "8px 12px" }}>バイナリファイルのため中身は表示しません</p>
          : file.cutOff
            ? <p className="hint" style={{ padding: "8px 12px" }}>diff が打ち切られたため、このファイルの中身は届いていません</p>
            : file.hunks.length === 0
              ? <p className="hint" style={{ padding: "8px 12px" }}>中身の変更はありません（モードや名前だけの変更）</p>
              : file.hunks.map((h, hi) => <Hunk key={hi} t={t} path={file.path} hunk={h} language={language} />)}
      </div>
    </section>
  );
}
