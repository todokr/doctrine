import { describe, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { IntakeRetryHint, RetryButton, SetupDoneNotice, SetupRetryHint, TaskActions } from "./components/TaskView";
import { retryInit } from "./composer";
import { PROJECTS, seedTasks, setupTask } from "./fixtures";
import type { Task } from "./types";

const task = (id: string) => seedTasks().find((t) => t.id === id)!;
const noop = () => {};

const html = (t: Task, pending: Parameters<typeof TaskActions>[0]["pending"] = null) =>
  renderToStaticMarkup(
    <TaskActions t={t} pending={pending} onPause={noop} onResume={noop} onCancel={noop}>
      <button className="btn sm">worktree の操作</button>
    </TaskActions>,
  );

const disabled = (label: string) => new RegExp(`<button[^>]*disabled=""[^>]*>${label}</button>`);

describe("TaskActions", () => {
  test("一時停止は queued・running・rate_limited で出る", () => {
    for (const id of ["t-91e0", "t-7f3a", "t-f22b"]) {
      const h = html(task(id));
      expect(h).toContain("一時停止");
      expect(h).not.toContain("再開");
    }
  });

  test("再開は paused でだけ出る", () => {
    const paused = html(task("t-d5e6"));
    expect(paused).toContain("再開");
    expect(paused).not.toContain("一時停止");
    const suspended = html(task("t-2b91"));
    expect(suspended).not.toContain("再開");
    expect(suspended).not.toContain("一時停止");
  });

  test("終端では一時停止・再開・中止を出さない", () => {
    for (const id of ["t-e812", "s-1105"]) {
      const h = html(task(id));
      expect(h).not.toContain("一時停止");
      expect(h).not.toContain("再開");
      expect(h).not.toContain("中止");
    }
  });

  test("送信中は一時停止・再開・中止を押せない", () => {
    const running = task("t-7f3a");
    const sending = html(running, "pause");
    expect(sending).toMatch(disabled("一時停止"));
    expect(sending).toMatch(disabled("中止"));
    const idle = html(running, null);
    expect(idle).not.toMatch(disabled("一時停止"));
    expect(idle).not.toMatch(disabled("中止"));
    expect(html(task("t-d5e6"), "resume")).toMatch(disabled("再開"));
  });

  test("worktree の操作は送信中でも止めず、そのまま並べる", () => {
    expect(html(task("t-7f3a"), "pause")).not.toMatch(disabled("worktree の操作"));
    expect(html(task("t-7f3a"))).toContain("worktree の操作");
  });

  test("仮の表示が残っていない", () => {
    for (const id of ["t-91e0", "t-7f3a", "t-f22b", "t-d5e6", "t-2b91", "t-e812", "s-1105"]) {
      expect(html(task(id))).not.toContain("第2段階");
    }
  });
});

describe("RetryButton", () => {
  test("「同じ内容で投入し直す」のボタンを出す", () => {
    const h = renderToStaticMarkup(<RetryButton init={retryInit(task("t-e812"), PROJECTS)} onOpen={noop} />);
    expect(h).toContain("同じ内容で投入し直す");
    expect(h).toContain('class="btn sm"');
  });

  test("押すと元のタスクの中身を渡してコンポーザを開く", () => {
    const onOpen = vi.fn();
    RetryButton({ init: retryInit(task("s-1105"), PROJECTS), onOpen }).props.onClick();
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith({
      project: "~/work/shop-api",
      workflow: "shop-api/feature",
      title: "決済 Webhook の署名検証",
      prompt: "決済 Webhook の署名検証。詳細は issue を参照してください。",
    });
  });
});

describe("IntakeRetryHint", () => {
  test("Intake の再投入を案内し、投入し直すボタンは出さない", () => {
    const h = renderToStaticMarkup(<IntakeRetryHint intakeId="i1" onOpenIntake={noop} />);
    expect(h).toContain("再投入する");
    expect(h).toContain("Intake を開く");
    expect(h).not.toContain("同じ内容で投入し直す");
    expect(h).not.toContain("pfd.yaml");
  });
});

describe("SetupDoneNotice", () => {
  const COMMIT = "コミットしてから、Issue を取り込むかタスクを作ってください";

  test("setup のタスクが completed ならコミットの案内を出す", () => {
    const h = renderToStaticMarkup(<SetupDoneNotice t={setupTask("completed")} />);
    expect(h).toContain(".doctrine/workflows/default.yaml");
    expect(h).toContain("（未コミット）");
    expect(h).toContain(COMMIT);
  });

  test("setup のタスクでも completed でなければ出さない", () => {
    for (const state of ["running", "suspended", "failed"] as const) {
      expect(renderToStaticMarkup(<SetupDoneNotice t={setupTask(state)} />)).toBe("");
    }
  });

  test("ほかのワークフローのタスクには出さない", () => {
    expect(renderToStaticMarkup(<SetupDoneNotice t={task("t-0a77")} />)).toBe("");
    expect(renderToStaticMarkup(<SetupDoneNotice t={{ ...setupTask("completed"), wf: "default" }} />)).toBe("");
  });
});

describe("SetupRetryHint", () => {
  test("worktree が残っていれば .doctrine-out/default.yaml を写す案内と、雛形を直す案内を出す", () => {
    const h = renderToStaticMarkup(
      <SetupRetryHint t={{ ...setupTask("failed"), worktree: "/Users/me/.doctrine/worktrees/t-5e70" }} />,
    );
    expect(h).toContain(".doctrine-out/default.yaml");
    expect(h).toContain("shop-api");
    expect(h).toContain(".doctrine/workflows/default.yaml");
    expect(h).toContain("雛形");
    expect(h).not.toContain("同じ内容で投入し直す");
  });

  test("worktree が無ければ雛形を直す案内だけを出す", () => {
    const h = renderToStaticMarkup(<SetupRetryHint t={setupTask("canceled")} />);
    expect(h).not.toContain(".doctrine-out/default.yaml");
    expect(h).toContain("雛形");
  });

  test("ほかのワークフローのタスクには出さない", () => {
    expect(renderToStaticMarkup(<SetupRetryHint t={task("t-e812")} />)).toBe("");
  });
});
