import type { Artifact, Pfd } from "../../../../shared/intake/pfd.ts";

export type TaskPromptInput = {
  pfd: Pfd;
  processId: string;
  parentIssue: { url: string; title: string };
  /** sub-issue を作る前（R-3 のプレビュー）は null。 */
  subIssueUrl: string | null;
  /** 人のプロセスの id → 完了の記録の note。 */
  humanNotes: Readonly<Record<string, string>>;
  /** 質問の id → 回答を文章にしたもの。回答の文章化は呼び出し側が行う。 */
  decisions: Readonly<Record<string, string>>;
};

function line(a: Artifact): string {
  return a.description ? `- ${a.name}: ${a.description}` : `- ${a.name}`;
}

export function buildTaskPrompt(input: TaskPromptInput): string {
  const { pfd, parentIssue, subIssueUrl } = input;
  const process = pfd.processes.find((p) => p.id === input.processId);
  if (!process) throw new Error(`プロセス ${input.processId} は案にありません`);

  const artifact = new Map(pfd.artifacts.map((a) => [a.id, a]));
  const humanProducer = new Map<string, string>();
  for (const p of pfd.processes) {
    if (p.actor === "human") p.outputs.forEach((o) => humanProducer.set(o, p.id));
  }

  const onBase: string[] = [];
  const decided: string[] = [];
  for (const id of process.inputs) {
    const a = artifact.get(id)!;
    const by = humanProducer.get(id);
    if (a.decision !== undefined) {
      const answer = input.decisions[a.decision];
      if (!answer) {
        throw new Error(`成果物「${a.name}」の決定（質問 ${a.decision} の回答）がありません`);
      }
      decided.push(`- ${a.name}: ${answer}`);
    } else if (by !== undefined) {
      const note = input.humanNotes[by];
      if (!note) {
        throw new Error(
          `成果物「${a.name}」の内容がありません（プロセス ${by} の完了が記録されていません）`,
        );
      }
      decided.push(`- ${a.name}: ${note}`);
    } else {
      onBase.push(line(a));
    }
  }

  const premise: string[] = [];
  if (onBase.length > 0) premise.push(`すでに baseBranch にあるもの:\n${onBase.join("\n")}`);
  if (decided.length > 0) premise.push(`人が決めたこと:\n${decided.join("\n")}`);

  const outputs = process.outputs.map((id) => {
    const a = artifact.get(id)!;
    return `${line(a)}\n  確かめ方: ${a.verify ?? ""}`;
  });

  const head = [`${parentIssue.url} ${parentIssue.title}`];
  if (subIssueUrl !== null) head.push(`この作業の sub-issue: ${subIssueUrl}`);

  return [
    head.join("\n"),
    "この作業は、上の Issue を分解したうちの 1 つである。",
    `## 目的\n${process.purpose ?? ""}`,
    `## 前提\n${premise.join("\n\n")}`,
    `## 作るもの\n${outputs.join("\n")}`,
    `## 手順\n${process.steps ?? ""}`,
    `## 完了条件\n${process.done_when ?? ""}`,
    "## 範囲\nこの作業の出力は上の「作るもの」だけである。Issue の残りの部分は別の作業が担う。",
  ].join("\n\n") + "\n";
}
