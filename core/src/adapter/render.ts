import { toolInputParts } from "../../../shared/toolInput.ts";
import type { AgentEvent } from "./types.ts";

/** 1行に載せる結果の長さ。これを超える分は切り落とす。 */
const MAX_RESULT = 120;

/**
 * イベントを、ログを読む人間に向けた1行にする。伝えるものが無いイベントは null。
 *
 * 読み手が追うのは「何を相手に、どの道具を使い、通ったか」であって、
 * イベントの構造ではない。だから system（hook_started / thinking_tokens など）と
 * result はここで落とす — 前者は中身が無く、後者は step_runs に残る。
 */
export function renderEvent(ev: AgentEvent): string | null {
  switch (ev.kind) {
    case "assistant":
      return ev.text.trim() === "" ? null : ev.text;
    case "toolUse": {
      const detail = detailOf(ev.name, ev.input);
      return detail === "" ? ev.name : `${ev.name}  ${detail}`;
    }
    case "toolResult": {
      const body = clip(ev.content.trim().replace(/\s+/g, " "));
      if (body === "") return null;
      return `${ev.isError ? "  ✗ " : "  → "}${body}`;
    }
    case "rateLimit":
      return `枠 ${ev.window} ${Math.round(ev.utilization * 100)}%`;
    case "system":
    case "result":
      return null;
  }
}

/** 引数どうしは2つの空白で区切る。値の中の空白と見分けるため。 */
function detailOf(name: string, input: Record<string, unknown>): string {
  return toolInputParts(name, input).map(oneLine).join("  ");
}

/**
 * 呼び出しの引数は1行目だけを見せる。複数行のシェルスクリプトを丸ごと流すと、
 * 何を呼んだかの一覧性が失われる。落とした行があることは末尾の … で示す。
 */
function oneLine(s: string): string {
  const [first = "", ...rest] = s.trim().split("\n");
  const body = first.trim().replace(/\s+/g, " ");
  const clipped = clip(body);
  return clipped === body && rest.some((l) => l.trim() !== "") ? `${body}…` : clipped;
}

function clip(s: string): string {
  return s.length > MAX_RESULT ? `${s.slice(0, MAX_RESULT)}…` : s;
}
