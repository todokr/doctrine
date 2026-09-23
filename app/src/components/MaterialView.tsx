import { Fragment } from "react";
import type { Material } from "../../../shared/intake/question.ts";
import { highlightLines, languageOf } from "../highlight";
import { DiagramView } from "./Diagrams";
import { Markdown } from "./text";

/** 色付けした等幅のコード。判断材料と仮定の根拠が使う */
export function CodeBlock(p: { code: string; language: string | null }) {
  return (
    <pre className="code">
      {highlightLines(p.code, p.language).map((pieces, li) => (
        <div key={li}>
          {pieces.map((piece, pi) => (
            piece.cls
              ? <span key={pi} className={`tk-${piece.cls}`}>{piece.text}</span>
              : <Fragment key={pi}>{piece.text}</Fragment>
          ))}
        </div>
      ))}
    </pre>
  );
}

export function MaterialView({ material }: { material: Material }) {
  return (
    <div className="material">
      {material.kind === "text" && (
        <div className="g-md"><Markdown src={material.body} /></div>
      )}
      {material.kind === "table" && (
        <>
          <span className="cap">{material.caption}</span>
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>{material.columns.map((c, i) => <th key={i}>{c}</th>)}</tr>
              </thead>
              <tbody>
                {material.rows.map((row, ri) => (
                  <tr key={ri}>{row.map((cell, ci) => <td key={ci}>{cell}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {material.kind === "code" && (
        <>
          <span className="cap">
            {material.caption}
            {material.path && <> <span className="mono">{material.path}</span></>}
          </span>
          <CodeBlock
            code={material.code}
            language={material.path ? languageOf(material.path) ?? material.language : material.language}
          />
        </>
      )}
      {material.kind === "diagram" && (
        <>
          <span className="cap">{material.caption}</span>
          <DiagramView diagram={material.diagram} />
        </>
      )}
    </div>
  );
}
