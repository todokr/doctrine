import type { IntakeSummary } from "../../../shared/protocol.ts";
import { executionOrder, isExecutionAttention } from "../execution";
import { MODE_WORD, workspaceOfIntake } from "../intake";
import { useStore } from "../store";
import { executionTone } from "../tone";
import type { Workspace } from "../types";
import { RateLimit } from "./RateLimit";
import { IntakeRow, WorkspaceFilterSelect } from "./Sidebar";

export function ExecutionRow(p: {
  intake: IntakeSummary;
  workspace: Workspace | undefined;
  attention: boolean;
  selected: boolean;
  now: number;
  onSelect: () => void;
}) {
  return (
    <IntakeRow
      intake={p.intake}
      workspace={p.workspace}
      tone={executionTone(p.intake, p.attention)}
      selected={p.selected}
      now={p.now}
      onSelect={p.onSelect}
      extra={
        <>
          <span className="tag">{MODE_WORD[p.intake.mode].mark}</span>
          {p.attention && <span className="row-pip" aria-label="あなたの番" />}
        </>
      }
    />
  );
}

export function ExecutionSidebar() {
  const { s, dispatch } = useStore();
  const rows = executionOrder(s.intakes, s.tasks, s.workspace, s.execClosed);
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
      </div>
      <div className="side-head">
        <div className="seg">
          <button aria-pressed={!s.execClosed} onClick={() => dispatch({ type: "execution.closed", closed: false })}>進行中</button>
          <button aria-pressed={s.execClosed} onClick={() => dispatch({ type: "execution.closed", closed: true })}>終了</button>
        </div>
      </div>
      <div className="side-scroll">
        {rows.map((i) => (
          <ExecutionRow
            key={i.id}
            intake={i}
            workspace={workspaceOfIntake(i, s.workspaces)}
            attention={isExecutionAttention(i, s.tasks)}
            selected={s.execSel === i.id}
            now={s.now}
            onSelect={() => dispatch({ type: "execution.select", id: i.id })}
          />
        ))}
        {rows.length === 0 && <p className="hint" style={{ padding: 8 }}>ありません</p>}
      </div>
      <RateLimit />
    </aside>
  );
}
