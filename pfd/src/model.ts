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

export function parsePfd(text: string): Pfd {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (err) {
    throw new Error(`PFD を YAML として読めません: ${(err as Error).message}`);
  }
  const result = pfdSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${i.path.join(".") || "(全体)"}: ${i.message}`);
    throw new Error(`PFD の形が正しくありません:\n${lines.join("\n")}`);
  }
  return result.data;
}
