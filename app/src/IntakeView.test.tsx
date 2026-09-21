import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { IntakeFacePlaceholder, IntakeHeading, RevisingBand } from "./components/IntakeView";
import { GhUnavailable, IssueList, IssuePreview } from "./components/IssuePicker";
import { GITHUB_ISSUES, INTAKES, PROJECTS } from "./fixtures";

const noop = () => {};
const URL = "https://github.com/o/r/issues/8";

function preview(o: Partial<Parameters<typeof IssuePreview>[0]>) {
  return renderToStaticMarkup(
    <IssuePreview
      issue={{ url: URL, number: 8, title: "Issue 8 のタイトル" }}
      detail={undefined}
      target={{ kind: "start", url: URL }}
      pending={false}
      onStart={noop}
      onOpen={noop}
      {...o}
    />,
  );
}

const reviewing = INTAKES.find((i) => i.state === "reviewing")!;

describe("IssuePreview", () => {
  test("Intake のある Issue は開始の代わりに開くボタンを出す", () => {
    const html = preview({ target: { kind: "open", intakeId: "i1" } });
    expect(html).toContain("進行中の Intake を開く");
    expect(html).not.toContain("Intake を開始");
  });

  test("Intake の無い Issue は開始ボタンを出す", () => {
    const html = preview({});
    expect(html).toMatch(/<button(?![^>]*disabled)[^>]*>Intake を開始<\/button>/);
    expect(preview({ pending: true })).toMatch(/<button[^>]*disabled=""[^>]*>Intake を開始<\/button>/);
  });

  test("本文は読み込み中・失敗・取れたときで出し分ける", () => {
    expect(preview({ detail: { kind: "loading" } })).toContain("読み込み中");
    expect(preview({ detail: { kind: "error", message: "取れません" } })).toContain("取れません");
    const ok = preview({
      detail: {
        kind: "ok",
        value: {
          url: URL,
          nodeId: "N",
          title: "T",
          body: "本文の一行",
          comments: [{ author: null, body: "コメント", createdAt: "2026-09-15T00:00:00Z" }],
        },
      },
    });
    expect(ok).toContain("本文の一行");
    expect(ok).toContain("削除されたユーザー");
  });
});

describe("IssueList", () => {
  test("一覧の行に Intake ありの印を付ける", () => {
    const html = renderToStaticMarkup(
      <IssueList issues={GITHUB_ISSUES} selected={null} onSelect={noop} />,
    );
    expect(html.split("Intake あり").length - 1).toBe(1);
  });

  test("0 件なら「ありません」", () => {
    expect(renderToStaticMarkup(<IssueList issues={[]} selected={null} onSelect={noop} />))
      .toContain("ありません");
  });
});

describe("GhUnavailable", () => {
  test("gh が使えないときは理由と直し方と gh の出力を出す", () => {
    const html = renderToStaticMarkup(
      <GhUnavailable
        status={{ ok: false, reason: "not_logged_in", message: "You are not logged into any GitHub hosts." }}
        onRetry={noop}
      />,
    );
    expect(html).toContain("gh にログインしていません");
    expect(html).toContain("gh auth login");
    expect(html).toContain("You are not logged into any GitHub hosts.");
    expect(html).toContain("もう一度確かめる");
  });
});

describe("IntakeView の部品", () => {
  test("面の枠は状態の語と面の種類を出す", () => {
    const html = renderToStaticMarkup(<IntakeFacePlaceholder intake={reviewing} />);
    expect(html).toContain('data-face="review"');
    expect(html).toContain("レビュー待ち");
  });

  test("改訂中は帯を出す", () => {
    expect(renderToStaticMarkup(<RevisingBand intake={{ ...reviewing, revising: true }} />))
      .toContain("改訂中");
    expect(renderToStaticMarkup(<RevisingBand intake={{ ...reviewing, revising: false }} />)).toBe("");
  });

  test("見出しに番号・タイトル・状態の語を出す", () => {
    const html = renderToStaticMarkup(
      <IntakeHeading intake={reviewing} project={PROJECTS[0]} />,
    );
    expect(html).toContain("#1");
    expect(html).toContain(reviewing.issue_title);
    expect(html).toContain("レビュー待ち");
    expect(html).toContain(reviewing.issue_url);
  });
});
