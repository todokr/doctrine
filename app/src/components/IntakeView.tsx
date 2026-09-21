import type { IntakeSummary } from "../../../shared/protocol.ts";
import { INTAKE_STATE, intakeFace, issueNumber } from "../intake";
import { intakeDetailOf, selectedIntake } from "../model";
import { useStore } from "../store";
import type { Project } from "../types";
import { IssuePicker } from "./IssuePicker";

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
  return (
    <>
      <RevisingBand intake={intake} />
      <div className="pad">
        <IntakeHeading intake={intake} project={s.projects.find((p) => p.daemonId === intake.project_id)} />
        <IntakeFacePlaceholder intake={intake} />
      </div>
    </>
  );
}
