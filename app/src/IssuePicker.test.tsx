import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn((..._: unknown[]) => Promise.resolve({})) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { directProjectChoices, IssuePreview, pickerWorkspace, startIntake, WorkspacePick } from "./components/IssuePicker";
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
        start: (w: string, u: string, m: IntakeMode, p?: string) =>
          rpc("intake.start", { workspace: w, issue_url: u, mode: m, ...(p !== undefined ? { project: p } : {}) }),
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

  test("project を渡したら intake.start の params に載せる", async () => {
    invoke.mockResolvedValue({ ...INTAKES[0], mode: "direct", alreadyActive: false });
    const { deps } = setup();
    await startIntake("~/work", "https://linear.app/t/issue/ENG-1", "direct", deps, "admin");
    expect(invoke).toHaveBeenCalledWith("rpc", {
      method: "intake.start",
      params: { workspace: "~/work", issue_url: "https://linear.app/t/issue/ENG-1", mode: "direct", project: "admin" },
    });
  });

  test("project を渡さなければ params に project のキーを作らない", async () => {
    invoke.mockResolvedValue({ ...INTAKES[0], mode: "direct", alreadyActive: false });
    const { deps } = setup();
    await startIntake("~/work/shop-api", "https://github.com/o/r/issues/8", "direct", deps);
    const params = (invoke.mock.calls[0][1] as { params: Record<string, unknown> }).params;
    expect(Object.keys(params)).not.toContain("project");
  });

  test("失敗したらトーストを出す", async () => {
    invoke.mockRejectedValue(new Error("x"));
    const { actions, deps, refresh } = setup();
    await startIntake("~/work/shop-api", "https://github.com/o/r/issues/8", "plan", deps);
    expect(actions).toEqual([{ type: "toast", message: "Intake を始められませんでした（x）" }]);
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("directProjectChoices", () => {
  test("Linear でプロジェクトが 2 つ以上なら名前を workspace の順で返す", () => {
    expect(directProjectChoices("linear", WORKSPACES[3])).toEqual(["shop", "admin", "batch"]);
  });
  test("Linear でプロジェクトが 1 つなら null", () => {
    expect(directProjectChoices("linear", WORKSPACES[0])).toBeNull();
  });
  test("GitHub ならプロジェクトが 2 つ以上でも null", () => {
    expect(directProjectChoices("github", WORKSPACES[3])).toBeNull();
  });
  test("名前は id ではなく name を使う", () => {
    const w = { ...WORKSPACES[3], projects: WORKSPACES[3].projects.map((p) => ({ ...p, id: `dir-${p.id}` })) };
    expect(directProjectChoices("linear", w)).toEqual(["shop", "admin", "batch"]);
  });
});

describe("IssuePreview の direct のプロジェクト", () => {
  const url = "https://linear.app/t/issue/ENG-1";
  const noop = () => {};
  const preview = (o: Partial<Parameters<typeof IssuePreview>[0]>) =>
    renderToStaticMarkup(
      <IssuePreview
        issue={{ url, identifier: "ENG-1", title: "T" }}
        detail={undefined}
        target={{ kind: "start", url }}
        pending={false}
        onStart={noop}
        onOpen={noop}
        {...o}
      />,
    );
  const directDisabled = /<button[^>]*disabled=""[^>]*>すぐ実行する/;
  const planDisabled = /<button[^>]*disabled=""[^>]*>計画して進める/;

  test("directProject を渡したときだけプロジェクトを選ぶ欄を出す", () => {
    const html = preview({ directProject: { choices: ["shop", "admin"], value: null, onChange: noop } });
    expect(html).toContain('aria-label="direct のプロジェクト"');
    expect(html).toContain('<option value="shop">shop</option>');
    expect(html).toContain('<option value="admin">admin</option>');
    const none = preview({});
    expect(none).not.toContain("direct のプロジェクト");
    expect(none).not.toContain("<select");
  });

  test("未選択の間は direct を押せず、plan は押せる", () => {
    const html = preview({ directProject: { choices: ["shop", "admin"], value: null, onChange: noop } });
    expect(html).toMatch(directDisabled);
    expect(html).not.toMatch(planDisabled);
    expect(html).toContain('<option value="" selected="">選んでください</option>');
  });

  test("選んだら direct を押せ、選んだ名前に selected が付く", () => {
    const html = preview({ directProject: { choices: ["shop", "admin"], value: "admin", onChange: noop } });
    expect(html).not.toMatch(directDisabled);
    expect(html).toContain('<option value="admin" selected="">admin</option>');
  });

  test("directProject が無ければ direct は pending のときだけ押せない", () => {
    expect(preview({})).not.toMatch(directDisabled);
    expect(preview({ pending: true })).toMatch(directDisabled);
  });

  test("Intake のある Issue では欄を出さない", () => {
    const html = preview({
      target: { kind: "open", intakeId: "i1" },
      directProject: { choices: ["shop", "admin"], value: null, onChange: noop },
    });
    expect(html).not.toContain("<select");
  });
});

describe("WorkspacePick", () => {
  test("workspace の名前を並べ、選んだものに selected が付く", () => {
    const html = renderToStaticMarkup(<WorkspacePick workspaces={WORKSPACES} value={2} onChange={() => {}} />);
    expect(html).toContain('<option value="2" selected="">shop-api</option>');
    for (const w of WORKSPACES) expect(html).toContain(w.name);
  });
});
