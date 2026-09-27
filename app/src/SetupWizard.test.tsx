import { renderToStaticMarkup } from "react-dom/server";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, test, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { SetupFailedScreen, WizardScreen } from "./components/SetupWizard";
import { DETECT_EXISTING, DETECT_PARENT, DETECT_REPO_ROOT } from "./fixtures";
import { DEFAULT_POLICY, initialWizard, withDetection, type WizardState } from "./wizard";

const noop = () => {};

const html = (s: WizardState, o: { closable?: boolean; pending?: boolean } = {}) =>
  renderToStaticMarkup(
    <WizardScreen
      s={s}
      closable={o.closable ?? false}
      pending={o.pending ?? false}
      onChange={noop}
      onPick={noop}
      onNext={noop}
      onBack={noop}
      onSubmit={noop}
      onClose={noop}
    />,
  );

const at = (step: WizardState["step"], patch: Partial<WizardState> = {}): WizardState => ({
  ...withDetection(initialWizard(), "/Users/me/work", DETECT_PARENT),
  step,
  ...patch,
});

/** 選ばれている選択肢のラベル。<input checked> の直後に置いたテキスト */
const checkedLabels = (h: string) =>
  [...h.matchAll(/<input[^>]*checked=""[^>]*\/>([^<]+)</g)].map((m) => m[1]);

describe("WizardScreen", () => {
  test("policy の画面に 7 問が既定値つきで出る", () => {
    const h = html(at("policy"));
    for (const q of ["計画と計画審査", "AI によるコードレビュー", "レビューガイド", "人の承認の位置", "PR とマージ待ち", "base branch への追従", "モデル"]) {
      expect(h).toContain(q);
    }
    expect(checkedLabels(h)).toEqual(["入れる", "入れる", "入れる", "実装の後だけ", "PR を開いてマージを待つ", "PR の前に取り込む"]);
    expect(h.match(/<input[^>]*value="claude-opus-5-5"/g)).toHaveLength(4);
  });

  test("PR を開かない方針なら追従の問を出さない", () => {
    const h = html(at("policy", { policy: { ...DEFAULT_POLICY, pr: "branch_only", sync: false } }));
    expect(h).not.toContain("base branch への追従");
  });

  test("linear を選ぶと config.json の手順が出る", () => {
    expect(html(at("tracker"))).not.toContain("config.json");
    const h = html(at("tracker", { tracker: { kind: "linear", team: "ENG" } }));
    expect(h).toContain("config.json");
    expect(h).toContain("linearApiKey");
    expect(h).toContain("dctld を起動し直す");
  });

  test("blocker があると次へのボタンが無効で理由が出る", () => {
    const h = html(at("tracker", { tracker: { kind: "linear", team: "" } }));
    expect(h).toMatch(/<button[^>]*disabled=""[^>]*>次へ<\/button>/);
    expect(h).toContain("Linear のチームのキーを入力してください");
    expect(html(at("tracker"))).not.toMatch(/<button[^>]*disabled=""[^>]*>次へ<\/button>/);
  });

  test("git のルートならプロジェクトは 1 つで選ばせない", () => {
    const h = html({ ...withDetection(initialWizard(), "/Users/me/git/doctrine", DETECT_REPO_ROOT), step: "projects" });
    expect(h).toContain("doctrine");
    expect(h).not.toContain('type="checkbox"');
  });

  test("workspace.yaml があればプロジェクト構成は表示だけ", () => {
    const h = html({ ...withDetection(initialWizard(), "/Users/me/work", DETECT_EXISTING), step: "projects" });
    expect(h).toContain("api");
    expect(h).not.toContain("<input");
  });

  test("git 管理外なら直下のリポジトリをチェックボックスと名前で選ばせる", () => {
    const h = html(at("projects"));
    expect(h.match(/type="checkbox"/g)).toHaveLength(2);
    expect(h).toContain('value="shop-api"');
    expect(h).toContain("Shop_API");
  });

  test("確認の画面に setup の対象の決め方と、確定のボタンが出る", () => {
    const h = html(at("confirm"));
    expect(h).toContain("shop-api");
    expect(h).toContain("登録する");
    expect(h).not.toContain(">次へ<");
  });

  test("確認で失敗したら理由を出す", () => {
    expect(html(at("confirm", { error: "登録できませんでした: x" }))).toContain("登録できませんでした: x");
  });

  test("初回は閉じられず、サイドバーから開いたときは閉じられる", () => {
    expect(html(at("welcome"))).not.toContain("閉じる");
    expect(html(at("welcome"), { closable: true })).toContain("閉じる");
  });
});

/** 要素の木から、ラベルが label のボタンを探す（関数コンポーネントは展開しない） */
function findButton(node: ReactNode, label: string): ReactElement<{ onClick: () => void }> | null {
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = findButton(n, label);
      if (hit) return hit;
    }
    return null;
  }
  if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(node)) return null;
  if (node.type === "button" && node.props.children === label) return node as ReactElement<{ onClick: () => void }>;
  return findButton(node.props.children, label);
}

describe("SetupFailedScreen", () => {
  test("登録済みであること・理由・手で直す案内を出し、戻る道は出さない", () => {
    const h = renderToStaticMarkup(<SetupFailedScreen message="policy は必須です" onDone={noop} />);
    expect(h).toContain("workspace は登録しました");
    expect(h).toContain("policy は必須です");
    expect(h).toContain("タスク画面から手でワークフローを直してください");
    expect(h).not.toContain("戻る");
    expect(h).not.toContain("登録する");
  });

  test("閉じるボタンで onDone を呼ぶ", () => {
    const onDone = vi.fn();
    const button = findButton(SetupFailedScreen({ message: "x", onDone }), "タスク一覧へ");
    expect(button).not.toBeNull();
    button!.props.onClick();
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
