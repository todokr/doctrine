import { Fragment, type ReactNode, useEffect, useState } from "react";
import { canRetry, retryInit } from "../composer";
import { rpc } from "../daemon/client";
import { sendDecision } from "../decision";
import {
  ago,
  bounceNotice,
  canPause,
  canResume,
  clock,
  denialLines,
  elapsed,
  hm,
  isTerminal,
  omittedDenials,
  RUN_WORD,
  stepRunHistory,
  stopReasons,
  type ComposerInit,
} from "../model";
import { useDecide, useNotYet, useStore } from "../store";
import { RUN_TONE, TASK_TONE } from "../tone";
import type { Task, TaskState } from "../types";
import { StatusDot } from "./StatusDot";
import { LogBlock } from "./LogBlock";
import { Crumbs, OpenInEditor } from "./ReviewView";
import { RemoveWorktreeButton } from "./WorktreeView";
import { WorkflowRail } from "./WorkflowRail";

export const STATE_WORD: Record<TaskState, string> = {
  suspended: "レビュー待ち",
  running: "実行中",
  queued: "待ち",
  paused: "一時停止",
  rate_limited: "上限待ち",
  waiting: "マージ待ち",
  failed: "失敗",
  completed: "完了",
  canceled: "中止",
  unknown: "不明な状態",
};

/** 末尾を一度に何行もらうか。task.logs の既定と揃える */
const TAIL = 200;

/**
 * 状態・ステップ・履歴の出どころ。task.list は今のステップしか持たないので、
 * 止まった理由と実行履歴はこちらから出す。
 *
 * タスクの状態やステップが動いたら取り直す。log.line のような流れ続ける
 * イベントでは取り直さない（毎行 task.get を投げることになる）。
 */
export function useTaskDetail(t: Task) {
  const { dispatch } = useStore();
  useEffect(() => {
    let alive = true;
    void rpc("task.get", { task_id: t.id })
      .then((detail) => {
        if (alive) dispatch({ type: "detail", id: t.id, detail });
      })
      // 取れなくても、task.list 由来の状態だけで画面は成り立つ
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [t.id, t.state, t.step, dispatch]);
}

/**
 * ログの末尾と追従。追従は1接続につき1タスクなので、実行中のタスクを離れる
 * ときは必ずやめる。やめないと、見ていないタスクのログが流れ続ける。
 */
function useTaskLogs(t: Task) {
  const { dispatch } = useStore();
  const follow = t.state === "running";
  useEffect(() => {
    let alive = true;
    void rpc("task.logs", { task_id: t.id, tail: TAIL, follow })
      .then((logs) => {
        if (alive) {
          dispatch({
            type: "logs",
            id: t.id,
            logs: { stepRunId: logs.step_run_id, lines: logs.lines },
          });
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
      if (follow) void rpc("task.logs", { task_id: t.id, follow: false }).catch(() => {});
    };
  }, [t.id, follow, dispatch]);
}

/** 送信中の操作。送っている間は一時停止・再開・中止を押せない */
type Pending = "pause" | "resume" | "cancel" | null;

/** worktree の操作（開く・コピー）は children で受け、送信中でも止めない */
export function TaskActions(props: {
  t: Task;
  pending: Pending;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
  children?: ReactNode;
}) {
  const { t, pending } = props;
  return (
    <div className="actions">
      {canPause(t.state) && (
        <button className="btn" disabled={pending !== null} onClick={props.onPause}>一時停止</button>
      )}
      {canResume(t.state) && (
        <button className="btn primary" disabled={pending !== null} onClick={props.onResume}>再開</button>
      )}
      {!isTerminal(t.state) && (
        <button className="btn danger" disabled={pending !== null} onClick={props.onCancel}>中止</button>
      )}
      {props.children}
    </div>
  );
}

/** hook を使わない。押すと init を渡して onOpen を呼ぶ */
export function RetryButton(props: { init: ComposerInit; onOpen: (init: ComposerInit) => void }) {
  return <button className="btn sm" onClick={() => props.onOpen(props.init)}>同じ内容で投入し直す</button>;
}

/** Intake 由来のタスクのやり直し方の案内。Intake の画面を開くボタンを添える */
export function IntakeRetryHint(props: { intakeId: string; onOpenIntake: (id: string) => void }) {
  return (
    <p className="hint">
      Intake から投入したタスクです。やり直すには、Intake の画面の「操作が必要」から「再投入する」を押してください。
      <button className="el-link" onClick={() => props.onOpenIntake(props.intakeId)}>Intake を開く</button>
    </p>
  );
}

export function TaskView({ t }: { t: Task }) {
  const { s, dispatch } = useStore();
  const decide = useDecide();
  const notYet = useNotYet();
  // 送信中だけ止める。失敗したら「中止しました」は出さず、もう一度押せる
  const [pending, setPending] = useState<Pending>(null);
  // 実行履歴で拒否の一覧を開いている行（step_runs.id）
  const [openDenials, setOpenDenials] = useState<number | null>(null);

  useTaskDetail(t);
  useTaskLogs(t);

  // 状態の書き換えは task.stateChanged と取り直しに任せる。ここでは成否のトーストだけ出す
  async function send(
    kind: NonNullable<Pending>,
    request: Promise<unknown>,
    failed: string,
    done: string | null,
    onSent?: () => void,
  ) {
    setPending(kind);
    try {
      const r = await sendDecision(request, failed);
      if (!r.ok) dispatch({ type: "toast", message: r.message });
      else if (onSent) {
        // cancel も「送れたときの後片付け」。task.stateChanged が先に届いて
        // t.state が canceled になっていても、送信自体が成功していればトーストは出す
        onSent();
      } else if (done) dispatch({ type: "toast", message: done });
    } finally {
      setPending(null);
    }
  }

  const openComposer = (init: ComposerInit) => dispatch({ type: "composer.open", init });
  const openIntake = (id: string) => dispatch({ type: "intake.open", id });

  const detail = s.detail[t.id];
  const history = stepRunHistory(detail);
  const log = s.logs[t.id];
  const following = t.state === "running";

  // 今のステップが何回目か。履歴の先頭が今の（または最後の）実行にあたる
  const attempt = history[0]?.attempt ?? 1;
  // t.worktree（DB の worktree_path）と worktree.list の path は文字列として一致するとは
  // 限らない（デーモンは canonical() で比べている）ので、task_id で引く
  const worktreeEntry = s.worktrees.find((e) => e.task_id === t.id);
  const removePath = worktreeEntry?.path ?? t.worktree;
  // 削除拒否は「完了時に未コミットの変更が残っていた」ので、行が見つからなくても true とみなす
  const removeDirty = worktreeEntry?.dirty ?? (t.refused ? true : null);

  return (
    <div className="pad">
      <Crumbs t={t} kind="Task" />
      <h1>{t.title}</h1>
      <div className="headrow">
        <StatusDot tone={TASK_TONE[t.state]} word={STATE_WORD[t.state]} />
        {t.step && (
          <span>
            ステップ <span className="mono">{t.step}</span>
            {attempt > 1 && <span className="hint">（{attempt}回目）</span>}
          </span>
        )}
        <span className="hint">
          {t.state === "running" ? `${elapsed(t.since, s.now)} 経過` : ago(t.since, s.now)}
        </span>
      </div>

      {stopReasons(s.tasks, t, detail).map((r) => {
        if (r.kind === "failed") {
          return (
            <section className="box danger" key="failed">
              {/* worktree を作る前に落ちたタスクはステップが無く、「 で失敗しました」になってしまう */}
              <h2>
                {r.step
                  ? <><span className="mono">{r.step}</span> で失敗しました</>
                  : "実行を開始できませんでした"}
              </h2>
              {t.worktree
                ? (
                  <p>
                    worktree は証拠として残しています。中を確認してから、同じ内容で投入し直すか、削除してください。
                  </p>
                )
                : (
                  <p>
                    worktree は残っていないので、中を見ることはできません。記録だけが残っています。
                  </p>
                )}
              {t.intake && <IntakeRetryHint intakeId={t.intake.id} onOpenIntake={openIntake} />}
              {(canRetry(t) || t.worktree) && (
                <div className="actions">
                  {canRetry(t) && <RetryButton init={retryInit(t, s.projects)} onOpen={openComposer} />}
                  {t.worktree && <RemoveWorktreeButton path={removePath!} dirty={removeDirty} />}
                </div>
              )}
            </section>
          );
        }
        if (r.kind === "refused") {
          return (
            <section className="box danger" key="refused">
              <h2>worktree の削除を拒否しました</h2>
              <p>完了時に未コミットの変更が残っていました。ワークフローの最終ステップがコミットしていない可能性があります。中を確認してから削除してください。</p>
              <RemoveWorktreeButton path={removePath!} dirty={removeDirty} />
            </section>
          );
        }
        return (
          <section className="box quiet" key="queued">
            <p>実行枠が空くのを待っています（行列の {r.position} 番目）。枠が取れた時点で worktree が作られます。</p>
          </section>
        );
      })}
      {t.state === "canceled" && (
        <section className="box quiet">
          <p>{t.worktree ? "中止しました。worktree は残しています。" : "中止しました。worktree は残っていません。"}</p>
          {t.intake
            ? <IntakeRetryHint intakeId={t.intake.id} onOpenIntake={openIntake} />
            : (
              <div className="actions">
                <RetryButton init={retryInit(t, s.projects)} onOpen={openComposer} />
              </div>
            )}
        </section>
      )}
      {t.state === "rate_limited" && (
        <section className="box quiet">
          <p>
            Claude の利用上限に達したので、{t.resumeAt ? `${hm(t.resumeAt)} ` : ""}枠が明けるのを待っています。
            待っている間は他のタスクも始めません。明けたら同じ会話の続きから自動で再開します。
          </p>
        </section>
      )}
      {t.state === "waiting" && (
        <section className="box quiet">
          <p>
            PR のマージを待っています。{t.checkAt ? `次は ${hm(t.checkAt)} に確認します。` : ""}
            ベースブランチと conflict したら、取り込み直して push し直します。
          </p>
        </section>
      )}
      {t.bounce && (
        // 差し戻しは失敗ではない（ワークフローは続いている）ので、赤い見た目は使わない
        <section className="box quiet">
          <h2>{bounceNotice(t.bounce)}</h2>
          <p>ワークフローは続いています。<span className="mono">{t.bounce.goto}</span> からやり直しています。</p>
        </section>
      )}
      {t.state === "paused" && (
        <section className="box quiet"><p>一時停止しています。「再開」を押すと行列の先頭に戻り、実行枠が空いたら続きを実行します。</p></section>
      )}

      <TaskActions
        t={t}
        pending={pending}
        onPause={() => void send("pause", decide.pause(t.id), "一時停止を送れませんでした", "一時停止しました")}
        onResume={() =>
          void send("resume", decide.resume(t.id), "再開を送れませんでした", "再開しました。行列の先頭に戻します")}
        onCancel={() =>
          void send("cancel", decide.cancel(t.id), "中止を送れませんでした", null, () => dispatch({ type: "cancel" }))}
      >
        {t.worktree && (
          <>
            <OpenInEditor />
            <button className="btn sm" onClick={() => notYet("パスのコピーは第2段階です")}>パスをコピー</button>
          </>
        )}
      </TaskActions>
      {t.worktree && <p className="mono hint">{t.worktree}</p>}

      {detail && (
        <div className="blk">
          <div className="headrow"><span className="lbl">Workflow</span><span className="mono hint">{t.wf}</span></div>
          <WorkflowRail detail={detail} legend />
        </div>
      )}

      <div className="headrow">
        <span className="lbl">Log</span>
        <span className="mono hint">
          {history.find((r) => r.id === log?.stepRunId)?.step_id ?? ""}
        </span>
        <span className="spacer" />
        {!following && <span className="hint">末尾 {TAIL} 行</span>}
      </div>
      <LogBlock
        lines={log?.lines}
        resetKey={`${t.id}:${log?.stepRunId}`}
        empty={t.state === "queued"
          ? "まだ1つもステップが走っていません。"
          : "このステップ実行のログは残っていません。"}
      />

      {history.length > 0 && (
        <details className="runs">
          <summary><span className="lbl">History</span> 実行履歴</summary>
          <div className="runtable">
            <table>
              <thead>
                <tr><th>ステップ</th><th>試行</th><th>状態</th><th>開始</th><th>終了</th></tr>
              </thead>
              <tbody>
                {history.map((r) => {
                  const denials = r.permission_denials;
                  const open = denials !== null && openDenials === r.id;
                  return (
                    <Fragment key={r.id}>
                      <tr>
                        <td className="mono">{r.step_id}</td>
                        <td className="mono">#{r.attempt}</td>
                        <td>
                          {denials
                            ? (
                              <button
                                className="st-btn"
                                aria-expanded={open}
                                title="拒否された操作を見る"
                                onClick={() => setOpenDenials(open ? null : r.id)}
                              >
                                <StatusDot tone={RUN_TONE[r.status]} word={RUN_WORD[r.status]} />
                              </button>
                            )
                            : <StatusDot tone={RUN_TONE[r.status]} word={RUN_WORD[r.status]} />}
                        </td>
                        <td className="hint">{clock(Date.parse(r.started_at))}</td>
                        <td className="hint">
                          {r.ended_at ? clock(Date.parse(r.ended_at)) : "—"}
                        </td>
                      </tr>
                      {denials && open && (
                        <tr>
                          <td colSpan={5} className="denials">
                            {denialLines(denials).map((l, i) => (
                              <div key={i} className="denial">
                                <span className="mono">{l.tool}</span>
                                <span className="mono denial-detail">{l.detail}</span>
                              </div>
                            ))}
                            {omittedDenials(denials) > 0 && (
                              <div className="hint">
                                他 {omittedDenials(denials)} 件は保存していません
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}
