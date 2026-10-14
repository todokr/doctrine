import { useState, type ReactNode } from "react";
import { sendDecision } from "../decision";
import { useDecide, useRefresh, useStore } from "../store";

/** 削除確認の文言。true・null は「失われ」を含める（未コミットの変更があるか分からない） */
export function removeConfirmText(dirty: boolean | null): string {
  if (dirty === true) return "未コミットの変更があります。削除すると失われます。";
  if (dirty === null) return "未コミットの変更があれば、削除すると失われます。";
  return "未コミットの変更はありません。";
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
  const { taskId, path, dirty } = s.removing;
  return (
    <RemoveConfirm
      path={path}
      dirty={dirty}
      pending={pending}
      onCancel={() => dispatch({ type: "remove.close" })}
      onConfirm={async () => {
        setPending(true);
        try {
          const r = await sendDecision(decide.removeWorktree(taskId), "worktree を削除できませんでした");
          dispatch({ type: "remove.close" });
          if (r.ok) {
            dispatch({ type: "toast", message: "worktree を削除しました" });
            void refresh();
          } else {
            dispatch({ type: "toast", message: r.message });
          }
        } finally {
          setPending(false);
        }
      }}
    />
  );
}

export function RemoveWorktreeButton(p: { taskId: string; path: string; dirty: boolean | null }): ReactNode {
  const { dispatch } = useStore();
  return (
    <button
      className="btn sm danger"
      onClick={() => dispatch({ type: "remove.ask", taskId: p.taskId, path: p.path, dirty: p.dirty })}
    >
      worktree を削除
    </button>
  );
}
