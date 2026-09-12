import { parse as parseYaml } from "yaml";
import { z } from "zod";

export type Branch = { goto: string; maxAttempts: number; feed?: string };
export type CommandStep = { id: string; type: "command"; run: string; onFailure?: Branch };
export type AgentStep = {
  id: string; type: "agent"; prompt: string;
  permissionMode?: string; model?: string; onFailure?: Branch;
};
export type ApprovalStep = { id: string; type: "approval"; title: string; onReject?: Branch };
export type Step = CommandStep | AgentStep | ApprovalStep;
export type Workflow = { name: string; steps: Step[] };

export const RESERVED_STEP_IDS = ["setup"] as const;

/** 再実行で二重に効く代表的なコマンド。完全には防げないが、黙って壊れるよりよい。 */
const NON_IDEMPOTENT = [
  /\bgh\s+pr\s+create\b/, /\bgh\s+release\s+create\b/,
  /\bgit\s+push\b/, /\bnpm\s+publish\b/, /\bpnpm\s+publish\b/,
];

export class WorkflowValidationError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`ワークフロー定義が不正です:\n- ${issues.join("\n- ")}`);
    this.name = "WorkflowValidationError";
    this.issues = issues;
  }
}

const stepId = z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/, "ステップidは英数字・ハイフン・アンダースコアのみ");
const branch = z.object({
  goto: z.string().min(1),
  maxAttempts: z.number().int().min(1),
  feed: z.string().optional(),
}).strict();

const stepSchema = z.discriminatedUnion("type", [
  z.object({ id: stepId, type: z.literal("command"), run: z.string().min(1), onFailure: branch.optional() }).strict(),
  z.object({
    id: stepId, type: z.literal("agent"), prompt: z.string().min(1),
    permissionMode: z.string().optional(), model: z.string().optional(), onFailure: branch.optional(),
  }).strict(),
  z.object({ id: stepId, type: z.literal("approval"), title: z.string().min(1), onReject: branch.optional() }).strict(),
]);

const workflowSchema = z.object({
  name: z.string().min(1),
  steps: z.array(stepSchema).min(1, "steps は1つ以上必要です"),
}).strict();

/**
 * ステップの「失敗時の分岐」を型を問わず取り出す。
 * approval は onReject、それ以外（command / agent）は onFailure。
 * ワークフローエンジン（後続タスク）も同じアクセサを使う。
 */
export function branchOf(step: Step): Branch | undefined {
  return step.type === "approval" ? step.onReject : step.onFailure;
}

export function parseWorkflow(yamlText: string): { workflow: Workflow; warnings: string[] } {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (e) {
    throw new WorkflowValidationError([`YAMLとして読めません: ${(e as Error).message}`]);
  }

  const parsed = workflowSchema.safeParse(raw);
  if (!parsed.success) {
    throw new WorkflowValidationError(
      parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    );
  }
  const workflow = parsed.data as Workflow;

  const issues: string[] = [];
  const seen = new Set<string>();
  for (const step of workflow.steps) {
    if (seen.has(step.id)) issues.push(`ステップidが重複しています: ${step.id}`);
    seen.add(step.id);
    if ((RESERVED_STEP_IDS as readonly string[]).includes(step.id)) {
      issues.push(`ステップid "${step.id}" は予約語です（project.yaml の setup が自動挿入されます）`);
    }
  }
  for (const step of workflow.steps) {
    const b = branchOf(step);
    if (b && !seen.has(b.goto)) {
      issues.push(`ステップ "${step.id}" の goto が存在しないステップを指しています: ${b.goto}`);
    }
  }
  if (issues.length > 0) throw new WorkflowValidationError(issues);

  const warnings: string[] = [];
  for (const step of workflow.steps) {
    if (step.type !== "command") continue;
    if (NON_IDEMPOTENT.some((re) => re.test(step.run))) {
      warnings.push(
        `ステップ "${step.id}" のコマンドは再実行で二重に効く可能性があります: ${step.run}\n` +
        `  クラッシュ復帰時、command ステップは頭から再実行されます。`,
      );
    }
  }
  return { workflow, warnings };
}
