import type { Artifact, Pfd } from "./pfd.ts";

export type SubIssueContent = { title: string; body: string };

const MARKER = /<!-- doctrine:intake=(\S+) process=(\S+) -->/g;

/** 本文の末尾に置く目印。`<!-- doctrine:intake=<intakeId> process=<processId> -->` */
export function subIssueMarker(intakeId: string, processId: string): string {
  return `<!-- doctrine:intake=${intakeId} process=${processId} -->`;
}

/** 本文から目印を読む。複数あれば最後のもの。無ければ null。 */
export function parseSubIssueMarker(body: string): { intakeId: string; processId: string } | null {
  const last = [...body.matchAll(MARKER)].at(-1);
  return last ? { intakeId: last[1], processId: last[2] } : null;
}

/** 入力の成果物を出力に持つプロセスの id。given の成果物は数えない。重複なし、pfd.processes の順。 */
export function upstreamProcessIds(pfd: Pfd, processId: string): string[] {
  const process = pfd.processes.find((p) => p.id === processId);
  if (!process) throw new Error(`案にプロセス ${processId} がありません`);
  const producers = new Map<string, string>();
  for (const p of pfd.processes) {
    for (const artifactId of p.outputs) producers.set(artifactId, p.id);
  }
  const wanted = new Set<string>();
  for (const artifactId of process.inputs) {
    const producer = producers.get(artifactId);
    if (producer !== undefined) wanted.add(producer);
  }
  return pfd.processes.filter((p) => wanted.has(p.id)).map((p) => p.id);
}

function artifactLine(a: Artifact): string {
  // 決定の成果物は回答の中身を持ち込まないよう、名前だけにする
  return a.description && a.decision === undefined
    ? `- ${a.name}: ${a.description}`
    : `- ${a.name}`;
}

/**
 * upstreamUrls: プロセスの id → sub-issue の URL。まだ無いプロセスはキーを持たない。
 * プロセスが pfd に無ければ投げる。
 */
export function buildSubIssue(input: {
  pfd: Pfd;
  intakeId: string;
  processId: string;
  upstreamUrls: ReadonlyMap<string, string>;
}): SubIssueContent {
  const { pfd, intakeId, processId, upstreamUrls } = input;
  const process = pfd.processes.find((p) => p.id === processId);
  if (!process) throw new Error(`案にプロセス ${processId} がありません`);
  const artifact = (id: string): Artifact => {
    const found = pfd.artifacts.find((a) => a.id === id);
    if (!found) throw new Error(`案に成果物 ${id} がありません`);
    return found;
  };

  const sections: string[] = [["## 目的", process.purpose ?? ""].join("\n")];
  if (process.actor === "human") {
    sections.push("このプロセスは人が行う。完了は Intake の画面で記録する。");
  }
  sections.push(["## 入力", ...process.inputs.map((id) => artifactLine(artifact(id)))].join("\n"));
  sections.push([
    "## 出力",
    ...process.outputs.flatMap((id) => {
      const a = artifact(id);
      return a.verify ? [artifactLine(a), `  確かめ方: ${a.verify}`] : [artifactLine(a)];
    }),
  ].join("\n"));
  sections.push(["## 完了条件", process.done_when ?? ""].join("\n"));

  const upstream = upstreamProcessIds(pfd, processId);
  if (upstream.length > 0) {
    sections.push([
      "## 先に終わっている必要があるもの",
      ...upstream.map((id) => {
        const name = pfd.processes.find((p) => p.id === id)!.name;
        const url = upstreamUrls.get(id);
        return url ? `- ${url} ${name}` : `- ${name}（sub-issue 未作成）`;
      }),
    ].join("\n"));
  }
  sections.push(subIssueMarker(intakeId, processId));
  return { title: process.name, body: sections.join("\n\n") };
}
