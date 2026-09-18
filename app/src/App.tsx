import { useEffect, useRef, useState } from "react";
import { ConnectionBanner } from "./components/ConnectionBanner";
import { fileAnchor } from "./components/DiffFileBlock";
import { ReviewView } from "./components/ReviewView";
import { Rail, Sidebar } from "./components/Sidebar";
import { TaskView } from "./components/TaskView";
import { composeRejection, currentStep, draftOf, filesFor, selectedTask } from "./model";
import { useDecide, useStore } from "./store";

function RejectModal() {
  const { s, dispatch } = useStore();
  const decide = useDecide();
  const t = selectedTask(s);
  // モーダルが開いている間だけ「送信済み」を保つ。同じタスクをもう一度差し戻す
  // ときは新たに開き直すので、モーダルの開閉に合わせてリセットしてよい
  const [sent, setSent] = useState(false);
  useEffect(() => {
    if (s.modal !== "reject-preview") setSent(false);
  }, [s.modal]);
  if (s.modal !== "reject-preview" || !t) return null;
  // reject.confirm は下書きをクリアするので、送る前にここで読んでおく
  // （dispatch の後に読むと、消えた下書きから空文字を送ってしまう）
  const comment = composeRejection(draftOf(s, t.id));
  return (
    <>
      <div className="scrim" onClick={() => dispatch({ type: "modal.close" })} />
      <div className="modal" role="dialog" aria-modal="true">
        <h2>差し戻してエージェントに送る内容</h2>
        <p className="hint">
          行コメントと全体へのコメントを1つの文字列にまとめて{" "}
          <span className="mono">task.reject(comment)</span> で送ります。
          戻り先のステップはワークフローの <span className="mono">onReject.goto</span> が決めます。
        </p>
        <pre className="block">{comment}</pre>
        <div className="actions">
          <button
            className="btn danger"
            disabled={sent}
            onClick={() => {
              setSent(true);
              decide.reject(t.id, comment);
              dispatch({ type: "reject.confirm" });
            }}
          >
            差し戻す
          </button>
          <button className="btn" onClick={() => dispatch({ type: "modal.close" })}>戻る</button>
        </div>
      </div>
    </>
  );
}

/** j / k: サイドバー、n / p: diff のファイル、[ / ]: ガイドのステップ。承認と差し戻しにはキーを割り当てない（spec 5章） */
function useKeys() {
  const { s, dispatch } = useStore();
  const latest = useRef(s);
  latest.current = s;
  const fileCursor = useRef<Record<string, string>>({});

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = latest.current;
      if ((e.target as Element).closest("input,textarea,select,[contenteditable]") || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape" && s.modal) return dispatch({ type: "modal.close" });
      if (e.key === "j" || e.key === "k") return dispatch({ type: "move", delta: e.key === "j" ? 1 : -1 });
      const t = selectedTask(s);
      if (!t || t.state !== "suspended" || !t.diff.length) return;
      const step = currentStep(s, t);
      if ((e.key === "[" || e.key === "]") && step !== null) return dispatch({ type: "step", idx: step + (e.key === "]" ? 1 : -1) });
      if (e.key === "n" || e.key === "p") {
        const files = filesFor(t, s.scope[t.id] ?? "all");
        if (!files.length) return;
        const i = Math.max(0, files.findIndex((f) => f.path === fileCursor.current[t.id]));
        const f = files[(i + (e.key === "n" ? 1 : files.length - 1)) % files.length];
        fileCursor.current[t.id] = f.path;
        document.getElementById(fileAnchor(f.path))?.scrollIntoView({ block: "start", behavior: "smooth" });
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [dispatch]);
}

export default function App() {
  const { s } = useStore();
  useKeys();
  const t = selectedTask(s);
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
  }, [s.sel]);

  return (
    <>
      <ConnectionBanner />
      <div className="app">
        <Rail />
        <Sidebar />
        <main className="main" ref={mainRef}>
          {!t ? (
            <div className="pad"><p className="hint">左からタスクを選んでください</p></div>
          ) : t.state === "suspended" ? (
            <ReviewView key={t.id} t={t} />
          ) : (
            <TaskView key={t.id} t={t} />
          )}
        </main>
      </div>
      <RejectModal />
      {s.toast && <div className="toast" role="status">{s.toast}</div>}
    </>
  );
}
