import { z } from "zod/v4";
import { type Guide, guideSchema } from "./schema.ts";

export type GuideValidation =
  | { ok: true; guide: Guide }
  | { ok: false; issues: string[] };

// 誤りの理由は zod 同梱の日本語ロケールに任せる。z.config() はアプリ側のメッセージまで変えるので使わない
const parseOptions = { error: z.locales.ja().localeError };

function formatShapeIssues(issues: z.core.$ZodIssue[]): string[] {
  return issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
}

/**
 * Review Guide を、形と id の整合性の両面から確かめる。例外は投げない。
 * diff との照合（hunk id の実在など）は含まない。
 */
export function validateGuide(input: unknown): GuideValidation {
  const parsed = guideSchema.safeParse(input, parseOptions);
  if (!parsed.success) return { ok: false, issues: formatShapeIssues(parsed.error.issues) };
  return { ok: true, guide: parsed.data };
}
