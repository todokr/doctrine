import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn((..._: unknown[]) => Promise.resolve({})) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { pickerWorkspace, startIntake, WorkspacePick } from "./components/IssuePicker";
import { rpc } from "./daemon/client";
import { INTAKES, WORKSPACES } from "./fixtures";
import type { Action } from "./model";
import type { IntakeMode } from "../../shared/protocol.ts";

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
    const refresh = vi.fn(() => Promise.resolve());
    return {
      actions,
      refresh,
      deps: {
        start: (w: string, u: string, m: IntakeMode) => rpc("intake.start", { workspace: w, issue_url: u, mode: m }),
        dispatch: (a: Action) => {
          actions.push(a);
        },
        refresh,
      },
    };
  };

  test("選んだ workspace の root と種類で intake.start を呼ぶ", async () => {
    invoke.mockResolvedValue({ ...INTAKES[0], alreadyActive: false });
    const { actions, deps } = setup();
    await startIntake(pickerWorkspace(WORKSPACES, 2)!.path, "https://github.com/o/r/issues/8", "direct", deps);
    expect(invoke).toHaveBeenCalledWith("rpc", {
      method: "intake.start",
      params: { workspace: "~/work/shop-api", issue_url: "https://github.com/o/r/issues/8", mode: "direct" },
    });
    expect(actions).toEqual([{ type: "intake.started", intake: INTAKES[0] }]);
  });

  test("direct で始めたら、できたタスクを拾うため一覧を取り直す", async () => {
    invoke.mockResolvedValue({ ...INTAKES[0], mode: "direct", alreadyActive: false });
    const direct = setup();
    await startIntake("~/work/shop-api", "https://github.com/o/r/issues/8", "direct", direct.deps);
    expect(direct.refresh).toHaveBeenCalledTimes(1);
    invoke.mockResolvedValue({ ...INTAKES[0], mode: "plan", alreadyActive: false });
    const plan = setup();
    await startIntake("~/work/shop-api", "https://github.com/o/r/issues/8", "plan", plan.deps);
    expect(plan.refresh).not.toHaveBeenCalled();
  });

  test("失敗したらトーストを出す", async () => {
    invoke.mockRejectedValue(new Error("x"));
    const { actions, deps, refresh } = setup();
    await startIntake("~/work/shop-api", "https://github.com/o/r/issues/8", "plan", deps);
    expect(actions).toEqual([{ type: "toast", message: "Intake を始められませんでした（x）" }]);
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("WorkspacePick", () => {
  test("workspace の名前を並べ、選んだものに selected が付く", () => {
    const html = renderToStaticMarkup(<WorkspacePick workspaces={WORKSPACES} value={2} onChange={() => {}} />);
    expect(html).toContain('<option value="2" selected="">shop-api</option>');
    for (const w of WORKSPACES) expect(html).toContain(w.name);
  });
});
