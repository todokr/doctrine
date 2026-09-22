import { describe, expect, test } from "vitest";
import { NOW } from "./fixtures";
import {
  addWarning,
  canRemoveWorktree,
  DAY,
  isStaleWorktree,
  removeConfirmText,
  sortWarnings,
  WARNINGS_KEPT,
  worktreesNeedAttention,
} from "./worktrees";
import type { IntakeSummary, Warning, WorktreeEntry } from "../../shared/protocol.ts";

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

const intake = (id: string, state: IntakeSummary["state"]): IntakeSummary => ({
  id,
  project_id: 1,
  issue_url: `https://github.com/o/r/issues/1`,
  issue_title: "タイトル",
  state,
  revising: false,
  attention_reason: null,
  dispatch_paused: false,
  rate_limited_until: null,
  progress: { done: 0, total: 0 },
  needs_human: false,
  watch: { lastSucceededAt: null, consecutiveFailures: 0, lastError: null },
  created_at: new Date(NOW - 300 * 60000).toISOString(),
  updated_at: new Date(NOW - 5 * 60000).toISOString(),
});

describe("isStaleWorktree", () => {
  test("しきい値の日数以上経った終端タスクの worktree は古い", () => {
    const e = entry({ task_state: "failed", age_basis: new Date(NOW - 7 * DAY).toISOString() });
    expect(isStaleWorktree(e, [], 7, NOW)).toBe(true);
  });

  test("しきい値に届かなければ古くない", () => {
    const e = entry({
      task_state: "failed",
      age_basis: new Date(NOW - 7 * DAY + 60000).toISOString(),
    });
    expect(isStaleWorktree(e, [], 7, NOW)).toBe(false);
  });

  test("孤児は age_basis から数える", () => {
    const e = entry({ task_id: null, intake_id: null, age_basis: new Date(NOW - 10 * DAY).toISOString() });
    expect(isStaleWorktree(e, [], 7, NOW)).toBe(true);
    expect(isStaleWorktree(e, [], 14, NOW)).toBe(false);
  });

  test("終わっていないタスクの worktree は古いと言わない", () => {
    const e = entry({ task_state: "paused", age_basis: new Date(NOW - 30 * DAY).toISOString() });
    expect(isStaleWorktree(e, [], 7, NOW)).toBe(false);
  });

  test("進行中の Intake の worktree は古いと言わない", () => {
    const e = entry({
      task_id: null,
      intake_id: "i1",
      age_basis: new Date(NOW - 30 * DAY).toISOString(),
    });
    expect(isStaleWorktree(e, [intake("i1", "active")], 7, NOW)).toBe(false);
    expect(isStaleWorktree(e, [], 7, NOW)).toBe(true);
  });

  test("しきい値が読めていなければ強調しない", () => {
    const e = entry({ task_state: "failed", age_basis: new Date(NOW - 30 * DAY).toISOString() });
    expect(isStaleWorktree(e, [], null, NOW)).toBe(false);
  });
});

describe("canRemoveWorktree", () => {
  test("非終端のタスクの worktree は消させない", () => {
    for (const state of ["queued", "running", "suspended", "paused", "rate_limited"] as const) {
      expect(canRemoveWorktree(entry({ task_state: state }), [])).toBe(false);
    }
  });

  test("終端のタスクと孤児は消せる", () => {
    for (const state of ["failed", "completed", "canceled"] as const) {
      expect(canRemoveWorktree(entry({ task_state: state }), [])).toBe(true);
    }
    expect(canRemoveWorktree(entry(), [])).toBe(true);
  });

  test("進行中の Intake は消させない", () => {
    const e = entry({ intake_id: "i1" });
    expect(canRemoveWorktree(e, [intake("i1", "active")])).toBe(false);
    expect(canRemoveWorktree(e, [intake("i1", "completed")])).toBe(true);
  });
});

describe("sortWarnings / addWarning", () => {
  const w = (at: string, message = "m"): Warning => ({ at, message });

  test("警告は新しい順に並ぶ", () => {
    const ws = [w("2026-09-15T10:00:00Z"), w("2026-09-15T12:00:00Z"), w("2026-09-15T11:00:00Z")];
    expect(sortWarnings(ws).map((x) => x.at)).toEqual([
      "2026-09-15T12:00:00Z",
      "2026-09-15T11:00:00Z",
      "2026-09-15T10:00:00Z",
    ]);
  });

  test("届いた警告は位置を問わず時刻の順に入る", () => {
    const ws = [w("2026-09-15T12:00:00Z"), w("2026-09-15T10:00:00Z")];
    const after = addWarning(ws, w("2026-09-15T11:00:00Z"));
    expect(after.map((x) => x.at)).toEqual([
      "2026-09-15T12:00:00Z",
      "2026-09-15T11:00:00Z",
      "2026-09-15T10:00:00Z",
    ]);
  });

  test("100 件で古いものから落とす", () => {
    const ws = Array.from({ length: WARNINGS_KEPT }, (_, i) => w(new Date(NOW - i * 60000).toISOString()));
    const oldest = ws[ws.length - 1];
    const after = addWarning(ws, w(new Date(NOW + 60000).toISOString()));
    expect(after.length).toBe(WARNINGS_KEPT);
    expect(after.find((x) => x.at === oldest.at)).toBeUndefined();
  });
});

describe("worktreesNeedAttention", () => {
  test("古い worktree も警告も無ければ点を付けない", () => {
    const e = entry({ task_state: "failed", age_basis: new Date(NOW - 1 * DAY).toISOString() });
    expect(worktreesNeedAttention([e], [], [], 7, NOW)).toBe(false);
  });

  test("古い worktree があれば点を付ける", () => {
    const e = entry({ task_state: "failed", age_basis: new Date(NOW - 8 * DAY).toISOString() });
    expect(worktreesNeedAttention([e], [], [], 7, NOW)).toBe(true);
  });

  test("警告があれば点を付ける", () => {
    expect(worktreesNeedAttention([], [{ at: new Date(NOW).toISOString(), message: "m" }], [], 7, NOW)).toBe(true);
  });

  test("終わっていないタスクの古い worktree では点を付けない", () => {
    const e = entry({ task_state: "running", age_basis: new Date(NOW - 30 * DAY).toISOString() });
    expect(worktreesNeedAttention([e], [], [], 7, NOW)).toBe(false);
  });

  test("しきい値が読めていなければ worktree では点を付けない", () => {
    const e = entry({ task_state: "failed", age_basis: new Date(NOW - 30 * DAY).toISOString() });
    expect(worktreesNeedAttention([e], [], [], null, NOW)).toBe(false);
  });
});

describe("removeConfirmText", () => {
  test("未コミットの変更があれば失われる旨を出す", () => {
    expect(removeConfirmText(true)).toContain("失われ");
  });

  test("分からないときも失われうる旨を出す", () => {
    expect(removeConfirmText(null)).toContain("失われ");
  });

  test("変更が無ければ失われるとは言わない", () => {
    expect(removeConfirmText(false)).not.toContain("失われ");
  });
});
