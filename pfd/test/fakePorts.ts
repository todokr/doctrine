import type { Ports, PrState, TaskFact } from "../src/ports.ts";

export class FakePorts implements Ports {
  tasks: TaskFact[] = [];
  prs: Record<string, PrState> = {};
  added: { title: string; prompt: string }[] = [];

  listTasks(_projectPath: string): Promise<TaskFact[]> {
    return Promise.resolve([...this.tasks]);
  }

  addTask(_projectPath: string, title: string, prompt: string) {
    const id = `t${this.tasks.length + 1}`;
    const branch = `doctrine/${id}`;
    this.tasks.push({ id, title, state: "queued", branch });
    this.added.push({ title, prompt });
    return Promise.resolve({ id, branch });
  }

  prState(_projectPath: string, branch: string): Promise<PrState> {
    return Promise.resolve(this.prs[branch] ?? "none");
  }

  issue(_projectPath: string, issue: number) {
    return Promise.resolve({
      url: `https://github.com/o/r/issues/${issue}`,
      title: "利用状況の集計を画面に出す",
    });
  }
}
