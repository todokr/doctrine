import type { IntakeSummary } from "../../../shared/protocol.ts";
import { INTAKE_STATE, intakeFace, issueNumber } from "../intake";
import { intakeDetailOf, selectedIntake } from "../model";
import { useStore } from "../store";
import type { Project } from "../types";
import { AnswerFace } from "./AnswerFace";
import { IssuePicker } from "./IssuePicker";
import { PlanReview } from "./PlanReview";

/** 改訂中の帯。面の中身に関係なく、どの面の上にも出す */
export function RevisingBand({ intake }: { intake: IntakeSummary }) {
  if (!intake.revising) return null;
  return <div className="band">改訂中</div>;
}

export function IntakeHeading({ intake, project }: { intake: IntakeSummary; project: Project | undefined }) {
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
  const { s } = useStore();
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
  const heading = <IntakeHeading intake={intake} project={s.projects.find((p) => p.daemonId === intake.project_id)} />;
  const detail = intakeDetailOf(s, intake.id);
  if (detail?.kind !== "ok") {
    return (
      <>
        <RevisingBand intake={intake} />
        <div className="pad">
          {heading}
          <p className="hint">{detail?.kind === "error" ? detail.message : "読み込み中"}</p>
        </div>
      </>
    );
  }
  const face = intakeFace(detail.value.state);
  // 判断の欄は面の外（main の下端）に置くので、レビュー待ちの面は自分で .pad を持つ。
  // 案が変わったら、選択と prompt のローカルな状態を捨てる
  if (face === "review") {
    return (
      <>
        <RevisingBand intake={intake} />
        <PlanReview key={detail.value.latest_draft?.id} detail={detail.value} heading={heading} />
      </>
    );
  }
  return (
    <>
      <RevisingBand intake={intake} />
      <div className="pad">
        {heading}
        {face === "questions" ? <AnswerFace detail={detail.value} /> : <IntakeFacePlaceholder intake={detail.value} />}
      </div>
    </>
  );
}
