import type { Artifact, Pfd, Process } from "./model.ts";
import type { DispatchRecord } from "./store.ts";

function line(a: Artifact): string {
  return a.description ? `- ${a.name}: ${a.description}` : `- ${a.name}`;
}

export function buildPrompt(
  pfd: Pfd,
  process: Process,
  record: DispatchRecord,
  issue: { url: string; title: string },
): string {
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
    if (by === undefined) {
      onBase.push(line(a));
      continue;
    }
    const note = record.done[by]?.note;
    if (!note) {
      throw new Error(
        `成果物「${a.name}」の内容がありません（プロセス ${by} を pfd done で完了にしてください）`,
      );
    }
    decided.push(`- ${a.name}: ${note}`);
  }

  const premise: string[] = [];
  if (onBase.length > 0) premise.push(`すでに baseBranch にあるもの:\n${onBase.join("\n")}`);
  if (decided.length > 0) premise.push(`人が決めたこと:\n${decided.join("\n")}`);

  const outputs = process.outputs.map((id) => {
    const a = artifact.get(id)!;
    return `${line(a)}\n  確かめ方: ${a.verify ?? ""}`;
  });

  return [
    `${issue.url} ${issue.title}`,
    "この作業は、上の Issue を分解したうちの 1 つである。",
    `## 目的\n${process.purpose ?? ""}`,
    `## 前提\n${premise.join("\n\n")}`,
    `## 作るもの\n${outputs.join("\n")}`,
    `## 手順\n${process.steps ?? ""}`,
    `## 完了条件\n${process.done_when ?? ""}`,
    "## 範囲\nこの作業の出力は上の「作るもの」だけである。Issue の残りの部分は別の作業が担う。",
  ].join("\n\n") + "\n";
}
