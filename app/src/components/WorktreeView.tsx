import { type ReactNode, useState } from "react";
import type { IntakeSummary, Warning, WorktreeEntry } from "../../../shared/protocol.ts";
import { ago, clock, projectKey, staleDaysOf } from "../model";
import { sendDecision } from "../decision";
import { useDecide, useRefresh, useStore } from "../store";
import type { Project, Task } from "../types";
import { canRemoveWorktree, isStaleWorktree, removeConfirmText, sortWarnings } from "../worktrees";
import { STATE_PILL } from "./TaskView";

function findTask(tasks: readonly Task[], id: string): Task | undefined {
  return tasks.find((t) => t.id === id);
}

export function WorktreeRow(p: {
  e: WorktreeEntry;
  projects: Project[];
  tasks: Task[];
  intakes: IntakeSummary[];
  staleDays: number | null;
  now: number;
  onRemove: () => void;
  onOpenTask: (id: string) => void;
  onOpenIntake: (id: string) => void;
}): ReactNode {
  const { e } = p;
  const project = p.projects.find((pr) => pr.path === e.project);
  const stale = isStaleWorktree(e, p.intakes, p.staleDays, p.now);
  const removable = canRemoveWorktree(e, p.intakes);
  const task = e.task_id ? findTask(p.tasks, e.task_id) : undefined;

  return (
    <tr className={stale ? "wt-stale" : undefined}>
      <td>{project?.id ?? projectKey(e.project)}</td>
      <td className="mono">{e.path}</td>
      <td>
        {e.task_id
          ? (
            task
              ? (
                <button className="btn sm" onClick={() => p.onOpenTask(e.task_id!)}>
                  {task.title}
                  {" "}
                  <span className={`pill ${STATE_PILL[task.state][1]}`}>{STATE_PILL[task.state][0]}</span>
                </button>
              )
              : <span className="mono">{e.task_id}</span>
          )
          : e.intake_id
          ? <button className="btn sm" onClick={() => p.onOpenIntake(e.intake_id!)}>Intake</button>
          : <span className="hint">孤児</span>}
      </td>
      <td>{e.dirty && <span className="pill p-attn">未コミットの変更あり</span>}</td>
      <td>
        {stale && <span className="pill p-attn">古い</span>}
        {" "}
        {ago(Date.parse(e.age_basis), p.now)}
      </td>
      <td>
        {removable && (
          <button className="btn sm danger" onClick={p.onRemove}>worktree を削除</button>
        )}
      </td>
    </tr>
  );
}

export function WarningList(p: {
  warnings: Warning[];
  tasks: Task[];
  now: number;
  onOpenTask: (id: string) => void;
}): ReactNode {
  const rows = sortWarnings(p.warnings);
  if (rows.length === 0) return <p className="hint">警告はありません</p>;
  return (
    <ul className="warnings">
      {rows.map((w, i) => {
        const task = w.task_id ? findTask(p.tasks, w.task_id) : undefined;
        return (
          <li key={i}>
            <span className="hint mono">{clock(Date.parse(w.at))}</span>
            <span>{w.message}</span>
            {w.task_id && (
              <button className="btn sm" onClick={() => p.onOpenTask(w.task_id!)}>
                {task?.title ?? w.task_id}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function RemoveConfirm(p: {
  path: string;
  dirty: boolean | null;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): ReactNode {
  return (
    <>
      <div className="scrim" onClick={p.onCancel} />
      <div className="modal" role="dialog" aria-modal="true">
        <h2>worktree を削除しますか</h2>
        <p className="mono hint">{p.path}</p>
        <p>{removeConfirmText(p.dirty)}</p>
        <div className="actions">
          <button className="btn danger" disabled={p.pending} onClick={p.onConfirm}>削除する</button>
          <button className="btn" onClick={p.onCancel}>戻る</button>
        </div>
      </div>
    </>
  );
}

export function RemoveWorktreeModal(): ReactNode {
  const { s, dispatch } = useStore();
  const decide = useDecide();
  const refresh = useRefresh();
  const [pending, setPending] = useState(false);
  if (!s.removing) return null;
  const { path, dirty } = s.removing;
  return (
    <RemoveConfirm
      path={path}
      dirty={dirty}
      pending={pending}
      onCancel={() => dispatch({ type: "remove.close" })}
      onConfirm={async () => {
        setPending(true);
        try {
          const r = await sendDecision(decide.removeWorktree(path), "worktree を削除できませんでした");
          if (r.ok) {
            dispatch({ type: "remove.close" });
            dispatch({ type: "toast", message: "worktree を削除しました" });
            void refresh();
          } else {
            dispatch({ type: "remove.close" });
            dispatch({ type: "toast", message: r.message });
          }
        } finally {
          setPending(false);
        }
      }}
    />
  );
}

export function RemoveWorktreeButton(p: { path: string; dirty: boolean | null }): ReactNode {
  const { dispatch } = useStore();
  return (
    <button className="btn sm danger" onClick={() => dispatch({ type: "remove.ask", path: p.path, dirty: p.dirty })}>
      worktree を削除
    </button>
  );
}

export function WorktreeView(): ReactNode {
  const { s, dispatch } = useStore();
  const rows = s.worktrees
    .filter((e) => s.project === "all" || (s.projects.find((p) => p.path === e.project)?.id ?? e.project) === s.project)
    .slice()
    .sort((a, b) => Date.parse(a.age_basis) - Date.parse(b.age_basis));
  const staleCount = rows.filter((e) => isStaleWorktree(e, s.intakes, staleDaysOf(s), s.now)).length;

  return (
    <div className="pad">
      <h1>worktree と警告</h1>

      <h2>worktree {rows.length > 0 && <span className="hint">（古いもの {staleCount} 件）</span>}</h2>
      {rows.length === 0
        ? <p className="hint">ありません</p>
        : (
          <div className="runtable">
            <table>
              <thead>
                <tr>
                  <th>プロジェクト</th>
                  <th>パス</th>
                  <th>持ち主</th>
                  <th>未コミットの変更</th>
                  <th>経過</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => (
                  <WorktreeRow
                    key={e.path}
                    e={e}
                    projects={s.projects}
                    tasks={s.tasks}
                    intakes={s.intakes}
                    staleDays={staleDaysOf(s)}
                    now={s.now}
                    onRemove={() => dispatch({ type: "remove.ask", path: e.path, dirty: e.dirty })}
                    onOpenTask={(id) => dispatch({ type: "task.open", id })}
                    onOpenIntake={(id) => dispatch({ type: "intake.open", id })}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}

      <h2>警告</h2>
      <WarningList
        warnings={s.warnings}
        tasks={s.tasks}
        now={s.now}
        onOpenTask={(id) => dispatch({ type: "task.open", id })}
      />
    </div>
  );
}
