import type { Pfd } from "./pfd.ts";

/** 差し戻しのコメント 1 件。intake.reject の NewComment と同じ形。 */
export type FeedbackComment = {
  target_kind: "artifact" | "process" | "whole";
  target_id: string | null;
  body: string;
};

function targetLabel(pfd: Pfd, c: FeedbackComment): string {
  if (c.target_kind === "whole") return "計画全体";
  const kind = c.target_kind === "artifact" ? "成果物" : "プロセス";
  const id = c.target_id ?? "";
  const list: { id: string; name: string }[] = c.target_kind === "artifact"
    ? pfd.artifacts
    : pfd.processes;
  const found = list.find((e) => e.id === id);
  return found ? `${kind} ${id}「${found.name}」` : `${kind} ${id}`;
}

/**
 * 差し戻しのコメントを、エージェントへ送る文面にする。画面のプレビューと同じ関数を
 * デーモンが使うので、コメントを DB に書く前でも呼べる。番号は渡された順に 1 から振る。
 */
export function buildFeedback(pfd: Pfd, comments: FeedbackComment[]): string {
  const lines = ["前回の PFD が差し戻されました。次のコメントに対応してください。", ""];
  comments.forEach((c, i) => {
    lines.push(`### コメント ${i + 1}: ${targetLabel(pfd, c)}`, "", c.body, "");
  });
  lines.push(
    '直した PFD を `kind: "pfd"` で返し、各コメントへの返答を `replies` に ' +
      "`commentId`（上のコメントの番号）で入れてください。" +
      "直すうえで人に決めてもらう事項が新たに出たら、PFD ではなく質問を返してかまいません。",
  );
  return lines.join("\n");
}
