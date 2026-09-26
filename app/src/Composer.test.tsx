import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn((..._: unknown[]) => Promise.resolve({})) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import type { WorkflowListEntry } from "../../shared/protocol.ts";
import { ComposerFields, submitComposer } from "./components/Composer";
import { initialComposerForm, type ComposerForm } from "./composer";
import { rpc } from "./daemon/client";
import { PROJECTS, WORKFLOW_LIST } from "./fixtures";
import type { Action, Loaded } from "./model";

beforeEach(() => {
  invoke.mockReset();
});

const noop = () => {};
const FORM: ComposerForm = { project: "~/git/doctrine", workflow: "default", title: "", prompt: "" };
const ok = (value: WorkflowListEntry[] = WORKFLOW_LIST): Loaded<WorkflowListEntry[]> => ({ kind: "ok", value });

const render = (over: Partial<Parameters<typeof ComposerFields>[0]> = {}) =>
  renderToStaticMarkup(
    <ComposerFields
      projects={PROJECTS}
      form={FORM}
      workflows={ok()}
      pending={false}
      error={null}
      onChange={noop}
      onSubmit={noop}
      onCancel={noop}
      {...over}
    />,
  );

describe("ComposerFields", () => {
  test("プロジェクトとワークフローの選択肢が出て、既定が選ばれている", () => {
    const html = render();
    expect(html).toContain('<option value="~/git/doctrine" selected="">');
    expect(html).toContain(">shop-api<");
    expect(html).toContain('<option value="default" selected="">default（既定）</option>');
  });
  test("ok: false のワークフローは選べず、issues が出る", () => {
    const html = render();
    expect(html).toMatch(/<option[^>]*value="broken"[^>]*disabled=""|<option[^>]*disabled=""[^>]*value="broken"/);
    expect(html).toContain("steps[1].goto: 存在しないステップ nowhere を指しています");
  });
  test("選んだワークフローのステップを WorkflowRail で出す", () => {
    const def = render();
    expect(def).toContain('class="wf-steps"');
    expect(def).toContain('<span class="nm">plan</span>');
    expect(def).toContain('<span class="nm">review</span>');
    expect(def).not.toContain("wf-legend");
    const light = render({ form: { ...FORM, workflow: "light" } });
    expect(light).toContain('<span class="nm">review</span>');
    expect(light).not.toContain('<span class="nm">plan</span>');
  });
  test("優先度の欄を出さない", () => {
    const html = render();
    expect(html).not.toContain("優先度");
    expect(html).not.toContain("priority");
  });
  test("外から渡した初期値が欄に入る", () => {
    const form = initialComposerForm(
      PROJECTS,
      { project: "~/git/blog", workflow: "light", title: "直す", prompt: "手順" },
      "all",
    );
    const html = render({ form });
    expect(html).toContain('<option value="~/git/blog" selected="">');
    expect(html).toContain('value="直す"');
    expect(html).toContain(">手順</textarea>");
  });
  test("入力が足りなければ作成を押せない", () => {
    const btn = /<button[^>]*disabled=""[^>]*>作成<\/button>/;
    expect(render()).toMatch(btn);
    const filled = { ...FORM, title: "T", prompt: "P" };
    expect(render({ form: filled })).not.toMatch(btn);
    expect(render({ form: filled, pending: true })).toMatch(btn);
  });
  test("ワークフローの読み込み中と失敗を出し分ける", () => {
    expect(render({ workflows: { kind: "loading" } })).toContain("読み込んでいます");
    expect(render({ workflows: { kind: "error", message: "未登録のプロジェクトです: /x" } })).toContain(
      "未登録のプロジェクトです: /x",
    );
  });
  test("送信のエラーを出す", () => {
    expect(render({ error: "作れません" })).toContain('<p class="hint error">作れません</p>');
  });
});

describe("submitComposer", () => {
  const form: ComposerForm = { project: "~/git/doctrine", workflow: "light", title: "T", prompt: "P" };
  const setup = () => {
    const log: string[] = [];
    const actions: Action[] = [];
    const deps = {
      create: (p: Parameters<typeof rpc<"task.create">>[1]) => rpc("task.create", p),
      refresh: async () => {
        log.push("refresh.begin");
        await Promise.resolve();
        log.push("refresh.done");
      },
      dispatch: (a: Action) => {
        log.push(a.type);
        actions.push(a);
      },
    };
    return { log, actions, deps };
  };

  test("task.create をパスと選んだワークフローで呼び、priority を渡さない", async () => {
    invoke.mockResolvedValue({ id: "new-1", title: "T", warnings: [] });
    await submitComposer(form, setup().deps);
    expect(invoke).toHaveBeenCalledWith("rpc", {
      method: "task.create",
      params: { project: "~/git/doctrine", workflow: "light", title: "T", prompt: "P" },
    });
  });
  test("成功したら取り直しが終わってから選ぶ", async () => {
    invoke.mockResolvedValue({ id: "new-1", title: "T", warnings: [] });
    const { log, actions, deps } = setup();
    const r = await submitComposer(form, deps);
    expect(log).toEqual(["refresh.begin", "refresh.done", "composer.created"]);
    expect(actions[0]).toEqual({ type: "composer.created", id: "new-1", toast: "タスクを作りました: T" });
    expect(r).toEqual({ ok: true });
  });
  test("警告をトーストに載せる", async () => {
    invoke.mockResolvedValue({ id: "new-1", title: "T", warnings: ["冪等でないコマンド: x"] });
    const { actions, deps } = setup();
    await submitComposer(form, deps);
    expect(actions[0]).toMatchObject({ toast: "タスクを作りました: T（警告: 冪等でないコマンド: x）" });
  });
  test("失敗したらメッセージを返し、取り直しも選択もしない", async () => {
    invoke.mockRejectedValue(new Error("未登録のプロジェクトです: /x"));
    const { log, deps } = setup();
    const r = await submitComposer(form, deps);
    expect(r).toEqual({ ok: false, message: "未登録のプロジェクトです: /x" });
    expect(log).toEqual([]);
  });
});
