import { parse } from "yaml";
import { z } from "zod";

/** YAML では `id: 1` と引用符なしで書かれることが多いので、数値も受けて文字列に揃える。 */
const idSchema = z.union([z.string().min(1), z.number()]).transform((v) => String(v));

const artifactSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  given: z.boolean().default(false),
  description: z.string().optional(),
  verify: z.string().optional(),
}).strict();

const processSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  actor: z.enum(["agent", "human"]).default("agent"),
  inputs: z.array(idSchema),
  outputs: z.array(idSchema),
  purpose: z.string().optional(),
  steps: z.string().optional(),
  done_when: z.string().optional(),
}).strict();

const pfdSchema = z.object({
  issue: z.number().int().positive(),
  title: z.string().min(1),
  goal: z.array(idSchema).min(1),
  artifacts: z.array(artifactSchema),
  processes: z.array(processSchema),
}).strict();

export type Artifact = z.infer<typeof artifactSchema>;
export type Process = z.infer<typeof processSchema>;
export type Pfd = z.infer<typeof pfdSchema>;

/** zod の issue（英語）を、このスキーマが実際に出しうる範囲だけ日本語にする。 */
function describeIssue(issue: z.ZodIssue): string {
  switch (issue.code) {
    case z.ZodIssueCode.invalid_type:
      if (issue.received === "undefined") {
        return `必須の項目がありません（${issue.expected} が必要です）`;
      }
      return `型が違います: ${issue.expected} が必要ですが ${issue.received} が書かれています`;
    case z.ZodIssueCode.unrecognized_keys:
      return `知らないキーがあります: ${issue.keys.join(", ")}`;
    case z.ZodIssueCode.too_small:
      if (issue.type === "array") {
        return `要素が足りません（${issue.minimum} 件以上必要です）`;
      }
      if (issue.type === "string") {
        return `空にはできません`;
      }
      if (issue.type === "number") {
        return `${issue.minimum} ${issue.inclusive ? "以上" : "より大きい値"}が必要です`;
      }
      return `形が正しくありません（${issue.code}）`;
    case z.ZodIssueCode.invalid_enum_value:
      return `次のいずれかが必要です: ${issue.options.join(", ")}`;
    case z.ZodIssueCode.invalid_union:
      return `文字列か数値が必要です`;
    default:
      return `形が正しくありません（${issue.code}）`;
  }
}

export function parsePfd(text: string): Pfd {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (err) {
    throw new Error(`PFD を YAML として読めません: ${(err as Error).message}`);
  }
  const result = pfdSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map((i) =>
      `  ${i.path.join(".") || "(全体)"}: ${describeIssue(i)}`
    );
    throw new Error(`PFD の形が正しくありません:\n${lines.join("\n")}`);
  }
  return result.data;
}
