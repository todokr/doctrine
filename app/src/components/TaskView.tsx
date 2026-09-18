import { ago, elapsed, isTerminal } from "../model";
import { useNotYet, useStore } from "../store";
import type { Task, TaskState } from "../types";
import { Crumbs, OpenInEditor } from "./ReviewView";

const STATE_PILL: Record<TaskState, [string, string]> = {
  suspended: ["レビュー待ち", "p-attn"],
  running: ["実行中", "p-run"],
  queued: ["待ち", "p-muted"],
  paused: ["一時停止", "p-muted"],
  failed: ["失敗", "p-danger"],
  completed: ["完了", "p-ok"],
  canceled: ["中止", "p-muted"],
};

export function TaskView({ t }: { t: Task }) {
  const { s, dispatch } = useStore();
  const notYet = useNotYet();

  const [stateName, stateCls] = STATE_PILL[t.state];
  const queuePos = s.tasks
    .filter((x) => x.state === "queued")
    .sort((a, b) => a.prio - b.prio || a.since - b.since)
    .findIndex((x) => x.id === t.id) + 1;

  return (
    <div className="pad">
      <Crumbs t={t} />
      <h1>{t.title}</h1>
      <div className="headrow">
        <span className={`pill ${stateCls}`}>{stateName}</span>
        {t.step && (
          <span>
            ステップ <span className="mono">{t.step}</span>
          </span>
        )}
        <span className="hint">{t.state === "running" ? `${elapsed(t.since, s.now)} 経過` : ago(t.since, s.now)}</span>
      </div>

      {t.state === "failed" && (
        <section className="box danger">
          <h2><span className="mono">{t.step}</span> で失敗しました</h2>
          <p>
            worktree は証拠として残しています。中を確認してから、<span className="mono">dctl add</span> で同じ内容を投入し直すか、
            <span className="mono">dctl gc {t.id}</span> で片付けてください（UIでの「同じ内容で投入し直す」は第2段階です）。
          </p>
        </section>
      )}
      {t.refused && (
        <section className="box danger">
          <h2>worktree の削除を拒否しました</h2>
          <p>完了時に未コミットの変更が残っていました。ワークフローの最終ステップがコミットしていない可能性があります。中を確認してから <span className="mono">dctl gc {t.id}</span> で削除してください。</p>
        </section>
      )}
      {t.degraded && (
        <section className="box deg">
          <h2><span className="mono">{t.degraded}</span> が、権限で拒否された操作を含んだまま成功扱いで終わりました</h2>
          <p>後続のステップは進んでいますが、エージェントが意図した操作（ここではコミット）はされていません。</p>
        </section>
      )}
      {t.state === "queued" && (
        <section className="box quiet"><p>実行枠が空くのを待っています（行列の {queuePos} 番目）。枠が取れた時点で worktree が作られます。</p></section>
      )}
      {t.state === "paused" && (
        <section className="box quiet"><p><span className="mono">dctl resume {t.id}</span> で再開できます（UIからの一時停止・再開は第2段階です）。</p></section>
      )}

      <div className="actions">
        {!isTerminal(t.state) && <button className="btn danger" onClick={() => dispatch({ type: "cancel" })}>中止</button>}
        {t.worktree && (
          <>
            <OpenInEditor />
            <button className="btn sm" onClick={() => notYet("パスのコピーは第2段階です")}>パスをコピー</button>
          </>
        )}
      </div>
      {t.worktree && <p className="mono hint">{t.worktree}</p>}

      <div className="headrow">
        <b>ログ</b>
        <span className="spacer" />
      </div>
      <div className="box quiet">
        <p>ログの取得と追従はまだありません（<span className="mono">task.logs</span> の follow は #47）。</p>
      </div>
    </div>
  );
}
