// worktree と警告の判定をまとめる純関数。model.ts はすでに大きいので分ける（intake.ts と同じ扱い）。
// model.ts を import しない（reducer がここを import するので、逆向きに import すると循環になる）
import type { IntakeSummary, TaskState, Warning, WorktreeEntry } from "../../shared/protocol.ts";
import { isClosedIntake } from "./intake";

export const DAY = 24 * 60 * 60 * 1000;
/** デーモンの daemon.warnings と同じ上限 */
export const WARNINGS_KEPT = 100;

const TERMINAL: readonly TaskState[] = ["completed", "failed", "canceled"];

/** その worktree の持ち主（タスクか Intake）がまだ動いているか。孤児・終端は false */
export function ownerActive(e: WorktreeEntry, intakes: readonly IntakeSummary[]): boolean {
  if (e.task_state !== null) return !TERMINAL.includes(e.task_state);
  if (e.intake_id !== null) {
    const i = intakes.find((x) => x.id === e.intake_id);
    return i !== undefined && !isClosedIntake(i.state);
  }
  return false;
}

/** 古いか（spec 8章「終端状態になってから」staleDays 日）。staleDays が null なら常に false */
export function isStaleWorktree(
  e: WorktreeEntry,
  intakes: readonly IntakeSummary[],
  staleDays: number | null,
  now: number,
): boolean {
  if (staleDays === null) return false;
  if (ownerActive(e, intakes)) return false;
  const basis = Date.parse(e.age_basis);
  if (Number.isNaN(basis)) return false;
  return now - basis >= staleDays * DAY;
}

/** 消してよいか。持ち主が動いていなければ true（孤児・終端のタスク・閉じた/未知の Intake） */
export function canRemoveWorktree(e: WorktreeEntry, intakes: readonly IntakeSummary[]): boolean {
  return !ownerActive(e, intakes);
}

/** at の降順。同時刻は元の順を保つ */
export function sortWarnings(ws: readonly Warning[]): Warning[] {
  return [...ws]
    .map((w, i) => ({ w, i }))
    .sort((a, b) => Date.parse(b.w.at) - Date.parse(a.w.at) || a.i - b.i)
    .map(({ w }) => w);
}

/** 1件足して並べ直し、WARNINGS_KEPT 件で切る */
export function addWarning(ws: readonly Warning[], w: Warning): Warning[] {
  return sortWarnings([...ws, w]).slice(0, WARNINGS_KEPT);
}

/** アイコン列の点。プロジェクトの絞り込みは見ない（countReview と同じく見逃さないため） */
export function worktreesNeedAttention(
  worktrees: readonly WorktreeEntry[],
  warnings: readonly Warning[],
  intakes: readonly IntakeSummary[],
  staleDays: number | null,
  now: number,
): boolean {
  if (warnings.length > 0) return true;
  return worktrees.some((e) => isStaleWorktree(e, intakes, staleDays, now));
}

/** 削除確認の文言。true・null は「失われ」を含める（未コミットの変更があるか分からない） */
export function removeConfirmText(dirty: boolean | null): string {
  if (dirty === true) return "未コミットの変更があります。削除すると失われます。";
  if (dirty === null) return "未コミットの変更があれば、削除すると失われます。";
  return "未コミットの変更はありません。";
}
