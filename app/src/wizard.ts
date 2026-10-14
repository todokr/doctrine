// 初回ウィザードの状態と遷移。画面に依存しない（テストは wizard.test.ts）
import { rpc } from "./daemon/client";
import type {
  TrackerConfig,
  WorkspaceDetection,
} from "../../shared/protocol.ts";

export type WizardStep = "welcome" | "directory" | "projects" | "tracker" | "confirm";

export type WizardState = {
  step: WizardStep;
  path: string | null;
  detection: WorkspaceDetection | null;
  projects: { dir: string; name: string; selected: boolean }[];
  tracker: TrackerConfig;
  error: string | null;
};

export function initialWizard(): WizardState {
  return {
    step: "welcome",
    path: null,
    detection: null,
    projects: [],
    tracker: { kind: "github" },
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
    default:
      return null;
  }
}

const ORDER: WizardStep[] = ["welcome", "directory", "projects", "tracker", "confirm"];

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

/** 確認画面の確定。workspace.add を呼ぶ */
export async function submitWizard(s: WizardState): Promise<void> {
  if (s.path === null || s.detection === null) throw new Error("ディレクトリが選ばれていません");
  // workspace.yaml があれば、中身はそちらが決める
  const init = s.detection.existing ? {} : {
    projects: Object.fromEntries(s.projects.filter((p) => p.selected).map((p) => [p.name, p.dir])),
    tracker: s.tracker.kind === "linear" ? { ...s.tracker, team: s.tracker.team.trim() } : s.tracker,
  };
  await rpc("workspace.add", { path: s.path, ...init });
}
