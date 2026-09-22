import type { TaskDetail } from "../../../shared/protocol.ts";
import { buildRail, type RailNode } from "../rail";
import { RUN_TONE, toneClass } from "../tone";

/**
 * approval のステップは、まだ来ていないうちはアンバーの破線（gate）、止まっているときは
 * awaiting の human で実線になる。済んだ後は success の ok。
 */
const nodeClass = (n: RailNode) =>
  [
    "wf-step",
    toneClass(RUN_TONE[n.status]),
    n.type === "approval" && n.status === "pending" && "gate",
    n.unknown && "unknown",
    n.current && "now",
  ]
    .filter(Boolean)
    .join(" ");

const LEGEND: { tone: Parameters<typeof toneClass>[0]; word: string }[] = [
  { tone: "ok", word: "済み" },
  { tone: "run", word: "実行中" },
  { tone: "danger", word: "失敗・差し戻し" },
  { tone: "human", word: "人の承認" },
  { tone: "idle", word: "未実行" },
];

export function WorkflowRail({ detail, legend }: { detail: TaskDetail; legend: boolean }) {
  const nodes = buildRail(detail.steps, detail.stepRuns, detail.task);
  if (!nodes) return null;
  return (
    <div className="wf">
      <div className="wf-scroll">
        <ol className="wf-steps" aria-label={`ワークフロー: ${nodes.map((n) => n.id).join(" → ")}`}>
          {nodes.map((n) => (
            <li key={n.id} className={nodeClass(n)} aria-current={n.current ? "step" : undefined} title={n.title}>
              <span className="bar" />
              <span className="nm">{n.id}</span>
            </li>
          ))}
        </ol>
      </div>
      {legend && (
        <div className="wf-legend">
          {LEGEND.map((l) => <span key={l.word} className={toneClass(l.tone)}><i aria-hidden="true" />{l.word}</span>)}
        </div>
      )}
    </div>
  );
}
