import { describe, expect, test } from "vitest";
import { checkGlobalLimit, checkSettingsForm } from "./settings";

describe("checkSettingsForm", () => {
  test("正しい値は AppSettings になる", () => {
    expect(
      checkSettingsForm({
        editorCommand: " code {path} ",
        terminalCommand: "open -a Terminal {path}",
      }),
    ).toEqual({
      ok: true,
      value: { editorCommand: "code {path}", terminalCommand: "open -a Terminal {path}" },
    });
  });

  test("空のコマンドは受けない", () => {
    const r = checkSettingsForm({
      editorCommand: "  ",
      terminalCommand: "open -a Terminal {path}",
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
