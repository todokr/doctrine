import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { IntakeProcessView } from "../../shared/protocol.ts";
import { ExecutionRow } from "./components/ExecutionSidebar";
import { DirectProcess } from "./components/ExecutionView";
import { INTAKES, NOW, WORKSPACES } from "./fixtures";

const noop = () => {};
const active = INTAKES.find((i) => i.id === "i2")!;

const row = (o: Partial<Parameters<typeof ExecutionRow>[0]> = {}) =>
  renderToStaticMarkup(
    <ExecutionRow intake={active} workspace={WORKSPACES[1]} attention={false} selected={false} now={NOW} onSelect={noop} {...o} />,
  );

describe("ExecutionRow", () => {
  test("種類の印を出す", () => {
    expect(row()).toContain(">Plan<");
    expect(row({ intake: { ...active, mode: "direct" } })).toContain(">Direct<");
  });

  test("人の番なら点を出し、行を human の色にする", () => {
    const html = row({ attention: true });
    expect(html).toContain('aria-label="あなたの番"');
    expect(html).toContain("tone-human");
    expect(row()).not.toContain('aria-label="あなたの番"');
  });

  test("完了は ok の色", () => {
    expect(row({ intake: { ...active, state: "completed" } })).toContain("tone-ok");
  });
});

const direct = (o: Partial<IntakeProcessView>): IntakeProcessView => ({
  id: "main",
  state: "running",
  taskId: "t1",
  sub_issue_url: null,
  task_ids: ["t1"],
  rail: null,
  ...o,
} as IntakeProcessView);

describe("DirectProcess", () => {
  test("Issue のタイトルと状態とタスクを出し、sub-issue の欄は出さない", () => {
    const html = renderToStaticMarkup(
      <DirectProcess title="ログインを直す" view={direct({})} pending={false} onRedispatch={noop} onOpenTask={noop} />,
    );
    expect(html).toContain("ログインを直す");
    expect(html).toContain("t1");
    expect(html).not.toContain("sub-issue");
    expect(html).not.toContain("再投入する");
  });

  test("要確認なら再投入のボタンを出す", () => {
    const html = renderToStaticMarkup(
      <DirectProcess
        title="ログインを直す"
        view={direct({ state: "needs_attention", taskId: "t1", reason: "task_stopped" } as Partial<IntakeProcessView>)}
        pending={false}
        onRedispatch={noop}
        onOpenTask={noop}
      />,
    );
    expect(html).toContain("再投入する");
  });

  test("プロセスがまだ届いていなければ読み込み中", () => {
    const html = renderToStaticMarkup(
      <DirectProcess title="x" view={undefined} pending={false} onRedispatch={noop} onOpenTask={noop} />,
    );
    expect(html).toContain("読み込み中");
  });
});
