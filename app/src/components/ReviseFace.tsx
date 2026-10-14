import { useMemo, useState, type ReactNode } from "react";
import type { IntakeDetail } from "../../../shared/protocol.ts";
import { sendDecision } from "../decision";
import { canRejectIntake, commentCounts, commentsOn, processStatuses, wholeComment } from "../intake";
import { intakeDraftOf } from "../model";
import { buildPfdView, frozenIds, pfdElement } from "../pfd";
import { useIntakeRpc, useStore } from "../store";
import { ReviseDecide, useApprovedPfd } from "./IntakeProgress";
import { PfdDiagram } from "./PfdDiagram";
import { PfdElementPanel } from "./PfdElementPanel";
import { StatusCounts } from "./StatusCounts";

/** 改訂に入るモードの面。承認された案の図の、固定でない要素にコメントを付けて改訂を始める */
export function ReviseFace({ detail, heading }: { detail: IntakeDetail; heading: ReactNode }) {
  const { s, dispatch } = useStore();
  const api = useIntakeRpc();
  const [selected, setSelected] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const { pfd, error } = useApprovedPfd(detail);
  const local = intakeDraftOf(s, detail.id);
  const frozen = useMemo(() => (pfd ? frozenIds(pfd, detail.processes) : new Set<string>()), [pfd, detail.processes]);
  const view = useMemo(
    () =>
      pfd
        ? buildPfdView(pfd, { statuses: processStatuses(detail.processes), comments: commentCounts(local.comments), frozen })
        : null,
    [pfd, detail.processes, local.comments, frozen],
  );
  if (!view || !pfd) {
    return <div className="pad">{heading}<p className="hint">{error ?? "承認された案を読み込み中"}</p></div>;
  }

  const info = selected === null ? null : pfdElement(pfd, selected, detail.question_sets);
  const isFrozen = selected !== null && frozen.has(selected);
  const commentKey = isFrozen ? null : selected;
  const start = async () => {
    setPending(true);
    try {
      const r = await sendDecision(api.revise(detail.id, local.comments), "改訂を始められませんでした");
      if (r.ok) dispatch({ type: "intake.sent", id: detail.id, what: "revise" });
      else dispatch({ type: "toast", message: r.message });
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <div className="pad">
        {heading}
        <StatusCounts view={view} />
        <div className="plan-body">
          <PfdDiagram view={view} selected={selected} onSelect={setSelected} />
          <PfdElementPanel
            pfd={pfd}
            info={info}
            onSelect={setSelected}
            frozen={isFrozen}
            prompt={undefined}
            onOpenPrompt={null}
            comments={commentKey === null ? [] : commentsOn(local.comments, commentKey)}
            previous={[]}
            onAddComment={commentKey === null
              ? null
              : (body) => dispatch({ type: "intake.comment.add", id: detail.id, key: commentKey, body })}
            onDeleteComment={commentKey === null
              ? null
              : (index) => dispatch({ type: "intake.comment.delete", id: detail.id, index })}
          />
        </div>
      </div>
      <ReviseDecide
        count={local.comments.length}
        whole={wholeComment(local.comments)}
        canStart={canRejectIntake(local)}
        pending={pending}
        onWhole={(body) => dispatch({ type: "intake.whole", id: detail.id, body })}
        onStart={() => void start()}
        onLeave={() => dispatch({ type: "intake.revise.leave" })}
      />
    </>
  );
}
