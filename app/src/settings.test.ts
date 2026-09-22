import { describe, expect, test } from "vitest";
import { checkGlobalLimit, checkSettingsForm, toSettingsForm } from "./settings";

describe("toSettingsForm", () => {
  test("日数を文字列にする", () => {
    expect(
      toSettingsForm({
        editorCommand: "code {path}",
        terminalCommand: "wezterm start --cwd {path}",
        staleDays: 14,
      }),
    ).toEqual({
      editorCommand: "code {path}",
      terminalCommand: "wezterm start --cwd {path}",
      staleDays: "14",
    });
  });
});

describe("checkSettingsForm", () => {
  test("正しい値は AppSettings になる", () => {
    expect(
      checkSettingsForm({
        editorCommand: " code {path} ",
        terminalCommand: "open -a Terminal {path}",
        staleDays: " 30 ",
      }),
    ).toEqual({
      ok: true,
      value: { editorCommand: "code {path}", terminalCommand: "open -a Terminal {path}", staleDays: 30 },
    });
  });

  test("日数は 1 以上の整数だけを受ける", () => {
    const form = { editorCommand: "code {path}", terminalCommand: "open -a Terminal {path}" };
    for (const bad of ["0", "-1", "1.5", "", "7日", "01", "4294967296"]) {
      const r = checkSettingsForm({ ...form, staleDays: bad });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.staleDays).toBe("1 以上の整数を入れてください");
    }
    for (const ok of ["1", "4294967295"]) {
      expect(checkSettingsForm({ ...form, staleDays: ok }).ok).toBe(true);
    }
  });

  test("空のコマンドは受けない", () => {
    const r = checkSettingsForm({
      editorCommand: "  ",
      terminalCommand: "open -a Terminal {path}",
      staleDays: "7",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.editorCommand).toBe("コマンドを入れてください");
      expect(r.errors.terminalCommand).toBeUndefined();
    }
  });
});

describe("checkGlobalLimit", () => {
  test("1 以上の整数を受け付ける", () => {
    expect(checkGlobalLimit("1")).toEqual({ ok: true, value: 1 });
    expect(checkGlobalLimit(" 12 ")).toEqual({ ok: true, value: 12 });
    expect(checkGlobalLimit("100000")).toEqual({ ok: true, value: 100000 });
  });

  test("1 以上の整数でなければエラーにする", () => {
    for (const bad of ["", "0", "-1", "1.5", "abc", "01"]) {
      expect(checkGlobalLimit(bad)).toEqual({ ok: false, error: "1 以上の整数を入れてください" });
    }
  });
});
