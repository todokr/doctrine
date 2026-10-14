import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { Pfd } from "../../../shared/intake/pfd.ts";
import type { IntakeDetail, IntakeSummary } from "../../../shared/protocol.ts";
import { sendDecision } from "../decision";
import { attentionProcessIds, firstAttentionKey, processKeyOfTask, railsOf } from "../execution";
import { processStatuses, progressOps, workspaceOfIntake } from "../intake";
import { intakeDetailOf, intakeRowOf } from "../model";
import { buildPfdView, directPfd } from "../pfd";
import { useIntakeRpc, useStore } from "../store";
import { ExecDetail } from "./ExecDetail";
import { CancelDialog, ProgressActions, useApprovedPfd, WatchAlert } from "./IntakeProgress";
import { IntakeHistory } from "./IntakeHistory";
import { IntakeHeading } from "./IntakeView";
import { PfdDiagram } from "./PfdDiagram";
import { StatusCounts } from "./StatusCounts";
import { useCall } from "./useCall";

/** Issue 単位の操作。plan と direct の両方が使う */
function Ops({ detail, pending, call }: { detail: IntakeDetail; pending: boolean; call: ReturnType<typeof useCall>["call"] }) {
  const { dispatch } = useStore();
  const api = useIntakeRpc();
  return (
    <ProgressActions
      ops={progressOps(detail)}
      paused={detail.dispatch_paused}
      pending={pending}
      onRefresh={() =>
        void call("*", api.refresh(detail.id), "確認できませんでした", (d) =>
          dispatch({ type: "intake.fresh", id: detail.id, detail: d }))}
      onTogglePause={() => {
        const paused = !detail.dispatch_paused;
        void call("*", api.setDispatchPaused(detail.id, paused), "自動投入を切り替えられませんでした", (intake) =>
          dispatch({ type: "intake.done", intake, toast: paused ? "自動投入を止めました" : "自動投入を再開しました" }));
      }}
      onRevise={() => dispatch({ type: "intake.revise.enter", id: detail.id })}
      onCloseIssue={() =>
        void call("*", api.closeIssue(detail.id), "Issue を閉じられませんでした", (intake) =>
          dispatch({ type: "intake.done", intake, toast: "Issue を閉じました" }))}
    />
  );
}

/** plan と direct の本体。上に見出し・操作・件数・図、下に選んだ要素のパネル（spec 6.2〜6.5） */
function GraphBody(p: { detail: IntakeDetail; pfd: Pfd; heading: ReactNode; history: boolean }) {
  const { s } = useStore();
  const { pending, call } = useCall();
  const execRef = useRef<HTMLDivElement>(null);
  const [maximized, setMaximized] = useState(false);
  const follow = processKeyOfTask(s.tasks, s.sel, p.detail.id);
  const [selected, setSelected] = useState<string | null>(follow);
  // 承認・差し戻しの後の次のレビュー待ちや、ほかから task.open したタスクのノードを選び直す
  useEffect(() => {
    if (follow !== null) setSelected(follow);
  }, [follow]);
  const attention = useMemo(() => attentionProcessIds(p.detail.processes, s.tasks), [p.detail.processes, s.tasks]);
  const view = useMemo(
    () => buildPfdView(p.pfd, { statuses: processStatuses(p.detail.processes), rails: railsOf(p.detail.processes), attention }),
    [p.pfd, p.detail.processes, attention],
  );
  return (
    <div className={maximized ? "exec maximized" : "exec"} ref={execRef}>
      <div className="exec-top pad">
        {p.heading}
        {p.detail.state === "completed" && <h2 className="plan-title">完了しました</h2>}
        <WatchAlert watch={p.detail.watch} now={s.now} />
        <Ops detail={p.detail} pending={pending !== null} call={call} />
        <StatusCounts view={view} attention={{ count: attention.size, onJump: () => setSelected(firstAttentionKey(view)) }} />
        <PfdDiagram view={view} selected={selected} onSelect={setSelected} />
        {p.history && <IntakeHistory detail={p.detail} />}
      </div>
      <ExecDetail
        detail={p.detail}
        pfd={p.pfd}
        view={view}
        selected={selected}
        onSelect={setSelected}
        maximized={maximized}
        onMaximize={setMaximized}
        room={() => execRef.current?.clientHeight ?? window.innerHeight}
      />
    </div>
  );
}

function PlanBody({ detail, heading }: { detail: IntakeDetail; heading: ReactNode }) {
  const { pfd, error } = useApprovedPfd(detail);
  const title = detail.state === "completed" ? <h2 className="plan-title">完了しました</h2> : null;
  if (detail.approval === null) {
    // 承認の前に中止した。図は無いので経緯だけ読み返せる
    return <div className="pad">{heading}{title}<IntakeHistory detail={detail} /></div>;
  }
  if (!pfd) {
    return <div className="pad">{heading}{title}<p className="hint">{error ?? "承認された案を読み込み中"}</p></div>;
  }
  return <GraphBody detail={detail} pfd={pfd} heading={heading} history />;
}

function DirectBody({ detail, heading }: { detail: IntakeDetail; heading: ReactNode }) {
  const pfd = useMemo(() => directPfd(detail.issue_title), [detail.issue_title]);
  return <GraphBody detail={detail} pfd={pfd} heading={heading} history={false} />;
}

export function ExecutionView() {
  const { s, dispatch } = useStore();
  const api = useIntakeRpc();
  const [canceling, setCanceling] = useState(false);
  if (s.execSel === null) {
    return <div className="pad"><p className="hint">左から Issue を選んでください</p></div>;
  }
  const intake: IntakeSummary | null = intakeRowOf(s, s.execSel);
  const detail = intakeDetailOf(s, s.execSel);
  if (!intake) {
    return <div className="pad"><p className="hint">{detail?.kind === "error" ? detail.message : "読み込み中"}</p></div>;
  }
  const workspace = workspaceOfIntake(intake, s.workspaces);
  if (detail?.kind !== "ok") {
    return (
      <div className="pad">
        <IntakeHeading intake={intake} workspace={workspace} label="Execution" />
        <p className="hint">{detail?.kind === "error" ? detail.message : "読み込み中"}</p>
      </div>
    );
  }
  const d = detail.value;
  const heading = (
    <IntakeHeading
      intake={intake}
      workspace={workspace}
      label="Execution"
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
  return (
    <>
      {d.mode === "direct"
        ? <DirectBody key={d.id} detail={d} heading={heading} />
        : <PlanBody key={`${d.id}:${d.approval?.draft_id}`} detail={d} heading={heading} />}
      {s.modal === "intake-cancel" && (
        <CancelDialog
          scope={d.mode === "direct" ? "direct" : d.approval !== null ? "plan" : "none"}
          pending={canceling}
          onSend={cancel}
          onClose={() => dispatch({ type: "modal.close" })}
        />
      )}
    </>
  );
}
