import { useState } from "react";
import { sendDecision } from "../decision";
import { ago, canReject, clock, currentStep, diffStats, draftOf, filesFor } from "../model";
import { useDecide, useNotYet, useStore } from "../store";
import type { ReviewFile, Task } from "../types";
import { DiffFileBlock, fileAnchor } from "./DiffFileBlock";
import { GuidePanel, StepView } from "./Guide";
import { Markdown } from "./text";

export function Crumbs({ t }: { t: Task }) {
  const { s } = useStore();
  const p = s.projects.find((x) => x.id === t.project);
  return (
    <div className="crumbs">
      {p && <span className="pjdot" style={{ background: p.color }} />}
      <span>{p?.id ?? t.project}</span>
      <span className="mono">{t.wf}</span>
      <span className="mono">{t.id}</span>
      <span className="mono">P{t.prio}</span>
    </div>
  );
}

export function OpenInEditor() {
  const notYet = useNotYet();
  return <button className="btn sm" onClick={() => notYet("エディタ／ターミナルで開くボタンは第2段階です")}>エディタで開く</button>;
}

function Context({ t }: { t: Task }) {
  const { s } = useStore();
  const c = t.lastCommand;
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div>
        <b>元の指示</b>
        <pre className="block" style={{ marginTop: 6, whiteSpace: "pre-wrap" }}>{t.prompt}</pre>
      </div>
      {t.reviews.length > 0 && (
        <details className="ctx">
          <summary>これまでのレビュー（{t.reviews.length}件、差し戻し）</summary>
          <div style={{ display: "grid", gap: 8 }}>
            {t.reviews.map((r, i) => (
              <div key={i}>
                <span className="hint">{clock(r.at)} · {ago(r.at, s.now)}</span>
                <pre className="block" style={{ marginTop: 4 }}>{r.comment}</pre>
              </div>
            ))}
          </div>
        </details>
      )}
      {c && (
        <details className="ctx">
          <summary>
            直近の command ステップの結果（<span className="mono">{c.stepId}</span> · exit{" "}
            {c.exitCode === null ? "シグナルで停止（終了コードなし）" : c.exitCode}）
          </summary>
          <pre className="block">{c.stdout}{c.stderr ? "\n" + c.stderr : ""}</pre>
        </details>
      )}
      {t.lastAgentMessage && (
        <div>
          <b>エージェントの最後の発言</b>
          <pre className="block" style={{ marginTop: 6, whiteSpace: "pre-wrap" }}>{t.lastAgentMessage}</pre>
        </div>
      )}
    </div>
  );
}

function Diff({ t }: { t: Task }) {
  const { s } = useStore();
  const scope = s.scope[t.id] ?? "all";
  const files = filesFor(t, scope);
  const all = t.diff;
  const step = currentStep(s, t);

  // デーモンには task.diff があるが、画面はまだ呼んでいない（#46）。
  // 見出し側で既に案内しているので、ここでは何も出さない
  if (all.length === 0) return null;
  if (t.guide && step !== null) return <StepView t={t} guide={t.guide} idx={step} />;

  return (
    <div className={`rv-body ${t.guide ? "has-guide" : ""}`}>
      <nav className="filelist" aria-label="変更ファイル">
        <header>{all.length} ファイル</header>
        {files.map((f) => {
          const { add, del } = diffStats(f);
          return (
            <button key={f.path} className="fl" onClick={() => document.getElementById(fileAnchor(f.path))?.scrollIntoView({ block: "start", behavior: "smooth" })}>
              <span className="nm">{f.path}</span>
              <span className="st"><span className="add">+{add}</span><span className="del">−{del}</span></span>
            </button>
          );
        })}
        {scope === "since" && all.length > files.length && (
          <div className="hint" style={{ padding: "6px 10px" }}>前回から変わっていない {all.length - files.length} ファイルを隠しています</div>
        )}
      </nav>
      <div className="diffs">{files.map((f) => <DiffFileBlock key={f.path} t={t} file={f} />)}</div>
      {t.guide && <GuidePanel t={t} guide={t.guide} />}
    </div>
  );
}

function FileBody({ file }: { file: ReviewFile | undefined }) {
  if (!file) return <p className="hint">(このステップは宣言していますが、まだ読めていません)</p>;
  switch (file.status) {
    case "ok":
      return <div className="md"><Markdown src={file.content} /></div>;
    case "missing":
      return <p className="hint">(ファイルがありません)</p>;
    case "too_large":
      return <p className="hint">(大きすぎるため表示していません · {file.size} バイト)</p>;
    case "outside_worktree":
      return <p className="hint">(worktree の外を指しているため読みませんでした)</p>;
    case "binary":
      return <p className="hint">(テキストとして読めないため表示していません · {file.size} バイト)</p>;
    default: {
      // ReviewFile に variant が増えたのにここが未対応だと、tsc がここで落ちる。
      const _exhaustive: never = file;
      void _exhaustive;
      return null;
    }
  }
}

export function ReviewView({ t }: { t: Task }) {
  const { s, dispatch } = useStore();
  const decide = useDecide();
  const draft = draftOf(s, t.id);
  const scope = s.scope[t.id] ?? "all";
  // 送信中は連打で二重送信しないよう承認ボタンを止める。成功したときだけ
  // 下書きを消す（approve の dispatch）ので、失敗時はここで再度押せる
  const [approving, setApproving] = useState(false);
  const hasSince = t.reviews.length > 0 && t.diff.some((f) => f.since);

  return (
    <>
      <div className="pad">
        <Crumbs t={t} />
        <h1>{t.title}</h1>
        <div className="headrow">
          <span className="pill p-attn">◆ {t.step ?? "レビュー待ち"}</span>
          {t.reviews.length > 0 && <span className="pill p-muted">{t.reviews.length + 1}回目のレビュー</span>}
          <span className="hint">{ago(t.since, s.now)}から待っています</span>
          <span className="mono hint">{t.branch}</span>
          <span className="spacer" />
          <OpenInEditor />
        </div>

        <Context t={t} />

        {/* 宣言されたパスの出どころはワークフロー定義ではなく task.context の応答。
            定義を引く口（workflow.list）は #58 で、それまではデーモンが解決した
            この配列だけが根拠になる。未取得（#46）のうちは何も出ない */}
        {(t.reviewFiles ?? []).map((file) => (
          <section className="rv-files-md" key={file.path}>
            <header><span className="mono">{file.path}</span><span className="hint">このステップが見せるファイル（review.files）</span></header>
            <FileBody file={file} />
          </section>
        ))}

        <div className="headrow">
          <b>変更</b>
          <span className="hint">diff はまだ取りに行っていません（<span className="mono">task.diff</span> の呼び出しは #46）</span>
          <span className="spacer" />
          {hasSince && (
            <span className="seg" role="group" aria-label="差分の範囲">
              <button aria-pressed={scope === "all"} onClick={() => dispatch({ type: "scope", scope: "all" })}>全体</button>
              <button aria-pressed={scope === "since"} onClick={() => dispatch({ type: "scope", scope: "since" })}>前回レビュー以降</button>
            </span>
          )}
        </div>

        <Diff t={t} />
      </div>
      <footer className="decide">
        <div>
          <div className="meta"><span>行コメント <b>{draft.comments.length}</b> 件</span></div>
          <textarea placeholder="全体へのコメント（差し戻すときに行コメントと一緒に送ります）" value={draft.overall} onChange={(e) => dispatch({ type: "overall", text: e.target.value })} />
        </div>
        <div className="actions">
          <button className="btn danger" disabled={!canReject(draft)} onClick={() => dispatch({ type: "reject.preview" })}>差し戻す…</button>
          <button
            className="btn primary"
            disabled={approving}
            onClick={async () => {
              setApproving(true);
              try {
                const r = await sendDecision(decide.approve(t.id), "承認を送れませんでした");
                // approve はもう「送れたときの後片付け」。task.stateChanged がこの
                // await より先に届いて t.state が変わっていても、後片付けは必ず走る
                if (r.ok) dispatch({ type: "approve" });
                else dispatch({ type: "toast", message: r.message });
              } finally {
                setApproving(false);
              }
            }}
          >
            承認する
          </button>
        </div>
      </footer>
    </>
  );
}
