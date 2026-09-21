import { describe, expect, test } from "vitest";
import { validateAnswers, validateQuestions } from "../../shared/intake/validateQuestion.ts";
import type { IntakeState } from "../../shared/intake/state.ts";
import { ANSWERS, INTAKES, PROJECTS, QUESTIONS } from "./fixtures";
import {
  answerIssues,
  countIntakeAttention,
  ghGuidance,
  intakeFace,
  intakeOrder,
  intakeProgress,
  intakeSection,
  issueNumber,
  issueTarget,
  normalizeAnswers,
  parseIssueInput,
  toggleOption,
  updateAnswer,
} from "./intake";

const [Q1, Q2] = QUESTIONS;

function withAnswer(questionId: string, patch: object) {
  return ANSWERS.map((a) => (a.questionId === questionId ? { ...a, ...patch } : a));
}

describe("normalizeAnswers", () => {
  test("空白だけのその他と補足は null にする", () => {
    const out = normalizeAnswers(QUESTIONS, withAnswer("q1", { other: "  ", note: "" }));
    expect(out[0]).toMatchObject({ questionId: "q1", other: null, note: null });
  });

  test("回答の無い質問は空の回答で埋め、質問の順に並べる", () => {
    const out = normalizeAnswers(QUESTIONS, [ANSWERS[2]]);
    expect(out).toHaveLength(3);
    expect(out.map((a) => a.questionId)).toEqual(["q1", "q2", "q3"]);
    expect(out[0]).toEqual({ questionId: "q1", optionIds: [], other: null, note: null });
  });

  test("質問に無い回答は落とす", () => {
    const out = normalizeAnswers(QUESTIONS, [
      ...ANSWERS,
      { questionId: "zz", optionIds: [], other: "x", note: null },
    ]);
    expect(out.map((a) => a.questionId)).toEqual(["q1", "q2", "q3"]);
  });

  test("値のある other と note は前後の空白ごと残す", () => {
    const out = normalizeAnswers(QUESTIONS, withAnswer("q3", { other: " ログ ", note: " 急ぐ " }));
    expect(out[2]).toMatchObject({ other: " ログ ", note: " 急ぐ " });
  });
});

describe("answerIssues", () => {
  test("そろった回答なら指摘なし", () => {
    expect(answerIssues(QUESTIONS, ANSWERS)).toEqual([]);
  });

  test("必須の質問に答えていなければ、その質問の指摘", () => {
    const answers = ANSWERS.filter((a) => a.questionId !== "q2");
    expect(answerIssues(QUESTIONS, answers)).toEqual([
      { questionId: "q2", message: "選択肢を 1 つ以上選ぶか、その他に書きます" },
    ]);
  });

  test("回答が空なら全ての質問が指摘される", () => {
    expect(answerIssues(QUESTIONS, []).map((i) => i.questionId)).toEqual(["q1", "q2", "q3"]);
  });

  test("single で選択肢とその他の両方は指摘", () => {
    const issues = answerIssues(QUESTIONS, withAnswer("q1", { optionIds: ["a"], other: "別案" }));
    expect(issues).toEqual([
      { questionId: "q1", message: "選択肢を 1 つ選ぶか、その他に書きます" },
    ]);
  });

  test("single でその他だけなら指摘なし", () => {
    expect(answerIssues(QUESTIONS, withAnswer("q1", { optionIds: [], other: "別案" }))).toEqual([]);
  });

  test("free のその他が空白だけなら未回答", () => {
    expect(answerIssues(QUESTIONS, withAnswer("q3", { other: "   " }))).toEqual([
      { questionId: "q3", message: "答えを書きます" },
    ]);
  });

  test("無い選択肢の id は指摘", () => {
    expect(answerIssues(QUESTIONS, withAnswer("q1", { optionIds: ["zz"] }))).toEqual([
      { questionId: "q1", message: "選択肢が見つかりません" },
    ]);
  });
});

describe("updateAnswer", () => {
  test("その他と補足が回答に入る", () => {
    const a = updateAnswer([], "q1", { other: "別案" });
    const b = updateAnswer(a, "q1", { note: "補足" });
    expect(b).toEqual([{ questionId: "q1", optionIds: [], other: "別案", note: "補足" }]);
  });

  test("入力の配列を書き換えない", () => {
    const input = ANSWERS.map((a) => ({ ...a, optionIds: [...a.optionIds] }));
    updateAnswer(input, "q1", { optionIds: ["b"], other: "x" });
    updateAnswer(input, "zz", { note: "y" });
    expect(input).toEqual(ANSWERS);
  });

  test("打鍵中の空白は消さない", () => {
    expect(updateAnswer([], "q1", { other: "a " })[0].other).toBe("a ");
  });
});

describe("toggleOption", () => {
  test("single は選んだ 1 つだけになる", () => {
    expect(toggleOption(Q1, ["a"], "b")).toEqual(["b"]);
  });

  test("multiple は足し引きし、選択肢の順にそろえる", () => {
    expect(toggleOption(Q2, ["c"], "a")).toEqual(["a", "c"]);
    expect(toggleOption(Q2, ["a", "c"], "a")).toEqual(["c"]);
  });
});

test("標本が質問と回答の検証を通る", () => {
  expect(validateQuestions(QUESTIONS).ok).toBe(true);
  expect(validateAnswers(QUESTIONS, ANSWERS).ok).toBe(true);
});

const REPO = { nameWithOwner: "o/r" };
const sections = (list: typeof INTAKES) => list.map(intakeSection);
const times = (list: typeof INTAKES) => list.map((i) => Date.parse(i.updated_at));

describe("countIntakeAttention", () => {
  test("needs_human だけを数える", () => {
    expect(countIntakeAttention(INTAKES)).toBe(2);
  });

  test("1 件もなければ 0", () => {
    expect(countIntakeAttention([])).toBe(0);
  });
});

describe("intakeOrder", () => {
  const order = intakeOrder(INTAKES, PROJECTS, "all", false);

  test("対応が要るもの・調査・分解中・進行中の順に並ぶ", () => {
    expect(sections(order)).toEqual(["attention", "attention", "working", "working", "active"]);
  });

  test("対応が要るものは更新の古い順", () => {
    const [a, b] = times(order.slice(0, 2));
    expect(a).toBeLessThan(b);
  });

  test("調査・分解中と進行中は更新の新しい順", () => {
    const [a, b] = times(order.slice(2, 4));
    expect(a).toBeGreaterThan(b);
  });

  test("既定では終了した Intake を含まない", () => {
    expect(order.map((i) => i.state)).not.toContain("completed");
    expect(order.map((i) => i.state)).not.toContain("canceled");
  });

  test("すべてでは末尾に終了した Intake が新しい順で並ぶ", () => {
    const all = intakeOrder(INTAKES, PROJECTS, "all", true);
    expect(sections(all.slice(5))).toEqual(["closed", "closed"]);
    expect(all.slice(5).map((i) => i.state)).toEqual(["canceled", "completed"]);
  });

  test("プロジェクトで絞る", () => {
    const out = intakeOrder(INTAKES, PROJECTS, "shop-api", false);
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((i) => i.project_id === 2)).toBe(true);
  });

  test("状態だけ変わった行も一覧から消えない", () => {
    const stale = { ...INTAKES[6], state: "answering" as const, needs_human: false };
    expect(intakeSection(stale)).toBe("working");
    expect(intakeOrder([stale], PROJECTS, "all", false)).toEqual([stale]);
  });
});

describe("issueNumber / intakeProgress", () => {
  test("URL の末尾から番号を取る", () => {
    expect(issueNumber("https://github.com/o/r/issues/12")).toBe("12");
    expect(issueNumber("https://example.com/x")).toBeNull();
  });

  test("承認前は進み具合を出さない", () => {
    expect(intakeProgress({ ...INTAKES[0], progress: { done: 2, total: 5 } })).toBe("2/5");
    expect(intakeProgress({ ...INTAKES[0], progress: { done: 0, total: 0 } })).toBeNull();
  });
});

describe("intakeFace", () => {
  test("状態ごとの面", () => {
    const expected: Record<IntakeState, string> = {
      investigating: "running",
      decomposing: "running",
      answering: "questions",
      reviewing: "review",
      needs_attention: "attention",
      active: "progress",
      completed: "progress",
      canceled: "progress",
    };
    for (const [state, face] of Object.entries(expected)) {
      expect(intakeFace(state as IntakeState)).toBe(face);
    }
  });
});

describe("parseIssueInput", () => {
  const url = "https://github.com/o/r/issues/12";

  test.each(["#12", "12", " 12 ", url, "https://github.com/O/R/issues/12#issuecomment-1"])(
    "%s は URL にする",
    (input) => {
      expect(parseIssueInput(input, REPO)).toBe(url);
    },
  );

  test.each(["https://github.com/x/y/issues/12", "", "abc", "#", "https://github.com/o/r/pull/12"])(
    "%s は null",
    (input) => {
      expect(parseIssueInput(input, REPO)).toBeNull();
    },
  );
});

describe("ghGuidance", () => {
  test("gh が無い", () => {
    const g = ghGuidance({ ok: false, reason: "not_installed", message: "" });
    expect(g.title).toBe("gh が見つかりません");
    expect(g.fix).toContain("https://cli.github.com");
    expect(g.command).toBeNull();
  });

  test("ログインしていない", () => {
    const g = ghGuidance({ ok: false, reason: "not_logged_in", message: "" });
    expect(g.title).toBe("gh にログインしていません");
    expect(g.command).toBe("gh auth login");
  });

  test("GitHub の remote が無い", () => {
    const g = ghGuidance({ ok: false, reason: "no_github_remote", message: "" });
    expect(g.title).toBe("このリポジトリに GitHub の remote がありません");
    expect(g.command).toBeNull();
  });
});

describe("issueTarget", () => {
  const active = INTAKES.find((i) => i.state === "active" && !i.needs_human)!;

  test("進行中の Intake がある Issue は開始の代わりに開く", () => {
    expect(issueTarget({ url: "https://github.com/o/r/issues/9", intake_id: "i1" }, []))
      .toEqual({ kind: "open", intakeId: "i1" });
  });

  test("直接入力の Issue も一覧の Intake と照合して開く", () => {
    expect(issueTarget({ url: active.issue_url }, INTAKES))
      .toEqual({ kind: "open", intakeId: active.id });
  });

  test("終了した Intake しかない Issue は開始できる", () => {
    const canceled = INTAKES.find((i) => i.state === "canceled")!;
    expect(issueTarget({ url: canceled.issue_url }, [canceled]))
      .toEqual({ kind: "start", url: canceled.issue_url });
  });

  test("Intake の無い Issue は開始", () => {
    const url = "https://github.com/o/r/issues/99";
    expect(issueTarget({ url }, INTAKES)).toEqual({ kind: "start", url });
  });
});
