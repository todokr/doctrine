// task.get の steps / stepRuns / current_step_id を、ワークフローの帯が描くノードの列にする。
// 副作用を持たない（テストは rail.test.ts）
import type { StepRun, StepView, TaskSummary } from "../../shared/protocol.ts";

/** 「まだ実行していない」は step_runs に対応する値が無いので、ここで足す。 */
export type RailStatus = StepRun["status"] | "pending";

export type RailNode = {
  id: string;
  /** steps に無く末尾に生やしたノードは種別が分からないので null。 */
  type: StepView["type"] | null;
  /** approval だけが持つ。ツールチップに出す。 */
  title?: string;
  status: RailStatus;
  /** current_step_id と一致するステップ。 */
  current: boolean;
  /** steps に無い step_id / current_step_id を末尾に生やしたノード。 */
  unknown: boolean;
};

/**
 * steps が null（ワークフロー YAML が読めない）なら null。帯は描かない。
 *
 * steps に無い step_id（YAML が編集されて列がずれた）は、stepRuns にあるものも
 * current_step_id も末尾に生やす。黙って落とすと、いま止まっているステップが帯から消える。
 */
export function buildRail(
  steps: StepView[] | null,
  stepRuns: StepRun[],
  task: Pick<TaskSummary, "current_step_id">,
): RailNode[] | null {
  if (steps === null) return null;

  const known = new Set(steps.map((s) => s.id));
  const extra: string[] = [];
  for (const id of [...stepRuns.map((r) => r.step_id), task.current_step_id]) {
    if (id !== null && !known.has(id)) {
      known.add(id);
      extra.push(id);
    }
  }

  // stepRuns は id の昇順で届くので、step_id ごとに後から上書きしたものが最後の run。
  const lastOf = new Map<string, StepRun>();
  for (const r of stepRuns) lastOf.set(r.step_id, r);

  return [
    ...steps.map((s) => ({ id: s.id, type: s.type, title: s.title, unknown: false })),
    ...extra.map((id) => ({ id, type: null, title: undefined, unknown: true })),
  ].map(({ title, ...n }) => ({
    ...n,
    ...(title !== undefined && { title }),
    status: lastOf.get(n.id)?.status ?? "pending",
    current: n.id === task.current_step_id,
  }));
}
