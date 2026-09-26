export type TemplateContext = {
  task: { id: string; title: string; prompt: string; branch: string };
  issue: { url: string | null; parent_url: string | null };
  worktree: { path: string };
  project: { path: string };
  steps: Record<string, { last_stdout: string; last_stderr: string; exitCode: string }>;
};

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateError";
  }
}

const PATTERN = /\{\{\s*([^}]+?)\s*\}\}/g;
const TASK_FIELDS = ["id", "title", "prompt", "branch"] as const;
const ISSUE_FIELDS = ["url", "parent_url", "closes"] as const;
const STEP_FIELDS = ["last_stdout", "last_stderr", "exitCode"] as const;

export function expand(template: string, ctx: TemplateContext): string {
  validatePlaceholders(template);
  // String.prototype.replace does not re-scan replacement text, so substituted values
  // containing {{ ... }} are inserted verbatim and never expanded again. This is
  // correct and security-relevant: it prevents agent output from injecting variables
  // into the next prompt. The test for malformed templates doubles as a regression
  // guard: it verifies that a well-formed template with substituted {{ ... }} does
  // not throw and the {{ ... }} survives unexpanded.
  return template.replace(PATTERN, (_m, expr: string) => resolve(expr.trim(), ctx));
}

function validatePlaceholders(template: string): void {
  const matches = Array.from(template.matchAll(PATTERN));
  const matchedIndices = new Set<number>();

  for (const match of matches) {
    if (match.index !== undefined) {
      const expr = match[1];
      const trimmed = expr.trim();

      // Reject empty or whitespace-only expressions
      if (!trimmed) {
        const endIdx = Math.min(match.index + 30, template.length);
        const excerpt = template.substring(match.index, endIdx);
        throw new TemplateError(
          `不正なプレースホルダー: "${excerpt}..." — プレースホルダーは閉じられていないか空です`,
        );
      }

      // Reject expressions containing unescaped braces (e.g., "{{ {{ task.id }}")
      if (trimmed.includes("{") || trimmed.includes("}")) {
        const endIdx = Math.min(match.index + 30, template.length);
        const excerpt = template.substring(match.index, endIdx);
        throw new TemplateError(
          `不正なプレースホルダー: "${excerpt}..." — プレースホルダーは閉じられていないか空です`,
        );
      }

      // Mark all characters of this match as covered
      for (let i = 0; i < match[0].length; i++) {
        matchedIndices.add(match.index + i);
      }
    }
  }

  let idx = 0;
  while ((idx = template.indexOf("{{", idx)) !== -1) {
    if (!matchedIndices.has(idx)) {
      const endIdx = Math.min(idx + 30, template.length);
      const excerpt = template.substring(idx, endIdx);
      throw new TemplateError(
        `不正なプレースホルダー: "${excerpt}..." — プレースホルダーは閉じられていないか空です`,
      );
    }
    idx += 1;
  }
}

/** Linear は PR の Closes で Issue を閉じないので参照だけを出す。閉じるのは Intake の見張りが行う。 */
function isLinearUrl(url: string): boolean {
  try {
    return new URL(url).hostname === "linear.app";
  } catch {
    return false;
  }
}

function resolve(expr: string, ctx: TemplateContext): string {
  const parts = expr.split(".");
  if (
    parts[0] === "task" && parts.length === 2 &&
    (TASK_FIELDS as readonly string[]).includes(parts[1])
  ) {
    return ctx.task[parts[1] as (typeof TASK_FIELDS)[number]];
  }
  if (parts[0] === "issue") {
    if (parts.length !== 2 || !(ISSUE_FIELDS as readonly string[]).includes(parts[1])) {
      throw new TemplateError(
        `{{ ${expr} }}: issue のフィールドは ${ISSUE_FIELDS.join(" / ")} のみです`,
      );
    }
    const { url, parent_url } = ctx.issue;
    if (parts[1] === "url") return url ?? "";
    if (parts[1] === "parent_url") return parent_url ?? "";
    if (!url) return "";
    return isLinearUrl(url) ? `Linear: ${url}` : `Closes ${url}`;
  }
  if (expr === "worktree.path") return ctx.worktree.path;
  if (expr === "project.path") return ctx.project.path;
  if (parts[0] === "steps") {
    if (parts.length < 3) {
      throw new TemplateError(
        `{{ ${expr} }}: ステップ出力を参照するにはフィールドが必要です（形式: steps.<id>.<field>）`,
      );
    }
    if (parts.length > 3) {
      throw new TemplateError(
        `{{ ${expr} }}: ステップidには . を含められません（形式: steps.<id>.<field>）`,
      );
    }
    const out = ctx.steps[parts[1]];
    if (!out) {
      throw new TemplateError(
        `{{ ${expr} }}: ステップ "${
          parts[1]
        }" の出力がありません（まだ実行されていないか、idが違います）`,
      );
    }
    if (!(STEP_FIELDS as readonly string[]).includes(parts[2])) {
      throw new TemplateError(
        `{{ ${expr} }}: ステップ出力のフィールドは ${STEP_FIELDS.join(" / ")} のみです`,
      );
    }
    return out[parts[2] as (typeof STEP_FIELDS)[number]];
  }
  throw new TemplateError(
    `{{ ${expr} }}: 使える変数は task.* / issue.* / worktree.path / project.path / steps.<id>.* のみです`,
  );
}
