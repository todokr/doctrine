import type { IntakeSummary } from "../../../shared/protocol.ts";
import {
  INTAKE_SECTIONS,
  INTAKE_STATE,
  countIntakeAttention,
  intakeOrder,
  intakeProgress,
  intakeSection,
  issueNumber,
  taskIntakeMark,
} from "../intake";
import { GROUPS, ago, countReview, groupOf, hm, sidebarOrder, staleDaysOf, timeLabel, visibleTasks } from "../model";
import { useNotYet, useStore } from "../store";
import type { Task } from "../types";
import { isStaleWorktree, worktreesNeedAttention } from "../worktrees";
import { RateLimit } from "./RateLimit";

const icons = {
  intake: (
    <svg viewBox="0 0 24 24"><rect x="3" y="4" width="6" height="5" rx="1" /><rect x="15" y="15" width="6" height="5" rx="1" /><rect x="15" y="4" width="6" height="5" rx="2.5" /><path d="M9 6.5h6M18 9v6M6 9v8.5h9" /></svg>
  ),
  inbox: (
    <svg viewBox="0 0 24 24"><path d="M3 13h5l1.5 3h5L16 13h5" /><path d="M5 5h14l2 8v6H3v-6z" /></svg>
  ),
  done: (
    <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></svg>
  ),
  worktree: (
    <svg viewBox="0 0 24 24"><path d="M7 3v12" /><circle cx="7" cy="18" r="3" /><circle cx="7" cy="6" r="3" /><circle cx="17" cy="18" r="3" /><path d="M7 9c0 6 4 6 8 8" /></svg>
  ),
  gear: (
    <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>
  ),
};

export function Rail() {
  const { s, dispatch } = useStore();
  const attention = countIntakeAttention(s.intakes);
  return (
    <nav className="rail" aria-label="ビュー">
      <button className="ib" title={attention > 0 ? `Intake（対応が要るもの ${attention} 件）` : "Intake"} aria-pressed={s.view === "intake"} onClick={() => dispatch({ type: "view", view: "intake" })}>
        {icons.intake}
        {attention > 0 && <span className="pip" />}
      </button>
      <button className="ib" title="タスク" aria-pressed={s.view === "tasks"} onClick={() => dispatch({ type: "view", view: "tasks" })}>
        {icons.inbox}
        {countReview(s.tasks) > 0 && <span className="pip" />}
      </button>
      <button className="ib" title="終了したタスク" aria-pressed={s.view === "done"} onClick={() => dispatch({ type: "view", view: "done" })}>
        {icons.done}
      </button>
      <button
        className="ib"
        title="worktree と警告"
        aria-pressed={s.view === "worktrees"}
        onClick={() => dispatch({ type: "view", view: "worktrees" })}
      >
        {icons.worktree}
        {worktreesNeedAttention(s.worktrees, s.warnings, s.intakes, staleDaysOf(s), s.now) && <span className="pip" />}
      </button>
      <span className="grow" />
      <button className="ib" title="設定" aria-pressed={s.view === "settings"} onClick={() => dispatch({ type: "view", view: "settings" })}>
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
    case "waiting": return <span className="hourglass" />;
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
        {t.intake && <span className="tag">{taskIntakeMark(t.intake)}</span>}
        <span className="tm">{timeLabel(t, s.now)}</span>
      </span>
    </button>
  );
}

function IntakeIcon({ i }: { i: IntakeSummary }) {
  switch (intakeSection(i)) {
    case "attention": return i.state === "needs_attention" ? <span className="bang">!</span> : <span className="diamond" />;
    case "working": return i.rate_limited_until ? <span className="hourglass" /> : <span className="spin" />;
    case "active": return <span className="ring" />;
    case "closed": return i.state === "completed" ? <span className="check" /> : <span className="xmark" />;
  }
}

function IntakeItem({ i }: { i: IntakeSummary }) {
  const { s, dispatch } = useStore();
  const p = s.projects.find((x) => x.daemonId === i.project_id);
  const num = issueNumber(i.issue_url);
  const state = INTAKE_STATE[i.state];
  const progress = intakeProgress(i);
  return (
    <button className="it" aria-current={s.intakeSel === i.id} onClick={() => dispatch({ type: "intake.select", id: i.id })}>
      <span className="ico"><IntakeIcon i={i} /></span>
      <span className="t">
        {num !== null && <span className="num">{`#${num}`}</span>}
        {i.issue_title}
      </span>
      <span className="m">
        <span className="pjdot" style={{ background: p?.color ?? "#666" }} />
        <span className={`pill ${state.cls}`} style={{ lineHeight: "16px", fontSize: "10.5px" }}>{state.word}</span>
        {progress && <span className="prog">{progress}</span>}
        {i.revising && <span className="tag rev">改訂中</span>}
        {i.rate_limited_until && <span>{`${hm(Date.parse(i.rate_limited_until))} 再開`}</span>}
        <span className="tm">{ago(Date.parse(i.updated_at), s.now)}</span>
      </span>
    </button>
  );
}

function IntakeSidebar() {
  const { s, dispatch } = useStore();
  const rows = intakeOrder(s.intakes, s.projects, s.project, s.showClosedIntakes);
  return (
    <aside className="side">
      <div className="side-head">
        <select aria-label="プロジェクトで絞り込む" value={s.project} onChange={(e) => dispatch({ type: "project", project: e.target.value })}>
          <option value="all">すべてのプロジェクト</option>
          {s.projects.map((p) => <option key={p.id} value={p.id}>{p.id}</option>)}
        </select>
        <span className="count">{rows.length}</span>
        <span className="grow" />
        <button className="plus" title="Issue を選んで Intake を始める" aria-label="Issue を選んで Intake を始める" aria-pressed={s.intakeSel === "new"} onClick={() => dispatch({ type: "intake.select", id: "new" })}>＋</button>
      </div>
      <div className="side-head">
        <div className="seg">
          <button aria-pressed={!s.showClosedIntakes} onClick={() => dispatch({ type: "intake.showClosed", show: false })}>進行中</button>
          <button aria-pressed={s.showClosedIntakes} onClick={() => dispatch({ type: "intake.showClosed", show: true })}>すべて</button>
        </div>
      </div>
      <div className="side-scroll">
        {INTAKE_SECTIONS.map((sec) => {
          const list = rows.filter((i) => intakeSection(i) === sec.key);
          if (!list.length) return null;
          return (
            <section className="grp" key={sec.key}>
              <h3>{sec.name} <span className="count">{list.length}</span></h3>
              {list.map((i) => <IntakeItem key={i.id} i={i} />)}
            </section>
          );
        })}
        {rows.length === 0 && <p className="hint" style={{ padding: 8 }}>ありません</p>}
      </div>
      <RateLimit />
    </aside>
  );
}

function WorktreeSidebar() {
  const { s, dispatch } = useStore();
  const staleCount = s.worktrees.filter((e) => isStaleWorktree(e, s.intakes, staleDaysOf(s), s.now)).length;
  return (
    <aside className="side">
      <div className="side-head">
        <select aria-label="プロジェクトで絞り込む" value={s.project} onChange={(e) => dispatch({ type: "project", project: e.target.value })}>
          <option value="all">すべてのプロジェクト</option>
          {s.projects.map((p) => <option key={p.id} value={p.id}>{p.id}</option>)}
        </select>
      </div>
      <div className="side-scroll">
        <p className="hint" style={{ padding: 8 }}>古い worktree {staleCount} 件・警告 {s.warnings.length} 件</p>
      </div>
      <RateLimit />
    </aside>
  );
}

function SettingsSidebar() {
  return (
    <aside className="side">
      <div className="side-head">設定</div>
      <RateLimit />
    </aside>
  );
}

export function Sidebar() {
  const { s, dispatch } = useStore();
  const notYet = useNotYet();
  if (s.view === "worktrees") return <WorktreeSidebar />;
  if (s.view === "intake") return <IntakeSidebar />;
  if (s.view === "settings") return <SettingsSidebar />;
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
