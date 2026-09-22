import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn((..._: unknown[]) => Promise.resolve({})) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { saveSettings } from "./daemon/client";
import { SettingsFields, submitSettings } from "./components/SettingsView";

beforeEach(() => {
  invoke.mockClear();
});

const FORM = { editorCommand: "code {path}", terminalCommand: "wezterm start --cwd {path}", staleDays: "14" };
const noop = () => {};

describe("SettingsFields", () => {
  test("読み込んだ値がフォームに出る", () => {
    const html = renderToStaticMarkup(
      <SettingsFields form={FORM} pending={false} onChange={noop} onSave={noop} />,
    );
    expect(html).toContain('value="code {path}"');
    expect(html).toContain('value="wezterm start --cwd {path}"');
    expect(html).toContain('value="14"');
  });

  test("コマンドには {path} が置き換わることを添える", () => {
    const html = renderToStaticMarkup(
      <SettingsFields form={FORM} pending={false} onChange={noop} onSave={noop} />,
    );
    expect(html).toContain("{path}");
    expect(html).toContain("置き換わります");
  });

  test("正しい値なら保存を押せる", () => {
    const html = renderToStaticMarkup(
      <SettingsFields form={FORM} pending={false} onChange={noop} onSave={noop} />,
    );
    const m = html.match(/<button[^>]*>保存<\/button>/);
    expect(m).not.toBeNull();
    expect(m![0]).not.toContain("disabled");
  });

  test("日数が不正なら保存を押せず、理由を出す", () => {
    const html = renderToStaticMarkup(
      <SettingsFields form={{ ...FORM, staleDays: "0" }} pending={false} onChange={noop} onSave={noop} />,
    );
    const m = html.match(/<button[^>]*disabled=""[^>]*>保存<\/button>/);
    expect(m).not.toBeNull();
    expect(html).toContain("1 以上の整数を入れてください");
  });

  test("保存中は保存を押せない", () => {
    const html = renderToStaticMarkup(
      <SettingsFields form={FORM} pending={true} onChange={noop} onSave={noop} />,
    );
    const m = html.match(/<button[^>]*disabled=""[^>]*>保存<\/button>/);
    expect(m).not.toBeNull();
  });
});

describe("submitSettings", () => {
  test("保存した値が save_settings に渡り、store の設定を置き換える", async () => {
    const dispatch = vi.fn();
    const value = { editorCommand: "code {path}", terminalCommand: "wezterm start --cwd {path}", staleDays: 30 };
    const r = await submitSettings({ ...FORM, staleDays: "30" }, saveSettings, dispatch);
    expect(r).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("save_settings", { settings: value });
    expect(dispatch).toHaveBeenCalledWith({ type: "settings", loaded: { kind: "ok", value } });
    expect(dispatch).toHaveBeenCalledWith({ type: "toast", message: "設定を保存しました" });
  });

  test("保存に失敗したらトーストで出し、store の設定は変えない", async () => {
    invoke.mockRejectedValueOnce("書けません");
    const dispatch = vi.fn();
    const r = await submitSettings(FORM, saveSettings, dispatch);
    expect(r).toBe(false);
    expect(dispatch).toHaveBeenCalledWith({ type: "toast", message: "設定を保存できませんでした: 書けません" });
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "settings" }));
  });

  test("不正な値は送らない", async () => {
    const dispatch = vi.fn();
    const r = await submitSettings({ ...FORM, staleDays: "0" }, saveSettings, dispatch);
    expect(r).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });
});
