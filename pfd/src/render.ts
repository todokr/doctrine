import type { Pfd } from "./model.ts";
import type { ProcessState, ProcessStatus } from "./status.ts";

const STATE_CLASS: Partial<Record<ProcessState, string>> = {
  done: "finished",
  merged: "finished",
  ready: "ready",
  your_turn: "ready",
  running: "active",
  pr_open: "active",
  no_pr: "stopped",
  task_stopped: "stopped",
};

function label(text: string): string {
  return text.replaceAll('"', "#quot;");
}

export function toMermaid(pfd: Pfd, statuses?: ProcessStatus[]): string {
  const a = new Map(pfd.artifacts.map((x, i) => [x.id, `a${i}`]));
  const lines = ["flowchart LR"];

  pfd.artifacts.forEach((x, i) => lines.push(`  a${i}["${label(x.name)}"]`));
  pfd.processes.forEach((p, i) => lines.push(`  p${i}(("${label(p.id)}<br/>${label(p.name)}"))`));
  pfd.processes.forEach((p, i) => {
    for (const id of p.inputs) if (a.has(id)) lines.push(`  ${a.get(id)} --> p${i}`);
    for (const id of p.outputs) if (a.has(id)) lines.push(`  p${i} --> ${a.get(id)}`);
  });

  lines.push("  classDef human stroke-dasharray: 5 5");
  lines.push("  classDef finished fill:#c8e6c9,stroke:#2e7d32,color:#000");
  lines.push("  classDef ready fill:#fff9c4,stroke:#f9a825,color:#000");
  lines.push("  classDef active fill:#bbdefb,stroke:#1565c0,color:#000");
  lines.push("  classDef stopped fill:#ffcdd2,stroke:#c62828,color:#000");

  pfd.processes.forEach((p, i) => {
    if (p.actor === "human") lines.push(`  class p${i} human`);
    const cls = STATE_CLASS[statuses?.find((s) => s.id === p.id)?.state ?? "waiting"];
    if (cls) lines.push(`  class p${i} ${cls}`);
  });
  return lines.join("\n");
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function toHtml(title: string, mermaid: string): string {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 24px; }
  .legend span { display: inline-block; margin-right: 16px; padding: 2px 8px; border: 1px solid #999; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<p class="legend">
  <span style="background:#fff9c4">着手可能・あなたの番</span>
  <span style="background:#bbdefb">実行中・PR レビュー待ち</span>
  <span style="background:#c8e6c9">完了</span>
  <span style="background:#ffcdd2">止まっている</span>
  <span style="border-style:dashed">人が行う</span>
</p>
<pre class="mermaid">${escapeHtml(mermaid)}</pre>
<script type="module">
  import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
  mermaid.initialize({ startOnLoad: true });
</script>
</body>
</html>
`;
}
