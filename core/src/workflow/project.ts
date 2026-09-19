import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  type CommandStep,
  formatZodIssues,
  type Workflow,
  WorkflowValidationError,
} from "./schema.ts";

export type ProjectConfig = {
  setup?: string;
  defaultWorkflow: string;
  maxConcurrent: number;
  baseBranch: string;
};

const schema = z.object({
  setup: z.string().min(1).optional(),
  defaultWorkflow: z.string().min(1),
  maxConcurrent: z.number().int().min(1).default(1),
  baseBranch: z.string().min(1).default("main"),
}).strict();

export function parseProjectConfig(yamlText: string): ProjectConfig {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (e) {
    throw new WorkflowValidationError([`YAMLとして読めません: ${(e as Error).message}`]);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new WorkflowValidationError(formatZodIssues(parsed.error));
  }
  return parsed.data;
}

/** setup は新しい概念ではなく、ただの command ステップに名前が付いたもの。 */
export function withSetupStep(workflow: Workflow, setup: string | undefined): Workflow {
  if (!setup) return workflow;
  const step: CommandStep = { id: "setup", type: "command", run: setup };
  return { ...workflow, steps: [step, ...workflow.steps] };
}
