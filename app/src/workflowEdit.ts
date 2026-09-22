import type { WorkflowSaveIssue, WorkflowStepChange, WorkflowStepDetail } from "../../shared/protocol.ts";

/** 分岐の入力欄の値。maxAttempts は打ちかけを持てるよう文字列で持つ */
export type BranchForm = { goto: string; maxAttempts: string; feed: string };

/** ステップ1つの入力欄の値。配列の項目は1行1件のテキストで持つ。種類に無い欄は使わない */
export type StepForm = {
  prompt: string;
  run: string;
  model: string;
  permissionMode: string;
  session: string;
  allowedTools: string;
  reviewFiles: string;
  branch: BranchForm | null;
};

/** エラーを出す欄。WorkflowSaveIssue.field のうち画面に欄があるもの */
export type StepFieldKey =
  | "prompt"
  | "run"
  | "model"
  | "permissionMode"
  | "session"
  | "allowedTools"
  | "reviewFiles"
  | "branch.goto"
  | "branch.maxAttempts"
  | "branch.feed";

export type StepFieldErrors = Partial<Record<StepFieldKey, string>>;

/** 保存のエラーを欄ごとに振り分けた結果。rest はどの欄にも当たらなかった分（無ければ null） */
export type StepSaveErrors = { fields: StepFieldErrors; rest: string | null };

export type StepFormCheck =
  | { ok: true; change: WorkflowStepChange | null }
  | { ok: false; errors: StepFieldErrors };

/** 手引きに出すテンプレート変数。core/src/workflow/template.ts の resolve が受け付けるもの */
export const TEMPLATE_VARIABLES: { name: string; note: string }[] = [
  { name: "{{ task.id }}", note: "タスクの id" },
  { name: "{{ task.title }}", note: "タスクの見出し" },
  { name: "{{ task.prompt }}", note: "タスク作成時に書いた指示" },
  { name: "{{ task.branch }}", note: "タスクの worktree のブランチ名" },
  { name: "{{ issue.url }}", note: "紐づく issue の URL。無ければ空文字" },
  { name: "{{ issue.parent_url }}", note: "親 issue の URL。無ければ空文字" },
  { name: "{{ issue.closes }}", note: "issue.url があれば \"Closes <url>\"、無ければ空文字" },
  { name: "{{ worktree.path }}", note: "worktree のパス" },
  { name: "{{ project.path }}", note: "プロジェクトのパス" },
  { name: "{{ steps.<id>.last_stdout }}", note: "そのステップが先に走っていること。標準出力" },
  { name: "{{ steps.<id>.last_stderr }}", note: "そのステップが先に走っていること。標準エラー出力" },
  { name: "{{ steps.<id>.exitCode }}", note: "そのステップが先に走っていること。終了コード" },
];

function toBranchForm(branch: WorkflowStepDetail["branch"]): BranchForm | null {
  if (!branch) return null;
  return { goto: branch.goto, maxAttempts: String(branch.maxAttempts), feed: branch.feed ?? "" };
}

export function toStepForm(step: WorkflowStepDetail): StepForm {
  const base: StepForm = {
    prompt: "",
    run: "",
    model: "",
    permissionMode: "",
    session: "",
    allowedTools: "",
    reviewFiles: "",
    branch: toBranchForm(step.branch),
  };
  if (step.type === "command") {
    return { ...base, run: step.run };
  }
  if (step.type === "agent") {
    return {
      ...base,
      prompt: step.prompt,
      model: step.model ?? "",
      permissionMode: step.permissionMode ?? "",
      session: step.session ?? "",
      allowedTools: step.allowedTools?.join("\n") ?? "",
    };
  }
  if (step.type === "approval") {
    return { ...base, reviewFiles: step.reviewFiles?.join("\n") ?? "" };
  }
  return {
    ...base,
    model: step.model ?? "",
    permissionMode: step.permissionMode ?? "",
    session: step.session,
    allowedTools: step.allowedTools?.join("\n") ?? "",
  };
}

const MAX_ATTEMPTS_RE = /^[1-9][0-9]*$/;

export function checkStepForm(step: WorkflowStepDetail, form: StepForm): StepFormCheck {
  if (form.branch && !MAX_ATTEMPTS_RE.test(form.branch.maxAttempts.trim())) {
    return { ok: false, errors: { "branch.maxAttempts": "1 以上の整数を入れてください" } };
  }
  return { ok: true, change: diffStepForm(step, form) };
}

function splitLines(text: string): string[] {
  return text.split("\n").map((l) => l.trim()).filter((l) => l !== "");
}

function sameArray(a: string[] | null, b: string[]): boolean {
  if (!a) return b.length === 0;
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function diffBranch(branch: WorkflowStepDetail["branch"], form: BranchForm | null): WorkflowStepChange["branch"] {
  if (!branch || !form) return undefined;
  const change: NonNullable<WorkflowStepChange["branch"]> = {};
  if (form.goto !== branch.goto) change.goto = form.goto;
  const maxAttempts = Number(form.maxAttempts.trim());
  if (maxAttempts !== branch.maxAttempts) change.maxAttempts = maxAttempts;
  const feed = form.feed === "" ? null : form.feed;
  if (feed !== (branch.feed ?? null)) change.feed = feed;
  return Object.keys(change).length > 0 ? change : undefined;
}

export function diffStepForm(step: WorkflowStepDetail, form: StepForm): WorkflowStepChange | null {
  const change: WorkflowStepChange = { id: step.id };

  if (step.type === "agent") {
    if (form.prompt !== step.prompt) change.prompt = form.prompt;
    const model = form.model === "" ? null : form.model;
    if (model !== step.model) change.model = model;
    const permissionMode = form.permissionMode === "" ? null : form.permissionMode;
    if (permissionMode !== step.permissionMode) change.permissionMode = permissionMode;
    const session = form.session === "" ? null : form.session;
    if (session !== step.session) change.session = session;
    const allowedTools = splitLines(form.allowedTools);
    if (!sameArray(step.allowedTools, allowedTools)) change.allowedTools = allowedTools.length > 0 ? allowedTools : null;
  } else if (step.type === "command") {
    if (form.run !== step.run) change.run = form.run;
  } else if (step.type === "approval") {
    const reviewFiles = splitLines(form.reviewFiles);
    if (!sameArray(step.reviewFiles, reviewFiles)) change.reviewFiles = reviewFiles.length > 0 ? reviewFiles : null;
  }

  const branch = diffBranch(step.branch, form.branch);
  if (branch !== undefined) change.branch = branch;

  const { id: _id, ...rest } = change;
  return Object.keys(rest).length > 0 ? change : null;
}

const FIELD_KEYS: StepFieldKey[] = [
  "prompt",
  "run",
  "model",
  "permissionMode",
  "session",
  "allowedTools",
  "reviewFiles",
  "branch.goto",
  "branch.maxAttempts",
  "branch.feed",
];

export function assignSaveIssues(issues: WorkflowSaveIssue[], stepId: string): StepSaveErrors {
  const fields: StepFieldErrors = {};
  const restLines: string[] = [];
  for (const issue of issues) {
    const field = issue.field === "branch" ? "branch.goto" : issue.field;
    if (issue.stepId === stepId && field && (FIELD_KEYS as string[]).includes(field)) {
      const key = field as StepFieldKey;
      fields[key] = fields[key] ? `${fields[key]}、${issue.message}` : issue.message;
    } else {
      restLines.push(issue.message);
    }
  }
  return { fields, rest: restLines.length > 0 ? restLines.join("\n") : null };
}
