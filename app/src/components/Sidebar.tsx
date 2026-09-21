import { GROUPS, countReview, groupOf, sidebarOrder, timeLabel, visibleTasks } from "../model";
import { useNotYet, useStore } from "../store";
import type { Task } from "../types";
import { RateLimit } from "./RateLimit";

const icons = {
  inbox: (
    <svg viewBox="0 0 24 24"><path d="M3 13h5l1.5 3h5L16 13h5" /><path d="M5 5h14l2 8v6H3v-6z" /></svg>
  ),
  done: (
    <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></svg>
  ),
  gear: (
    <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>
  ),
};

export function Rail() {
  const { s, dispatch } = useStore();
  const notYet = useNotYet();
  return (
    <nav className="rail" aria-label="ビュー">
      <button className="ib" title="タスク" aria-pressed={s.view === "tasks"} onClick={() => dispatch({ type: "view", view: "tasks" })}>
        {icons.inbox}
        {countReview(s.tasks) > 0 && <span className="pip" />}
      </button>
      <button className="ib" title="終了したタスク" aria-pressed={s.view === "done"} onClick={() => dispatch({ type: "view", view: "done" })}>
        {icons.done}
      </button>
      <span className="grow" />
      <button className="ib" title="設定" onClick={() => notYet("設定画面はまだありません")}>
        {icons.gear}
      </button>
    </nav>
  );
}

export function StateIcon({ t }: { t: Task }) {
  switch (groupOf(t)) {
    case "review": return <span className="diamond" />;
    case "check": return <span className="bang">!</span>;
    case "running": return <span className="spin" />;
    case "limited": return <span className="hourglass" />;
    case "queued": return <span className="ring" />;
    case "paused": return <span className="pause" />;
    default: return t.state === "completed" ? <span className="check" /> : <span className="xmark" />;
  }
}

function Item({ t }: { t: Task }) {
  const { s, dispatch } = useStore();
  const p = s.projects.find((x) => x.id === t.project);
  return (
    <button className="it" aria-current={s.sel === t.id} onClick={() => dispatch({ type: "select", id: t.id })}>
      <span className="ico"><StateIcon t={t} /></span>
      <span className="t">{t.title}</span>
      <span className="m">
        <span className="pj">
          <span className="pjdot" style={{ background: p?.color ?? "#666" }} />
          {p?.id ?? t.project}
        </span>
        <span className="tm">{timeLabel(t, s.now)}</span>
      </span>
    </button>
  );
}

export function Sidebar() {
  const { s, dispatch } = useStore();
  const notYet = useNotYet();
  const ts = visibleTasks(s.tasks, s.project);
  const isDone = s.view === "done";
  const count = ts.filter((t) => (groupOf(t) === "done") === isDone).length;

  return (
    <aside className="side">
      <div className="side-head">
        <select aria-label="プロジェクトで絞り込む" value={s.project} onChange={(e) => dispatch({ type: "project", project: e.target.value })}>
          <option value="all">{isDone ? "終了したタスク" : "全タスク"}</option>
          {s.projects.map((p) => <option key={p.id} value={p.id}>{p.id}</option>)}
        </select>
        <span className="count">{count}</span>
        <span className="grow" />
        <button className="plus" title="新しいタスク" aria-label="新しいタスク" onClick={() => notYet("タスクの作成はCLI（dctl add）から行います。UIからの作成（コンポーザ）は第2段階です")}>＋</button>
      </div>
      <div className="side-scroll">
        {isDone ? (
          sidebarOrder(s.tasks, "done", s.project).map((t) => <Item key={t.id} t={t} />)
        ) : (
          GROUPS.map((g) => {
            const list = ts.filter((t) => groupOf(t) === g.key).sort(g.sort);
            if (!list.length) return null;
            return (
              <section className="grp" key={g.key}>
                <h3>{g.name} <span className="count">{list.length}</span></h3>
                {list.map((t) => <Item key={t.id} t={t} />)}
              </section>
            );
          })
        )}
        {count === 0 && <p className="hint" style={{ padding: 8 }}>ありません</p>}
      </div>
      <RateLimit />
    </aside>
  );
}
