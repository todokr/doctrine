import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TaskActions } from "./components/TaskView";
import { seedTasks } from "./fixtures";
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
