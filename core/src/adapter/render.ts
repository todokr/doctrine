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

/**
 * ツールごとに「何を相手にしたか」を取る。
 * 引数の名前はツール定義に従うので、ツールが増えたらここに足す。
 */
const DETAIL: Record<string, (i: Record<string, unknown>) => string> = {
  Bash: (i) => join(str(i.command)),
  Read: (i) => join(str(i.file_path)),
  Write: (i) => join(str(i.file_path)),
  Edit: (i) => join(str(i.file_path)),
  NotebookEdit: (i) => join(str(i.notebook_path)),
  Grep: (i) => join(str(i.pattern), str(i.path)),
  Glob: (i) => join(str(i.pattern), str(i.path)),
  Agent: (i) => join(str(i.description)),
  Task: (i) => join(str(i.description)),
  Skill: (i) => join(str(i.skill), str(i.args)),
  WebFetch: (i) => join(str(i.url)),
  WebSearch: (i) => join(str(i.query)),
  TodoWrite: () => "",
};

function detailOf(name: string, input: Record<string, unknown>): string {
  const known = DETAIL[name];
  if (known) return known(input);
  if (Object.keys(input).length === 0) return "";
  return oneLine(JSON.stringify(input));
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** 引数どうしは2つの空白で区切る。値の中の空白と見分けるため。 */
function join(...parts: string[]): string {
  return parts.filter((p) => p !== "").map(oneLine).join("  ");
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
