import { join } from "@std/path";
import type { ProjectRow, TaskRow } from "../db/schema.ts";
import { parseWorkflow, type Workflow } from "./schema.ts";
import { withSetupStep } from "./project.ts";

/** ディスクから読んだワークフロー。text は検証を通った YAML の中身そのまま。 */
export type LoadedWorkflow = { text: string; workflow: Workflow; warnings: string[] };

export type WorkflowLoader = (projectPath: string, name: string) => Promise<LoadedWorkflow>;

export async function loadWorkflowFromDisk(
  projectPath: string,
  name: string,
): Promise<LoadedWorkflow> {
  const path = join(projectPath, ".doctrine", "workflows", `${name}.yaml`);
  const text = await Deno.readTextFile(path).catch(() => {
    throw new Error(`ワークフローがありません: ${path}`);
  });
  const { workflow, warnings } = parseWorkflow(text);
  return { text, workflow, warnings };
}

/** tasks に保存する作成時の定義。 */
export type WorkflowPin = { workflow_yaml: string; workflow_setup: string | null };

export function pinOf(loaded: LoadedWorkflow, project: Pick<ProjectRow, "setup">): WorkflowPin {
  return { workflow_yaml: loaded.text, workflow_setup: project.setup };
}

/**
 * タスクが従うワークフロー（setup を差し込んだ後）。workflow_yaml が非 NULL なら
 * それを唯一の情報源とし、project の今の設定は見ない（pin の意味そのもの）。
 * NULL の行（0011 より前に作られたタスク）だけ load でディスクを読む。
 */
export async function taskWorkflow(
  task: Pick<TaskRow, "workflow_name" | "workflow_yaml" | "workflow_setup">,
  project: Pick<ProjectRow, "path" | "setup">,
  load: WorkflowLoader,
): Promise<Workflow> {
  if (task.workflow_yaml !== null) {
    const { workflow } = parseWorkflow(task.workflow_yaml);
    return withSetupStep(workflow, task.workflow_setup ?? undefined);
  }
  const { workflow } = await load(project.path, task.workflow_name);
  return withSetupStep(workflow, project.setup ?? undefined);
}
