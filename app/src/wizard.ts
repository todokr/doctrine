// 初回ウィザードの状態と遷移。画面に依存しない（テストは wizard.test.ts）
import { rpc } from "./daemon/client";
import type {
  SetupPolicy,
  TaskSummary,
  TrackerConfig,
  WorkspaceDetection,
  WorkspaceSummary,
} from "../../shared/protocol.ts";

export type WizardStep = "welcome" | "directory" | "projects" | "tracker" | "policy" | "confirm";

export type WizardState = {
  step: WizardStep;
  path: string | null;
  detection: WorkspaceDetection | null;
  projects: { dir: string; name: string; selected: boolean }[];
  tracker: TrackerConfig;
  policy: SetupPolicy;
  error: string | null;
};

/** doctrine 自身の .doctrine/workflows/default.yaml に合わせた既定 */
export const DEFAULT_POLICY: SetupPolicy = {
  plan: true,
  agentReview: true,
  guide: true,
  approval: "after_implement",
  pr: "open_and_wait",
  sync: true,
  models: {
    plan: "claude-opus-5-5",
    implement: "claude-opus-5-5",
    review: "claude-opus-5-5",
    guide: "claude-opus-5-5",
  },
};

export function initialWizard(): WizardState {
  return {
    step: "welcome",
    path: null,
    detection: null,
    projects: [],
    tracker: { kind: "github" },
    policy: DEFAULT_POLICY,
    error: null,
  };
}

// core/src/db/workspaces.ts の projectNameFrom。app からは import できないので写している
const projectNameFrom = (dirName: string) =>
  dirName.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "project";

const basename = (path: string) => path.replace(/\/+$/, "").split("/").pop() ?? path;

/** workspace.detect の結果を受け取る。プロジェクト構成の初期値もここで決める */
export function withDetection(s: WizardState, path: string, detection: WorkspaceDetection): WizardState {
  const projects = detection.existing
    ? Object.entries(detection.existing.projects).map(([name, dir]) => ({ dir, name, selected: true }))
    : detection.isRepoRoot
    ? [{ dir: ".", name: projectNameFrom(basename(path)), selected: true }]
    : detection.repositories.map((r) => ({ dir: r.dir, name: r.suggestedName, selected: true }));
  return {
    ...s,
    path,
    detection,
    projects,
    tracker: detection.existing?.tracker ?? s.tracker,
    error: null,
  };
}

const PROJECT_NAME = /^[a-z0-9-]+$/;

/** 次へ進めるか。進めないときは理由の文言 */
export function blocker(s: WizardState): string | null {
  switch (s.step) {
    case "directory": {
      if (s.path === null) return "ディレクトリを選んでください";
      if (s.detection === null) return s.error ?? "ディレクトリを調べています";
      const d = s.detection;
      if (d.alreadyRegistered) return "このディレクトリは workspace として登録済みです";
      if (!d.existing && !d.isRepoRoot && d.repositories.length === 0) {
        return "git リポジトリではなく、直下にも git リポジトリがありません。別のディレクトリを選んでください";
      }
      return null;
    }
    case "projects": {
      if (s.detection?.existing || s.detection?.isRepoRoot) return null;
      const chosen = s.projects.filter((p) => p.selected);
      if (chosen.length === 0) return "プロジェクトを 1 つ以上選んでください";
      const bad = chosen.find((p) => !PROJECT_NAME.test(p.name));
      if (bad) return `名前「${bad.name}」は英小文字・数字・ハイフン（[a-z0-9-]+）で書いてください`;
      const dup = chosen.find((p, i) => chosen.findIndex((q) => q.name === p.name) !== i);
      if (dup) return `名前「${dup.name}」が重なっています`;
      return null;
    }
    case "tracker":
      return s.tracker.kind === "linear" && s.tracker.team.trim() === ""
        ? "Linear のチームのキーを入力してください"
        : null;
    case "policy": {
      const empty = Object.entries(s.policy.models).find(([, m]) => m.trim() === "");
      return empty ? "モデルをすべての役割に入れてください" : null;
    }
    default:
      return null;
  }
}

const ORDER: WizardStep[] = ["welcome", "directory", "projects", "tracker", "policy", "confirm"];

/** workspace.yaml があればトラッカーは決まっているので聞かない */
const skipped = (s: WizardState, step: WizardStep) => step === "tracker" && s.detection?.existing != null;

export function next(s: WizardState): WizardStep {
  const rest = ORDER.slice(ORDER.indexOf(s.step) + 1).filter((step) => !skipped(s, step));
  return rest[0] ?? s.step;
}

export function prev(s: WizardState): WizardStep {
  const before = ORDER.slice(0, ORDER.indexOf(s.step)).filter((step) => !skipped(s, step));
  return before.at(-1) ?? s.step;
}

type Choice<K extends keyof SetupPolicy> = {
  key: K;
  label: string;
  options: { label: string; value: SetupPolicy[K] }[];
};

export type PolicyQuestion =
  | Choice<"plan">
  | Choice<"agentReview">
  | Choice<"guide">
  | Choice<"approval">
  | Choice<"pr">
  | Choice<"sync">
  | { key: "models"; label: string };

const inOut = [{ label: "入れる", value: true }, { label: "入れない", value: false }];

/** ワークフローの方針の問。base branch への追従は PR を開く方針のときだけ聞く */
export function policyQuestions(p: SetupPolicy): PolicyQuestion[] {
  const qs: PolicyQuestion[] = [
    { key: "plan", label: "計画と計画審査", options: inOut },
    { key: "agentReview", label: "AI によるコードレビュー", options: inOut },
    { key: "guide", label: "レビューガイド", options: inOut },
    {
      key: "approval",
      label: "人の承認の位置",
      options: [
        { label: "実装の後だけ", value: "after_implement" },
        { label: "計画の後にも", value: "after_plan_and_implement" },
      ],
    },
    {
      key: "pr",
      label: "PR とマージ待ち",
      options: [
        { label: "PR を開いてマージを待つ", value: "open_and_wait" },
        { label: "ブランチで止める", value: "branch_only" },
      ],
    },
  ];
  if (p.pr === "open_and_wait") {
    qs.push({
      key: "sync",
      label: "base branch への追従",
      options: [{ label: "PR の前に取り込む", value: true }, { label: "取り込まない", value: false }],
    });
  }
  qs.push({ key: "models", label: "モデル" });
  return qs;
}

export const MODEL_ROLES: { key: keyof SetupPolicy["models"]; label: string }[] = [
  { key: "plan", label: "計画" },
  { key: "implement", label: "実装" },
  { key: "review", label: "審査" },
  { key: "guide", label: "ガイド" },
];

/** setup の対象: created に <project>/.doctrine/workflows/default.yaml が入っているプロジェクトの名前 */
export function setupTargets(summary: WorkspaceSummary, created: string[]): string[] {
  return summary.projects
    .filter((p) => created.includes(`${p.path}/.doctrine/workflows/default.yaml`))
    .map((p) => p.name);
}

/** workspace.add は通った（workspace は登録済み）が、workspace.setup が失敗した */
export class WorkspaceSetupError extends Error {}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 確認画面の確定。workspace.add → （対象があれば）workspace.setup */
export async function submitWizard(s: WizardState): Promise<{ tasks: TaskSummary[] }> {
  if (s.path === null || s.detection === null) throw new Error("ディレクトリが選ばれていません");
  // workspace.yaml があれば、中身はそちらが決める
  const init = s.detection.existing ? {} : {
    projects: Object.fromEntries(s.projects.filter((p) => p.selected).map((p) => [p.name, p.dir])),
    tracker: s.tracker.kind === "linear" ? { ...s.tracker, team: s.tracker.team.trim() } : s.tracker,
  };
  const added = await rpc("workspace.add", { path: s.path, ...init });
  const targets = setupTargets(added, added.created);
  if (targets.length === 0) return { tasks: [] };
  const policy = { ...s.policy, sync: s.policy.pr === "open_and_wait" && s.policy.sync };
  try {
    return { tasks: await rpc("workspace.setup", { workspace: added.id, projects: targets, policy }) };
  } catch (e) {
    throw new WorkspaceSetupError(errorMessage(e));
  }
}
