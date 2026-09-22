import { useEffect, useRef, useState } from "react";
import { ConnectionBanner } from "./components/ConnectionBanner";
import { fileAnchor } from "./components/DiffFileBlock";
import { IntakeView } from "./components/IntakeView";
import { ReviewView } from "./components/ReviewView";
import { Rail, Sidebar } from "./components/Sidebar";
import { SettingsView } from "./components/SettingsView";
import { TaskView } from "./components/TaskView";
import { RemoveWorktreeModal, WorktreeView } from "./components/WorktreeView";
import { sendDecision } from "./decision";
import { composeRejection, diffOf, draftOf, layoutOf, scopeOf, selectedTask } from "./model";
import { useDecide, useStore } from "./store";

function RejectModal() {
  const { s, dispatch } = useStore();
  const decide = useDecide();
  const t = selectedTask(s);
  // 送信中だけボタンを止める（連打対策）。成功・失敗のどちらでも finally で必ず戻すので、
  // dispatch や s.modal の変化に頼らない（頼ると、そのどちらかが起きない・遅れる
  // 場合にボタンが無効なまま固まる）
  const [pending, setPending] = useState(false);
  if (s.modal !== "reject-preview" || !t) return null;
  // reject.confirm は成功したときにだけ下書きをクリアする。その dispatch より前に
  // ここで読んでおく（消えてから読むと空文字を送ってしまう）
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
            disabled={pending}
            onClick={async () => {
              setPending(true);
              try {
                const r = await sendDecision(decide.reject(t.id, comment), "差し戻しを送れませんでした");
                // reject.confirm はもう「送れたときの後片付け」であって、送ってよいかの
                // 判定ではない（デーモンからの task.stateChanged がこの await より先に
                // 届いて t.state が変わっていても、後片付けは必ず走る）
                if (r.ok) dispatch({ type: "reject.confirm" });
                else dispatch({ type: "toast", message: r.message });
              } finally {
                setPending(false);
              }
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

/**
 * main の上端に最も近い selector の要素から delta だけ離れた要素へスクロールする。
 * 上端をまたいでいる要素（今読んでいるもの）を基準にする
 */
function moveBy(selector: string, delta: 1 | -1) {
  const main = document.querySelector("main.main");
  if (!main) return;
  const els = [...main.querySelectorAll<HTMLElement>(selector)];
  if (!els.length) return;
  const top = main.getBoundingClientRect().top + 8;
  // DOM の順は上から下なので、上端より上にある要素の数がそのまま今の位置になる
  const at = Math.max(0, els.filter((el) => el.getBoundingClientRect().top <= top).length - 1);
  els[Math.max(0, Math.min(els.length - 1, at + delta))].scrollIntoView({ block: "start", behavior: "smooth" });
}

/**
 * j / k: サイドバー、n / p: diff のファイル（ガイドの順では hunk）、[ / ]: ガイドの順でのグループ。
 * 承認と差し戻しにはキーを割り当てない（spec 5章）
 */
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
      if (e.key === "Escape" && s.removing) return dispatch({ type: "remove.close" });
      if (e.key === "j" || e.key === "k") return dispatch({ type: "move", delta: e.key === "j" ? 1 : -1 });
      const t = selectedTask(s);
      if (!t || t.state !== "suspended") return;
      const loaded = diffOf(s, t.id, scopeOf(s, t.id));
      if (loaded?.kind !== "ok") return;
      const flowing = layoutOf(s, t.id) === "flow";
      if (e.key === "[" || e.key === "]") {
        if (flowing) moveBy(".flow-sec", e.key === "]" ? 1 : -1);
        return;
      }
      if ((e.key === "n" || e.key === "p") && flowing) {
        // 流れにはファイルの id が無いので、DOM の順に並ぶ hunk（と hunk の無いファイル）の前後へ動く
        return moveBy("[data-anchor]", e.key === "n" ? 1 : -1);
      }
      if (e.key === "n" || e.key === "p") {
        const files = loaded.value.files;
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
  }, [s.sel, s.intakeSel]);

  return (
    <>
      <ConnectionBanner />
      <div className="app">
        <Rail />
        <Sidebar />
        <main className="main" ref={mainRef}>
          {s.view === "worktrees" ? (
            <WorktreeView />
          ) : s.view === "settings" ? (
            <SettingsView />
          ) : s.view === "intake" ? (
            <IntakeView />
          ) : !t ? (
            <div className="pad"><p className="hint">左からタスクを選んでください</p></div>
          ) : t.state === "suspended" ? (
            <ReviewView key={t.id} t={t} />
          ) : (
            <TaskView key={t.id} t={t} />
          )}
        </main>
      </div>
      <RejectModal />
      <RemoveWorktreeModal />
      {s.toast && <div className="toast" role="status">{s.toast}</div>}
    </>
  );
}
