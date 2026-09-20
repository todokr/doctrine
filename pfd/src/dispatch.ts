import { taskTitle } from "./key.ts";
import type { Pfd } from "./model.ts";
import type { Ports } from "./ports.ts";
import { buildPrompt } from "./prompt.ts";
import { computeStatus, gatherFacts } from "./status.ts";
import { hashOf, readRecord, writeRecord } from "./store.ts";

export interface DispatchInput {
  pfd: Pfd;
  text: string;
  dir: string;
  projectPath: string;
  ports: Ports;
  now: () => string;
}

export interface DispatchResult {
  created: { process_id: string; task_id: string }[];
  adopted: { process_id: string; task_id: string }[];
}

export async function dispatch(input: DispatchInput): Promise<DispatchResult> {
  const { pfd, text, dir, projectPath, ports, now } = input;
  const record = await readRecord(dir);
  if (!record.approved) {
    throw new Error("この PFD は承認されていません（pfd approve を実行してください）");
  }
  if (record.approved.hash !== await hashOf(text)) {
    throw new Error(
      "承認の後に pfd.yaml が書き換えられています（内容を確かめて pfd approve をやり直してください）",
    );
  }

  const statuses = computeStatus(pfd, record, await gatherFacts(pfd, projectPath, ports));
  const result: DispatchResult = { created: [], adopted: [] };

  for (const s of statuses) {
    if (!s.task_id || !s.branch || record.tasks[s.id]) continue;
    record.tasks[s.id] = { task_id: s.task_id, branch: s.branch, at: now() };
    result.adopted.push({ process_id: s.id, task_id: s.task_id });
  }
  if (result.adopted.length > 0) await writeRecord(dir, record);

  const ready = statuses.filter((s) => s.state === "ready");
  if (ready.length === 0) return result;

  const issue = await ports.issue(projectPath, pfd.issue);
  for (const s of ready) {
    const process = pfd.processes.find((p) => p.id === s.id)!;
    const prompt = buildPrompt(pfd, process, record, issue);
    const task = await ports.addTask(projectPath, taskTitle(pfd.issue, process), prompt);
    record.tasks[s.id] = { task_id: task.id, branch: task.branch, at: now() };
    await writeRecord(dir, record);
    result.created.push({ process_id: s.id, task_id: task.id });
  }
  return result;
}
