import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { IntakeLogPanel } from "./components/IntakeLog";
import { IntakeFacePlaceholder, IntakeHeading, RevisingBand } from "./components/IntakeView";
import { IssueChooser, IssueList, IssuePreview, TrackerUnavailable } from "./components/IssuePicker";
import { GITHUB_ISSUES, INTAKES, LINEAR_ISSUES, PROJECTS } from "./fixtures";

const noop = () => {};
const URL = "https://github.com/o/r/issues/8";

function chooser(o: Partial<Parameters<typeof IssueChooser>[0]>) {
  return renderToStaticMarkup(
    <IssueChooser
      kind="github"
      target={{ id: "o/r", name: "o/r" }}
      assignee="me"
      onAssignee={noop}
      searchText=""
      onSearchText={noop}
      onSearch={noop}
      issues={{ kind: "ok", value: GITHUB_ISSUES }}
      refreshing={false}
      refreshError={null}
      intakes={INTAKES}
      selected={null}
      onSelect={noop}
      direct=""
      onDirect={noop}
      onPickDirect={noop}
      {...o}
    />,
  );
}

function preview(o: Partial<Parameters<typeof IssuePreview>[0]>) {
  return renderToStaticMarkup(
    <IssuePreview
      issue={{ url: URL, identifier: "#8", title: "Issue 8 のタイトル" }}
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
  test("見出しに識別子とタイトルを出す", () => {
    expect(preview({})).toContain("#8 Issue 8 のタイトル");
    const noIdentifier = preview({ issue: { url: URL, identifier: null, title: "T" } });
    expect(noIdentifier).toContain("<h2>T</h2>");
  });

  test("Linear の Issue は見出しに ENG-123 を出す", () => {
    const html = preview({
      issue: { url: LINEAR_ISSUES[0].url, identifier: "ENG-123", title: "ログインを直す" },
    });
    expect(html).toContain("ENG-123 ログインを直す");
  });

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
  test("行に識別子を出す", () => {
    const html = renderToStaticMarkup(
      <IssueList issues={GITHUB_ISSUES} intakes={INTAKES} selected={null} onSelect={noop} />,
    );
    expect(html).toContain("#5");
    expect(html).toContain("#8");
    const linear = [{ ...GITHUB_ISSUES[0], identifier: "ENG-123" }];
    const linearHtml = renderToStaticMarkup(
      <IssueList issues={linear} intakes={INTAKES} selected={null} onSelect={noop} />,
    );
    expect(linearHtml).toContain("ENG-123");
    expect(linearHtml).not.toContain("#ENG-123");
  });

  test("一覧の行に Intake ありの印を付ける", () => {
    const html = renderToStaticMarkup(
      <IssueList issues={GITHUB_ISSUES} intakes={INTAKES} selected={null} onSelect={noop} />,
    );
    expect(html.split("Intake あり").length - 1).toBe(1);
  });

  test("印は intake_id ではなく、手元の進行中の Intake で決める", () => {
    const issues = GITHUB_ISSUES.map((i) => ({ ...i, intake_id: i.intake_id ? null : "stale" }));
    const html = renderToStaticMarkup(
      <IssueList issues={issues} intakes={INTAKES} selected={null} onSelect={noop} />,
    );
    expect(html.split("Intake あり").length - 1).toBe(1);
  });

  test("0 件なら「ありません」", () => {
    expect(renderToStaticMarkup(<IssueList issues={[]} intakes={[]} selected={null} onSelect={noop} />))
      .toContain("ありません");
  });
});

describe("IssueChooser", () => {
  test("Linear のプロジェクトでは ENG-123 形式の識別子を出し、URL の直接入力欄を出さない", () => {
    const html = chooser({
      kind: "linear",
      target: { id: "team-uuid", name: "Engineering" },
      issues: { kind: "ok", value: LINEAR_ISSUES },
    });
    expect(html).toContain("ENG-123");
    expect(html).toContain("ENG-124");
    expect(html).toContain("Engineering");
    expect(html).not.toContain("issue-direct");
    expect(html).not.toContain("番号か URL を直接入れる");
    expect(html).not.toContain("github.com");
  });

  test("GitHub のプロジェクトでは直接入力欄を出し、チームの行は出さない", () => {
    const html = chooser({});
    expect(html).toContain('id="issue-direct"');
    expect(html).toContain("番号か URL を直接入れる");
    expect(html).toContain("#5");
    expect(html).not.toContain("Linear のチーム");
  });

  test("取り直しに失敗したら手元の一覧を出したまま理由を出す", () => {
    const html = chooser({ refreshError: "ネットワーク" });
    expect(html).toContain("取り直せませんでした（ネットワーク）");
    expect(html).toContain("#5");
  });
});

describe("TrackerUnavailable", () => {
  test("Linear の API key が無いときは config.json への設定を促す", () => {
    const html = renderToStaticMarkup(
      <TrackerUnavailable
        status={{ ok: false, reason: "no_api_key", message: "config.json に linearApiKey がありません" }}
        onRetry={noop}
      />,
    );
    expect(html).toContain("Linear の API key がありません");
    expect(html).toContain("config.json");
    expect(html).toContain("linearApiKey");
    expect(html).toContain("もう一度確かめる");
  });

  test("Linear のチームが見つからないときは project.yaml の tracker.team を確かめるよう促す", () => {
    const html = renderToStaticMarkup(
      <TrackerUnavailable
        status={{ ok: false, reason: "team_not_found", message: "チーム ENG が見つかりません" }}
        onRetry={noop}
      />,
    );
    expect(html).toContain("tracker.team");
    expect(html).toContain("チーム ENG が見つかりません");
  });

  test("gh が使えないときは理由と直し方と gh の出力を出す", () => {
    const html = renderToStaticMarkup(
      <TrackerUnavailable
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
    expect(renderToStaticMarkup(<RevisingBand intake={{ ...reviewing, revising: true }} pending={false} onAbandon={noop} />))
      .toContain("改訂中");
    expect(renderToStaticMarkup(<RevisingBand intake={{ ...reviewing, revising: false }} pending={false} onAbandon={noop} />)).toBe("");
  });

  test("改訂中の帯は改訂をやめるボタンだけを持つ", () => {
    const html = renderToStaticMarkup(
      <RevisingBand intake={{ ...reviewing, revising: true }} pending={false} onAbandon={noop} />,
    );
    expect(html).toContain("改訂中");
    expect(html).toContain("改訂をやめる");
  });

  test("見出しは終端でなければ中止を出す", () => {
    const heading = (intake: typeof reviewing, onCancel?: () => void) =>
      renderToStaticMarkup(<IntakeHeading intake={intake} project={PROJECTS[0]} onCancel={onCancel} />);
    expect(heading(reviewing, noop)).toContain("中止…");
    expect(heading({ ...reviewing, state: "completed" }, noop)).not.toContain("中止…");
    expect(heading(reviewing)).not.toContain("中止…");
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

describe("IntakeLogPanel", () => {
  const run = {
    id: 7,
    purpose: "decompose" as const,
    attempt: 2,
    status: "running" as const,
    started_at: null,
    ended_at: null,
    cost_usd: null,
    num_turns: null,
    duration_ms: null,
    issues: null,
    permission_denials: null,
  };
  const panel = (o: Partial<Parameters<typeof IntakeLogPanel>[0]>) =>
    renderToStaticMarkup(
      <IntakeLogPanel intakeId="i1" log={undefined} runs={[run]} following={true} {...o} />,
    );

  test("実行の目的と何回目かを添えてログを出す", () => {
    const html = panel({ log: { runId: 7, lines: ["12:00:00 Issue を読んでいます", ""] } });
    expect(html).toContain("分解 2 回目");
    expect(html).toContain("Issue を読んでいます");
    expect(html).not.toContain("末尾 200 行");
  });

  test("追っていないときは末尾だけであることを示す", () => {
    expect(panel({ log: { runId: 7, lines: ["x"] }, following: false })).toContain("末尾 200 行");
  });

  test("行が無ければ、実行が無いのかログが無いのかを出し分ける", () => {
    expect(panel({ log: { runId: null, lines: [] } })).toContain("まだ実行がありません");
    expect(panel({ log: { runId: 7, lines: [""] } })).toContain("この実行のログはまだありません");
  });
});
