import { basename } from "@std/path";
import type { ServerEvent } from "../../../shared/protocol.ts";
import type { Db, ProjectRow, TaskRow } from "../db/schema.ts";
import { getProject, getTask } from "../db/tasks.ts";
import { getIntake } from "../db/intakes.ts";
import type { Workflow } from "../workflow/schema.ts";
import type { WarningLog } from "../daemon/warnings.ts";
import type { Notifier } from "./notifier.ts";

export type Notification = { title: string; body: string };

export type NotificationDeps = {
  db: Db;
  workflowOf(task: TaskRow, project: ProjectRow): Promise<Workflow>;
};

const INTAKE_LABELS: Record<string, string> = {
  answering: "回答待ち",
  reviewing: "レビュー待ち",
  needs_attention: "要確認",
  completed: "完了",
};

/** issue_url の末尾が /issues/<数字>（末尾の / は許す）なら数字を返す。取れなければ null（Linear の URL など）。 */
export function issueNumberOf(issueUrl: string): string | null {
  return issueUrl.match(/\/issues\/(\d+)\/?$/)?.[1] ?? null;
}

/** approval ステップで止まったときだけ title が取れる。取れなければ null。 */
async function approvalTitle(
  deps: NotificationDeps,
  task: TaskRow,
  project: ProjectRow,
): Promise<string | null> {
  if (!task.current_step_id) return null;
  try {
    const wf = await deps.workflowOf(task, project);
    const step = wf.steps.find((s) => s.id === task.current_step_id);
    return step?.type === "approval" ? step.title : null;
  } catch {
    return null;
  }
}

/** 通知するイベントなら文面を返し、それ以外は null。DB の行が無ければ null。 */
export async function notificationFor(
  ev: ServerEvent,
  deps: NotificationDeps,
): Promise<Notification | null> {
  const title = "doctrine";
  if (
    ev.event === "task.stateChanged" && (ev.to === "suspended" || ev.to === "failed") ||
    ev.event === "task.cleanedUp" && ev.outcome === "refused"
  ) {
    const task = await getTask(deps.db, ev.task_id);
    if (!task) return null;
    const project = await getProject(deps.db, task.project_id);
    if (!project) return null;
    const head = `[${basename(project.path)}] ${task.title} — `;
    if (ev.event === "task.cleanedUp") {
      return { title, body: `${head}worktree の削除を拒否` };
    }
    if (ev.to === "failed") return { title, body: `${head}失敗` };
    const approval = await approvalTitle(deps, task, project);
    return { title, body: `${head}レビュー待ち${approval === null ? "" : `: ${approval}`}` };
  }
  if (ev.event === "intake.stateChanged" && ev.to in INTAKE_LABELS) {
    const intake = await getIntake(deps.db, ev.intake_id);
    if (!intake) return null;
    const project = await getProject(deps.db, intake.project_id);
    if (!project) return null;
    const n = issueNumberOf(intake.issue_url);
    const issue = `${n === null ? "" : `#${n} `}${intake.issue_title}`;
    return { title, body: `[${basename(project.path)}] ${issue} — ${INTAKE_LABELS[ev.to]}` };
  }
  return null;
}

export type EventNotifier = {
  /** 決して reject しない。broadcast から void で呼ぶ。 */
  handle(ev: ServerEvent): Promise<void>;
};

export function createEventNotifier(
  o: NotificationDeps & { notifier: Notifier; warnings: Pick<WarningLog, "push"> },
): EventNotifier {
  // 一度失敗したらそのプロセスの間は黙る。並行して飛んでいる送出にも効かせるため、送出の前後で見る。
  let disabled = false;
  return {
    async handle(ev) {
      try {
        if (disabled) return;
        // DB の一時的な失敗のたびに警告を積むと溢れるので、ここでは警告しない。
        const n = await notificationFor(ev, o).catch(() => null);
        if (!n || disabled) return;
        try {
          await o.notifier.notify(n.title, n.body);
        } catch (e) {
          if (disabled) return;
          disabled = true;
          o.warnings.push(
            `OS 通知を送れませんでした。このデーモンの間は通知を止めます: ${(e as Error).message}`,
          );
        }
      } catch {
        // handle は reject しない
      }
    },
  };
}
