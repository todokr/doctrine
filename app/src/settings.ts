import type { AppSettings } from "./daemon/client";

/** 入力欄の値。日数は打ちかけ（空・"1a"）を持てるよう文字列で持つ */
export type SettingsForm = { editorCommand: string; terminalCommand: string; staleDays: string };

export type SettingsCheck =
  | { ok: true; value: AppSettings }
  | { ok: false; errors: Partial<Record<keyof SettingsForm, string>> };

export function toSettingsForm(s: AppSettings): SettingsForm {
  return {
    editorCommand: s.editorCommand,
    terminalCommand: s.terminalCommand,
    staleDays: String(s.staleDays),
  };
}

// Rust の u32 の上限
const U32_MAX = 4294967295;

export function checkSettingsForm(f: SettingsForm): SettingsCheck {
  const errors: Partial<Record<keyof SettingsForm, string>> = {};
  const editorCommand = f.editorCommand.trim();
  const terminalCommand = f.terminalCommand.trim();
  const staleDaysText = f.staleDays.trim();
  if (!editorCommand) errors.editorCommand = "コマンドを入れてください";
  if (!terminalCommand) errors.terminalCommand = "コマンドを入れてください";
  const staleDays = Number(staleDaysText);
  if (!/^[1-9][0-9]*$/.test(staleDaysText) || staleDays > U32_MAX) {
    errors.staleDays = "1 以上の整数を入れてください";
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { editorCommand, terminalCommand, staleDays } };
}

export type GlobalLimitCheck = { ok: true; value: number } | { ok: false; error: string };

export function checkGlobalLimit(text: string): GlobalLimitCheck {
  const trimmed = text.trim();
  if (!/^[1-9][0-9]*$/.test(trimmed)) return { ok: false, error: "1 以上の整数を入れてください" };
  return { ok: true, value: Number(trimmed) };
}
