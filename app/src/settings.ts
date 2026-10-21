import type { AppSettings } from "./daemon/client";
import type { Loaded } from "./model";

/** 入力欄の値 */
export type SettingsForm = { editorCommand: string; terminalCommand: string };

export type SettingsCheck =
  | { ok: true; value: AppSettings }
  | { ok: false; errors: Partial<Record<keyof SettingsForm, string>> };

export function toSettingsForm(s: AppSettings): SettingsForm {
  return {
    editorCommand: s.editorCommand,
    terminalCommand: s.terminalCommand,
  };
}

export function checkSettingsForm(f: SettingsForm): SettingsCheck {
  const errors: Partial<Record<keyof SettingsForm, string>> = {};
  const editorCommand = f.editorCommand.trim();
  const terminalCommand = f.terminalCommand.trim();
  if (!editorCommand) errors.editorCommand = "コマンドを入れてください";
  if (!terminalCommand) errors.terminalCommand = "コマンドを入れてください";
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { editorCommand, terminalCommand } };
}

export type GlobalLimitCheck = { ok: true; value: number } | { ok: false; error: string };

export function checkGlobalLimit(text: string): GlobalLimitCheck {
  const trimmed = text.trim();
  if (!/^[1-9][0-9]*$/.test(trimmed)) return { ok: false, error: "1 以上の整数を入れてください" };
  return { ok: true, value: Number(trimmed) };
}

/** 「エディタで開く」に使うコマンド。設定を読めていなければ開かずに理由を返す */
export function editorCommandOf(
  settings: Loaded<AppSettings>,
): { ok: true; command: string } | { ok: false; message: string } {
  switch (settings.kind) {
    case "ok":
      return { ok: true, command: settings.value.editorCommand };
    case "loading":
      return { ok: false, message: "設定を読み込んでいます" };
    case "error":
      return { ok: false, message: `設定を読めないのでエディタを開けません（${settings.message}）` };
  }
}
