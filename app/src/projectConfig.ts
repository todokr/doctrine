import type { ProjectConfig, ProjectConfigInput, WorkflowListEntry } from "../../shared/protocol.ts";

/** 入力欄の値。maxConcurrent は打ちかけを持てるよう文字列で持つ */
export type ProjectConfigForm = {
  defaultWorkflow: string;
  maxConcurrent: string;
  baseBranch: string;
  setup: string;
};

export type ProjectConfigErrors = Partial<Record<keyof ProjectConfigForm, string>>;

export type ProjectConfigCheck =
  | { ok: true; value: ProjectConfigInput }
  | { ok: false; errors: ProjectConfigErrors };

export function toProjectConfigForm(c: ProjectConfig): ProjectConfigForm {
  return {
    defaultWorkflow: c.defaultWorkflow,
    maxConcurrent: String(c.maxConcurrent),
    baseBranch: c.baseBranch,
    setup: c.setup ?? "",
  };
}

export function checkProjectConfigForm(f: ProjectConfigForm): ProjectConfigCheck {
  const errors: ProjectConfigErrors = {};
  if (!f.defaultWorkflow) errors.defaultWorkflow = "ワークフローを選んでください";
  const maxConcurrentText = f.maxConcurrent.trim();
  const maxConcurrent = Number(maxConcurrentText);
  if (!/^[1-9][0-9]*$/.test(maxConcurrentText) || !Number.isSafeInteger(maxConcurrent)) {
    errors.maxConcurrent = "1 以上の整数を入れてください";
  }
  const baseBranch = f.baseBranch.trim();
  if (!baseBranch) errors.baseBranch = "ブランチ名を入れてください";
  const setup = f.setup.trim() === "" ? null : f.setup;
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { defaultWorkflow: f.defaultWorkflow, maxConcurrent, baseBranch, setup } };
}

/** 保存のエラーを欄ごとに振り分けた結果。rest はどの欄にも当たらなかった分（無ければ null） */
export type ProjectConfigSaveErrors = { fields: ProjectConfigErrors; rest: string | null };

const FIELD_KEYS: (keyof ProjectConfigForm)[] = ["defaultWorkflow", "maxConcurrent", "baseBranch", "setup"];

const WORKFLOW_UNREADABLE_PREFIX = "defaultWorkflow が指すワークフローを読めません";

export function assignSaveError(message: string): ProjectConfigSaveErrors {
  if (message.startsWith(WORKFLOW_UNREADABLE_PREFIX)) {
    return { fields: { defaultWorkflow: message }, rest: null };
  }
  const fields: ProjectConfigErrors = {};
  const restLines: string[] = [];
  for (const line of message.split("\n")) {
    if (!line.startsWith("- ")) continue;
    const m = /^- ([^:]+): (.+)$/.exec(line);
    const key = m?.[1] as keyof ProjectConfigForm | undefined;
    if (m && key && FIELD_KEYS.includes(key)) {
      fields[key] = fields[key] ? `${fields[key]}、${m[2]}` : m[2];
    } else {
      restLines.push(line);
    }
  }
  if (Object.keys(fields).length === 0) return { fields: {}, rest: message };
  return { fields, rest: restLines.length > 0 ? restLines.join("\n") : null };
}

export type WorkflowOption = { name: string; label: string };

export function workflowOptions(entries: WorkflowListEntry[], current: string): WorkflowOption[] {
  const options = entries.map((e) => ({ name: e.name, label: e.ok ? e.name : `${e.name}（不正）` }));
  if (current && !entries.some((e) => e.name === current)) {
    return [{ name: current, label: `${current}（見つかりません）` }, ...options];
  }
  return options;
}
