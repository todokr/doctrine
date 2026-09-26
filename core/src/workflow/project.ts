import { join } from "@std/path";
import { parse as parseYaml, parseDocument } from "yaml";
import { z } from "zod";
import {
  type CommandStep,
  formatZodIssues,
  type Workflow,
  WorkflowValidationError,
} from "./schema.ts";
import type { IssuePhase } from "../../../shared/intake/tracker.ts";
import { writeTextFileAtomic } from "../util/atomicWrite.ts";

/** 段階ごとの Linear の状態の名前。書いた段階は名前で引く。 */
export type LinearStateNames = Partial<Record<IssuePhase, string>>;

/** Issue をどこから取るか。1 つのプロジェクトは 1 つのトラッカーだけを使う。 */
export type TrackerConfig =
  | { kind: "github" }
  | { kind: "linear"; team: string; states?: LinearStateNames };

export type ProjectConfig = {
  setup?: string;
  defaultWorkflow: string;
  maxConcurrent: number;
  baseBranch: string;
  tracker: TrackerConfig;
};

const trackerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("github") }).strict(),
  z.object({
    kind: z.literal("linear"),
    team: z.string().min(1),
    states: z.object({
      todo: z.string().min(1),
      inProgress: z.string().min(1),
      inReview: z.string().min(1),
    }).partial().strict().optional(),
  }).strict(),
]);

const schema = z.object({
  setup: z.string().min(1).optional(),
  defaultWorkflow: z.string().min(1),
  maxConcurrent: z.number().int().min(1).default(1),
  baseBranch: z.string().min(1).default("main"),
  tracker: trackerSchema.default({ kind: "github" }),
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

/** 画面から保存するときの入力。setup が undefined / null / "" ならキーを消す。 */
export type ProjectConfigInput = {
  defaultWorkflow: string;
  maxConcurrent: number;
  baseBranch: string;
  setup?: string | null;
};

/**
 * project.yaml のテキストに値を当て、コメントを保ったまま検証する。ファイルには触らない純粋関数。
 * 検証に通らなければ text にも触らず（呼び出し側が何も書けないよう）投げる。
 */
export function applyProjectConfig(
  yamlText: string,
  input: ProjectConfigInput,
): { text: string; config: ProjectConfig } {
  const doc = parseDocument(yamlText);
  if (doc.errors.length > 0) {
    throw new WorkflowValidationError([
      `YAMLとして読めません: ${doc.errors.map((e) => e.message).join(", ")}`,
    ]);
  }
  doc.set("defaultWorkflow", input.defaultWorkflow);
  doc.set("maxConcurrent", input.maxConcurrent);
  doc.set("baseBranch", input.baseBranch);
  if (input.setup === undefined || input.setup === null || input.setup === "") {
    doc.delete("setup");
  } else {
    doc.set("setup", input.setup);
  }
  const text = doc.toString({ lineWidth: 0 });
  const config = parseProjectConfig(text);
  return { text, config };
}

/** project.yaml を一時ファイル経由で作業ツリーに書く。書き込みか rename に失敗したら一時ファイルを消して投げ直す。 */
export async function writeProjectYaml(projectPath: string, text: string): Promise<void> {
  await writeTextFileAtomic(join(projectPath, ".doctrine", "project.yaml"), text);
}

/** setup は新しい概念ではなく、ただの command ステップに名前が付いたもの。 */
export function withSetupStep(workflow: Workflow, setup: string | undefined): Workflow {
  if (!setup) return workflow;
  const step: CommandStep = { id: "setup", type: "command", run: setup };
  return { ...workflow, steps: [step, ...workflow.steps] };
}
