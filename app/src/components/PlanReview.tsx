import { useMemo, useState, type ReactNode } from "react";
import type { IntakeDetail } from "../../../shared/protocol.ts";
import { sendDecision } from "../decision";
import {
  canRejectIntake,
  commentCounts,
  commentReplies,
  commentsOn,
  commentTarget,
  commentTargetLabel,
  rejectionText,
  wholeComment,
} from "../intake";
import { ago, intakeDraftOf, type Loaded } from "../model";
import { buildPfdView, pfdElement } from "../pfd";
import { useIntakeRpc, useStore } from "../store";
import { IntakeHistory } from "./IntakeHistory";
import { PfdDiagram } from "./PfdDiagram";
import { PfdElementPanel } from "./PfdElementPanel";

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 判断の欄。props だけで描く */
export function PlanDecide(p: {
  /** コメントの件数（whole を含む） */
  count: number;
  whole: string;
  canReject: boolean;
  approving: boolean;
  onWhole: (body: string) => void;
  onReject: () => void;
  onApprove: () => void;
}) {
  return (
    <footer className="decide">
      <div>
        <div className="meta"><span>コメント <b>{p.count}</b> 件</span></div>
        <textarea
          placeholder="計画全体へのコメント（差し戻すときに要素へのコメントと一緒に送ります）"
          value={p.whole}
          onChange={(e) => p.onWhole(e.target.value)}
        />
      </div>
      <div className="actions">
        <button className="btn danger" disabled={!p.canReject} onClick={p.onReject}>差し戻す…</button>
        <button className="btn primary" disabled={p.approving} onClick={p.onApprove}>承認する</button>
      </div>
    </footer>
  );
}

/** 差し戻しの確認。props だけで描く */
export function RejectPreview(p: { text: string; pending: boolean; onSend: () => void; onClose: () => void }) {
  return (
    <>
      <div className="scrim" onClick={p.onClose} />
      <div className="modal" role="dialog" aria-modal="true">
        <h2>差し戻してエージェントに送る内容</h2>
        <p className="hint">
          要素と計画全体へのコメントを 1 つの文面にまとめて <span className="mono">intake.reject</span> で送ります。
        </p>
        <pre className="block">{p.text}</pre>
        <div className="actions">
          <button className="btn danger" disabled={p.pending} onClick={p.onSend}>差し戻す</button>
          <button className="btn" onClick={p.onClose}>戻る</button>
        </div>
      </div>
    </>
  );
}

/** reviewing の面。store を読み、intake.processPrompt / reject / approve を呼ぶ。heading は共通の見出し */
export function PlanReview({ detail, heading }: { detail: IntakeDetail; heading: ReactNode }) {
  const { s, dispatch } = useStore();
  const api = useIntakeRpc();
  const [selected, setSelected] = useState<string | null>(null);
  const [prompts, setPrompts] = useState<Record<string, Loaded<string>>>({});
  const [approving, setApproving] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const draft = detail.latest_draft;
  const local = intakeDraftOf(s, detail.id);
  const view = useMemo(
    () => (draft ? buildPfdView(draft.pfd, { comments: commentCounts(local.comments) }) : null),
    [draft, local.comments],
  );
  if (!draft || !view) return <div className="pad">{heading}<p className="hint">案を読み込み中</p></div>;

  const { pfd } = draft;
  const info = selected === null ? null : pfdElement(pfd, selected, detail.question_sets);
  const processId = info?.kind === "process" ? info.process.id : null;

  const openPrompt = () => {
    if (processId === null || prompts[processId]) return;
    setPrompts((m) => ({ ...m, [processId]: { kind: "loading" } }));
    api.processPrompt(detail.id, draft.id, processId).then(
      (value) => setPrompts((m) => ({ ...m, [processId]: { kind: "ok", value } })),
      (e) => setPrompts((m) => ({ ...m, [processId]: { kind: "error", message: errorMessage(e) } })),
    );
  };

  const previousDraftId = detail.drafts.find((d) => d.seq === draft.seq - 1)?.id;
  const previous = commentReplies(
    detail.comments.filter((c) => c.draft_id === previousDraftId),
    draft.replies,
  );
  const target = selected === null ? null : commentTarget(selected);
  const previousHere = previous.filter(
    ({ comment: c }) => target !== null && c.target_kind === target.target_kind && c.target_id === target.target_id,
  );

  // 送る値は、後片付けの dispatch が下書きを消す前に読んでおく
  const text = rejectionText(pfd, local);
  const send = async () => {
    setRejecting(true);
    try {
      const r = await sendDecision(api.reject(detail.id, draft.id, local.comments), "差し戻しを送れませんでした");
      if (r.ok) dispatch({ type: "intake.sent", id: detail.id, what: "reject" });
      else dispatch({ type: "toast", message: r.message });
    } finally {
      setRejecting(false);
    }
  };
  const approve = async () => {
    setApproving(true);
    try {
      const r = await sendDecision(api.approve(detail.id, draft.id, draft.hash), "承認を送れませんでした");
      if (r.ok) {
        dispatch({ type: "intake.sent", id: detail.id, what: "approve" });
      } else {
        // 案が新しくなっていたときなど。詳細を取り直して、今の案を見せる
        dispatch({ type: "toast", message: r.message });
        dispatch({ type: "intake.reload", id: detail.id });
      }
    } finally {
      setApproving(false);
    }
  };

  return (
    <>
      <div className="pad">
        {heading}
        <div className="headrow">
          <h2 className="plan-title">{`${draft.seq} 回目の案`}</h2>
          <span className="hint">{ago(Date.parse(draft.created_at), s.now)}</span>
        </div>
        <div className="plan-body">
          <PfdDiagram view={view} selected={selected} onSelect={setSelected} />
          <PfdElementPanel
            pfd={pfd}
            info={info}
            onSelect={setSelected}
            prompt={processId === null ? undefined : prompts[processId]}
            onOpenPrompt={openPrompt}
            comments={selected === null ? [] : commentsOn(local.comments, selected)}
            previous={previousHere}
            onAddComment={(body) => selected !== null && dispatch({ type: "intake.comment.add", id: detail.id, key: selected, body })}
            onDeleteComment={(index) => dispatch({ type: "intake.comment.delete", id: detail.id, index })}
          />
        </div>
        {draft.seq > 1 && (
          <section className="box">
            <h2>前の案へのコメントと返答</h2>
            {previous.length === 0 && <p className="hint">コメントはありませんでした</p>}
            {previous.map(({ comment, reply }) => (
              <div key={comment.id} className="cmt">
                <div className="who">{commentTargetLabel(comment, pfd)}</div>
                <div>{comment.body}</div>
                <div className="hint">{reply ?? "返答なし"}</div>
              </div>
            ))}
          </section>
        )}
        <IntakeHistory detail={detail} />
      </div>
      <PlanDecide
        count={local.comments.length}
        whole={wholeComment(local.comments)}
        canReject={canRejectIntake(local)}
        approving={approving}
        onWhole={(body) => dispatch({ type: "intake.whole", id: detail.id, body })}
        onReject={() => dispatch({ type: "intake.preview", modal: "intake-reject" })}
        onApprove={approve}
      />
      {s.modal === "intake-reject" && (
        <RejectPreview text={text} pending={rejecting} onSend={send} onClose={() => dispatch({ type: "modal.close" })} />
      )}
    </>
  );
}
