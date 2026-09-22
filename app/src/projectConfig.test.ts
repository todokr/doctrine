import { describe, expect, test } from "vitest";
import {
  assignSaveError,
  checkProjectConfigForm,
  toProjectConfigForm,
  workflowOptions,
} from "./projectConfig";

describe("toProjectConfigForm", () => {
  test("数値を文字列にし、setup が無ければ空にする", () => {
    expect(toProjectConfigForm({ defaultWorkflow: "default", maxConcurrent: 2, baseBranch: "main" }))
      .toEqual({ defaultWorkflow: "default", maxConcurrent: "2", baseBranch: "main", setup: "" });
  });

  test("setup はそのまま入る", () => {
    const form = toProjectConfigForm({
      defaultWorkflow: "default",
      maxConcurrent: 2,
      baseBranch: "main",
      setup: "pnpm install\n",
    });
    expect(form.setup).toBe("pnpm install\n");
  });
});

const FORM = { defaultWorkflow: "default", maxConcurrent: "2", baseBranch: "main", setup: "" };

describe("checkProjectConfigForm", () => {
  test("正しい値なら送る値になり、空の setup は null になる", () => {
    expect(checkProjectConfigForm(FORM)).toEqual({
      ok: true,
      value: { defaultWorkflow: "default", maxConcurrent: 2, baseBranch: "main", setup: null },
    });
  });

  test("baseBranch は前後の空白を落とす", () => {
    const r = checkProjectConfigForm({ ...FORM, baseBranch: " develop " });
    expect(r.ok).toBe(true);
    expect(r.ok && r.value.baseBranch).toBe("develop");
  });

  test("setup は中身があれば trim せずに送る", () => {
    const r = checkProjectConfigForm({ ...FORM, setup: "pnpm install\n" });
    expect(r.ok).toBe(true);
    expect(r.ok && r.value.setup).toBe("pnpm install\n");
  });

  test("空白だけの setup は null", () => {
    const r = checkProjectConfigForm({ ...FORM, setup: "  \n" });
    expect(r.ok).toBe(true);
    expect(r.ok && r.value.setup).toBeNull();
  });

  test.each(["0", "", "1.5", "-1", "2a"])("maxConcurrent が 1 以上の整数でなければ拒む: %s", (v) => {
    const r = checkProjectConfigForm({ ...FORM, maxConcurrent: v });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors.maxConcurrent).toBe("1 以上の整数を入れてください");
  });

  test("baseBranch が空なら拒む", () => {
    const r = checkProjectConfigForm({ ...FORM, baseBranch: "  " });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors.baseBranch).toBe("ブランチ名を入れてください");
  });

  test("defaultWorkflow が空なら拒む", () => {
    const r = checkProjectConfigForm({ ...FORM, defaultWorkflow: "" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors.defaultWorkflow).toBe("ワークフローを選んでください");
  });
});

describe("assignSaveError", () => {
  test("値の検証のエラーを欄に振り分ける", () => {
    const message = "ワークフロー定義が不正です:\n- maxConcurrent: 数値が小さすぎます（1以上が必要です）\n- baseBranch: 文字列が短すぎます（1文字以上必要です）";
    expect(assignSaveError(message)).toEqual({
      fields: {
        maxConcurrent: "数値が小さすぎます（1以上が必要です）",
        baseBranch: "文字列が短すぎます（1文字以上必要です）",
      },
      rest: null,
    });
  });

  test("ワークフローが読めないエラーは defaultWorkflow の欄に出す", () => {
    const message = "defaultWorkflow が指すワークフローを読めません: .doctrine/workflows/nope.yaml（No such file）";
    expect(assignSaveError(message)).toEqual({ fields: { defaultWorkflow: message }, rest: null });
  });

  test("欄に当たらない行は rest に残す", () => {
    const message = "ワークフロー定義が不正です:\n- baseBranch: 文字列が短すぎます（1文字以上必要です）\n- (root): 認識できないキーがあります: foo";
    const r = assignSaveError(message);
    expect(r.fields.baseBranch).toBe("文字列が短すぎます（1文字以上必要です）");
    expect(r.rest).toBe("- (root): 認識できないキーがあります: foo");
  });

  test("どの欄にも当たらなければ全文を rest にする", () => {
    const message = "ワークフロー定義が不正です:\n- YAMLとして読めません: bad";
    expect(assignSaveError(message)).toEqual({ fields: {}, rest: message });

    const message2 = "未登録のプロジェクトです: /x";
    expect(assignSaveError(message2)).toEqual({ fields: {}, rest: message2 });
  });
});

describe("workflowOptions", () => {
  test("一覧の名前が選択肢になる", () => {
    const entries: Parameters<typeof workflowOptions>[0] = [
      { name: "default", ok: true },
      { name: "quick", ok: true },
    ];
    expect(workflowOptions(entries, "default")).toEqual([
      { name: "default", label: "default" },
      { name: "quick", label: "quick" },
    ]);
  });

  test("読めないワークフローには（不正）を添える", () => {
    const entries: Parameters<typeof workflowOptions>[0] = [
      { name: "broken", ok: false, issues: ["x"] },
    ];
    expect(workflowOptions(entries, "broken")[0].label).toBe("broken（不正）");
  });

  test("今の値が一覧に無ければ（見つかりません）を先頭に足す", () => {
    const entries: Parameters<typeof workflowOptions>[0] = [{ name: "default", ok: true }];
    const r = workflowOptions(entries, "gone");
    expect(r[0]).toEqual({ name: "gone", label: "gone（見つかりません）" });
    expect(r[1]).toEqual({ name: "default", label: "default" });
  });
});
