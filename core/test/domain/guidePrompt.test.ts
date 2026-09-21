import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { buildGuidePrompt, type GuidePromptInput } from "../../src/domain/guidePrompt.ts";
import { GUIDE_HUNKS_RELPATH } from "../../src/domain/guideInputs.ts";

function inputOf(over: Partial<GuidePromptInput> = {}): GuidePromptInput {
  return {
    ctx: {
      task: { id: "t1", title: "タイトル", prompt: "Issue #49 を実装する", branch: "b" },
      issue: { url: null, parent_url: null },
      worktree: { path: "/w" },
      project: { path: "/p" },
      steps: {},
    },
    mergeBase: "abc1234",
    tree: "def5678",
    lastCommand: null,
    rejections: [],
    ...over,
  };
}

test("タスクの指示がそのまま入る", () => {
  assert.ok(buildGuidePrompt(inputOf()).includes("Issue #49 を実装する"));
});

test("テスト結果のステップid・終了コード・stdout・stderr が入る", () => {
  const p = buildGuidePrompt(inputOf({
    lastCommand: {
      stepId: "verify",
      exitCode: 1,
      stdout: "1 テスト失敗",
      stderr: "型が合いません",
    },
  }));
  for (const s of ["verify", "終了コード: 1", "1 テスト失敗", "型が合いません"]) {
    assert.ok(p.includes(s), s);
  }
});

test("シグナルで殺されたテスト結果も書ける", () => {
  const p = buildGuidePrompt(inputOf({
    lastCommand: { stepId: "verify", exitCode: null, stdout: "", stderr: "" },
  }));
  assert.ok(p.includes("シグナルで終了"));
});

test("テスト結果が無くても組み立てが失敗せず、タスクの指示は残る", () => {
  const p = buildGuidePrompt(inputOf({ lastCommand: null }));
  assert.ok(p.length > 0);
  assert.ok(p.includes("Issue #49 を実装する"));
  assert.ok(p.includes("テストの結果は渡されていません"));
});

test("人の差し戻しコメントが古い順に入る", () => {
  const p = buildGuidePrompt(inputOf({ rejections: ["1回目の指摘", "2回目の指摘"] }));
  assert.ok(p.includes("1回目の指摘"));
  assert.ok(p.includes("2回目の指摘"));
  assert.ok(p.indexOf("1回目の指摘") < p.indexOf("2回目の指摘"));
});

test("差し戻しが無いときは差し戻しの節を出さない", () => {
  assert.ok(!buildGuidePrompt(inputOf()).includes("差し戻"));
});

test(".doctrine-out/ の計画・計画レビュー・セルフレビューが探索先として指示される", () => {
  const p = buildGuidePrompt(inputOf());
  for (const f of ["plan.md", "plan-review.md", "review.md"]) {
    assert.ok(p.includes(`/w/.doctrine-out/${f}`), f);
  }
});

test(".doctrine-out/ に何も無くても書けることを指示する", () => {
  assert.ok(buildGuidePrompt(inputOf()).includes("無ければ、`.doctrine-out/` にあるものだけ"));
});

test("diff は merge-base と記録したツリーの間で読ませる", () => {
  const p = buildGuidePrompt(inputOf({ mergeBase: "abc1234", tree: "def5678" }));
  assert.ok(p.includes("git diff -M abc1234 def5678"));
  assert.ok(p.includes(":(exclude).doctrine-out/"));
});

test("リポジトリの構造は自分で読ませる", () => {
  assert.ok(
    buildGuidePrompt(inputOf()).includes("リポジトリの構造（変更されたファイルの周辺のコード）"),
  );
});

test("hunk の一覧のパスが絶対パスで入る", () => {
  assert.ok(buildGuidePrompt(inputOf()).includes(`/w/${GUIDE_HUNKS_RELPATH}`));
});

test("行番号ではなく hunk の id で指させる", () => {
  const p = buildGuidePrompt(inputOf());
  assert.ok(p.includes("行番号では指さない"));
  assert.ok(p.includes("id"));
});

test("Risks は事実を書かせ、読み手への指示を書かせない", () => {
  const p = buildGuidePrompt(inputOf());
  for (const k of ["breaks", "assumption", "unknown", "considered"]) {
    assert.ok(p.includes(k), k);
  }
  assert.ok(p.includes("読み手への指示は書かない"));
});

test("Risks に impact の 3 段階を書かせる", () => {
  const p = buildGuidePrompt(inputOf());
  for (const k of ["impact", "high", "medium", "low"]) {
    assert.ok(p.includes(k), k);
  }
});

test("impact は、悪い方に転んだときに起きることで選ばせる", () => {
  assert.ok(buildGuidePrompt(inputOf()).includes("悪い方に転んだとき"));
});

test("considered に残すものを、経緯のある論点に絞らせる", () => {
  const p = buildGuidePrompt(inputOf());
  assert.ok(p.includes("計画レビュー"));
  assert.ok(p.includes("セルフコードレビュー"));
  assert.ok(p.includes("論点になり"));
});

test("重大度を付けないという指示は残っていない", () => {
  assert.ok(!buildGuidePrompt(inputOf()).includes("重大度も付けません"));
});

test("図はシーケンスとグラフの2形に限らせる", () => {
  const p = buildGuidePrompt(inputOf());
  assert.ok(p.includes("sequence"));
  assert.ok(p.includes("graph"));
});

test("version は書かせ、tree と createdAt は書かせない", () => {
  const p = buildGuidePrompt(inputOf());
  assert.ok(p.includes("version"));
  assert.ok(p.includes("`tree` と `createdAt` は doctrine が付けるので書かない"));
});

test("task.prompt の {{ }} は展開されずそのまま残る", () => {
  const base = inputOf();
  const p = buildGuidePrompt({
    ...base,
    ctx: { ...base.ctx, task: { ...base.ctx.task, prompt: "{{ task.id }} を直す" } },
  });
  assert.ok(p.includes("{{ task.id }} を直す"));
});
