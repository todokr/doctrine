import type { Process } from "./model.ts";
import type { TaskFact } from "./ports.ts";

export function keyOf(issue: number, processId: string): string {
  return `[pfd:${issue}/${processId}]`;
}

export function taskTitle(issue: number, process: Process): string {
  return `${keyOf(issue, process.id)} ${process.name}`;
}

export function findTask(
  tasks: TaskFact[],
  issue: number,
  processId: string,
): TaskFact | undefined {
  const prefix = `${keyOf(issue, processId)} `;
  return tasks.find((t) => t.title.startsWith(prefix));
}
