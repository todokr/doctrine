import { useState } from "react";
import { buildAnswerText } from "../../../shared/intake/answerText.ts";
import type { IntakeDetail } from "../../../shared/protocol.ts";
import { sendDecision } from "../decision";
import { draftReply, normalizeReply, openQuestionSet } from "../intake";
import { intakeDraftOf } from "../model";
import { useIntakeRpc, useStore } from "../store";
import { IntakeHistory } from "./IntakeHistory";
import { QuestionForm } from "./QuestionForm";

/** 確認のモーダル。props だけで描く */
export function AnswerPreview(p: { text: string; pending: boolean; onSend: () => void; onClose: () => void }) {
  return (
    <>
      <div className="scrim" onClick={p.onClose} />
      <div className="modal" role="dialog" aria-modal="true">
        <h2>回答してエージェントに送る内容</h2>
        <p className="hint">
          回答と仮定への応答を 1 つの文面にまとめて <span className="mono">intake.answer</span> で送ります。
        </p>
        <pre className="block">{p.text}</pre>
        <div className="actions">
          <button className="btn primary" disabled={p.pending} onClick={p.onSend}>送る</button>
          <button className="btn" onClick={p.onClose}>戻る</button>
        </div>
      </div>
    </>
  );
}

/** answering の面。store を読み、intake.answer を呼ぶ */
export function AnswerFace({ detail }: { detail: IntakeDetail }) {
  const { s, dispatch } = useStore();
  const api = useIntakeRpc();
  const [pending, setPending] = useState(false);
  const set = openQuestionSet(detail);
  // 状態の遷移とイベントの間の、一瞬の食い違い
  if (!set) return <p className="hint">質問を読み込み中</p>;

  const reply = draftReply(intakeDraftOf(s, detail.id), set.id);
  // 送る値と文面は、後片付けの dispatch が下書きを消す前に読んでおく
  const normalized = normalizeReply(set, reply);
  const text = buildAnswerText(set, normalized);
  const send = async () => {
    setPending(true);
    try {
      const r = await sendDecision(api.answer(detail.id, set.id, normalized), "回答を送れませんでした");
      if (r.ok) dispatch({ type: "intake.sent", id: detail.id, what: "answer" });
      else dispatch({ type: "toast", message: r.message });
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <QuestionForm
        set={set}
        reply={reply}
        onChange={(next) => dispatch({ type: "intake.answers", id: detail.id, questionSetId: set.id, reply: next })}
        onSubmit={() => dispatch({ type: "intake.preview", modal: "intake-answer" })}
      />
      <IntakeHistory detail={detail} />
      {s.modal === "intake-answer" && (
        <AnswerPreview text={text} pending={pending} onSend={send} onClose={() => dispatch({ type: "modal.close" })} />
      )}
    </>
  );
}
