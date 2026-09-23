import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn((..._: unknown[]) => Promise.resolve({})) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { rpc, saveSettings } from "./daemon/client";
import { SettingsFields, SlotsFields, submitGlobalLimit, submitSettings } from "./components/SettingsView";
import type { DaemonSlots, TaskSummary } from "../../shared/protocol.ts";

beforeEach(() => {
  invoke.mockClear();
});

const FORM = { editorCommand: "code {path}", terminalCommand: "wezterm start --cwd {path}", staleDays: "14" };
const noop = () => {};

const waitingTask: TaskSummary = {
  id: "t-91e0",
  project_id: 1,
  title: "ログ追従を1接続1タスクに上書きする",
  prompt: "",
  workflow_name: "feature",
  state: "queued",
  current_step_id: null,
  branch: "doctrine/t-91e0",
  worktree_path: null,
  rate_limited_until: null,
  waiting_until: null,
  priority: 2,
  created_at: "2026-09-15T05:00:00.000Z",
  updated_at: "2026-09-15T05:00:00.000Z",
  intake_id: null,
  intake_process_id: null,
  issue_url: null,
  parent_issue_url: null,
};

const SLOTS: DaemonSlots = {
  global_limit: 4,
  in_use: 3,
  waiting_tasks: [waitingTask],
  waiting_intake_runs: [{ id: 7, intake_id: "in-1", issue_title: "設定画面を充実させる", purpose: "decompose" }],
};

function slotsFields(overrides: Partial<Parameters<typeof SlotsFields>[0]> = {}) {
  return renderToStaticMarkup(
    <SlotsFields
      connected={true}
      slots={{ kind: "ok", value: SLOTS }}
      limit="4"
      pending={false}
      onChange={noop}
      onSave={noop}
      onOpenTask={noop}
      onOpenIntake={noop}
      {...overrides}
    />,
  );
}

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

describe("SlotsFields", () => {
  test("いまの値と使っている数を出す", () => {
    const html = slotsFields();
    expect(html).toContain("いまの値");
    expect(html).toContain("4");
    expect(html).toContain("3 / 4");
    expect(html).toContain('value="4"');
  });

  test("枠待ちのタスクと Intake をリンク付きで出す", () => {
    const html = slotsFields();
    expect(html).toContain("ログ追従を1接続1タスクに上書きする");
    expect(html).toContain("t-91e0");
    expect(html).toContain("設定画面を充実させる");
    expect(html).toContain("分解");
    expect(html).toMatch(/<button[^>]*>ログ追従を1接続1タスクに上書きする<\/button>/);
    expect(html).toMatch(/<button[^>]*>設定画面を充実させる<\/button>/);
  });

  test("枠待ちが無ければ、ありませんと出す", () => {
    const html = slotsFields({ slots: { kind: "ok", value: { ...SLOTS, waiting_tasks: [], waiting_intake_runs: [] } } });
    expect(html).toContain("ありません");
    expect(html).not.toContain("ログ追従を1接続1タスクに上書きする");
  });

  test("値を変えたら保存を押せる", () => {
    const html = slotsFields({ limit: "6" });
    const m = html.match(/<button[^>]*>実行枠を保存<\/button>/);
    expect(m).not.toBeNull();
    expect(m![0]).not.toContain("disabled");
  });

  test("値が変わっていなければ保存を押せない", () => {
    const html = slotsFields({ limit: "4" });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>実行枠を保存<\/button>/);
  });

  test("不正な値は保存を押せず、欄にエラーを出す", () => {
    for (const bad of ["0", "abc"]) {
      const html = slotsFields({ limit: bad });
      expect(html).toMatch(/<button[^>]*disabled=""[^>]*>実行枠を保存<\/button>/);
      expect(html).toContain("1 以上の整数を入れてください");
    }
  });

  test("保存中は保存を押せない", () => {
    const html = slotsFields({ limit: "6", pending: true });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>実行枠を保存<\/button>/);
  });

  test("デーモンにつながっていないときは欄を無効にしてその旨を出す", () => {
    const html = slotsFields({ connected: false });
    expect(html).toContain("デーモンにつながっていない");
    expect(html).toMatch(/<input[^>]*disabled=""[^>]*>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>実行枠を保存<\/button>/);
    expect(html).not.toContain("ログ追従を1接続1タスクに上書きする");
  });

  test("読み込めなかったら理由を出す", () => {
    const html = slotsFields({ slots: { kind: "error", message: "socket closed" } });
    expect(html).toContain("実行枠を読めませんでした");
    expect(html).toContain("socket closed");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>実行枠を保存<\/button>/);
  });
});

describe("submitGlobalLimit", () => {
  const setGlobalLimit = (n: number) => rpc("daemon.setGlobalLimit", { global_limit: n });

  test("値を daemon.setGlobalLimit に渡し、応答を返す", async () => {
    invoke.mockResolvedValueOnce(SLOTS);
    const dispatch = vi.fn();
    const r = await submitGlobalLimit(" 4 ", setGlobalLimit, dispatch);
    expect(r).toEqual(SLOTS);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("rpc", { method: "daemon.setGlobalLimit", params: { global_limit: 4 } });
    expect(dispatch).toHaveBeenCalledWith({ type: "toast", message: "実行枠を保存しました" });
  });

  test("保存に失敗したらトーストで出して null を返す", async () => {
    invoke.mockRejectedValueOnce("書けません");
    const dispatch = vi.fn();
    const r = await submitGlobalLimit("4", setGlobalLimit, dispatch);
    expect(r).toBeNull();
    expect(dispatch).toHaveBeenCalledWith({ type: "toast", message: "実行枠を保存できませんでした: 書けません" });
  });

  test("不正な値は送らない", async () => {
    for (const bad of ["0", "abc"]) {
      const dispatch = vi.fn();
      const r = await submitGlobalLimit(bad, setGlobalLimit, dispatch);
      expect(r).toBeNull();
      expect(invoke).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
    }
  });
});
