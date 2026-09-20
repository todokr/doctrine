import { findTask } from "./key.ts";
import type { Pfd, Process } from "./model.ts";
import type { Ports, PrState, TaskFact } from "./ports.ts";
import type { DispatchRecord } from "./store.ts";

export interface Facts {
  tasks: TaskFact[];
  prs: Record<string, PrState>;
}

export type ProcessState =
  | "done"
  | "your_turn"
  | "merged"
  | "pr_open"
  | "no_pr"
  | "task_stopped"
  | "lost"
  | "running"
  | "ready"
  | "waiting";

export interface ProcessStatus {
  id: string;
  name: string;
  actor: "agent" | "human";
  state: ProcessState;
  task_id?: string;
  branch?: string;
  waiting_for: string[];
}

/** 入力が揃っているかを見ずに決まる状態。決まらなければ undefined。 */
function settledState(
  p: Process,
  task: TaskFact | undefined,
  record: DispatchRecord,
  facts: Facts,
): ProcessState | undefined {
  if (p.actor === "human") return record.done[p.id] ? "done" : undefined;
  if (!task) return record.tasks[p.id] ? "lost" : undefined;
  const pr = facts.prs[task.branch] ?? "none";
  if (pr === "merged") return "merged";
  if (pr === "open") return "pr_open";
  if (task.state === "completed") return "no_pr";
  if (task.state === "failed" || task.state === "canceled") return "task_stopped";
  return "running";
}

export function computeStatus(pfd: Pfd, record: DispatchRecord, facts: Facts): ProcessStatus[] {
  const tasks = new Map(pfd.processes.map((p) => [p.id, findTask(facts.tasks, pfd.issue, p.id)]));
  const settled = new Map(
    pfd.processes.map((p) => [p.id, settledState(p, tasks.get(p.id), record, facts)]),
  );

  const ready = new Set(pfd.artifacts.filter((a) => a.given).map((a) => a.id));
  for (const p of pfd.processes) {
    const s = settled.get(p.id);
    if (s === "done" || s === "merged") p.outputs.forEach((o) => ready.add(o));
  }
  const nameOf = new Map(pfd.artifacts.map((a) => [a.id, a.name]));

  return pfd.processes.map((p) => {
    const task = tasks.get(p.id);
    const missing = p.inputs.filter((i) => !ready.has(i));
    const open: ProcessState = missing.length > 0
      ? "waiting"
      : p.actor === "human"
      ? "your_turn"
      : "ready";
    const state = settled.get(p.id) ?? open;
    const recorded = state === "lost" ? record.tasks[p.id] : undefined;
    return {
      id: p.id,
      name: p.name,
      actor: p.actor,
      state,
      task_id: recorded?.task_id ?? task?.id,
      branch: recorded?.branch ?? task?.branch,
      waiting_for: state === "waiting" ? missing.map((i) => nameOf.get(i) ?? i) : [],
    };
  });
}

export async function gatherFacts(pfd: Pfd, projectPath: string, ports: Ports): Promise<Facts> {
  const tasks = await ports.listTasks(projectPath);
  const prs: Record<string, PrState> = {};
  for (const p of pfd.processes) {
    const task = findTask(tasks, pfd.issue, p.id);
    if (task) prs[task.branch] = await ports.prState(projectPath, task.branch);
  }
  return { tasks, prs };
}
