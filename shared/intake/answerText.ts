import type { Answer, Assumption, AssumptionResponse, Question } from "./question.ts";
import type { QuestionSetContent, QuestionSetReply } from "./validateQuestion.ts";

function describeAnswer(q: Question, a: Answer | undefined): string[] {
  if (a === undefined) return ["回答なし"];
  const lines: string[] = [];
  for (const id of a.optionIds) {
    const option = q.options.find((o) => o.id === id);
    lines.push(`選んだ選択肢: ${option ? `${option.label}（${id}）` : id}`);
  }
  if (a.other !== null && a.other !== "") lines.push(`選択肢以外の答え: ${a.other}`);
  if (a.note !== null && a.note !== "") lines.push(`補足: ${a.note}`);
  return lines.length > 0 ? lines : ["回答なし"];
}

// 認めたか書き直したかを、下流の prompt でも見分けられる文にする
function describeResponse(a: Assumption, r: AssumptionResponse): string {
  return r.verdict === "accepted"
    ? `エージェントの仮定を人が認めた: ${a.statement}`
    : `人が書き直した: ${r.correction}（エージェントの仮定: ${a.statement}）`;
}

/**
 * 回答済みのまとまりから、質問 id・仮定 id → 決定の文章 を作る。buildTaskPrompt の decisions に渡す。
 * 未回答のまとまり（reply が null）は飛ばす。
 */
export function decisionTexts(
  sets: readonly (QuestionSetContent & { reply: QuestionSetReply | null })[],
): Record<string, string> {
  const texts: Record<string, string> = {};
  for (const set of sets) {
    if (set.reply === null) continue;
    for (const q of set.questions) {
      const a = set.reply.answers.find((x) => x.questionId === q.id);
      if (a === undefined) continue;
      texts[q.id] = describeAnswer(q, a).join("、");
    }
    for (const a of set.assumptions) {
      const r = set.reply.assumptionResponses.find((x) => x.assumptionId === a.id);
      if (r === undefined) continue;
      texts[a.id] = describeResponse(a, r);
    }
  }
  return texts;
}

/**
 * 人の回答と仮定への応答を、分解の会話へ返す文面にする。画面のモーダルと同じ関数をデーモンが使う。
 * 回答の検証は validateAnswers の役目で、ここでは投げない。
 */
export function buildAnswerText(set: QuestionSetContent, reply: QuestionSetReply): string {
  const lines: string[] = [];
  if (set.questions.length > 0) {
    lines.push("## 質問への回答", "");
    for (const q of set.questions) {
      lines.push(`### ${q.id}: ${q.prompt}`, "");
      const a = reply.answers.find((x) => x.questionId === q.id);
      for (const l of describeAnswer(q, a)) lines.push(`- ${l}`);
      lines.push("");
    }
  }

  const responded = set.assumptions.flatMap((a) => {
    const r = reply.assumptionResponses.find((x) => x.assumptionId === a.id);
    return r === undefined ? [] : [{ a, r }];
  });
  const corrected = responded.filter(({ r }) => r.verdict === "corrected");
  const accepted = responded.filter(({ r }) => r.verdict === "accepted");
  if (corrected.length > 0) {
    lines.push("## 人が書き直した仮定", "");
    for (const { a, r } of corrected) {
      lines.push(`### ${a.id}: ${a.statement}`, "");
      if (r.verdict === "corrected") lines.push(`- 正しい内容: ${r.correction}`);
      lines.push("");
    }
  }
  if (accepted.length > 0) {
    lines.push("## 人が認めた仮定", "");
    for (const { a } of accepted) lines.push(`- ${a.id}: ${a.statement}`);
    lines.push("");
  }

  lines.push(
    '回答を踏まえて分解し、PFD を `kind: "pfd"` で返してください。' +
      "決まった事項のうちプロセスの前提になるものは、`decision` にその質問か仮定の id を入れた " +
      "`given: true` の成果物として置きます。" +
      "書き直された仮定は、書き直された内容を前提にします。" +
      "まだ人に決めてもらう事項が残るなら、質問を返してかまいません。",
  );
  return lines.join("\n");
}
