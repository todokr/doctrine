import { beforeEach, describe, expect, test, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn((..._: unknown[]): Promise<unknown> => Promise.resolve({})) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { ADDED_WORKSPACE, DETECT_EXISTING, DETECT_PARENT, DETECT_REPO_ROOT } from "./fixtures";
import {
  blocker,
  initialWizard,
  next,
  submitWizard,
  withDetection,
  type WizardState,
} from "./wizard";
import type { WorkspaceDetection } from "../../shared/protocol.ts";

beforeEach(() => {
  invoke.mockReset();
});

const detected = (path: string, detection: WorkspaceDetection, patch: Partial<WizardState> = {}): WizardState => ({
  ...withDetection({ ...initialWizard(), step: "directory" }, path, detection),
  ...patch,
});

/** invoke を method ごとに答えさせ、呼ばれた順に [method, params] を返す */
function daemon(answers: Record<string, () => Promise<unknown>>): [string, unknown][] {
  const calls: [string, unknown][] = [];
  invoke.mockImplementation((...args: unknown[]) => {
    const { method, params } = args[1] as { method: string; params: unknown };
    calls.push([method, params]);
    const answer = answers[method];
    return answer ? answer() : Promise.reject(new Error(`想定外の呼び出し: ${method}`));
  });
  return calls;
}

describe("画面の分岐", () => {
  test("リポジトリのルートなら projects を確認だけにして tracker へ進む", () => {
    const s = detected("/Users/me/git/Doctrine", DETECT_REPO_ROOT);
    expect(blocker(s)).toBeNull();
    expect(next(s)).toBe("projects");
    const onProjects = { ...s, step: "projects" as const };
    // 選ぶものは無く、root の名前で 1 つに決まっている
    expect(onProjects.projects).toEqual([{ dir: ".", name: "doctrine", selected: true }]);
    expect(blocker(onProjects)).toBeNull();
    expect(next(onProjects)).toBe("tracker");
  });

  test("workspace.yaml があれば tracker を飛ばして confirm へ進む", () => {
    const s = detected("/Users/me/work", DETECT_EXISTING, { step: "projects" });
    expect(blocker(s)).toBeNull();
    expect(next(s)).toBe("confirm");
  });

  test("git 管理外で直下にリポジトリが無ければ先へ進めない", () => {
    const s = detected("/Users/me/empty", { ...DETECT_PARENT, repositories: [] });
    expect(blocker(s)).toContain("git リポジトリがありません");
  });

  test("ディレクトリを選ぶまでは先へ進めない", () => {
    expect(blocker({ ...initialWizard(), step: "directory" })).toBe("ディレクトリを選んでください");
  });

  test("調べるのに失敗したら、その理由で先へ進めない", () => {
    const s = { ...initialWizard(), step: "directory" as const, path: "/r/sub", error: "リポジトリのルートを指定してください" };
    expect(blocker(s)).toBe("リポジトリのルートを指定してください");
  });

  test("登録済みのディレクトリなら先へ進めない", () => {
    const s = detected("/Users/me/work", { ...DETECT_PARENT, alreadyRegistered: true });
    expect(blocker(s)).toContain("登録済み");
  });

  test("名前が重なる・形が違うなら先へ進めない", () => {
    const s = detected("/Users/me/work", DETECT_PARENT, { step: "projects" });
    expect(blocker(s)).toBeNull();
    const dup = { ...s, projects: s.projects.map((p) => ({ ...p, name: "api" })) };
    expect(blocker(dup)).toContain("重なっています");
    // 選んでいないものは数えない
    expect(blocker({ ...dup, projects: [dup.projects[0], { ...dup.projects[1], selected: false }] })).toBeNull();
    const bad = { ...s, projects: [{ ...s.projects[0], name: "Shop_API" }, s.projects[1]] };
    expect(blocker(bad)).toContain("Shop_API");
    const none = { ...s, projects: s.projects.map((p) => ({ ...p, selected: false })) };
    expect(blocker(none)).toContain("1 つ以上");
  });

  test("linear で team が空なら先へ進めない", () => {
    const s = detected("/Users/me/work", DETECT_PARENT, { step: "tracker" });
    expect(blocker(s)).toBeNull();
    expect(blocker({ ...s, tracker: { kind: "linear", team: " " } })).toContain("チーム");
    expect(blocker({ ...s, tracker: { kind: "linear", team: "ENG" } })).toBeNull();
  });
});

describe("submitWizard", () => {
  test("submitWizard は workspace.add だけを呼ぶ", async () => {
    const calls = daemon({ "workspace.add": () => Promise.resolve(ADDED_WORKSPACE) });
    const s = detected("/Users/me/work", DETECT_PARENT, {
      step: "confirm",
      tracker: { kind: "linear", team: "ENG" },
    });
    await submitWizard(s);
    expect(calls).toEqual([
      [
        "workspace.add",
        {
          path: "/Users/me/work",
          projects: { "shop-api": "Shop_API", web: "web" },
          tracker: { kind: "linear", team: "ENG" },
        },
      ],
    ]);
  });

  test("Linear のチームのキーは前後の空白を落として送る", async () => {
    const calls = daemon({
      "workspace.add": () => Promise.resolve({ ...ADDED_WORKSPACE, created: [] }),
    });
    await submitWizard(detected("/Users/me/work", DETECT_PARENT, {
      step: "confirm",
      tracker: { kind: "linear", team: " ENG ", states: { inReview: "In Review" } },
    }));
    expect((calls[0][1] as { tracker: unknown }).tracker).toEqual({ kind: "linear", team: "ENG", states: { inReview: "In Review" } });
  });

  test("選ばなかったリポジトリは projects に入れない", async () => {
    const calls = daemon({
      "workspace.add": () => Promise.resolve(ADDED_WORKSPACE),
    });
    const s = detected("/Users/me/work", DETECT_PARENT, { step: "confirm" });
    await submitWizard({ ...s, projects: [s.projects[0], { ...s.projects[1], selected: false }] });
    expect(calls[0][1]).toEqual({
      path: "/Users/me/work",
      projects: { "shop-api": "Shop_API" },
      tracker: { kind: "github" },
    });
  });

  test("リポジトリのルートは root の名前で . を渡す", async () => {
    const calls = daemon({
      "workspace.add": () => Promise.resolve({ ...ADDED_WORKSPACE, created: [] }),
    });
    await submitWizard(detected("/Users/me/git/Doctrine", DETECT_REPO_ROOT, { step: "confirm" }));
    expect(calls[0][1]).toEqual({
      path: "/Users/me/git/Doctrine",
      projects: { doctrine: "." },
      tracker: { kind: "github" },
    });
  });

  test("workspace.yaml があれば projects と tracker を渡さない", async () => {
    const calls = daemon({
      "workspace.add": () => Promise.resolve({ ...ADDED_WORKSPACE, created: [] }),
    });
    await submitWizard(detected("/Users/me/work", DETECT_EXISTING, { step: "confirm" }));
    expect(calls[0][1]).toEqual({ path: "/Users/me/work" });
  });

  test("workspace.add が失敗したら投げる", async () => {
    const calls = daemon({
      "workspace.add": () => Promise.reject("projects の web と api が同じパスを指しています"),
    });
    const s = detected("/Users/me/work", DETECT_PARENT, { step: "confirm" });
    await expect(submitWizard(s)).rejects.toBe("projects の web と api が同じパスを指しています");
    expect(calls.map(([m]) => m)).toEqual(["workspace.add"]);
  });
});
