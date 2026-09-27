import { beforeEach, describe, expect, test, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn((..._: unknown[]): Promise<unknown> => Promise.resolve({})) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { ADDED_WORKSPACE, DETECT_EXISTING, DETECT_PARENT, DETECT_REPO_ROOT } from "./fixtures";
import {
  DEFAULT_POLICY,
  blocker,
  initialWizard,
  next,
  policyQuestions,
  setupTargets,
  submitWizard,
  withDetection,
  WorkspaceSetupError,
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

  test("workspace.yaml があれば tracker を飛ばして policy へ進む", () => {
    const s = detected("/Users/me/work", DETECT_EXISTING, { step: "projects" });
    expect(blocker(s)).toBeNull();
    expect(next(s)).toBe("policy");
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

  test("PR を開かない方針なら sync は false になり、追従の問を出さない", async () => {
    expect(policyQuestions(DEFAULT_POLICY)).toHaveLength(7);
    const branchOnly = { ...DEFAULT_POLICY, pr: "branch_only" as const, sync: true };
    expect(policyQuestions(branchOnly).map((q) => q.key)).not.toContain("sync");

    const calls = daemon({
      "workspace.add": () => Promise.resolve(ADDED_WORKSPACE),
      "workspace.setup": () => Promise.resolve([]),
    });
    await submitWizard(detected("/Users/me/work", DETECT_PARENT, { step: "confirm", policy: branchOnly }));
    const setup = calls.find(([m]) => m === "workspace.setup")!;
    expect((setup[1] as { policy: { sync: boolean } }).policy.sync).toBe(false);
  });
});

describe("setupTargets", () => {
  test("setupTargets は created に default.yaml が入っているプロジェクトだけを返す", () => {
    expect(setupTargets(ADDED_WORKSPACE, ADDED_WORKSPACE.created)).toEqual(["shop-api"]);
    expect(setupTargets(ADDED_WORKSPACE, [])).toEqual([]);
  });
});

describe("submitWizard", () => {
  test("submitWizard は workspace.add → workspace.setup の順に呼ぶ", async () => {
    const calls = daemon({
      "workspace.add": () => Promise.resolve(ADDED_WORKSPACE),
      "workspace.setup": () => Promise.resolve([{ id: "t-5e70" }]),
    });
    const s = detected("/Users/me/work", DETECT_PARENT, {
      step: "confirm",
      tracker: { kind: "linear", team: "ENG" },
    });
    const r = await submitWizard(s);
    expect(calls).toEqual([
      [
        "workspace.add",
        {
          path: "/Users/me/work",
          projects: { "shop-api": "Shop_API", web: "web" },
          tracker: { kind: "linear", team: "ENG" },
        },
      ],
      ["workspace.setup", { workspace: 7, projects: ["shop-api"], policy: DEFAULT_POLICY }],
    ]);
    expect(r.tasks).toEqual([{ id: "t-5e70" }]);
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
      "workspace.setup": () => Promise.resolve([]),
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

  test("setup の対象が無ければ workspace.setup を呼ばない", async () => {
    const calls = daemon({
      "workspace.add": () => Promise.resolve({ ...ADDED_WORKSPACE, created: ["/Users/me/work/web/.doctrine/project.yaml"] }),
    });
    const r = await submitWizard(detected("/Users/me/work", DETECT_PARENT, { step: "confirm" }));
    expect(calls.map(([m]) => m)).toEqual(["workspace.add"]);
    expect(r.tasks).toEqual([]);
  });

  test("workspace.add が失敗したら投げ、workspace.setup を呼ばない", async () => {
    const calls = daemon({
      "workspace.add": () => Promise.reject("projects の web と api が同じパスを指しています"),
    });
    const s = detected("/Users/me/work", DETECT_PARENT, { step: "confirm" });
    await expect(submitWizard(s)).rejects.toBe("projects の web と api が同じパスを指しています");
    expect(calls.map(([m]) => m)).toEqual(["workspace.add"]);
  });

  test("workspace.setup が失敗したら、登録済みであることが分かる形で投げる", async () => {
    daemon({
      "workspace.add": () => Promise.resolve(ADDED_WORKSPACE),
      "workspace.setup": () => Promise.reject("policy は必須です"),
    });
    const s = detected("/Users/me/work", DETECT_PARENT, { step: "confirm" });
    const e = await submitWizard(s).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(WorkspaceSetupError);
    expect((e as Error).message).toContain("policy は必須です");
  });
});
