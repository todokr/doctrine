import { useState } from "react";
import type { IntakeSummary } from "../../../shared/protocol.ts";
import { sendDecision } from "../decision";
import { INTAKE_STATE, intakeFace, isClosedIntake, issueNumber } from "../intake";
import { intakeDetailOf, selectedIntake } from "../model";
import { useIntakeRpc, useStore } from "../store";
import type { Project } from "../types";
import { AnswerFace } from "./AnswerFace";
import { IntakeProgress, CancelDialog } from "./IntakeProgress";
import { IssuePicker } from "./IssuePicker";
import { PlanReview } from "./PlanReview";

/** 改訂中の帯。面の中身に関係なく、どの面の上にも出す */
export function RevisingBand(p: { intake: IntakeSummary; pending: boolean; onAbandon: () => void }) {
  if (!p.intake.revising) return null;
  return (
    <div className="band">
      改訂中
      <span className="spacer" />
      <button className="btn sm" disabled={p.pending} onClick={p.onAbandon}>改訂をやめる</button>
    </div>
  );
}

export function IntakeHeading(
  { intake, project, onCancel }: { intake: IntakeSummary; project: Project | undefined; onCancel?: () => void },
) {
  const num = issueNumber(intake.issue_url);
  const state = INTAKE_STATE[intake.state];
  return (
    <>
      <div className="crumbs">
        <span>Intake</span>
        <span>/</span>
        <span className="pjdot" style={{ background: project?.color ?? "#666" }} />
        <span>{project?.id ?? ""}</span>
      </div>
      <div className="headrow">
        <h1>
          {num !== null && <span className="num">{`#${num}`}</span>}
          {intake.issue_title}
        </h1>
        <span className={`pill ${state.cls}`}>{state.word}</span>
        <span className="mono hint">{intake.issue_url}</span>
        {onCancel && !isClosedIntake(intake.state) && <button className="btn sm danger" onClick={onCancel}>中止…</button>}
      </div>
    </>
  );
}

/** 状態ごとの面が入る場所。面の中身は別の作業が差し替える */
export function IntakeFacePlaceholder({ intake }: { intake: IntakeSummary }) {
  return (
    <div className="box quiet" data-face={intakeFace(intake.state)}>
      {INTAKE_STATE[intake.state].word}
    </div>
  );
}

export function IntakeView() {
  const { s, dispatch } = useStore();
  const api = useIntakeRpc();
  const [abandoning, setAbandoning] = useState(false);
  const [canceling, setCanceling] = useState(false);
  if (s.intakeSel === "new") return <IssuePicker />;
  if (s.intakeSel === null) {
    return <div className="pad"><p className="hint">左から Intake を選んでください</p></div>;
  }
  const intake = selectedIntake(s);
  if (!intake) {
    const d = intakeDetailOf(s, s.intakeSel);
    return (
      <div className="pad">
        <p className="hint">{d?.kind === "error" ? d.message : "読み込み中"}</p>
      </div>
    );
  }
  const project = s.projects.find((p) => p.daemonId === intake.project_id);
  const detail = intakeDetailOf(s, intake.id);
  const abandon = async () => {
    setAbandoning(true);
    try {
      let next: IntakeSummary | undefined;
      const r = await sendDecision(api.abandonRevision(intake.id).then((v) => {
        next = v;
      }), "改訂をやめられませんでした");
      if (r.ok && next) dispatch({ type: "intake.done", intake: next, toast: "改訂をやめました" });
      else if (!r.ok) dispatch({ type: "toast", message: r.message });
    } finally {
      setAbandoning(false);
    }
  };
  const band = <RevisingBand intake={intake} pending={abandoning} onAbandon={abandon} />;
  if (detail?.kind !== "ok") {
    return (
      <>
        {band}
        <div className="pad">
          <IntakeHeading intake={intake} project={project} />
          <p className="hint">{detail?.kind === "error" ? detail.message : "読み込み中"}</p>
        </div>
      </>
    );
  }
  const heading = (
    <IntakeHeading
      intake={intake}
      project={project}
      onCancel={() => dispatch({ type: "intake.preview", modal: "intake-cancel" })}
    />
  );
  const cancel = async (mode: "leave" | "stop") => {
    setCanceling(true);
    try {
      let next: IntakeSummary | undefined;
      const r = await sendDecision(api.cancel(intake.id, mode).then((v) => {
        next = v;
      }), "中止できませんでした");
      if (r.ok && next) dispatch({ type: "intake.done", intake: next, toast: "中止しました" });
      else if (!r.ok) dispatch({ type: "toast", message: r.message });
    } finally {
      setCanceling(false);
    }
  };
  const dialog = s.modal === "intake-cancel" && (
    <CancelDialog
      approved={detail.value.approval !== null}
      pending={canceling}
      onSend={cancel}
      onClose={() => dispatch({ type: "modal.close" })}
    />
  );
  const face = intakeFace(detail.value.state);
  // 判断の欄は面の外（main の下端）に置くので、レビュー待ちと進行中の面は自分で .pad を持つ。
  // 案が変わったら、選択と prompt のローカルな状態を捨てる
  if (face === "review") {
    return (
      <>
        {band}
        <PlanReview key={detail.value.latest_draft?.id} detail={detail.value} heading={heading} />
        {dialog}
      </>
    );
  }
  if (face === "progress") {
    return (
      <>
        {band}
        <IntakeProgress key={detail.value.approval?.draft_id} detail={detail.value} heading={heading} />
        {dialog}
      </>
    );
  }
  return (
    <>
      {band}
      <div className="pad">
        {heading}
        {face === "questions" ? <AnswerFace detail={detail.value} /> : <IntakeFacePlaceholder intake={detail.value} />}
      </div>
      {dialog}
    </>
  );
}
