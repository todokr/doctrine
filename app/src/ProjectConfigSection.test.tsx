import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn((..._: unknown[]) => Promise.resolve({})) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import type { ProjectConfig, ProjectConfigInput, ProjectSummary, WorkflowListEntry } from "../../shared/protocol.ts";
import { rpc } from "./daemon/client";
import { toProjectConfigForm, workflowOptions } from "./projectConfig";
import {
  ProjectConfigFields,
  loadProjectConfig,
  submitProjectConfig,
} from "./components/ProjectConfigSection";

beforeEach(() => {
  invoke.mockClear();
});

const api = {
  get: (p: string): Promise<ProjectConfig> => rpc("project.config.get", { project: p }),
  workflows: (p: string): Promise<WorkflowListEntry[]> => rpc("workflow.list", { project: p }),
  save: (p: string, c: ProjectConfigInput): Promise<ProjectSummary> =>
    rpc("project.config.save", { project: p, config: c }),
};

const noop = () => {};
const NO_ERRORS = { fields: {}, rest: null };

describe("loadProjectConfig", () => {
  test("project.config.get と workflow.list をプロジェクトのパスで呼ぶ", async () => {
    const config: ProjectConfig = { defaultWorkflow: "default", maxConcurrent: 2, baseBranch: "main", setup: "pnpm install" };
    const list: WorkflowListEntry[] = [
      { name: "default", default: true, ok: true, steps: [] },
      { name: "quick", default: false, ok: true, steps: [] },
    ];
    invoke.mockResolvedValueOnce(config).mockResolvedValueOnce(list);

    const r = await loadProjectConfig("/repo/app", api);

    expect(invoke).toHaveBeenCalledWith("rpc", { method: "project.config.get", params: { project: "/repo/app" } });
    expect(invoke).toHaveBeenCalledWith("rpc", { method: "workflow.list", params: { project: "/repo/app" } });
    expect(r).toEqual({ config, workflows: list });
  });

  test("project.yaml が読めなければ投げる", async () => {
    invoke.mockRejectedValueOnce("ワークフロー定義が不正です:\n- YAMLとして読めません: bad");
    await expect(loadProjectConfig("/repo/app", api)).rejects.toBe(
      "ワークフロー定義が不正です:\n- YAMLとして読めません: bad",
    );
  });
});

describe("ProjectConfigFields", () => {
  const config: ProjectConfig = { defaultWorkflow: "default", maxConcurrent: 2, baseBranch: "main", setup: "pnpm install" };
  const list: WorkflowListEntry[] = [
    { name: "default", default: true, ok: true, steps: [] },
    { name: "quick", default: false, ok: true, steps: [] },
  ];

  test("project.config.get の値が欄に出る", () => {
    const form = toProjectConfigForm(config);
    const html = renderToStaticMarkup(
      <ProjectConfigFields
        form={form}
        workflows={workflowOptions(list, "default")}
        saveErrors={NO_ERRORS}
        saved={false}
        pending={false}
        onChange={noop}
        onSave={noop}
      />,
    );
    expect(html).toContain('<option value="default" selected="">');
    expect(html).toContain('value="2"');
    expect(html).toContain('value="main"');
    expect(html).toContain(">pnpm install</textarea>");
    expect(html).toContain(">quick<");
  });

  test("一覧に無い defaultWorkflow は（見つかりません）として出る", () => {
    const form = { ...toProjectConfigForm(config), defaultWorkflow: "gone" };
    const html = renderToStaticMarkup(
      <ProjectConfigFields
        form={form}
        workflows={workflowOptions(list, "gone")}
        saveErrors={NO_ERRORS}
        saved={false}
        pending={false}
        onChange={noop}
        onSave={noop}
      />,
    );
    expect(html).toContain("gone（見つかりません）");
    expect(html).toContain('<option value="gone" selected="">');
  });

  test("入力が不正なら保存を押せず、欄に理由を出す", () => {
    const form = { ...toProjectConfigForm(config), maxConcurrent: "0" };
    const html = renderToStaticMarkup(
      <ProjectConfigFields
        form={form}
        workflows={workflowOptions(list, "default")}
        saveErrors={NO_ERRORS}
        saved={false}
        pending={false}
        onChange={noop}
        onSave={noop}
      />,
    );
    const m = html.match(/<button[^>]*disabled=""[^>]*>保存<\/button>/);
    expect(m).not.toBeNull();
    expect(html).toContain("1 以上の整数を入れてください");
  });

  test("保存のエラーが該当する欄に出る", () => {
    const form = toProjectConfigForm(config);
    const html = renderToStaticMarkup(
      <ProjectConfigFields
        form={form}
        workflows={workflowOptions(list, "default")}
        saveErrors={{ fields: { baseBranch: "文字列が短すぎます（1文字以上必要です）" }, rest: null }}
        saved={false}
        pending={false}
        onChange={noop}
        onSave={noop}
      />,
    );
    expect(html).toContain("文字列が短すぎます（1文字以上必要です）");
    const baseBranchIdx = html.indexOf('id="project-base-branch"');
    const setupIdx = html.indexOf('id="project-setup"');
    const errorIdx = html.indexOf("文字列が短すぎます（1文字以上必要です）");
    expect(errorIdx).toBeGreaterThan(baseBranchIdx);
    expect(errorIdx).toBeLessThan(setupIdx);
  });

  test("欄に当たらないエラーは保存の上に出る", () => {
    const form = toProjectConfigForm(config);
    const html = renderToStaticMarkup(
      <ProjectConfigFields
        form={form}
        workflows={workflowOptions(list, "default")}
        saveErrors={{ fields: {}, rest: "未登録のプロジェクトです: /x" }}
        saved={false}
        pending={false}
        onChange={noop}
        onSave={noop}
      />,
    );
    expect(html).toContain("未登録のプロジェクトです: /x");
    expect(html).toMatch(/<p class="hint error">未登録のプロジェクトです: \/x<\/p>/);
  });

  test("保存したら未コミットであることを出す", () => {
    const form = toProjectConfigForm(config);
    const htmlSaved = renderToStaticMarkup(
      <ProjectConfigFields
        form={form}
        workflows={workflowOptions(list, "default")}
        saveErrors={NO_ERRORS}
        saved={true}
        pending={false}
        onChange={noop}
        onSave={noop}
      />,
    );
    expect(htmlSaved).toContain("未コミット");

    const htmlNotSaved = renderToStaticMarkup(
      <ProjectConfigFields
        form={form}
        workflows={workflowOptions(list, "default")}
        saveErrors={NO_ERRORS}
        saved={false}
        pending={false}
        onChange={noop}
        onSave={noop}
      />,
    );
    expect(htmlNotSaved).not.toContain("未コミット");
  });

  test("保存中は保存を押せない", () => {
    const form = toProjectConfigForm(config);
    const html = renderToStaticMarkup(
      <ProjectConfigFields
        form={form}
        workflows={workflowOptions(list, "default")}
        saveErrors={NO_ERRORS}
        saved={false}
        pending={true}
        onChange={noop}
        onSave={noop}
      />,
    );
    const m = html.match(/<button[^>]*disabled=""[^>]*>保存<\/button>/);
    expect(m).not.toBeNull();
  });
});

describe("submitProjectConfig", () => {
  test("変えた値で project.config.save を呼ぶ", async () => {
    const form = { defaultWorkflow: "quick", maxConcurrent: "3", baseBranch: "develop", setup: "" };
    const saved: ProjectSummary = {
      id: 1,
      path: "/repo/app",
      default_workflow: "quick",
      max_concurrent: 3,
      base_branch: "develop",
      setup: null,
    };
    invoke.mockResolvedValueOnce(saved);

    const r = await submitProjectConfig("/repo/app", form, api.save);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("rpc", {
      method: "project.config.save",
      params: {
        project: "/repo/app",
        config: { defaultWorkflow: "quick", maxConcurrent: 3, baseBranch: "develop", setup: null },
      },
    });
    expect(r).toEqual({ ok: true, saved });
  });

  test("保存のエラーを欄に振り分けて返す", async () => {
    const form = { defaultWorkflow: "quick", maxConcurrent: "3", baseBranch: "develop", setup: "" };
    const message = "defaultWorkflow が指すワークフローを読めません: .doctrine/workflows/quick.yaml（No such file）";
    invoke.mockRejectedValueOnce(message);

    const r = await submitProjectConfig("/repo/app", form, api.save);

    expect(r).toEqual({ ok: false, fields: { defaultWorkflow: message }, rest: null });
  });

  test("不正な値は送らない", async () => {
    const form = { defaultWorkflow: "quick", maxConcurrent: "0", baseBranch: "develop", setup: "" };

    const r = await submitProjectConfig("/repo/app", form, api.save);

    expect(invoke).not.toHaveBeenCalled();
    expect(r).toEqual({ ok: false, fields: { maxConcurrent: "1 以上の整数を入れてください" }, rest: null });
  });
});
