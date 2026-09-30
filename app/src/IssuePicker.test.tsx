import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn((..._: unknown[]) => Promise.resolve({})) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { pickerWorkspace, startIntake, WorkspacePick } from "./components/IssuePicker";
import { rpc } from "./daemon/client";
import { INTAKES, WORKSPACES } from "./fixtures";
import type { Action } from "./model";

beforeEach(() => {
  invoke.mockReset();
});

describe("pickerWorkspace", () => {
  test("選んだ id の workspace を返す", () => {
    expect(pickerWorkspace(WORKSPACES, 2)?.id).toBe(2);
  });
  test("未選択なら先頭（サイドバーが「すべて」のときの初期選択）", () => {
    expect(pickerWorkspace(WORKSPACES, undefined)?.id).toBe(1);
  });
  test("一覧に無い id なら先頭", () => {
    expect(pickerWorkspace(WORKSPACES, 99)?.id).toBe(1);
  });
  test("一覧が空なら undefined", () => {
    expect(pickerWorkspace([], undefined)).toBeUndefined();
  });
});

describe("startIntake", () => {
  const setup = () => {
    const actions: Action[] = [];
    return {
      actions,
      deps: {
        start: (w: string, u: string) => rpc("intake.start", { workspace: w, issue_url: u }),
        dispatch: (a: Action) => {
          actions.push(a);
        },
      },
    };
  };

  test("選んだ workspace の root で intake.start を呼ぶ", async () => {
    invoke.mockResolvedValue({ ...INTAKES[0], alreadyActive: false });
    const { actions, deps } = setup();
    await startIntake(pickerWorkspace(WORKSPACES, 2)!.path, "https://github.com/o/r/issues/8", deps);
    expect(invoke).toHaveBeenCalledWith("rpc", {
      method: "intake.start",
      params: { workspace: "~/work/shop-api", issue_url: "https://github.com/o/r/issues/8" },
    });
    expect(actions).toEqual([{ type: "intake.started", intake: INTAKES[0] }]);
  });

  test("失敗したらトーストを出す", async () => {
    invoke.mockRejectedValue(new Error("x"));
    const { actions, deps } = setup();
    await startIntake("~/work/shop-api", "https://github.com/o/r/issues/8", deps);
    expect(actions).toEqual([{ type: "toast", message: "Intake を始められませんでした（x）" }]);
  });
});

describe("WorkspacePick", () => {
  test("workspace の名前を並べ、選んだものに selected が付く", () => {
    const html = renderToStaticMarkup(<WorkspacePick workspaces={WORKSPACES} value={2} onChange={() => {}} />);
    expect(html).toContain('<option value="2" selected="">shop-api</option>');
    for (const w of WORKSPACES) expect(html).toContain(w.name);
  });
});
