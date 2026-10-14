import type { IntakeSummary } from "../../../shared/protocol.ts";
import { MODE_WORD } from "../intake";
import { executionTone } from "../tone";
import type { Workspace } from "../types";
import { IntakeRow } from "./Sidebar";

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
