import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { sendDecision } from "../decision";
import { risksAt } from "../flow";
import { taskIntakeLabel } from "../intake";
import {
  ago,
  canFlow,
  canReject,
  clock,
  contextOf,
  diffOf,
  draftOf,
  fellBackToAll,
  guideOf,
  hasSince,
  isPartial,
  layoutOf,
  rejections,
  reviewRound,
  scopeOf,
  type DiffView,
  type Layout,
  type Loaded,
  type Scope,
} from "../model";
import { useDecide, useNotYet, useStore } from "../store";
import type { ReviewFile, Task, TaskContext } from "../types";
import { DiffFileBlock, fileAnchor, fileStat } from "./DiffFileBlock";
import { GuideNotice, GuidePanel, RiskNote } from "./Guide";
import { flowSectionAnchor, ReadingFlow } from "./ReadingFlow";
import { StatusDot } from "./StatusDot";
import { Markdown } from "./text";

/**
 * 並べ方を切り替える直前に、読んでいる hunk（main の上端をまたいでいる、または最初に見えている
 * hunk）を覚える。どちらの並びでも hunk はちょうど 1 回出るので、切り替え後の飛び先は 1 つに決まる。
 * 返すのは切り替え後に querySelector で引ける CSS セレクタ
 */
function rememberPosition(): string | null {
  const main = document.querySelector("main.main");
  if (!main) return null;
  const top = main.getBoundingClientRect().top + 8;
  const anchors = [...main.querySelectorAll<HTMLElement>("[data-anchor]")];
  const reading = anchors.filter((el) => el.getBoundingClientRect().top <= top).at(-1) ?? anchors[0];
  const key = reading?.dataset.anchor;
  return key ? `[data-anchor="${CSS.escape(key)}"]` : null;
}

export function Crumbs({ t }: { t: Task }) {
  const { s, dispatch } = useStore();
  const p = s.projects.find((x) => x.id === t.project);
  return (
    <div className="crumbs">
      {p && <span className="pjdot" style={{ background: p.color }} />}
      <span>{p?.id ?? t.project}</span>
      <span className="mono">{t.wf}</span>
      <span className="mono">{t.id}</span>
      <span className="mono">P{t.prio}</span>
      {t.intake && (
        <button className="el-link" onClick={() => dispatch({ type: "intake.open", id: t.intake!.id })}>
          {taskIntakeLabel(t.intake, s.intakes)}
        </button>
      )}
    </div>
  );
}

export function OpenInEditor() {
  const notYet = useNotYet();
  return <button className="btn sm" onClick={() => notYet("エディタ／ターミナルで開くボタンは第2段階です")}>エディタで開く</button>;
}

/** 取れなかったものは黙って隠さない。人は「無い」と「取れていない」を区別できる必要がある */
function LoadError({ what, message }: { what: string; message: string }) {
  return (
    <div className="box danger">
      <b>{what}を取れませんでした</b>
      <p className="mono">{message}</p>
    </div>
  );
}

function Context({ t, loaded }: { t: Task; loaded: Loaded<TaskContext> | undefined }) {
  const { s } = useStore();
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div>
        {/* 元の指示だけは task.list が持っているので、経緯を取れなくても出せる */}
        <b>元の指示</b>
        <pre className="block" style={{ marginTop: 6, whiteSpace: "pre-wrap" }}>{t.prompt}</pre>
      </div>
      {(loaded === undefined || loaded.kind === "loading") && <p className="hint">経緯を読み込んでいます…</p>}
      {loaded?.kind === "error" && <LoadError what="経緯（task.context）" message={loaded.message} />}
      {loaded?.kind === "ok" && <History c={loaded.value} now={s.now} />}
    </div>
  );
}

function History({ c, now }: { c: TaskContext; now: number }) {
  const past = rejections(c);
  return (
    <>
      {past.length > 0 && (
        <details className="ctx">
          <summary>これまでのレビュー（{past.length}件、差し戻し）</summary>
          <div style={{ display: "grid", gap: 8 }}>
            {past.map((r) => {
              const at = Date.parse(r.endedAt);
              return (
                <div key={r.stepRunId}>
                  <span className="hint">{clock(at)} · {ago(at, now)} · <span className="mono">{r.stepId}</span></span>
                  <pre className="block" style={{ marginTop: 4 }}>{r.comment}</pre>
                </div>
              );
            })}
          </div>
        </details>
      )}
      {c.lastCommand && (
        <details className="ctx">
          <summary>
            直近の command ステップの結果（<span className="mono">{c.lastCommand.stepId}</span> · exit{" "}
            {c.lastCommand.exitCode === null ? "シグナルで停止（終了コードなし）" : c.lastCommand.exitCode}）
          </summary>
          <pre className="block">
            {c.lastCommand.stdout}{c.lastCommand.stderr ? "\n" + c.lastCommand.stderr : ""}
          </pre>
        </details>
      )}
    </>
  );
}

/** 計画は差分を見る前に毎回読み直すものではないので畳んで出す。
    パスはワークフローが決めるので、末尾のファイル名だけで見る */
function foldedByDefault(path: string) {
  return path.split("/").pop() === "plan.md";
}

function FileBody({ file }: { file: ReviewFile }) {
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

function Diff({ t, scope, loaded, jump }: {
  t: Task;
  scope: Scope;
  loaded: Loaded<DiffView> | undefined;
  /** 並べ方を切り替えた直後に scrollIntoView する先の CSS セレクタ。State ではなく DOM の位置なので ref で持つ */
  jump: RefObject<string | null>;
}) {
  const { s, dispatch } = useStore();
  const layout = layoutOf(s, t.id);
  const guideView = guideOf(s, t.id);

  useLayoutEffect(() => {
    const target = jump.current;
    if (!target) return;
    jump.current = null;
    document.querySelector(target)?.scrollIntoView({ block: "start" });
  }, [layout, jump]);

  if (loaded === undefined || loaded.kind === "loading") return <p className="hint">diff を読み込んでいます…</p>;
  if (loaded.kind === "error") return <LoadError what="diff（task.diff）" message={loaded.message} />;

  const { meta, files } = loaded.value;
  // 「取れなかった」と紛れないよう、ここまで来てから「変更なし」と言う
  if (files.length === 0) {
    return (
      <p className="hint">
        {scope === "since" && meta.since_step_run_id !== null
          ? "前回のレビュー以降、変更はありません"
          : `${meta.base.branch} との差分はありません`}
      </p>
    );
  }
  // ガイドの注意書きと打ち切りの箱は、どちらの並べ方でも出す
  const notice = <GuideNotice view={guideView} />;
  const guide = guideView?.kind === "ok" && guideView.value.kind === "ok" ? guideView.value.guide : null;
  const truncatedBox = meta.truncated && (
    <div className="box attn">
      <b>diff が大きすぎるため途中で打ち切りました</b>
      <p>
        後ろのファイルは一覧にだけ出て、中身がありません。全部を読むには
        worktree（<span className="mono">{t.worktree ?? "削除済み"}</span>）を直接見てください。
      </p>
    </div>
  );

  if (guide && layout === "flow") {
    return <>{notice}{truncatedBox}<ReadingFlow t={t} guide={guide} view={loaded.value} /></>;
  }

  const risks = guide ? risksAt(guide) : null;
  const jumpToGroup = canFlow(s, t.id)
    ? (i: number) => {
      jump.current = `#${flowSectionAnchor(`g${i}`)}`;
      dispatch({ type: "layout", layout: "flow" });
    }
    : undefined;

  return (
    <>
      {notice}
      {truncatedBox}
      <div className={`rv-body ${guide ? "has-guide" : ""}`}>
        <nav className="filelist" aria-label="変更ファイル">
          <header>{files.length} ファイル</header>
          {files.map((f) => (
            <button key={f.path} className="fl" onClick={() => document.getElementById(fileAnchor(f.path))?.scrollIntoView({ block: "start", behavior: "smooth" })}>
              <span className="nm">{f.path}</span>
              <span className="st">{fileStat(f)}</span>
            </button>
          ))}
        </nav>
        <div className="diffs">
          {files.map((f) => (
            <DiffFileBlock
              key={f.path}
              t={t}
              files={files}
              file={f}
              note={risks && (
                <RiskNote
                  risks={[
                    ...(risks.byPath.get(f.path) ?? []),
                    ...(f.status === "R" && f.old_path ? risks.byPath.get(f.old_path) ?? [] : []),
                  ]}
                />
              )}
              hunkNote={risks ? (h) => <RiskNote risks={risks.byHunk.get(h.id)} /> : undefined}
            />
          ))}
        </div>
        {guide && (
          <GuidePanel
            guide={guide}
            files={files}
            truncated={meta.truncated}
            partial={isPartial(loaded.value, scope)}
            onJump={jumpToGroup}
          />
        )}
      </div>
    </>
  );
}

export function ReviewView({ t }: { t: Task }) {
  const { s, dispatch } = useStore();
  const decide = useDecide();
  const draft = draftOf(s, t.id);
  const scope = scopeOf(s, t.id);
  const diff = diffOf(s, t.id, scope);
  const context = contextOf(s, t.id);
  // 送信中は連打で二重送信しないよう承認ボタンを止める。成功したときだけ
  // 下書きを消す（approve の dispatch）ので、失敗時はここで再度押せる
  const [approving, setApproving] = useState(false);
  const c = context?.kind === "ok" ? context.value : null;
  const jump = useRef<string | null>(null);
  const layout = layoutOf(s, t.id);
  const switchLayout = (next: Layout) => {
    if (next === layout) return;
    jump.current = rememberPosition();
    dispatch({ type: "layout", layout: next });
  };

  return (
    <>
      <div className="pad">
        <Crumbs t={t} />
        <h1>{t.title}</h1>
        <div className="headrow">
          <StatusDot tone="human" word="レビュー待ち" />
          {t.step && <span>ステップ <span className="mono">{t.step}</span></span>}
          {c && reviewRound(c) > 1 && <span>{reviewRound(c)} 回目のレビュー</span>}
          <span className="hint">{ago(t.since, s.now)}から待っています</span>
          <span className="mono hint">{t.branch}</span>
          <span className="spacer" />
          <OpenInEditor />
        </div>

        <Context t={t} loaded={context} />

        {/* 宣言されたパスの出どころはワークフロー定義ではなく task.context の応答。
            定義を引く口（workflow.list）は #58 で、それまではデーモンが解決した
            この配列だけが根拠になる */}
        {(c?.reviewFiles ?? []).map((file) => (
          <details className="rv-files-md" key={file.path} open={!foldedByDefault(file.path)}>
            <summary><span className="mono">{file.path}</span><span className="hint">このステップが見せるファイル（review.files）</span></summary>
            <FileBody file={file} />
          </details>
        ))}

        <div className="headrow">
          <b>変更</b>
          {diff?.kind === "ok" && (
            <span className="hint">
              {fellBackToAll(diff.value, scope)
                ? "基準にできる前回のレビューが無いので全体を出しています"
                : scope === "since"
                  ? "前回のレビュー以降の変更"
                  : `${diff.value.meta.base.branch} との差分`}
            </span>
          )}
          <span className="spacer" />
          {canFlow(s, t.id) && (
            <span className="seg" role="group" aria-label="diff の並べ方">
              <button aria-pressed={layout === "flow"} onClick={() => switchLayout("flow")}>ガイドの順</button>
              <button aria-pressed={layout === "files"} onClick={() => switchLayout("files")}>ファイル順</button>
            </span>
          )}
          {c && hasSince(c) && (
            <span className="seg" role="group" aria-label="差分の範囲">
              <button aria-pressed={scope === "all"} onClick={() => dispatch({ type: "scope", scope: "all" })}>全体</button>
              <button aria-pressed={scope === "since"} onClick={() => dispatch({ type: "scope", scope: "since" })}>前回レビュー以降</button>
            </span>
          )}
        </div>

        <Diff t={t} scope={scope} loaded={diff} jump={jump} />
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
