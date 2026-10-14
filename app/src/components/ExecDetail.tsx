import { useEffect, useMemo, useState } from "react";
import type { Pfd } from "../../../shared/intake/pfd.ts";
import type { IntakeDetail } from "../../../shared/protocol.ts";
import { clampPanelHeight, panelContentOf, panelStorage, readPanelHeight, writePanelHeight } from "../execution";
import { actionNeeded, isClosedIntake } from "../intake";
import { intakeDraftOf, type Loaded } from "../model";
import { pfdElement, type PfdView } from "../pfd";
import { useIntakeRpc, useRefresh, useStore } from "../store";
import { ExecPanel } from "./ExecPanel";
import { ActionNeeded, ProcessTrail } from "./IntakeProgress";
import { PfdElementPanel } from "./PfdElementPanel";
import { ReviewView } from "./ReviewView";
import { TaskView } from "./TaskView";
import { useCall } from "./useCall";

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 選んだ要素の下のパネル（spec 6.5）。何を出すかは panelContentOf が決め、タスクは s.sel に合わせる */
export function ExecDetail(p: {
  detail: IntakeDetail;
  pfd: Pfd;
  view: PfdView;
  selected: string | null;
  onSelect: (key: string | null) => void;
  maximized: boolean;
  onMaximize: (on: boolean) => void;
  /** Execution の領域の高さ。パネルの上限を決める */
  room: () => number;
}) {
  const { s, dispatch } = useStore();
  const api = useIntakeRpc();
  const refresh = useRefresh();
  const { pending, call } = useCall();
  // 覚えた高さは前の窓の大きさのものなので、いまの領域に収め直す
  const [height, setHeight] = useState(() => clampPanelHeight(readPanelHeight(panelStorage()), p.room()));
  // 初めの描画では親の ref がまだ無く room は窓の高さなので、付いてから領域の高さで収め直す
  useEffect(() => setHeight((h) => clampPanelHeight(h, p.room())), []);
  const [prompts, setPrompts] = useState<Record<string, Loaded<string>>>({});
  const keys = useMemo(() => new Set(p.view.nodes.map((n) => n.key)), [p.view]);

  const content = panelContentOf({ key: p.selected, keys, processes: p.detail.processes, tasks: s.tasks, chosenTaskId: s.sel });
  const taskId = content?.kind === "review" || content?.kind === "task" ? content.taskId : null;
  useEffect(() => {
    if (taskId !== null && s.sel !== taskId) dispatch({ type: "task.open", id: taskId });
  }, [taskId]);

  if (content === null) return null;

  const openTask = (id: string) => dispatch({ type: "task.open", id });
  const local = intakeDraftOf(s, p.detail.id);
  const info = pfdElement(p.pfd, content.key, p.detail.question_sets);
  const processView = info?.kind === "process" ? p.detail.processes.find((x) => x.id === info.process.id) : undefined;
  const trail = processView && <ProcessTrail view={processView} onOpenTask={openTask} showSubIssue={p.detail.mode !== "direct"} />;
  // direct は案を持たないので、プロセスのプロンプトはタスク画面のプロンプトで読む
  const draftId = p.detail.approval?.draft_id ?? null;
  const processId = info?.kind === "process" ? info.process.id : null;

  const complete = (id: string) => {
    // 送る値は、後片付けの dispatch が下書きを消す前に読んでおく
    const note = local.notes[id] ?? "";
    void call(id, api.completeHumanProcess(p.detail.id, id, note), "完了を記録できませんでした", (d) => {
      dispatch({ type: "intake.sent", id: p.detail.id, what: "complete", processId: id });
      dispatch({ type: "intake.fresh", id: p.detail.id, detail: d });
    });
  };
  const redispatch = (id: string) =>
    void call(id, api.redispatch(p.detail.id, id), "再投入できませんでした", (d) => {
      dispatch({ type: "intake.fresh", id: p.detail.id, detail: d });
      dispatch({ type: "toast", message: "再投入しました" });
      // 投入したタスクを次の取り直しを待たずに一覧へ載せる
      void refresh();
    });
  const openPrompt = () => {
    if (processId === null || draftId === null || prompts[processId]) return;
    setPrompts((m) => ({ ...m, [processId]: { kind: "loading" } }));
    api.processPrompt(p.detail.id, draftId, processId).then(
      (value) => setPrompts((m) => ({ ...m, [processId]: { kind: "ok", value } })),
      (e) => setPrompts((m) => ({ ...m, [processId]: { kind: "error", message: errorMessage(e) } })),
    );
  };

  const items = actionNeeded(p.detail, p.pfd);
  const actionsFor = (id: string, what: "yourTurn" | "needsAttention") => (
    <ActionNeeded
      pfd={p.pfd}
      items={{
        yourTurn: what === "yourTurn" ? items.yourTurn.filter((x) => x.process.id === id) : [],
        needsAttention: what === "needsAttention" ? items.needsAttention.filter((x) => x.process.id === id) : [],
      }}
      notes={local.notes}
      pending={pending}
      onNote={(pid, text) => dispatch({ type: "intake.note", id: p.detail.id, processId: pid, text })}
      onComplete={complete}
      onRedispatch={redispatch}
      onOpenTask={openTask}
      readOnly={isClosedIntake(p.detail.state)}
    />
  );
  const element = (
    <PfdElementPanel
      pfd={p.pfd}
      info={info}
      onSelect={p.onSelect}
      extra={trail}
      prompt={processId === null ? undefined : prompts[processId]}
      onOpenPrompt={draftId === null ? null : openPrompt}
      comments={[]}
      previous={[]}
      onAddComment={null}
      onDeleteComment={null}
    />
  );
  const task = taskId === null ? undefined : s.tasks.find((t) => t.id === taskId);

  return (
    <ExecPanel
      height={height}
      maximized={p.maximized}
      title={info?.kind === "artifact" ? info.artifact.name : info?.process.name}
      onResize={(h) => setHeight(clampPanelHeight(h, p.room()))}
      onResizeEnd={(h) => {
        const c = clampPanelHeight(h, p.room());
        setHeight(c);
        writePanelHeight(panelStorage(), c);
      }}
      onMaximize={() => p.onMaximize(!p.maximized)}
      onClose={() => {
        p.onMaximize(false);
        p.onSelect(null);
      }}
    >
      {content.kind === "element" && <div className="pad">{element}</div>}
      {content.kind === "human" && <div className="pad">{actionsFor(content.processId, "yourTurn")}{element}</div>}
      {content.kind === "review" && task && (
        <>
          <div className="exec-trail">{trail}</div>
          <ReviewView key={task.id} t={task} />
        </>
      )}
      {content.kind === "task" && task && (
        <>
          {content.attention && <div className="pad">{actionsFor(content.processId, "needsAttention")}</div>}
          <div className="exec-trail">{trail}</div>
          <TaskView key={task.id} t={task} />
        </>
      )}
    </ExecPanel>
  );
}
