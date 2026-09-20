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

const idSections = ["decisions", "risks", "tests", "diagrams"] as const;

// id の重複と参照先の実在を確かめる。形は通っている前提。id の空間は節ごと
function checkIntegrity(guide: Guide): string[] {
  const issues: string[] = [];
  const ids = {} as Record<(typeof idSections)[number], Set<string>>;

  for (const section of idSections) {
    const seen = new Set<string>();
    guide[section].forEach((item, i) => {
      if (seen.has(item.id)) issues.push(`${section}.${i}.id: id が重複しています: ${item.id}`);
      seen.add(item.id);
    });
    ids[section] = seen;
  }

  guide.readingOrder.forEach((group, i) => {
    for (const section of idSections) {
      group.refs[section].forEach((id, j) => {
        if (!ids[section].has(id)) {
          issues.push(
            `readingOrder.${i}.refs.${section}.${j}: 存在しない ${section} の id です: ${id}`,
          );
        }
      });
    }
  });

  guide.how.forEach((step, i) => {
    if (step.diagram !== undefined && !ids.diagrams.has(step.diagram)) {
      issues.push(`how.${i}.diagram: 存在しない diagrams の id です: ${step.diagram}`);
    }
  });

  return issues;
}

/**
 * Review Guide を、形と id の整合性の両面から確かめる。例外は投げない。
 * diff との照合（hunk id の実在など）は含まない。
 */
export function validateGuide(input: unknown): GuideValidation {
  const parsed = guideSchema.safeParse(input, parseOptions);
  if (!parsed.success) return { ok: false, issues: formatShapeIssues(parsed.error.issues) };
  const issues = checkIntegrity(parsed.data);
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, guide: parsed.data };
}
