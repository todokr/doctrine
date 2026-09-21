import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { IntakeProcessView } from "../../shared/protocol.ts";
import {
  ActionNeeded,
  CancelDialog,
  ProcessTrail,
  ProgressActions,
  ReviseDecide,
  WatchAlert,
} from "./components/IntakeProgress";
import { INTAKE_ACTIVE, NOW, PFD_SAMPLE, PFD_STATUSES_A } from "./fixtures";
import { actionNeeded, progressOps, summaryOf } from "./intake";

const noop = () => {};
const disabled = (label: string) => new RegExp(`<button[^>]*disabled=""[^>]*>${label}</button>`);

function needed(o: Partial<Parameters<typeof ActionNeeded>[0]> = {}) {
  return renderToStaticMarkup(
    <ActionNeeded
      pfd={PFD_SAMPLE}
      items={actionNeeded(INTAKE_ACTIVE, PFD_SAMPLE)}
      notes={{}}
      pending={null}
      onNote={noop}
      onComplete={noop}
      onRedispatch={noop}
      onOpenTask={noop}
      {...o}
    />,
  );
}

describe("ActionNeeded", () => {
  test("あなたの番は目的・完了条件・決めた内容の欄を出し、空なら記録できない", () => {
    const html = needed();
    for (const text of ["受け入れる", "あなたの番", "決めた内容"]) expect(html).toContain(text);
    expect(html).toMatch(disabled("完了を記録する"));
    expect(needed({ notes: { approve: "OK" } })).not.toMatch(disabled("完了を記録する"));
    expect(needed({ notes: { approve: "OK" }, pending: "approve" })).toMatch(disabled("完了を記録する"));
  });

  test("要確認は理由とタスクと再投入を出す", () => {
    const html = needed();
    for (const text of ["要確認（タスクが止まった）", "t1", "再投入する"]) expect(html).toContain(text);
  });

  test("どちらも無ければ何も出さない", () => {
    expect(needed({ items: { yourTurn: [], needsAttention: [] } })).toBe("");
  });
});

describe("WatchAlert", () => {
  test("失敗が続けば回数と最後のエラーを出す", () => {
    const watch = { consecutiveFailures: 2, lastError: "HTTP 502", lastSucceededAt: new Date(NOW).toISOString() };
    const html = renderToStaticMarkup(<WatchAlert watch={watch} now={NOW} />);
    for (const text of ["2 回続けて失敗", "HTTP 502", "最後に成功"]) expect(html).toContain(text);
    expect(renderToStaticMarkup(<WatchAlert watch={{ ...watch, consecutiveFailures: 0 }} now={NOW} />)).toBe("");
  });
});

const trail = (view: IntakeProcessView) => renderToStaticMarkup(<ProcessTrail view={view} onOpenTask={noop} />);
const count = (html: string, text: string) => html.split(text).length - 1;

describe("ProcessTrail", () => {
  test("sub-issue・タスク・PR を別々の欄に出す", () => {
    const design = INTAKE_ACTIVE.processes.find((p) => p.id === "design")!;
    const html = trail(design);
    for (const title of ["sub-issue", "タスク", "PR"]) expect(count(html, `<h3>${title}</h3>`)).toBe(1);
    expect(html).toContain(design.sub_issue_url!);
    expect(html.indexOf("t1")).toBeLessThan(html.indexOf("t-old"));
    expect(html).toMatch(/<h3>PR<\/h3>[\s\S]*なし/);
  });

  test("PR の番号と状態", () => {
    const view = { ...PFD_STATUSES_A["build-api"], id: "build-api", sub_issue_url: null, task_ids: ["t2"] } as IntakeProcessView;
    const html = trail(view);
    expect(html).toContain("#42");
    expect(html).toContain("レビュー中");
    expect(html).toContain("まだありません");
  });

  test("人の完了は記録した内容を出す", () => {
    const view = { ...PFD_STATUSES_A.approve, id: "approve", sub_issue_url: null, task_ids: [] } as IntakeProcessView;
    const html = trail(view);
    expect(html).toContain("完了（人）");
    expect(html).toContain("確認した");
  });
});

const actions = (o: Partial<Parameters<typeof ProgressActions>[0]> & { state?: "active" | "completed" | "canceled" } = {}) => {
  const { state = "active", ...rest } = o;
  const ops = progressOps({ ...summaryOf(INTAKE_ACTIVE), state });
  return renderToStaticMarkup(
    <ProgressActions
      ops={ops}
      paused={false}
      pending={false}
      onRefresh={noop}
      onTogglePause={noop}
      onRevise={noop}
      onCloseIssue={noop}
      {...rest}
    />,
  );
};

describe("ProgressActions", () => {
  test("進行中は確認・一時停止・改訂", () => {
    const html = actions();
    for (const text of ["いま確認する", "自動投入を一時停止", "改訂に入る…"]) expect(html).toContain(text);
    expect(html).not.toContain("Issue を閉じる");
    expect(actions({ paused: true })).toContain("自動投入を再開");
  });

  test("完了は Issue を閉じるだけ", () => {
    const html = actions({ state: "completed" });
    expect(html).toContain("Issue を閉じる");
    for (const text of ["いま確認する", "自動投入", "改訂に入る"]) expect(html).not.toContain(text);
  });

  test("中止した Intake は操作を出さない", () => {
    expect(actions({ state: "canceled" })).toBe("");
  });
});

describe("ReviseDecide", () => {
  test("コメントが無いと改訂を始められない", () => {
    const decide = (canStart: boolean) =>
      renderToStaticMarkup(
        <ReviseDecide count={0} whole="" canStart={canStart} pending={false} onWhole={noop} onStart={noop} onLeave={noop} />,
      );
    expect(decide(false)).toMatch(disabled("改訂を始める"));
    expect(decide(true)).not.toMatch(disabled("改訂を始める"));
  });
});

describe("CancelDialog", () => {
  const dialog = (approved: boolean) =>
    renderToStaticMarkup(<CancelDialog approved={approved} pending={false} onSend={noop} onClose={noop} />);

  test("承認済みならタスクと sub-issue の扱いを選ばせる", () => {
    const html = dialog(true);
    expect(html).toContain("そのままにする");
    expect(html).toContain("タスクを止め、sub-issue を取りやめとして閉じる");
  });

  test("承認前は選択肢を出さない", () => {
    const html = dialog(false);
    expect(html).not.toContain("そのままにする");
    expect(html).not.toContain("タスクを止め、sub-issue を取りやめとして閉じる");
    expect(html).toContain("中止する");
  });
});
