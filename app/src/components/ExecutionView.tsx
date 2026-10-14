import type { IntakeProcessView } from "../../../shared/protocol.ts";
import { statusText } from "../intake";
import { PROCESS_TONE } from "../tone";
import { ProcessTrail } from "./IntakeProgress";
import { StatusDot } from "./StatusDot";

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
