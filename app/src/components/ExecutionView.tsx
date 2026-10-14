import { useMemo, useState, type ReactNode } from "react";
import { DIRECT_PROCESS_ID } from "../../../shared/intake/processStatus.ts";
import type { IntakeDetail, IntakeProcessView, IntakeSummary } from "../../../shared/protocol.ts";
import { sendDecision } from "../decision";
import { actionNeeded, processStatuses, progressOps, statusText, workspaceOfIntake } from "../intake";
import { intakeDetailOf, intakeDraftOf, intakeRowOf, selectedTask, type Loaded } from "../model";
import { buildPfdView, pfdElement } from "../pfd";
import { useIntakeRpc, useStore } from "../store";
import { PROCESS_TONE } from "../tone";
import { ActionNeeded, CancelDialog, ProcessTrail, ProgressActions, useApprovedPfd, WatchAlert } from "./IntakeProgress";
import { IntakeHistory } from "./IntakeHistory";
import { IntakeHeading } from "./IntakeView";
import { PfdDiagram } from "./PfdDiagram";
import { PfdElementPanel } from "./PfdElementPanel";
import { ReviewView } from "./ReviewView";
import { StatusCounts } from "./StatusCounts";
import { StatusDot } from "./StatusDot";
import { TaskView } from "./TaskView";

/** direct の Issue の欄。図の組み立ては段階 3 なので、ここではプロセス 1 つを箱で出す */
export function DirectProcess(p: {
  title: string;
  view: IntakeProcessView | undefined;
  pending: boolean;
  onRedispatch: () => void;
  onOpenTask: (taskId: string) => void;
}) {
  if (!p.view) return <p className="hint">タスクを読み込み中</p>;
  return (
    <section className="box">
      <div className="headrow">
        <b>{p.title}</b>
        <StatusDot tone={PROCESS_TONE[p.view.state].tone} word={statusText(p.view)} />
      </div>
      <ProcessTrail view={p.view} onOpenTask={p.onOpenTask} showSubIssue={false} />
      {p.view.state === "needs_attention" && (
        <div className="actions">
          <button className="btn" disabled={p.pending} onClick={p.onRedispatch}>再投入する</button>
        </div>
      )}
    </section>
  );
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** スロットの下に、選んでいるタスク（s.sel）がこの Intake のものなら、その画面を出す */
function OpenedTask({ intakeId }: { intakeId: string }) {
  const { s } = useStore();
  const t = selectedTask(s);
  if (!t || t.intake?.id !== intakeId) return null;
  return t.state === "suspended" ? <ReviewView key={t.id} t={t} /> : <TaskView key={t.id} t={t} />;
}

/** RPC を送り、成功したときだけ後片付けをする。失敗はトースト */
function useCall() {
  const { dispatch } = useStore();
  const [pending, setPending] = useState<string | null>(null);
  const call = async <T,>(key: string, send: Promise<T>, failed: string, onOk: (value: T) => void) => {
    setPending(key);
    try {
      let value!: T;
      const r = await sendDecision(send.then((v) => {
        value = v;
      }), failed);
      if (r.ok) onOk(value);
      else dispatch({ type: "toast", message: r.message });
    } finally {
      setPending(null);
    }
  };
  return { pending, call };
}

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

function PlanBody({ detail, heading }: { detail: IntakeDetail; heading: ReactNode }) {
  const { s, dispatch } = useStore();
  const api = useIntakeRpc();
  const { pending, call } = useCall();
  const [selected, setSelected] = useState<string | null>(null);
  const [prompts, setPrompts] = useState<Record<string, Loaded<string>>>({});
  const { pfd, error } = useApprovedPfd(detail);
  const local = intakeDraftOf(s, detail.id);
  const view = useMemo(
    () => (pfd ? buildPfdView(pfd, { statuses: processStatuses(detail.processes) }) : null),
    [pfd, detail.processes],
  );

  const title = detail.state === "completed" ? <h2 className="plan-title">完了しました</h2> : null;
  if (detail.approval === null) {
    // 承認の前に中止した。図は無いので経緯だけ読み返せる
    return <div className="pad">{heading}{title}<IntakeHistory detail={detail} /></div>;
  }
  if (!view || !pfd) {
    return <div className="pad">{heading}{title}<p className="hint">{error ?? "承認された案を読み込み中"}</p></div>;
  }

  const approval = detail.approval;
  const info = selected === null ? null : pfdElement(pfd, selected, detail.question_sets);
  const processId = info?.kind === "process" ? info.process.id : null;
  const processView = processId === null ? undefined : detail.processes.find((p) => p.id === processId);
  const openTask = (id: string) => dispatch({ type: "task.open", id });
  const openPrompt = () => {
    if (processId === null || prompts[processId]) return;
    setPrompts((m) => ({ ...m, [processId]: { kind: "loading" } }));
    api.processPrompt(detail.id, approval.draft_id, processId).then(
      (value) => setPrompts((m) => ({ ...m, [processId]: { kind: "ok", value } })),
      (e) => setPrompts((m) => ({ ...m, [processId]: { kind: "error", message: errorMessage(e) } })),
    );
  };
  const complete = (id: string) => {
    // 送る値は、後片付けの dispatch が下書きを消す前に読んでおく
    const note = local.notes[id] ?? "";
    void call(id, api.completeHumanProcess(detail.id, id, note), "完了を記録できませんでした", (d) => {
      dispatch({ type: "intake.sent", id: detail.id, what: "complete", processId: id });
      dispatch({ type: "intake.fresh", id: detail.id, detail: d });
    });
  };
  const redispatch = (id: string) =>
    void call(id, api.redispatch(detail.id, id), "再投入できませんでした", (d) => {
      dispatch({ type: "intake.fresh", id: detail.id, detail: d });
      dispatch({ type: "toast", message: "再投入しました" });
    });

  return (
    <div className="pad">
      {heading}
      {title}
      <WatchAlert watch={detail.watch} now={s.now} />
      {detail.state !== "canceled" && (
        <ActionNeeded
          pfd={pfd}
          items={actionNeeded(detail, pfd)}
          notes={local.notes}
          pending={pending}
          onNote={(id, text) => dispatch({ type: "intake.note", id: detail.id, processId: id, text })}
          onComplete={complete}
          onRedispatch={redispatch}
          onOpenTask={openTask}
        />
      )}
      <Ops detail={detail} pending={pending !== null} call={call} />
      <StatusCounts view={view} />
      <PfdDiagram view={view} selected={selected} onSelect={setSelected} />
      <div className="exec-panel-slot">
        <PfdElementPanel
          pfd={pfd}
          info={info}
          onSelect={setSelected}
          extra={processView && <ProcessTrail view={processView} onOpenTask={openTask} />}
          prompt={processId === null ? undefined : prompts[processId]}
          onOpenPrompt={openPrompt}
          comments={[]}
          previous={[]}
          onAddComment={null}
          onDeleteComment={null}
        />
        <OpenedTask intakeId={detail.id} />
      </div>
      <IntakeHistory detail={detail} />
    </div>
  );
}

function DirectBody({ detail, heading }: { detail: IntakeDetail; heading: ReactNode }) {
  const { s, dispatch } = useStore();
  const api = useIntakeRpc();
  const { pending, call } = useCall();
  const view = detail.processes.find((p) => p.id === DIRECT_PROCESS_ID);
  const redispatch = () =>
    void call(DIRECT_PROCESS_ID, api.redispatch(detail.id, DIRECT_PROCESS_ID), "再投入できませんでした", (d) => {
      dispatch({ type: "intake.fresh", id: detail.id, detail: d });
      dispatch({ type: "toast", message: "再投入しました" });
    });
  return (
    <div className="pad">
      {heading}
      {detail.state === "completed" && <h2 className="plan-title">完了しました</h2>}
      <WatchAlert watch={detail.watch} now={s.now} />
      <Ops detail={detail} pending={pending !== null} call={call} />
      <div className="exec-panel-slot">
        <DirectProcess
          title={detail.issue_title}
          view={view}
          pending={pending !== null}
          onRedispatch={redispatch}
          onOpenTask={(id) => dispatch({ type: "task.open", id })}
        />
        <OpenedTask intakeId={detail.id} />
      </div>
    </div>
  );
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
        ? <DirectBody detail={d} heading={heading} />
        : <PlanBody key={d.approval?.draft_id} detail={d} heading={heading} />}
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
