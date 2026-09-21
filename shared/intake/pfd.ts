import { z } from "zod/v4";

const artifactSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  given: z.boolean(),
  decision: z.string().min(1).optional(),
  description: z.string().optional(),
  verify: z.string().optional(),
});

const processSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  actor: z.enum(["agent", "human"]),
  inputs: z.array(z.string().min(1)),
  outputs: z.array(z.string().min(1)),
  purpose: z.string().optional(),
  steps: z.string().optional(),
  done_when: z.string().optional(),
});

export const pfdSchema = z.strictObject({
  title: z.string().min(1),
  goal: z.array(z.string().min(1)).min(1),
  artifacts: z.array(artifactSchema),
  processes: z.array(processSchema),
});

export type Artifact = z.infer<typeof artifactSchema>;
export type Process = z.infer<typeof processSchema>;
export type Pfd = z.infer<typeof pfdSchema>;

export type PfdParse = { ok: true; pfd: Pfd } | { ok: false; issues: string[] };

// 誤りの理由は zod 同梱の日本語ロケールに任せる。z.config() はアプリ側のメッセージまで変えるので使わない
const parseOptions = { error: z.locales.ja().localeError };

/**
 * PFD の形だけを確かめる。例外は投げない。
 * 規則の検証（core の validatePfd）は、回答や改訂の固定集合という外の情報が要るので含まない。
 */
export function parsePfd(input: unknown): PfdParse {
  const parsed = pfdSchema.safeParse(input, parseOptions);
  if (parsed.success) return { ok: true, pfd: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) =>
      `${issue.path.join(".") || "(root)"}: ${issue.message}`
    ),
  };
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const v = (value as Record<string, unknown>)[key];
    if (v !== undefined) out[key] = sortKeys(v);
  }
  return out;
}

/** キーを辞書順に固定し、undefined のキーを落として JSON にする。配列の順は保つ。 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}
