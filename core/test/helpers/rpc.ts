import { once } from "node:events";
import { connect as netConnect, type Socket } from "node:net";
import type { Response, ServerEvent } from "../../../shared/protocol.ts";
import { isNotFound } from "../../src/util/fsError.ts";

/** テストからデーモンに 1 回だけ RPC を投げるクライアント。応答を待つ上限。 */
const REQUEST_TIMEOUT_MS = 30_000;

/** サーバから来る1行が `Response`（idを持つ）か `ServerEvent`（eventを持つ）かを判定する。 */
function isEvent(msg: Response | ServerEvent): msg is ServerEvent {
  return "event" in msg;
}

/** ソケットに繋ぐ。無ければデーモン未起動のメッセージで投げる。 */
async function connect(path: string): Promise<Socket> {
  const sock = netConnect(path);
  try {
    await once(sock, "connect");
  } catch (err) {
    sock.destroy();
    if (isNotFound(err)) {
      throw new Error(`デーモンが起動していないようです（ソケットが見つかりません: ${path}）`);
    }
    throw err;
  }
  // 接続後の EPIPE / ECONNRESET は readMessages の終わりとして扱う。
  sock.on("error", () => {});
  return sock;
}

/** リクエストを 1 行 JSON で書き切る。 */
async function send(
  conn: Socket,
  id: number,
  method: string,
  params: Record<string, unknown>,
): Promise<void> {
  const line = JSON.stringify({ id, method, params }) + "\n";
  await new Promise<void>((resolve, reject) =>
    conn.write(line, (e) => (e ? reject(e) : resolve())),
  );
}

/**
 * 受信バイト列を改行で切って JSON.parse し、1 件ずつ返す。
 * 相手が閉じたら終わる。JSON として読めない行は抜粋付きで投げる。
 */
async function* readMessages(conn: Socket): AsyncGenerator<Response | ServerEvent> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of conn) {
    buf += decoder.decode(chunk as Buffer, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim() === "") continue;

      let msg: Response | ServerEvent;
      try {
        msg = JSON.parse(line) as Response | ServerEvent;
      } catch {
        const excerpt = line.length > 200 ? `${line.slice(0, 200)}…` : line;
        throw new Error(`デーモンからの応答がJSONとして読めません: ${excerpt}`);
      }
      yield msg;
    }
  }
}

export async function call(
  path: string,
  method: string,
  params: Record<string, unknown>,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<unknown> {
  const requestId = 1;
  // タイムアウト時に読み取り待ちの接続を閉じるため、接続は外から触れる場所に置く。
  const state: { conn?: Socket } = {};
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`デーモンからの応答がありません（${timeoutMs}ミリ秒待ちました）`));
    }, timeoutMs);
  });

  const exchange = (async (): Promise<unknown> => {
    state.conn = await connect(path);
    const conn = state.conn;
    await send(conn, requestId, method, params);

    for await (const msg of readMessages(conn)) {
      if (isEvent(msg)) continue; // このコマンドはイベント購読をしないので無視
      if (msg.id === null) {
        // id が null ということは、デーモンがリクエスト自体を JSON として
        // 読めなかったということ。この接続でこれ以上まともな応答は来ないので、
        // 無視して待ち続けるのではなく、ここで確定的に失敗させる。
        throw new Error(msg.ok ? "不明なプロトコルエラーです" : msg.error);
      }
      if (msg.id !== requestId) continue;
      if (msg.ok) return msg.result;
      throw new Error(msg.error);
    }
    throw new Error("デーモンが応答を返す前に接続を閉じました");
  })();
  // タイムアウトが先に確定した後、閉じた接続の読み取りが reject しても未処理にしない。
  exchange.catch(() => {});

  try {
    return await Promise.race([exchange, timeout]);
  } finally {
    clearTimeout(timer);
    state.conn?.destroy();
  }
}
