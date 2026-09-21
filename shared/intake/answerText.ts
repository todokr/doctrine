import type { Answer, Question } from "./question.ts";

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

/**
 * 人の回答を、分解の会話へ返す文面にする。画面のモーダルと同じ関数をデーモンが使う。
 * 回答の検証は validateAnswers の役目で、ここでは投げない。
 */
export function buildAnswerText(questions: Question[], answers: Answer[]): string {
  const lines = ["質問への回答です。", ""];
  for (const q of questions) {
    lines.push(`### ${q.id}: ${q.prompt}`, "");
    const a = answers.find((x) => x.questionId === q.id);
    for (const l of describeAnswer(q, a)) lines.push(`- ${l}`);
    lines.push("");
  }
  lines.push(
    '回答を踏まえて分解し、PFD を `kind: "pfd"` で返してください。' +
      "決まった事項のうちプロセスの前提になるものは、`decision` にその質問の id を入れた " +
      "`given: true` の成果物として置きます。" +
      "まだ人に決めてもらう事項が残るなら、質問を返してかまいません。",
  );
  return lines.join("\n");
}
