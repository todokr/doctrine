import { runStdout } from "./exec.ts";

export type Run = (cmd: string, args: string[], cwd?: string) => Promise<string>;

export interface TaskFact {
  id: string;
  title: string;
  state: string;
  branch: string;
}

export type PrState = "merged" | "open" | "none";

export interface Ports {
  listTasks(projectPath: string): Promise<TaskFact[]>;
  addTask(
    projectPath: string,
    title: string,
    prompt: string,
  ): Promise<{ id: string; branch: string }>;
  prState(projectPath: string, branch: string): Promise<PrState>;
  issue(projectPath: string, issue: number): Promise<{ url: string; title: string }>;
}

function parseJson<T>(stdout: string, label: string): T {
  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new Error(`${label} の出力を JSON として読めません: ${stdout.slice(0, 200)}`);
  }
}

export function realPorts(run: Run = runStdout): Ports {
  return {
    async listTasks(projectPath) {
      const rows = parseJson<(TaskFact & { project_id: number })[]>(
        await run("dctl", ["ls", "--project", projectPath]),
        "dctl ls",
      );
      if (new Set(rows.map((r) => r.project_id)).size > 1) {
        throw new Error(
          `dctl ls --project ${projectPath} がプロジェクトで絞り込まれていません。${projectPath} が dctl project-add に渡したパスと完全に一致しているか確かめてください`,
        );
      }
      return rows.map((r) => ({ id: r.id, title: r.title, state: r.state, branch: r.branch }));
    },
    async addTask(projectPath, title, prompt) {
      const args = ["add", "--project", projectPath, "--title", title, "--prompt", prompt];
      const row = parseJson<{ id: string; branch: string }>(await run("dctl", args), "dctl add");
      return { id: row.id, branch: row.branch };
    },
    async prState(projectPath, branch) {
      const args = ["pr", "list", "--head", branch, "--state", "all", "--json", "state"];
      const rows = parseJson<{ state: string }[]>(await run("gh", args, projectPath), "gh pr list");
      if (rows.some((r) => r.state === "MERGED")) return "merged";
      if (rows.some((r) => r.state === "OPEN")) return "open";
      return "none";
    },
    async issue(projectPath, issue) {
      const args = ["issue", "view", String(issue), "--json", "url,title"];
      const row = parseJson<{ url: string; title: string }>(
        await run("gh", args, projectPath),
        "gh issue view",
      );
      return { url: row.url, title: row.title };
    },
  };
}
