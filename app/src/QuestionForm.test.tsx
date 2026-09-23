import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QuestionForm } from "./components/QuestionForm";
import { EvidenceView } from "./components/EvidenceView";
import { MaterialView } from "./components/MaterialView";
import { ANSWERS, ASSUMPTIONS, QUESTIONS, RESPONSES } from "./fixtures";
import type { Answer, AssumptionResponse } from "../../shared/intake/question.ts";

const noop = () => {};
const SET = { questions: QUESTIONS, assumptions: ASSUMPTIONS };

function fill(answers: Answer[], assumptionResponses: AssumptionResponse[] = RESPONSES) {
  return renderToStaticMarkup(
    <QuestionForm set={SET} reply={{ answers, assumptionResponses }} onChange={noop} onSubmit={noop} />,
  );
}

function readBack(answers: Answer[], assumptionResponses: AssumptionResponse[] = RESPONSES) {
  return renderToStaticMarkup(<QuestionForm set={SET} reply={{ answers, assumptionResponses }} readOnly />);
}

function count(html: string, needle: string) {
  return html.split(needle).length - 1;
}

const SUBMIT = /<button[^>]*>回答を送る…<\/button>/;

describe("QuestionForm: 答える面", () => {
  test("必須の質問に答えるまで送信できない", () => {
    const html = fill([], []);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>回答を送る…<\/button>/);
    expect(html).toContain("未回答 5 件");
  });

  test("1 問でも足りなければ送信できない", () => {
    const html = fill(ANSWERS.filter((a) => a.questionId !== "q2"));
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>回答を送る…<\/button>/);
    expect(count(html, "qcard missing")).toBe(1);
  });

  test("そろえば送信できる", () => {
    const html = fill(ANSWERS);
    expect(html).toMatch(SUBMIT);
    expect(html.match(SUBMIT)![0]).not.toContain("disabled");
    expect(html).not.toContain("qcard missing");
  });

  test("その他と補足の入力が描かれる", () => {
    const html = fill(ANSWERS);
    expect(html).toMatch(/<textarea[^>]*>D も入れる<\/textarea>/);
    expect(html).toMatch(/<textarea[^>]*>移行は後で<\/textarea>/);
  });

  test("推奨を出さず、どの選択肢も初めから選ばない", () => {
    const html = fill([], []);
    expect(html).not.toContain('checked=""');
    expect(html).not.toContain("推奨");
  });

  test("補足の欄は選んだ理由も兼ねる", () => {
    expect(fill(ANSWERS)).toContain("補足・選んだ理由");
  });

  test("判断材料を選択肢より先に出す", () => {
    const html = fill([]);
    expect(html.indexOf("案の比較")).toBeGreaterThan(-1);
    expect(html.indexOf("案の比較")).toBeLessThan(html.indexOf('class="lb">同期'));
  });

  test("種類の語を出す", () => {
    const html = fill([]);
    expect(html).toContain("単一選択");
    expect(html).toContain("複数選択");
    expect(html).toContain("自由記述");
  });

  test("質問も仮定も 0 件でも落ちず、送信は押せる", () => {
    const html = renderToStaticMarkup(
      <QuestionForm
        set={{ questions: [], assumptions: [] }}
        reply={{ answers: [], assumptionResponses: [] }}
        onChange={noop}
        onSubmit={noop}
      />,
    );
    expect(html.match(SUBMIT)![0]).not.toContain("disabled");
    expect(html).not.toContain("エージェントの仮定");
  });
});

describe("QuestionForm: 仮定", () => {
  test("仮定は質問の後に、結論・根拠・崩れたときの影響と一緒に並ぶ", () => {
    const html = fill(ANSWERS, []);
    const heading = html.indexOf("エージェントの仮定");
    expect(heading).toBeGreaterThan(html.indexOf("ほかに考慮すべきことは"));
    expect(html.indexOf("書き込みは 1 秒に数回に収まる")).toBeGreaterThan(heading);
    expect(html).toContain("利用者は社内の数人");
    expect(html).toContain("書き込みのプロセスにキューが要るかが変わる");
  });

  test("認めるか書き直すかを初めから選ばず、まとめて認める操作も無い", () => {
    const html = fill(ANSWERS, []);
    expect(html).not.toMatch(/name="assumption-[^"]+" checked=""/);
    expect(count(html, ">認める</span>")).toBe(2);
    expect(html).not.toContain("すべて認める");
    expect(count(html, "qcard missing")).toBe(2);
  });

  test("書き直すを選ぶと正しい内容の欄が開く", () => {
    const html = fill(ANSWERS);
    expect(count(html, "正しい内容")).toBe(1);
    expect(html).toMatch(/<textarea[^>]*>設定は別のファイルに分ける<\/textarea>/);
  });

  test("書き直す内容が空白だけなら送信できない", () => {
    const html = fill(ANSWERS, [
      { assumptionId: "s1", verdict: "accepted" },
      { assumptionId: "s2", verdict: "corrected", correction: " " },
    ]);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>回答を送る…<\/button>/);
    expect(html).toContain("正しい内容を書きます");
  });
});

describe("QuestionForm: 読み返し", () => {
  test("読み返しでは編集できない", () => {
    const html = readBack(ANSWERS);
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("回答を送る…");
    expect(html).not.toContain("未回答");
  });

  test("読み返しでは選んだ選択肢と、その他・補足の文を出す", () => {
    const html = readBack(ANSWERS);
    expect(html).toContain("opt on");
    for (const text of ["D も入れる", "移行は後で", "ログの量", "急がない"]) {
      expect(html).toContain(text);
    }
  });

  test("読み返しでは仮定への応答と書き直した内容だけを出す", () => {
    const html = readBack(ANSWERS);
    expect(count(html, ">認める</span>")).toBe(1);
    expect(count(html, ">書き直す</span>")).toBe(1);
    expect(html).toContain("設定は別のファイルに分ける");
  });

  test("読み返しでは足りない質問にも印を付けない", () => {
    expect(readBack([], [])).not.toContain("qcard missing");
  });
});

describe("EvidenceView", () => {
  test("Issue の根拠は引用を出し、コメントでなければ本文と添える", () => {
    const html = renderToStaticMarkup(<EvidenceView evidence={ASSUMPTIONS[0].evidence[0]} />);
    expect(html).toContain("Issue の本文");
    expect(html).toContain("<blockquote");
  });

  test("コードの根拠はパスと行の範囲と抜粋を出す", () => {
    const html = renderToStaticMarkup(<EvidenceView evidence={ASSUMPTIONS[0].evidence[1]} />);
    expect(html).toContain("core/src/x.ts:10-12");
    expect(html).toContain("await");
  });
});

describe("MaterialView", () => {
  test("表は列と行を描く", () => {
    const table = QUESTIONS[0].materials.find((m) => m.kind === "table")!;
    const html = renderToStaticMarkup(<MaterialView material={table} />);
    expect(count(html, "<th>")).toBe(3);
    expect(count(html, "<td>")).toBe(6);
  });

  test("コードはパスと中身を描く", () => {
    const code = QUESTIONS[0].materials.find((m) => m.kind === "code")!;
    const html = renderToStaticMarkup(<MaterialView material={code} />);
    expect(html).toContain("core/src/x.ts");
    expect(html).toContain("await");
  });
});
