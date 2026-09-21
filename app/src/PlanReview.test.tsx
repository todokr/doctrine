import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { buildAnswerText } from "../../shared/intake/answerText.ts";
import type { IntakeComment, PfdDraft } from "../../shared/protocol.ts";
import { AnswerPreview } from "./components/AnswerFace";
import { HistoryEntryView } from "./components/IntakeHistory";
import { PfdElementPanel } from "./components/PfdElementPanel";
import { PlanDecide, RejectPreview } from "./components/PlanReview";
import { ANSWERS, INTAKE_REVIEWING, PFD_SAMPLE, QUESTIONS } from "./fixtures";
import { EMPTY_INTAKE_DRAFT, intakeHistory, rejectionText } from "./intake";
import { pfdElement } from "./pfd";

const noop = () => {};
const SETS = [{ questions: QUESTIONS, answers: ANSWERS }];

function panel(key: string, o: Partial<Parameters<typeof PfdElementPanel>[0]> = {}) {
  return renderToStaticMarkup(
    <PfdElementPanel
      pfd={PFD_SAMPLE}
      info={pfdElement(PFD_SAMPLE, key, SETS)}
      onSelect={noop}
      prompt={undefined}
      onOpenPrompt={noop}
      comments={[]}
      previous={[]}
      onAddComment={noop}
      onDeleteComment={noop}
      {...o}
    />,
  );
}

describe("PfdElementPanel", () => {
  test("成果物の定義の全文と前段・後続", () => {
    const html = panel("a:schema");
    for (const text of ["CSV スキーマ", "列の一覧が docs にある", "スキーマを設計する", "API を作る"]) {
      expect(html).toContain(text);
    }
    expect(panel("a:issue")).toMatch(/前段[\s\S]*なし/);
  });

  test("エージェントのプロセスだけがタスクのプロンプトを持つ", () => {
    expect(panel("p:design")).toContain("タスクのプロンプト");
    expect(panel("p:approve")).not.toContain("タスクのプロンプト");
    expect(panel("p:design", { prompt: { kind: "ok", value: "PROMPT本文" } })).toContain("PROMPT本文");
    expect(panel("p:design", { prompt: { kind: "error", message: "完了が記録されていません" } }))
      .toContain("完了が記録されていません");
    expect(panel("p:design", { prompt: { kind: "loading" } })).toContain("読み込み中");
  });

  test("決定の成果物は質問と回答の文を出す", () => {
    const html = panel("a:policy");
    expect(html).toContain("書き込みをどう扱うか");
    expect(html).toContain("同期");
  });

  test("コメントを並べ、読み返しでは欄を出さない", () => {
    const comments = [{ index: 0, comment: { target_kind: "process" as const, target_id: "design", body: "列を減らす" } }];
    const html = panel("p:design", { comments });
    expect(html).toContain("列を減らす");
    expect(html).toContain("コメントを足す");
    expect(html).toContain("消す");

    const readOnly = panel("p:design", { comments, onAddComment: null, onDeleteComment: null, onOpenPrompt: null });
    expect(readOnly).not.toContain("コメントを足す");
    expect(readOnly).not.toContain("タスクのプロンプト");
  });

  test("前の案へのコメントと返答を並べる", () => {
    const previous = [{ comment: INTAKE_REVIEWING.comments[0], reply: "列を減らしました" }];
    const html = panel("p:design", { previous });
    expect(html).toContain("前の案へのコメント");
    expect(html).toContain("列が多すぎる");
    expect(html).toContain("列を減らしました");
    expect(panel("p:design", { previous: [{ ...previous[0], reply: null }] })).toContain("返答なし");
  });

  test("何も選んでいなければ計画の題名を出す", () => {
    expect(panel("p:nope")).toContain("注文の CSV 出力");
  });
});

describe("PlanDecide", () => {
  const decide = (o: Partial<Parameters<typeof PlanDecide>[0]> = {}) =>
    renderToStaticMarkup(
      <PlanDecide count={0} whole="" canReject={false} approving={false} onWhole={noop} onReject={noop} onApprove={noop} {...o} />,
    );

  test("コメントが無いと差し戻せない", () => {
    expect(decide({ canReject: false })).toMatch(/<button[^>]*disabled=""[^>]*>差し戻す…<\/button>/);
    expect(decide({ canReject: true })).not.toMatch(/<button[^>]*disabled=""[^>]*>差し戻す…<\/button>/);
    expect(decide({ count: 2 })).toContain("コメント <b>2</b> 件");
  });
});

describe("RejectPreview", () => {
  test("送る文面をそのまま出す", () => {
    const text = rejectionText(PFD_SAMPLE, {
      ...EMPTY_INTAKE_DRAFT,
      comments: [{ target_kind: "process", target_id: "design", body: "列を減らす" }],
    });
    const html = renderToStaticMarkup(<RejectPreview text={text} pending={false} onSend={noop} onClose={noop} />);
    expect(html).toMatch(/<pre[^>]*>[\s\S]*### コメント 1/);
    expect(html).toContain("列を減らす");
    const pending = renderToStaticMarkup(<RejectPreview text={text} pending onSend={noop} onClose={noop} />);
    expect(pending).toMatch(/<button[^>]*disabled=""[^>]*>差し戻す<\/button>/);
  });
});

describe("AnswerPreview", () => {
  test("回答の文面を出す", () => {
    const text = buildAnswerText(QUESTIONS, ANSWERS);
    const html = renderToStaticMarkup(<AnswerPreview text={text} pending={false} onSend={noop} onClose={noop} />);
    expect(html).toContain("### q1: 書き込みをどう扱うか");
  });
});

describe("HistoryEntryView", () => {
  const history = intakeHistory({
    ...INTAKE_REVIEWING,
    approval: { id: 1, draft_id: 12, hash: "h", approved_at: "2026-09-15T14:59:00+09:00" },
  });
  const entry = <K extends string>(kind: K) => history.find((e) => e.kind === kind)!;
  const draft: PfdDraft = INTAKE_REVIEWING.latest_draft!;

  test("質問の行は件数と読み返しの印を出す", () => {
    const html = renderToStaticMarkup(<HistoryEntryView entry={entry("questions")} draft={undefined} onOpen={noop} />);
    expect(html).toContain("質問に答えた（3 件）");
    expect(html).toContain("選んだ");
  });

  test("案の行は対象の名前と返答を出し、中身が無ければ図を描かない", () => {
    const second = history.find((e) => e.kind === "draft" && e.seq === 2)!;
    const opened = renderToStaticMarkup(
      <HistoryEntryView entry={second} draft={{ kind: "ok", value: draft }} onOpen={noop} />,
    );
    expect(opened).toContain("2 回目の案");
    expect(opened).toContain("プロセス design");
    expect(opened).toContain("列が多すぎる");
    expect(opened).toContain("列を減らしました");
    expect(opened).toContain("pfd-scroll");

    const closed = renderToStaticMarkup(<HistoryEntryView entry={second} draft={undefined} onOpen={noop} />);
    expect(closed).not.toContain("pfd-scroll");
  });

  test("差し戻したコメントは返答なしで並べる", () => {
    const comment: IntakeComment = INTAKE_REVIEWING.comments[0];
    const html = renderToStaticMarkup(
      <HistoryEntryView
        entry={{ kind: "draft", at: comment.created_at, draftId: 11, seq: 1, previousComments: [], pendingComments: [comment] }}
        draft={undefined}
        onOpen={noop}
      />,
    );
    expect(html).toContain("差し戻したコメント");
  });

  test("承認の行", () => {
    const html = renderToStaticMarkup(<HistoryEntryView entry={entry("approval")} draft={undefined} onOpen={noop} />);
    expect(html).toContain("承認した（2 回目の案）");
  });
});
