/**
 * 1行が極端に長くなる（実測では hook_response 行に skill 本文が丸ごと入っていた）。
 * バッファ長に上限を設けず、改行が来るまで貯める。
 *
 * 入力はバイト列でも文字列でもよい（Deno の子プロセスの stdout は Uint8Array を流す）。
 * マルチバイト文字の途中でチャンクが割れても、TextDecoder の stream モードが
 * 不完全なバイト列を次のチャンクまで保留するので文字化けしない。
 */
export async function* readNdjson(stream: AsyncIterable<string | Uint8Array>): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const parsed = tryParse(line);
      if (parsed !== undefined) yield parsed;
    }
  }
  buffer += decoder.decode();
  const rest = tryParse(buffer);
  if (rest !== undefined) yield rest;
}

function tryParse(line: string): unknown | undefined {
  const t = line.trim();
  if (t === "") return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined; // 壊れた行で読み取り全体を落とさない
  }
}
