import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QuestionForm } from "./components/QuestionForm";
import { MaterialView } from "./components/MaterialView";
import { ANSWERS, QUESTIONS } from "./fixtures";
import type { Answer } from "../../shared/intake/question.ts";

const noop = () => {};

function fill(answers: Answer[]) {
  return renderToStaticMarkup(
    <QuestionForm questions={QUESTIONS} answers={answers} onChange={noop} onSubmit={noop} />,
  );
}

function readBack(answers: Answer[]) {
  return renderToStaticMarkup(<QuestionForm questions={QUESTIONS} answers={answers} readOnly />);
}

function count(html: string, needle: string) {
  return html.split(needle).length - 1;
}

const SUBMIT = /<button[^>]*>回答を送る…<\/button>/;

describe("QuestionForm: 答える面", () => {
  test("必須の質問に答えるまで送信できない", () => {
    const html = fill([]);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>回答を送る…<\/button>/);
    expect(html).toContain("未回答 3 件");
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

  test("推奨を初めから選ばない", () => {
    const html = fill([]);
    expect(html).not.toContain('checked=""');
    expect(count(html, ">推奨</span>")).toBe(4);
    expect(html).toContain("単純で十分速い");
    expect(count(html, "使われているため")).toBe(2);
    expect(html).toContain("範囲が小さいため");
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

  test("質問が 0 件でも落ちず、送信は押せる", () => {
    const html = renderToStaticMarkup(
      <QuestionForm questions={[]} answers={[]} onChange={noop} onSubmit={noop} />,
    );
    expect(html.match(SUBMIT)![0]).not.toContain("disabled");
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

  test("読み返しでは足りない質問にも印を付けない", () => {
    expect(readBack([])).not.toContain("qcard missing");
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
