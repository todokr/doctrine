import type { Readable } from "node:stream";

/**
 * 1行が極端に長くなる（実測では hook_response 行に skill 本文が丸ごと入っていた）。
 * バッファ長に上限を設けず、改行が来るまで貯める。
 */
export async function* readNdjson(stream: Readable): AsyncGenerator<unknown> {
  let buffer = "";
  stream.setEncoding("utf8");
  for await (const chunk of stream) {
    buffer += chunk as string;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const parsed = tryParse(line);
      if (parsed !== undefined) yield parsed;
    }
  }
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
