import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { Pfd } from "../../../shared/intake/pfd.ts";
import type { IntakeDetail, IntakeProcessView, PfdDraft, WatchHealth } from "../../../shared/protocol.ts";
import { sendDecision } from "../decision";
import {
  actionNeeded,
  canCompleteHuman,
  canRejectIntake,
  commentCounts,
  commentsOn,
  PR_STATE,
  processStatuses,
  processTrail,
  progressOps,
  statusText,
  watchAlert,
  wholeComment,
  type ProgressOps,
} from "../intake";
import { ago, clock, intakeDraftOf, type Loaded } from "../model";
import { buildPfdView, frozenIds, pfdElement } from "../pfd";
import { useIntakeRpc, useStore } from "../store";
import { IntakeHistory } from "./IntakeHistory";
import { PfdDiagram } from "./PfdDiagram";
import { PfdElementPanel } from "./PfdElementPanel";
import { Markdown } from "./text";

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 「操作が必要」の欄（8.1）。props だけで描く */
export function ActionNeeded(p: {
  pfd: Pfd;
  items: ReturnType<typeof actionNeeded>;
  notes: Record<string, string>;
  /** 送信中のプロセス id */
  pending: string | null;
  onNote: (processId: string, text: string) => void;
  onComplete: (processId: string) => void;
  onRedispatch: (processId: string) => void;
  onOpenTask: (taskId: string) => void;
}) {
  const { yourTurn, needsAttention } = p.items;
  if (yourTurn.length === 0 && needsAttention.length === 0) return null;
  return (
    <section className="box attn">
      <h2>操作が必要</h2>
      {yourTurn.map(({ process }) => {
        const note = p.notes[process.id] ?? "";
        return (
          <div key={process.id} className="need">
            <div className="headrow">
              <b>{process.name}</b>
              <span className="pill p-attn">あなたの番</span>
            </div>
            {process.purpose && <Markdown src={process.purpose} />}
            {process.done_when && <Markdown src={process.done_when} />}
            <textarea
              placeholder="決めた内容"
              aria-label="決めた内容"
              value={note}
              onChange={(e) => p.onNote(process.id, e.target.value)}
            />
            <div className="actions">
              <button
                className="btn primary"
                disabled={!canCompleteHuman(note) || p.pending === process.id}
                onClick={() => p.onComplete(process.id)}
              >
                完了を記録する
              </button>
            </div>
          </div>
        );
      })}
      {needsAttention.map(({ process, view }) => (
        <div key={process.id} className="need">
          <div className="headrow">
            <b>{process.name}</b>
            <span className="pill p-danger">{statusText(view)}</span>
            <button className="el-link mono" onClick={() => p.onOpenTask(view.taskId)}>{view.taskId}</button>
          </div>
          <div className="actions">
            <button className="btn" disabled={p.pending === process.id} onClick={() => p.onRedispatch(process.id)}>
              再投入する
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}

/** 見張りの失敗（8.3）。props だけで描く */
export function WatchAlert({ watch, now }: { watch: WatchHealth; now: number }) {
  const text = watchAlert(watch);
  if (text === null) return null;
  const at = watch.lastSucceededAt === null ? null : Date.parse(watch.lastSucceededAt);
  return (
    <section className="box danger">
      <p>{text}</p>
      {watch.lastError && <p className="mono">{watch.lastError}</p>}
      {at !== null && <p className="hint">{`最後に成功: ${clock(at)}（${ago(at, now)}）`}</p>}
    </section>
  );
}

function Sec({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="el-sec">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

/** プロセスの欄に足す 4 つの欄（8.2）。props だけで描く */
export function ProcessTrail({ view, onOpenTask }: { view: IntakeProcessView; onOpenTask: (taskId: string) => void }) {
  const { subIssueUrl, taskIds, pr } = processTrail(view);
  return (
    <>
      <Sec title="状態">
        <span>{statusText(view)}</span>
        {view.state === "done" && <Markdown src={view.note} />}
      </Sec>
      <Sec title="sub-issue">
        {subIssueUrl === null ? <span className="hint">まだありません</span> : <span className="mono">{subIssueUrl}</span>}
      </Sec>
      <Sec title="タスク">
        {taskIds.length === 0
          ? <span className="hint">なし</span>
          : (
            <div className="el-links">
              {taskIds.map((id, i) => (
                <span key={id}>
                  {i === 0 && <span className="tag">今</span>}
                  <button className="el-link mono" onClick={() => onOpenTask(id)}>{id}</button>
                </span>
              ))}
            </div>
          )}
      </Sec>
      <Sec title="PR">
        {pr === null
          ? <span className="hint">なし</span>
          : (
            <>
              <span>{`#${pr.number} ${PR_STATE[pr.state]}`}</span>
              <span className="mono">{pr.url}</span>
            </>
          )}
      </Sec>
    </>
  );
}

/** 操作の並び（8.4）。中止は見出しにあるのでここには置かない */
export function ProgressActions(p: {
  ops: ProgressOps;
  paused: boolean;
  pending: boolean;
  onRefresh: () => void;
  onTogglePause: () => void;
  onRevise: () => void;
  onCloseIssue: () => void;
}) {
  const { ops } = p;
  if (!ops.refresh && !ops.pause && !ops.revise && !ops.closeIssue) return null;
  return (
    <div className="actions">
      {ops.refresh && <button className="btn" disabled={p.pending} onClick={p.onRefresh}>いま確認する</button>}
      {ops.pause && (
        <button className="btn" disabled={p.pending} onClick={p.onTogglePause}>
          {p.paused ? "自動投入を再開" : "自動投入を一時停止"}
        </button>
      )}
      {ops.revise && <button className="btn" disabled={p.pending} onClick={p.onRevise}>改訂に入る…</button>}
      {ops.closeIssue && <button className="btn primary" disabled={p.pending} onClick={p.onCloseIssue}>Issue を閉じる</button>}
    </div>
  );
}

/** 改訂に入るモードの下端の欄。PlanDecide と同じ位置・同じ作り */
export function ReviseDecide(p: {
  count: number;
  whole: string;
  canStart: boolean;
  pending: boolean;
  onWhole: (body: string) => void;
  onStart: () => void;
  onLeave: () => void;
}) {
  return (
    <footer className="decide">
      <div>
        <div className="meta"><span>コメント <b>{p.count}</b> 件</span></div>
        <textarea
          placeholder="計画全体へのコメント（改訂の依頼に要素へのコメントと一緒に送ります）"
          value={p.whole}
          onChange={(e) => p.onWhole(e.target.value)}
        />
      </div>
      <div className="actions">
        <button className="btn" onClick={p.onLeave}>やめる</button>
        <button className="btn primary" disabled={!p.canStart || p.pending} onClick={p.onStart}>改訂を始める</button>
      </div>
    </footer>
  );
}

/** 中止の確認（8.6）。承認済みなら leave / stop を選ばせ、承認前は選択肢を出さない */
export function CancelDialog(p: {
  /** detail.approval !== null。改訂中も true */
  approved: boolean;
  pending: boolean;
  onSend: (mode: "leave" | "stop") => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<"leave" | "stop">("leave");
  return (
    <>
      <div className="scrim" onClick={p.onClose} />
      <div className="modal" role="dialog" aria-modal="true">
        <h2>Intake を中止する</h2>
        {p.approved && (
          <>
            <label>
              <input type="radio" name="cancel-mode" checked={mode === "leave"} onChange={() => setMode("leave")} />
              そのままにする
            </label>
            <label>
              <input type="radio" name="cancel-mode" checked={mode === "stop"} onChange={() => setMode("stop")} />
              タスクを止め、sub-issue を取りやめとして閉じる
            </label>
          </>
        )}
        <div className="actions">
          <button className="btn danger" disabled={p.pending} onClick={() => p.onSend(p.approved ? mode : "leave")}>
            中止する
          </button>
          <button className="btn" onClick={p.onClose}>戻る</button>
        </div>
      </div>
    </>
  );
}

/** active / completed / canceled の面。store を読み、承認済みの案の図を進み具合で塗る */
export function IntakeProgress({ detail, heading }: { detail: IntakeDetail; heading: ReactNode }) {
  const { s, dispatch } = useStore();
  const api = useIntakeRpc();
  const [selected, setSelected] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [prompts, setPrompts] = useState<Record<string, Loaded<string>>>({});
  const [fetched, setFetched] = useState<Loaded<PfdDraft> | null>(null);

  const { approval } = detail;
  // 進行中の面の図は承認された案。最新の案が承認された案と違うときは取りに行く
  const inLatest = approval !== null && detail.latest_draft?.id === approval.draft_id;
  const approvedId = approval?.draft_id ?? null;
  useEffect(() => {
    if (approvedId === null || inLatest) return;
    let alive = true;
    setFetched({ kind: "loading" });
    api.draft(detail.id, approvedId).then(
      (value) => alive && setFetched({ kind: "ok", value }),
      (e) => alive && setFetched({ kind: "error", message: errorMessage(e) }),
    );
    return () => {
      alive = false;
    };
  }, [detail.id, approvedId, inLatest]);

  const pfd = inLatest ? detail.latest_draft!.pfd : fetched?.kind === "ok" ? fetched.value.pfd : null;
  const mode = s.intakeRevise === detail.id && detail.state === "active" && !detail.revising ? "revise" : "view";
  const local = intakeDraftOf(s, detail.id);
  const frozen = useMemo(() => (pfd ? frozenIds(pfd, detail.processes) : new Set<string>()), [pfd, detail.processes]);
  const view = useMemo(
    () =>
      pfd
        ? buildPfdView(pfd, {
          statuses: processStatuses(detail.processes),
          comments: mode === "revise" ? commentCounts(local.comments) : undefined,
          frozen: mode === "revise" ? frozen : undefined,
        })
        : null,
    [pfd, detail.processes, mode, local.comments, frozen],
  );

  const title = detail.state === "completed" ? <h2 className="plan-title">完了しました</h2> : null;
  if (approval === null) {
    // 承認の前に中止した。図は無いので経緯だけ読み返せる
    return <div className="pad">{heading}{title}<IntakeHistory detail={detail} /></div>;
  }
  if (!view || !pfd) {
    const hint = fetched?.kind === "error" ? fetched.message : "承認された案を読み込み中";
    return <div className="pad">{heading}{title}<p className="hint">{hint}</p></div>;
  }

  // どの操作も、成功したときだけ後片付けをする（失敗は下書きを残してトーストだけ）
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

  const info = selected === null ? null : pfdElement(pfd, selected, detail.question_sets);
  const processId = info?.kind === "process" ? info.process.id : null;
  const processView = processId === null ? undefined : detail.processes.find((p) => p.id === processId);
  const isFrozen = mode === "revise" && selected !== null && frozen.has(selected);
  // 改訂に入るモードで、固定でない要素を選んでいるときだけコメントできる
  const commentKey = mode === "revise" && !isFrozen ? selected : null;

  const openPrompt = () => {
    if (processId === null || prompts[processId]) return;
    setPrompts((m) => ({ ...m, [processId]: { kind: "loading" } }));
    api.processPrompt(detail.id, approval.draft_id, processId).then(
      (value) => setPrompts((m) => ({ ...m, [processId]: { kind: "ok", value } })),
      (e) => setPrompts((m) => ({ ...m, [processId]: { kind: "error", message: errorMessage(e) } })),
    );
  };

  const openTask = (id: string) => dispatch({ type: "task.open", id });
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
  const refresh = () =>
    void call("*", api.refresh(detail.id), "確認できませんでした", (d) =>
      dispatch({ type: "intake.fresh", id: detail.id, detail: d }));
  const togglePause = () => {
    const paused = !detail.dispatch_paused;
    void call("*", api.setDispatchPaused(detail.id, paused), "自動投入を切り替えられませんでした", (intake) =>
      dispatch({ type: "intake.done", intake, toast: paused ? "自動投入を止めました" : "自動投入を再開しました" }));
  };
  const closeIssue = () =>
    void call("*", api.closeIssue(detail.id), "Issue を閉じられませんでした", (intake) =>
      dispatch({ type: "intake.done", intake, toast: "Issue を閉じました" }));
  const startRevision = () =>
    void call("*", api.revise(detail.id, local.comments), "改訂を始められませんでした", () =>
      dispatch({ type: "intake.sent", id: detail.id, what: "revise" }));

  return (
    <>
      <div className="pad">
        {heading}
        {title}
        <WatchAlert watch={detail.watch} now={s.now} />
        {detail.state !== "canceled" && mode !== "revise" && (
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
        <ProgressActions
          ops={progressOps(detail)}
          paused={detail.dispatch_paused}
          pending={pending !== null}
          onRefresh={refresh}
          onTogglePause={togglePause}
          onRevise={() => {
            dispatch({ type: "intake.revise.enter", id: detail.id });
            setSelected(null);
          }}
          onCloseIssue={closeIssue}
        />
        <div className="plan-body">
          <PfdDiagram view={view} selected={selected} onSelect={setSelected} />
          <PfdElementPanel
            pfd={pfd}
            info={info}
            onSelect={setSelected}
            extra={processView && <ProcessTrail view={processView} onOpenTask={openTask} />}
            frozen={isFrozen}
            prompt={processId === null ? undefined : prompts[processId]}
            onOpenPrompt={openPrompt}
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
        <IntakeHistory detail={detail} />
      </div>
      {mode === "revise" && (
        <ReviseDecide
          count={local.comments.length}
          whole={wholeComment(local.comments)}
          canStart={canRejectIntake(local)}
          pending={pending !== null}
          onWhole={(body) => dispatch({ type: "intake.whole", id: detail.id, body })}
          onStart={startRevision}
          onLeave={() => dispatch({ type: "intake.revise.leave" })}
        />
      )}
    </>
  );
}
