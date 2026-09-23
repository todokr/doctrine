import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { validateAnswers, validateQuestions } from "../../../shared/intake/validateQuestion.ts";

type Obj = Record<string, unknown>;

const tableIndex = 1;

function q1Materials(): Obj[] {
  return [
    { kind: "text", body: "現状は **同期** で書き込んでいる" },
    {
      kind: "table",
      caption: "案の比較",
      columns: ["案", "利点", "欠点"],
      rows: [["a", "単純", "遅い"], ["b", "速い", "複雑"]],
    },
    {
      kind: "code",
      caption: "いまの書き込み",
      language: "ts",
      path: "core/src/x.ts",
      code: "await write(x);",
    },
    { kind: "code", caption: "案の疑似コード", language: "ts", path: null, code: "queue.push(x);" },
    {
      kind: "diagram",
      caption: "書き込みの流れ",
      diagram: {
        id: "g1",
        title: "流れ",
        body: {
          shape: "sequence",
          actors: ["UI", "Core"],
          messages: [{ from: "UI", to: "Core", label: "要求" }],
        },
      },
    },
  ];
}

function question1(over: Obj = {}): Obj {
  return {
    id: "q1",
    prompt: "書き込みをどう扱うか",
    kind: "single",
    options: [
      { id: "a", label: "同期", description: "呼び出しの中で書く" },
      { id: "b", label: "非同期", description: "キューに積む" },
    ],
    materials: q1Materials(),
    ...over,
  };
}

function question2(over: Obj = {}): Obj {
  return {
    id: "q2",
    prompt: "対象にするものを選ぶ",
    kind: "multiple",
    options: [
      { id: "a", label: "A", description: "説明 A" },
      { id: "b", label: "B", description: "説明 B" },
      { id: "c", label: "C", description: "説明 C" },
    ],
    materials: [{
      kind: "diagram",
      caption: "状態",
      diagram: {
        id: "g2",
        title: "状態遷移",
        body: {
          shape: "graph",
          kind: "state",
          nodes: [{ id: "n1", label: "開始" }, { id: "n2", label: "終了" }],
          edges: [{ from: "n1", to: "n2", label: "完了" }],
        },
      },
    }],
    ...over,
  };
}

function question3(over: Obj = {}): Obj {
  return {
    id: "q3",
    prompt: "ほかに考慮すべきことは",
    kind: "free",
    options: [],
    materials: [],
    ...over,
  };
}

function validQuestions(): Obj[] {
  return [question1(), question2(), question3()];
}

function assumption1(over: Obj = {}): Obj {
  return {
    id: "s1",
    statement: "書き込みは 1 秒に数回に収まる",
    evidence: [
      { kind: "issue", commentUrl: null, quote: "利用者は社内の数人" },
      {
        kind: "code",
        path: "core/src/x.ts",
        startLine: 10,
        endLine: 12,
        excerpt: "await write(x);",
      },
      { kind: "convention", body: "既存の書き込みはすべて同期" },
    ],
    impact: "書き込みのプロセスにキューが要るかが変わる",
    ...over,
  };
}

function validAssumptions(): Obj[] {
  return [assumption1(), assumption1({ id: "s2", evidence: [{ kind: "convention", body: "x" }] })];
}

function content(questions: unknown = validQuestions(), assumptions: unknown = validAssumptions()) {
  return { questions, assumptions };
}

function validAnswers(): Obj[] {
  return [
    { questionId: "q1", optionIds: ["a"], other: null, note: null },
    { questionId: "q2", optionIds: ["b", "c"], other: null, note: "補足" },
    { questionId: "q3", optionIds: [], other: "自由記述", note: null },
  ];
}

function validResponses(): Obj[] {
  return [
    { assumptionId: "s1", verdict: "accepted" },
    { assumptionId: "s2", verdict: "corrected", correction: "1 秒に数百回になりうる" },
  ];
}

function questionIssuesOf(questions: unknown, assumptions: unknown = []): string[] {
  const result = validateQuestions({ questions, assumptions });
  assert.equal(result.ok, false);
  return result.ok ? [] : result.issues;
}

function assumptionIssuesOf(assumptions: unknown): string[] {
  const result = validateQuestions({ questions: validQuestions(), assumptions });
  assert.equal(result.ok, false);
  return result.ok ? [] : result.issues;
}

function parsedContent() {
  const result = validateQuestions(content());
  assert.equal(result.ok, true);
  return result.ok ? result : { questions: [], assumptions: [] };
}

function validateReply(answers: unknown, assumptionResponses: unknown = validResponses()) {
  return validateAnswers(parsedContent(), { answers, assumptionResponses });
}

function answerIssuesOf(
  answers: unknown,
  assumptionResponses: unknown = validResponses(),
): string[] {
  const result = validateReply(answers, assumptionResponses);
  assert.equal(result.ok, false);
  return result.ok ? [] : result.issues;
}

function responseIssuesOf(assumptionResponses: unknown): string[] {
  return answerIssuesOf(validAnswers(), assumptionResponses);
}

function answersWith(index: number, over: Obj): Obj[] {
  const answers = validAnswers();
  answers[index] = { ...answers[index], ...over };
  return answers;
}

// 質問と仮定の形

test("spec の型に沿った質問と仮定のまとまりが ok になり、そのまま返る", () => {
  const input = content();
  const result = validateQuestions(input);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.questions, input.questions);
    assert.deepEqual(result.assumptions, input.assumptions);
  }
});

test("質問も仮定も無い空のまとまりは ok になる", () => {
  assert.equal(validateQuestions(content([], [])).ok, true);
});

test("形が壊れた入力でも例外を投げずに落ちる", () => {
  for (const input of [null, undefined, "質問", {}]) {
    assert.ok(questionIssuesOf(input).length >= 1);
    assert.ok(assumptionIssuesOf(input).length >= 1);
  }
  assert.ok(questionIssuesOf({}).some((s) => s.startsWith("questions")));
  assert.ok(assumptionIssuesOf({}).some((s) => s.startsWith("assumptions")));
});

test("質問は推奨を持てない", () => {
  const recommendation = { optionIds: ["a"], text: null, reason: "単純で十分速い" };
  const issues = questionIssuesOf([question1({ recommendation })]);
  assert.ok(issues.some((s) => s.startsWith("questions.0") && s.includes("recommendation")));
});

test("知らないキーがあったら落ちる", () => {
  const issues = questionIssuesOf([question1({ title: "x" })]);
  assert.ok(issues.some((s) => s.startsWith("questions.0") && s.includes("title")));
});

test("kind が 3 つ以外なら落ちる", () => {
  const issues = questionIssuesOf([question1({ kind: "choice" })]);
  assert.ok(issues.some((s) => s.startsWith("questions.0.kind")));
});

test("判断材料の kind が 4 つ以外なら落ちる", () => {
  const input = [question1({ materials: [{ kind: "image", caption: "x" }] })];
  assert.ok(questionIssuesOf(input).length > 0);
});

test("code の path は null を書く必要があり、省けない", () => {
  const materials = q1Materials();
  const { path: _path, ...codeWithoutPath } = materials[3];
  materials[3] = codeWithoutPath;
  assert.ok(questionIssuesOf([question1({ materials })]).length > 0);
});

test("図の材料は Review Guide の図の形だけを許す", () => {
  const materials = q1Materials();
  materials[4] = {
    kind: "diagram",
    caption: "x",
    diagram: { id: "g1", title: "流れ", body: { shape: "flow" } },
  };
  assert.ok(questionIssuesOf([question1({ materials })]).length > 0);
});

test("根拠の無い仮定は落ちる", () => {
  const issues = assumptionIssuesOf([assumption1({ evidence: [] })]);
  assert.ok(issues.some((s) => s.startsWith("assumptions.0.evidence")));
});

test("根拠の kind が 3 つ以外なら落ちる", () => {
  const issues = assumptionIssuesOf([assumption1({ evidence: [{ kind: "guess", body: "x" }] })]);
  assert.ok(issues.some((s) => s.startsWith("assumptions.0.evidence.0")));
});

test("コードの根拠の行は null を書く必要があり、省けない", () => {
  const evidence = [{ kind: "code", path: "core/src/x.ts", excerpt: "x" }];
  const issues = assumptionIssuesOf([assumption1({ evidence })]);
  assert.ok(issues.some((s) => s.startsWith("assumptions.0.evidence.0")));
});

test("仮定の知らないキーは落ちる", () => {
  const issues = assumptionIssuesOf([assumption1({ recommendation: "x" })]);
  assert.ok(issues.some((s) => s.startsWith("assumptions.0") && s.includes("recommendation")));
});

// 質問と仮定の整合性

test("選択肢が無い single は落ちる", () => {
  const issues = questionIssuesOf([question1({ options: [] })]);
  assert.ok(issues.some((s) => s.startsWith("questions.0.options")));
});

test("選択肢が無い multiple は落ちる", () => {
  const issues = questionIssuesOf([question1(), question2({ options: [] })]);
  assert.ok(issues.some((s) => s.startsWith("questions.1.options")));
});

test("free が選択肢を持っていたら落ちる", () => {
  const options = [{ id: "a", label: "A", description: "説明" }];
  const issues = questionIssuesOf([question1(), question2(), question3({ options })]);
  assert.ok(issues.some((s) => s.startsWith("questions.2.options")));
});

test("質問 id が重複したら落ちる", () => {
  const issues = questionIssuesOf([question1(), question2({ id: "q1" })]);
  assert.ok(issues.some((s) => s.startsWith("questions.1.id") && s.includes("重複")));
});

test("仮定 id が質問 id と重なったら落ちる", () => {
  const issues = assumptionIssuesOf([assumption1({ id: "q2" })]);
  assert.ok(issues.some((s) => s.startsWith("assumptions.0.id") && s.includes("重複")));
});

test("仮定 id が重複したら落ちる", () => {
  const issues = assumptionIssuesOf([assumption1(), assumption1()]);
  assert.ok(issues.some((s) => s.startsWith("assumptions.1.id") && s.includes("重複")));
});

test("質問の中で選択肢 id が重複したら落ちる", () => {
  const options = [
    { id: "a", label: "同期", description: "呼び出しの中で書く" },
    { id: "a", label: "非同期", description: "キューに積む" },
  ];
  const issues = questionIssuesOf([question1({ options })]);
  assert.ok(issues.some((s) => s.startsWith("questions.0.options.1.id")));
});

test("表の行の列数が columns と違えば落ちる", () => {
  const materials = q1Materials();
  materials[tableIndex] = {
    kind: "table",
    caption: "案の比較",
    columns: ["案", "利点", "欠点"],
    rows: [["a", "単純", "遅い"], ["b", "速い"]],
  };
  const issues = questionIssuesOf([question1({ materials })]);
  assert.ok(issues.some((s) => s.startsWith(`questions.0.materials.${tableIndex}.rows.1`)));
});

test("違反が複数あればすべて返す", () => {
  const issues = questionIssuesOf(
    [question1({ options: [] }), question2({ id: "q1" })],
    [assumption1({ id: "q1" })],
  );
  assert.ok(issues.some((s) => s.startsWith("questions.0.options")));
  assert.ok(issues.some((s) => s.startsWith("questions.1.id")));
  assert.ok(issues.some((s) => s.startsWith("assumptions.0.id")));
});

// 回答

test("すべての質問に正しく答え、すべての仮定に応じた回答が ok になり、そのまま返る", () => {
  const result = validateReply(validAnswers());
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.answers, validAnswers());
    assert.deepEqual(result.assumptionResponses, validResponses());
  }
});

test("single は選択肢の代わりに other で答えられる", () => {
  assert.equal(validateReply(answersWith(0, { optionIds: [], other: "別案" })).ok, true);
});

test("multiple は選択と other を併せて答えられる", () => {
  assert.equal(validateReply(answersWith(1, { optionIds: ["a"], other: "別案" })).ok, true);
});

test("形が壊れた回答は例外を投げずに落ちる", () => {
  assert.ok(answerIssuesOf(null).length >= 1);
  const issues = answerIssuesOf([{ questionId: "q1" }]);
  assert.ok(issues.some((s) => s.startsWith("answers.0")));
  assert.ok(responseIssuesOf(null).some((s) => s.startsWith("assumptionResponses")));
});

test("答えていない質問があれば落ちる", () => {
  const issues = answerIssuesOf(validAnswers().slice(0, 2));
  assert.ok(issues.some((s) => s.includes("q3")));
});

test("存在しない質問への回答は落ちる", () => {
  const extra = { questionId: "q9", optionIds: [], other: "x", note: null };
  const issues = answerIssuesOf([...validAnswers(), extra]);
  assert.ok(issues.some((s) => s.startsWith("answers.3.questionId") && s.includes("q9")));
});

test("同じ質問への回答が重複したら落ちる", () => {
  const issues = answerIssuesOf([...validAnswers(), validAnswers()[0]]);
  assert.ok(issues.some((s) => s.includes("重複") && s.includes("q1")));
});

test("存在しない選択肢を選んだら落ちる", () => {
  const issues = answerIssuesOf(answersWith(0, { optionIds: ["z"] }));
  assert.ok(issues.some((s) => s.startsWith("answers.0.optionIds.0") && s.includes("z")));
});

test("回答の選択肢 id が重複したら落ちる", () => {
  const issues = answerIssuesOf(answersWith(1, { optionIds: ["a", "a"] }));
  assert.ok(issues.some((s) => s.startsWith("answers.1.optionIds.1") && s.includes("重複")));
});

test("single で 2 つ選んだら落ちる", () => {
  const issues = answerIssuesOf(answersWith(0, { optionIds: ["a", "b"] }));
  assert.ok(issues.some((s) => s.startsWith("answers.0")));
});

test("single で選択と other の両方を書いたら落ちる", () => {
  const issues = answerIssuesOf(answersWith(0, { optionIds: ["a"], other: "別案" }));
  assert.ok(issues.some((s) => s.startsWith("answers.0")));
});

test("single で選択も other も無ければ落ちる", () => {
  const issues = answerIssuesOf(answersWith(0, { optionIds: [], other: null }));
  assert.ok(issues.some((s) => s.startsWith("answers.0")));
});

test("multiple で選択も other も無ければ落ちる", () => {
  const issues = answerIssuesOf(answersWith(1, { optionIds: [], other: null }));
  assert.ok(issues.some((s) => s.startsWith("answers.1")));
});

test("free で other が無ければ落ちる", () => {
  const issues = answerIssuesOf(answersWith(2, { other: null }));
  assert.ok(issues.some((s) => s.startsWith("answers.2")));
});

test("free で選択肢を選んだら落ちる", () => {
  const issues = answerIssuesOf(answersWith(2, { optionIds: ["a"], other: "x" }));
  assert.ok(issues.some((s) => s.startsWith("answers.2")));
});

test("応答の無い仮定があれば落ちる", () => {
  const issues = responseIssuesOf(validResponses().slice(0, 1));
  assert.ok(issues.some((s) => s.includes("応答がありません") && s.includes("s2")));
});

test("存在しない仮定への応答は落ちる", () => {
  const extra = { assumptionId: "s9", verdict: "accepted" };
  const issues = responseIssuesOf([...validResponses(), extra]);
  assert.ok(issues.some((s) => s.startsWith("assumptionResponses.2.assumptionId")));
});

test("同じ仮定への応答が重複したら落ちる", () => {
  const issues = responseIssuesOf([...validResponses(), validResponses()[0]]);
  assert.ok(issues.some((s) => s.includes("重複") && s.includes("s1")));
});

test("書き直すなら内容が要る", () => {
  const issues = responseIssuesOf([
    validResponses()[0],
    { assumptionId: "s2", verdict: "corrected", correction: "  " },
  ]);
  assert.ok(issues.some((s) => s.startsWith("assumptionResponses.1") && s.includes("書き直した")));
});

test("認める応答は内容を持てない", () => {
  const issues = responseIssuesOf([
    { assumptionId: "s1", verdict: "accepted", correction: "x" },
    validResponses()[1],
  ]);
  assert.ok(issues.some((s) => s.startsWith("assumptionResponses.0")));
});
