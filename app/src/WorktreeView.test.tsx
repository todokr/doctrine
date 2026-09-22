import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RemoveConfirm, WarningList, WorktreeRow } from "./components/WorktreeView";
import { NOW, PROJECTS, seedTasks } from "./fixtures";
import { DAY } from "./worktrees";
import type { WorktreeEntry } from "../../shared/protocol.ts";

const tasks = seedTasks();
const noop = () => {};

const entry = (overrides: Partial<WorktreeEntry> = {}): WorktreeEntry => ({
  project: "~/git/doctrine",
  path: "/s/worktrees/doctrine/x",
  branch: "doctrine/x",
  task_id: null,
  task_state: null,
  intake_id: null,
  dirty: false,
  age_basis: new Date(NOW - 1 * DAY).toISOString(),
  ...overrides,
});

const row = (e: WorktreeEntry, staleDays: number | null = 7) =>
  renderToStaticMarkup(
    <WorktreeRow
      e={e}
      projects={PROJECTS}
      tasks={tasks}
      intakes={[]}
      staleDays={staleDays}
      now={NOW}
      onRemove={noop}
      onOpenTask={noop}
      onOpenIntake={noop}
    />,
  );

describe("WorktreeRow", () => {
  test("しきい値を超えた worktree の行を強調する", () => {
    const stale = row(entry({ task_state: "failed", age_basis: new Date(NOW - 8 * DAY).toISOString() }));
    expect(stale).toContain("wt-stale");
    expect(stale).toContain("古い");
    const fresh = row(entry({ task_state: "failed", age_basis: new Date(NOW - 2 * DAY).toISOString() }));
    expect(fresh).not.toContain("wt-stale");
    expect(fresh).not.toContain("古い");
  });

  test("非終端のタスクの行には削除ボタンを出さない", () => {
    const running = row(entry({ task_state: "running" }));
    expect(running).not.toContain("削除");
    const failed = row(entry({ task_state: "failed" }));
    expect(failed).toContain("削除");
  });

  test("持ち主と状態・未コミットの変更の有無を出す", () => {
    const h = row(entry({ task_id: "t-e812", task_state: "failed", dirty: true }));
    expect(h).toContain("daemon.warning イベントを追加する");
    expect(h).toContain("失敗");
    expect(h).toContain("未コミットの変更あり");
    const orphan = row(entry());
    expect(orphan).toContain("孤児");
  });
});

describe("RemoveConfirm", () => {
  const confirm = (dirty: boolean | null) =>
    renderToStaticMarkup(
      <RemoveConfirm path="/s/worktrees/doctrine/x" dirty={dirty} pending={false} onConfirm={noop} onCancel={noop} />,
    );

  test("未コミットの変更がある worktree の削除確認には失われる旨が出る", () => {
    const h = confirm(true);
    expect(h).toContain("失われ");
    expect(h).toContain("/s/worktrees/doctrine/x");
    expect(confirm(false)).not.toContain("失われ");
  });

  test("送信中は削除を押せない", () => {
    const pending = renderToStaticMarkup(
      <RemoveConfirm path="/s/worktrees/doctrine/x" dirty={false} pending onConfirm={noop} onCancel={noop} />,
    );
    expect(pending).toMatch(/<button[^>]*disabled=""[^>]*>削除する<\/button>/);
  });
});

describe("WarningList", () => {
  test("警告は新しい順に並び、task_id があればそのタスクへのボタンを出す", () => {
    const h = renderToStaticMarkup(
      <WarningList
        warnings={[
          { at: "2026-09-15T10:00:00.000Z", message: "古い方の警告本文" },
          { at: "2026-09-15T12:00:00.000Z", message: "新しい方の警告本文", task_id: "t-e812" },
        ]}
        tasks={tasks}
        now={NOW}
        onOpenTask={noop}
      />,
    );
    expect(h.indexOf("新しい方の警告本文")).toBeLessThan(h.indexOf("古い方の警告本文"));
    expect(h).toContain("daemon.warning イベントを追加する");
  });
});
