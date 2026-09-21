import { useState, type ReactNode } from "react";
import type { Artifact, Pfd, Process } from "../../../shared/intake/pfd.ts";
import type { IntakeComment, NewComment } from "../../../shared/protocol.ts";
import type { Loaded } from "../model";
import { pfdKey, type PfdElementInfo, type PfdNodeKind } from "../pfd";
import { Markdown } from "./text";

const ACTOR = { agent: "エージェント", human: "人" } as const;

function Sec({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="el-sec">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

/** 値が無い欄は出さない */
function Text({ title, src }: { title: string; src: string | undefined }) {
  if (!src) return null;
  return (
    <Sec title={title}>
      <Markdown src={src} />
    </Sec>
  );
}

function Links(p: { title: string; kind: PfdNodeKind; items: (Artifact | Process)[]; onSelect: (key: string) => void }) {
  return (
    <Sec title={p.title}>
      {p.items.length === 0
        ? <span className="hint">なし</span>
        : (
          <div className="el-links">
            {p.items.map((x) => (
              <button key={x.id} className="el-link" onClick={() => p.onSelect(pfdKey(p.kind, x.id))}>
                {x.name}
              </button>
            ))}
          </div>
        )}
    </Sec>
  );
}

function PromptSec(p: { prompt: Loaded<string> | undefined; onOpen: () => void }) {
  return (
    <details className="el-prompt" onToggle={(e) => e.currentTarget.open && p.onOpen()}>
      <summary>タスクのプロンプト</summary>
      {p.prompt?.kind === "ok" && <pre className="block">{p.prompt.value}</pre>}
      {p.prompt?.kind === "error" && <p className="hint">{p.prompt.message}</p>}
      {p.prompt?.kind === "loading" && <p className="hint">読み込み中</p>}
    </details>
  );
}

function CommentBox(p: {
  comments: { index: number; comment: NewComment }[];
  onAdd: ((body: string) => void) | null;
  onDelete: ((index: number) => void) | null;
}) {
  const [text, setText] = useState("");
  return (
    <Sec title="コメント">
      {p.comments.map(({ index, comment }) => (
        <div key={index} className="el-comment">
          <span>{comment.body}</span>
          {p.onDelete && <button className="btn sm" onClick={() => p.onDelete?.(index)}>消す</button>}
        </div>
      ))}
      {p.onAdd && (
        <>
          <textarea placeholder="この要素へのコメント" value={text} onChange={(e) => setText(e.target.value)} />
          <div className="actions">
            <button
              className="btn sm"
              disabled={text.trim() === ""}
              onClick={() => {
                p.onAdd?.(text);
                setText("");
              }}
            >
              コメントを足す
            </button>
          </div>
        </>
      )}
    </Sec>
  );
}

export function PfdElementPanel(p: {
  pfd: Pfd;
  /** pfdElement の結果。null なら計画の題名と goal を出す */
  info: PfdElementInfo | null;
  /** 前段・後続・入力・出力を押したとき */
  onSelect: (key: string) => void;
  /** 選んだエージェントのプロセスの prompt */
  prompt: Loaded<string> | undefined;
  /** 「タスクのプロンプト」を開いたとき。null なら欄ごと出さない（経緯の読み返し） */
  onOpenPrompt: (() => void) | null;
  comments: { index: number; comment: NewComment }[];
  /** 前の案でこの要素に付けたコメントと、その返答（UI spec 7.2） */
  previous: { comment: IntakeComment; reply: string | null }[];
  /** null ならコメント欄を出さない（経緯の読み返し） */
  onAddComment: ((body: string) => void) | null;
  onDeleteComment: ((index: number) => void) | null;
  /** プロセスの定義の後、コメント欄の前に出す（進行中の面の状態・sub-issue・タスク・PR） */
  extra?: ReactNode;
  /** 改訂で変えられない要素 */
  frozen?: boolean;
}) {
  const { info } = p;
  if (!info) {
    const goals = p.pfd.artifacts.filter((a) => p.pfd.goal.includes(a.id));
    return (
      <aside className="el-panel">
        <b>{p.pfd.title}</b>
        <Sec title="ゴール">
          {goals.map((a) => <span key={a.id}>{a.name}</span>)}
        </Sec>
        <p className="hint">図の要素を選ぶと、定義を読んでコメントできます</p>
      </aside>
    );
  }

  const head = info.kind === "artifact" ? info.artifact : info.process;
  return (
    <aside className="el-panel">
      <div className="el-head">
        <b>{head.name}</b>
        <span className="mono hint">{`${info.kind === "artifact" ? "成果物" : "プロセス"} ${head.id}`}</span>
        {p.frozen && <span className="tag">🔒 固定</span>}
      </div>
      {info.kind === "artifact"
        ? (
          <>
            <Sec title="種類">
              <span>
                {[info.artifact.given ? "最初から揃っている" : "プロセスが作る", info.goal && "末端の成果物（ゴール）"]
                  .filter(Boolean)
                  .join(" / ")}
              </span>
            </Sec>
            {info.decision && (
              <Sec title="決定">
                <span>{info.decision.prompt ?? `質問 ${info.decision.questionId}`}</span>
                <span>{info.decision.answer ?? "回答が見つかりません"}</span>
              </Sec>
            )}
            <Text title="説明" src={info.artifact.description} />
            <Text title="確かめ方" src={info.artifact.verify} />
            <Links title="前段" kind="process" items={info.producers} onSelect={p.onSelect} />
            <Links title="後続" kind="process" items={info.consumers} onSelect={p.onSelect} />
          </>
        )
        : (
          <>
            <Sec title="担い手">
              <span>{`${ACTOR[info.process.actor]}（段 ${info.stage}）`}</span>
            </Sec>
            <Text title="目的" src={info.process.purpose} />
            <Text title="手順" src={info.process.steps} />
            <Text title="完了の条件" src={info.process.done_when} />
            <Links title="入力" kind="artifact" items={info.inputs} onSelect={p.onSelect} />
            <Links title="出力" kind="artifact" items={info.outputs} onSelect={p.onSelect} />
            {info.process.actor === "agent" && p.onOpenPrompt && (
              // 別のプロセスを選んだら閉じ直す（開いたままだと onToggle が来ず、prompt を取りに行かない）
              <PromptSec key={info.key} prompt={p.prompt} onOpen={p.onOpenPrompt} />
            )}
          </>
        )}
      {p.extra}
      {p.previous.length > 0 && (
        <Sec title="前の案へのコメント">
          {p.previous.map(({ comment, reply }) => (
            <div key={comment.id} className="el-comment">
              <span>{comment.body}</span>
              <span className="hint">{reply ?? "返答なし"}</span>
            </div>
          ))}
        </Sec>
      )}
      {(p.onAddComment !== null || p.comments.length > 0) && (
        <CommentBox key={info.key} comments={p.comments} onAdd={p.onAddComment} onDelete={p.onDeleteComment} />
      )}
    </aside>
  );
}
