import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { expand, type TemplateContext, TemplateError } from "../../src/workflow/template.ts";

const ctx: TemplateContext = {
  task: { id: "t1", title: "ログイン修正", prompt: "直して", branch: "doctrine/t1-login" },
  worktree: { path: "/state/wt/t1" },
  project: { path: "/repo" },
  steps: { test: { last_stdout: "ok", last_stderr: "3 failing", exitCode: "1" } },
};

test("4系統すべてを展開する", () => {
  assert.equal(expand("{{ task.prompt }}", ctx), "直して");
  assert.equal(expand("{{ task.branch }}", ctx), "doctrine/t1-login");
  assert.equal(expand("{{ worktree.path }}", ctx), "/state/wt/t1");
  assert.equal(expand("{{ project.path }}", ctx), "/repo");
  assert.equal(expand("{{ steps.test.last_stderr }}", ctx), "3 failing");
  assert.equal(expand("{{ steps.test.exitCode }}", ctx), "1");
});

test("空白の有無を問わない", () => {
  assert.equal(expand("{{task.id}}/{{  task.id  }}", ctx), "t1/t1");
});

test("1つの文字列に複数個埋められる", () => {
  assert.equal(
    expand("テストが失敗した:\n{{ steps.test.last_stderr }}", ctx),
    "テストが失敗した:\n3 failing",
  );
});

test("未知の系統は落とす", () => {
  assert.throws(() => expand("{{ env.HOME }}", ctx), (e: unknown) => {
    assert.ok(e instanceof TemplateError);
    assert.match((e as Error).message, /env\.HOME/);
    return true;
  });
});

test("未実行のステップを参照したら落とす", () => {
  assert.throws(() => expand("{{ steps.build.last_stdout }}", ctx), TemplateError);
});

test("ステップの未知のフィールドは落とす", () => {
  assert.throws(() => expand("{{ steps.test.cost }}", ctx), TemplateError);
});

test("変数を含まない文字列はそのまま返す", () => {
  assert.equal(expand("pnpm test", ctx), "pnpm test");
});

test("閉じられていないプレースホルダーは落とす", () => {
  assert.throws(() => expand("{{ task.prompt", ctx), (e: unknown) => {
    assert.ok(e instanceof TemplateError);
    assert.match((e as Error).message, /不正なプレースホルダー/);
    return true;
  });
});

test("空のプレースホルダーは落とす", () => {
  assert.throws(() => expand("{{}}", ctx), (e: unknown) => {
    assert.ok(e instanceof TemplateError);
    assert.match((e as Error).message, /不正なプレースホルダー/);
    return true;
  });
});

test("空白のみのプレースホルダーは落とす", () => {
  assert.throws(() => expand("{{ }}", ctx), (e: unknown) => {
    assert.ok(e instanceof TemplateError);
    assert.match((e as Error).message, /不正なプレースホルダー/);
    return true;
  });
});

test("プレースホルダー内に中括弧を含むと落とす", () => {
  assert.throws(() => expand("{{{{ task.id }}", ctx), (e: unknown) => {
    assert.ok(e instanceof TemplateError);
    assert.match((e as Error).message, /不正なプレースホルダー/);
    return true;
  });
});

test("代入された値に{{ }}を含むテンプレートは展開してもスルーする（再展開しない）", () => {
  const ctxWithTemplate: TemplateContext = {
    task: ctx.task,
    worktree: ctx.worktree,
    project: ctx.project,
    steps: {
      test: { last_stdout: "見つからない: {{ task.prompt }}", last_stderr: "error", exitCode: "1" },
    },
  };
  const result = expand("失敗:\n{{ steps.test.last_stdout }}", ctxWithTemplate);
  assert.equal(result, "失敗:\n見つからない: {{ task.prompt }}");
});

test("ステップidにドットを含めるとエラーメッセージで指摘する", () => {
  assert.throws(() => expand("{{ steps.my.step.last_stdout }}", ctx), (e: unknown) => {
    assert.ok(e instanceof TemplateError);
    assert.match((e as Error).message, /ステップidには . を含められません/);
    return true;
  });
});

test("ステップにフィールドがないと落とす", () => {
  assert.throws(() => expand("{{ steps.test }}", ctx), (e: unknown) => {
    assert.ok(e instanceof TemplateError);
    assert.match((e as Error).message, /ステップ出力を参照するにはフィールドが必要です/);
    return true;
  });
});

test("ステップ出力は最新の実行を指す名前で引く", () => {
  const ctx: TemplateContext = {
    task: { id: "t1", title: "T", prompt: "P", branch: "b" },
    worktree: { path: "/w" },
    project: { path: "/p" },
    steps: { test: { last_stdout: "ok", last_stderr: "3 failing", exitCode: "1" } },
  };
  assert.equal(expand("{{ steps.test.last_stdout }}", ctx), "ok");
  assert.equal(expand("{{ steps.test.last_stderr }}", ctx), "3 failing");
  assert.equal(expand("{{ steps.test.exitCode }}", ctx), "1");
});
