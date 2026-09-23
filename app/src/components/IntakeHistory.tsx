import { useMemo, useState } from "react";
import type { Pfd } from "../../../shared/intake/pfd.ts";
import type { IntakeComment, IntakeDetail, IntakeQuestionSet, PfdDraft } from "../../../shared/protocol.ts";
import { commentReplies, commentTargetLabel, intakeHistory, type IntakeHistoryEntry } from "../intake";
import { clock, type Loaded } from "../model";
import { buildPfdView, pfdElement } from "../pfd";
import { useIntakeRpc } from "../store";
import { PfdDiagram } from "./PfdDiagram";
import { PfdElementPanel } from "./PfdElementPanel";
import { QuestionForm } from "./QuestionForm";

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 読み返し用の案の図と要素の欄。選択はここだけで持ち、コメントとプロンプトの欄は出さない */
function DraftBody(p: { pfd: Pfd; questionSets: IntakeDetail["question_sets"] }) {
  const [selected, setSelected] = useState<string | null>(null);
  const view = useMemo(() => buildPfdView(p.pfd), [p.pfd]);
  return (
    <div className="plan-body">
      <PfdDiagram view={view} selected={selected} onSelect={setSelected} />
      <PfdElementPanel
        pfd={p.pfd}
        info={selected === null ? null : pfdElement(p.pfd, selected, p.questionSets)}
        onSelect={setSelected}
        prompt={undefined}
        onOpenPrompt={null}
        comments={[]}
        previous={[]}
        onAddComment={null}
        onDeleteComment={null}
      />
    </div>
  );
}

function CommentRows(p: { title: string; rows: { comment: IntakeComment; reply?: string | null }[]; pfd: Pfd | null }) {
  return (
    <section className="hist-comments">
      <h3 className="el-sec-title">{p.title}</h3>
      {p.rows.map(({ comment, reply }) => (
        <div key={comment.id} className="cmt">
          <div className="who">{commentTargetLabel(comment, p.pfd)}</div>
          <div>{comment.body}</div>
          {reply !== undefined && <div className="hint">{reply ?? "返答なし"}</div>}
        </div>
      ))}
    </section>
  );
}

function answeredTitle(set: IntakeQuestionSet): string {
  const parts = [
    set.questions.length > 0 && `質問 ${set.questions.length} 件`,
    set.assumptions.length > 0 && `仮定 ${set.assumptions.length} 件`,
  ].filter(Boolean);
  return `${parts.join("と")}に答えた`;
}

/** 1 件の行。props だけで描く */
export function HistoryEntryView(p: {
  entry: IntakeHistoryEntry;
  /** kind が draft のときの中身 */
  draft: Loaded<PfdDraft> | undefined;
  /** 案の行を開いたとき */
  onOpen: () => void;
  questionSets?: IntakeDetail["question_sets"];
}) {
  const { entry } = p;
  const when = clock(Date.parse(entry.at));
  if (entry.kind === "questions") {
    return (
      <div className="hist-row">
        <div className="hist-head">
          <b>{answeredTitle(entry.set)}</b>
          <span className="hint">{when}</span>
        </div>
        <QuestionForm set={entry.set} reply={entry.set.reply ?? { answers: [], assumptionResponses: [] }} readOnly />
      </div>
    );
  }
  if (entry.kind === "approval") {
    return (
      <div className="hist-row">
        <div className="hist-head">
          <b>{`承認した（${entry.seq} 回目の案）`}</b>
          <span className="hint">{when}</span>
        </div>
      </div>
    );
  }
  const loaded = p.draft?.kind === "ok" ? p.draft.value : null;
  return (
    <details className="hist-row" onToggle={(e) => e.currentTarget.open && p.onOpen()}>
      <summary className="hist-head">
        <b>{`${entry.seq} 回目の案`}</b>
        <span className="hint">{when}</span>
      </summary>
      {p.draft?.kind === "loading" && <p className="hint">読み込み中</p>}
      {p.draft?.kind === "error" && <p className="hint">{p.draft.message}</p>}
      {loaded && <DraftBody pfd={loaded.pfd} questionSets={p.questionSets ?? []} />}
      {loaded && entry.previousComments.length > 0 && (
        <CommentRows
          title="前の案へのコメントと返答"
          rows={commentReplies(entry.previousComments, loaded.replies)}
          pfd={loaded.pfd}
        />
      )}
      {entry.pendingComments.length > 0 && (
        <CommentRows
          title="差し戻したコメント"
          rows={entry.pendingComments.map((comment) => ({ comment }))}
          pfd={loaded?.pfd ?? null}
        />
      )}
    </details>
  );
}

/** 面の下に置く「経緯」。store は読まず、intake.draft は useIntakeRpc で取る */
export function IntakeHistory({ detail }: { detail: IntakeDetail }) {
  const api = useIntakeRpc();
  const [drafts, setDrafts] = useState<Record<number, Loaded<PfdDraft>>>({});
  const entries = intakeHistory(detail);
  if (entries.length === 0) return null;

  const draftOf = (id: number): Loaded<PfdDraft> | undefined =>
    detail.latest_draft?.id === id ? { kind: "ok", value: detail.latest_draft } : drafts[id];
  const open = (id: number) => {
    if (draftOf(id)) return;
    setDrafts((m) => ({ ...m, [id]: { kind: "loading" } }));
    api.draft(detail.id, id).then(
      (value) => setDrafts((m) => ({ ...m, [id]: { kind: "ok", value } })),
      (e) => setDrafts((m) => ({ ...m, [id]: { kind: "error", message: errorMessage(e) } })),
    );
  };

  return (
    <details className="history">
      <summary>経緯</summary>
      {entries.map((entry, i) => (
        <HistoryEntryView
          key={i}
          entry={entry}
          draft={entry.kind === "draft" ? draftOf(entry.draftId) : undefined}
          onOpen={() => entry.kind === "draft" && open(entry.draftId)}
          questionSets={detail.question_sets}
        />
      ))}
    </details>
  );
}
