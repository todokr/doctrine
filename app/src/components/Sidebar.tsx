import type { ReactNode } from "react";
import type { IntakeSummary } from "../../../shared/protocol.ts";
import {
  INTAKE_SECTIONS,
  INTAKE_WORD,
  countIntakeAttention,
  intakeOrder,
  intakeProgress,
  intakeSection,
  issueNumber,
  workspaceOfIntake,
} from "../intake";
import { countExecutionAttention } from "../execution";
import { ago, hm, parseWorkspaceFilter } from "../model";
import { useStore } from "../store";
import { type Tone, sectionTone, toneClass } from "../tone";
import type { Workspace, WorkspaceFilter } from "../types";
import { ExecutionSidebar } from "./ExecutionSidebar";
import { RateLimit } from "./RateLimit";

const icons = {
  intake: (
    <svg viewBox="0 0 24 24"><rect x="3" y="4" width="6" height="5" rx="1" /><rect x="15" y="15" width="6" height="5" rx="1" /><rect x="15" y="4" width="6" height="5" rx="2.5" /><path d="M9 6.5h6M18 9v6M6 9v8.5h9" /></svg>
  ),
  execution: (
    <svg viewBox="0 0 24 24"><circle cx="6" cy="12" r="3" /><circle cx="18" cy="6" r="3" /><circle cx="18" cy="18" r="3" /><path d="M9 12h3l3-4.5M12 12l3 4.5" /></svg>
  ),
  addWorkspace: (
    <svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M12 10v6M9 13h6" /></svg>
  ),
  gear: (
    <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>
  ),
};

export function Rail() {
  const { s, dispatch } = useStore();
  const attention = countIntakeAttention(s.intakes);
  const execAttention = countExecutionAttention(s.intakes, s.tasks);
  return (
    <nav className="rail" aria-label="ビュー">
      <button className="ib" title={attention > 0 ? `Intake（対応が要るもの ${attention} 件）` : "Intake"} aria-pressed={s.view === "intake"} onClick={() => dispatch({ type: "view", view: "intake" })}>
        {icons.intake}
        {attention > 0 && <span className="pip" />}
      </button>
      <button
        className="ib"
        title={execAttention > 0 ? `Execution（あなたの番 ${execAttention} 件）` : "Execution"}
        aria-pressed={s.view === "execution"}
        onClick={() => dispatch({ type: "view", view: "execution" })}
      >
        {icons.execution}
        {execAttention > 0 && <span className="pip" />}
      </button>
      <span className="grow" />
      <button className="ib" title="workspace を追加" aria-label="workspace を追加" onClick={() => dispatch({ type: "wizard.open" })}>
        {icons.addWorkspace}
      </button>
      <button className="ib" title="設定" aria-pressed={s.view === "settings"} onClick={() => dispatch({ type: "view", view: "settings" })}>
        {icons.gear}
      </button>
    </nav>
  );
}

/** Intake と Execution のサイドバーが共有する workspace の絞り込み */
export function WorkspaceFilterSelect(props: {
  workspaces: Workspace[];
  value: WorkspaceFilter;
  allLabel: string;
  onChange: (workspace: WorkspaceFilter) => void;
}) {
  return (
    <select
      aria-label="workspace で絞り込む"
      value={String(props.value)}
      onChange={(e) => props.onChange(parseWorkspaceFilter(e.target.value))}
    >
      <option value="all">{props.allLabel}</option>
      {props.workspaces.map((w) => <option key={w.id} value={String(w.id)}>{w.name}</option>)}
    </select>
  );
}

function IntakeItem({ i }: { i: IntakeSummary }) {
  const { s, dispatch } = useStore();
  return (
    <IntakeRow
      intake={i}
      workspace={workspaceOfIntake(i, s.workspaces)}
      tone={sectionTone(intakeSection(i), i)}
      selected={s.intakeSel === i.id}
      now={s.now}
      onSelect={() => dispatch({ type: "intake.select", id: i.id })}
    />
  );
}

export function IntakeRow(p: {
  intake: IntakeSummary;
  workspace: Workspace | undefined;
  tone: Tone;
  selected: boolean;
  now: number;
  onSelect: () => void;
  /** 行のメタの末尾に足す印 */
  extra?: ReactNode;
}) {
  const i = p.intake;
  const num = issueNumber(i.issue_url);
  const progress = intakeProgress(i);
  return (
    <button className={`it ${toneClass(p.tone)}`} aria-current={p.selected} onClick={p.onSelect}>
      <span className="t">
        {num !== null && <span className="num">{`#${num}`}</span>}
        {i.issue_title}
      </span>
      <span className="m">
        <span className="pj">
          <span className="pjdot" style={{ background: p.workspace?.color ?? "#666" }} />
          {p.workspace?.name ?? ""}
        </span>
        <span>{INTAKE_WORD[i.state]}</span>
        {progress && <span className="prog">{progress}</span>}
        {i.revising && <span className="tag rev">改訂中</span>}
        {i.rate_limited_until && <span>{`${hm(Date.parse(i.rate_limited_until))} 再開`}</span>}
        {p.extra}
        <span className="tm">{ago(Date.parse(i.updated_at), p.now)}</span>
      </span>
    </button>
  );
}

function IntakeSidebar() {
  const { s, dispatch } = useStore();
  const rows = intakeOrder(s.intakes, s.workspace, s.intakeRevise);
  return (
    <aside className="side">
      <div className="side-head">
        <WorkspaceFilterSelect
          workspaces={s.workspaces}
          value={s.workspace}
          allLabel="すべての workspace"
          onChange={(workspace) => dispatch({ type: "workspace", workspace })}
        />
        <span className="count">{rows.length}</span>
        <span className="grow" />
        <button className="plus" title="Issue を選んで Intake を始める" aria-label="Issue を選んで Intake を始める" aria-pressed={s.intakeSel === "new"} onClick={() => dispatch({ type: "intake.select", id: "new" })}>＋</button>
      </div>
      <div className="side-scroll">
        {INTAKE_SECTIONS.map((sec) => {
          const list = rows.filter((i) => intakeSection(i) === sec.key);
          if (!list.length) return null;
          return (
            <section className="grp" key={sec.key}>
              <h3><span className="lbl">{sec.name}</span> <span className="count">{list.length}</span></h3>
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

function SettingsSidebar() {
  return (
    <aside className="side">
      <div className="side-head">設定</div>
      <RateLimit />
    </aside>
  );
}

export function Sidebar() {
  const { s } = useStore();
  if (s.view === "settings") return <SettingsSidebar />;
  if (s.view === "execution") return <ExecutionSidebar />;
  return <IntakeSidebar />;
}
