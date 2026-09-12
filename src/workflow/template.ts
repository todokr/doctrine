export type TemplateContext = {
  task: { id: string; title: string; prompt: string; branch: string };
  worktree: { path: string };
  project: { path: string };
  steps: Record<string, { stdout: string; stderr: string; exitCode: string }>;
};

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateError";
  }
}

const PATTERN = /\{\{\s*([^}]+?)\s*\}\}/g;
const TASK_FIELDS = ["id", "title", "prompt", "branch"] as const;
const STEP_FIELDS = ["stdout", "stderr", "exitCode"] as const;

export function expand(template: string, ctx: TemplateContext): string {
  return template.replace(PATTERN, (_m, expr: string) => resolve(expr.trim(), ctx));
}

function resolve(expr: string, ctx: TemplateContext): string {
  const parts = expr.split(".");
  if (parts[0] === "task" && parts.length === 2
      && (TASK_FIELDS as readonly string[]).includes(parts[1])) {
    return ctx.task[parts[1] as (typeof TASK_FIELDS)[number]];
  }
  if (expr === "worktree.path") return ctx.worktree.path;
  if (expr === "project.path") return ctx.project.path;
  if (parts[0] === "steps" && parts.length === 3) {
    const out = ctx.steps[parts[1]];
    if (!out) {
      throw new TemplateError(
        `{{ ${expr} }}: ステップ "${parts[1]}" の出力がありません（まだ実行されていないか、idが違います）`,
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
    `{{ ${expr} }}: 使える変数は task.* / worktree.path / project.path / steps.<id>.* のみです`,
  );
}
