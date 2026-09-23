import type { Evidence } from "../../../shared/intake/question.ts";
import { languageOf } from "../highlight";
import { CodeBlock } from "./MaterialView";
import { Markdown } from "./text";

function lineRange(e: Extract<Evidence, { kind: "code" }>): string {
  if (e.startLine === null) return "";
  return e.endLine === null || e.endLine === e.startLine ? `:${e.startLine}` : `:${e.startLine}-${e.endLine}`;
}

/** 仮定の根拠 1 件。props だけで描く */
export function EvidenceView({ evidence }: { evidence: Evidence }) {
  return (
    <div className="material">
      {evidence.kind === "issue" && (
        <>
          <span className="cap">
            {evidence.commentUrl
              ? <>Issue のコメント <span className="mono">{evidence.commentUrl}</span></>
              : "Issue の本文"}
          </span>
          <blockquote className="evq">{evidence.quote}</blockquote>
        </>
      )}
      {evidence.kind === "code" && (
        <>
          <span className="cap mono">{evidence.path}{lineRange(evidence)}</span>
          <CodeBlock code={evidence.excerpt} language={languageOf(evidence.path)} />
        </>
      )}
      {evidence.kind === "convention" && (
        <>
          <span className="cap">慣習</span>
          <div className="g-md"><Markdown src={evidence.body} /></div>
        </>
      )}
    </div>
  );
}
