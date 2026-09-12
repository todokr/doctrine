#!/usr/bin/env node
import { connect } from "node:net";
import { socketPath } from "../daemon/server.ts";
import type { Response, ServerEvent } from "../daemon/protocol.ts";
import { isDirectlyExecuted } from "../util/entry.ts";

const NUMERIC = new Set(["priority", "limit", "tail", "step_run_id"]);
const BOOLEAN = new Set(["force", "follow"]);

/** リクエストが応答を待つ最大時間。`--follow` で接続を張りっぱなしにする
 * ストリーミングモードを将来追加するときは、この一律タイムアウトは使えない
 * （待ち続けること自体が正しい動作になるため）。その場合は follow 専用の
 * 経路を別に用意すること。 */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * 引数列を一度だけ舐めて、`--flag [value]` をフラグとして消費し、
 * 残りを positional として集める。`--flag` の直後の要素はフラグの値として
 * 必ず消費するので、値が別のフラグや positional と紛れて index がずれることはない。
 */
function splitArgs(argv: string[]): { flags: Record<string, unknown>; positional: string[] } {
  const flags: Record<string, unknown> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (BOOLEAN.has(key)) {
        flags[key] = true;
        continue;
      }
      i += 1;
      const value = argv[i];
      if (NUMERIC.has(key)) {
        const n = Number(value);
        // Number(undefined) も Number("abc") も NaN になる。NaN は
        // JSON.stringify で null にすり替わり、デーモン側の
        // `typeof params.x === "number"` チェックを黙って通り抜けて
        // 既定値にフォールバックしてしまう。CLI 自身の引数形式の検証
        // なので、ここで弾いてもデーモンの業務ルールを重複させることにはならない。
        if (!Number.isFinite(n)) throw new Error(`--${key} には数値を指定してください（渡された値: ${String(value)}）`);
        flags[key] = n;
      } else {
        flags[key] = value;
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

export function parseArgv(argv: string[]): { method: string; params: Record<string, unknown> } {
  const [cmd, ...rest] = argv;
  const { flags, positional } = splitArgs(rest);
  switch (cmd) {
    case "add":
      return { method: "task.create", params: flags };
    case "ls":
      return { method: "task.list", params: flags };
    case "get":
      return { method: "task.get", params: { task_id: positional[0], ...flags } };
    case "approve":
      return { method: "task.approve", params: { task_id: positional[0] } };
    case "reject":
      return { method: "task.reject", params: { task_id: positional[0], ...flags } };
    case "pause":
      return { method: "task.pause", params: { task_id: positional[0] } };
    case "resume":
      return { method: "task.resume", params: { task_id: positional[0] } };
    case "cancel":
      return { method: "task.cancel", params: { task_id: positional[0] } };
    case "logs":
      return { method: "task.logs", params: { task_id: positional[0], ...flags } };
    case "projects":
      return { method: "project.list", params: {} };
    case "project-add":
      return { method: "project.add", params: flags };
    case "project-update":
      return { method: "project.update", params: flags };
    case "worktrees":
      return { method: "worktree.list", params: {} };
    case "gc":
      return { method: "worktree.remove", params: { task_id: positional[0], ...flags } };
    case "ratelimit":
      return { method: "ratelimit.recent", params: flags };
    default:
      throw new Error(`未知のコマンドです: ${cmd}`);
  }
}

/** サーバから来る1行が `Response`（idを持つ）か `ServerEvent`（eventを持つ）かを判定する。 */
function isEvent(msg: Response | ServerEvent): msg is ServerEvent {
  return "event" in msg;
}

export function call(
  path: string,
  method: string,
  params: Record<string, unknown>,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const requestId = 1;
    const socket = connect(path);
    let buf = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(`デーモンからの応答がありません（${timeoutMs}ミリ秒待ちました）`));
    }, timeoutMs);

    function settle(fn: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    }

    socket.setEncoding("utf8");
    socket.on("error", (err: NodeJS.ErrnoException) => {
      settle(() => {
        if (err.code === "ENOENT") {
          reject(new Error(`デーモンが起動していないようです（ソケットが見つかりません: ${path}）`));
        } else {
          reject(err);
        }
      });
    });
    socket.on("connect", () => socket.write(JSON.stringify({ id: requestId, method, params }) + "\n"));
    socket.on("data", (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim() === "") continue;

        let msg: Response | ServerEvent;
        try {
          msg = JSON.parse(line) as Response | ServerEvent;
        } catch {
          // これはこの Promise executor の外（'data' コールバック）で起きるので、
          // 素の throw は誰にも catch されず uncaught exception としてプロセスを
          // 落とす。必ずここで捕まえて reject に変換し、ソケットも閉じる。
          const excerpt = line.length > 200 ? `${line.slice(0, 200)}…` : line;
          settle(() => {
            socket.destroy();
            reject(new Error(`デーモンからの応答がJSONとして読めません: ${excerpt}`));
          });
          return;
        }

        if (isEvent(msg)) continue; // このコマンドはイベント購読をしないので無視
        if (msg.id === null) {
          // id が null ということは、デーモンがリクエスト自体を JSON として
          // 読めなかったということ。この接続でこれ以上まともな応答は来ないので、
          // 無視して待ち続けるのではなく、ここで確定的に失敗させる。
          settle(() => {
            socket.end();
            reject(new Error(msg.ok ? "不明なプロトコルエラーです" : msg.error));
          });
          return;
        }
        if (msg.id !== requestId) continue;
        settle(() => {
          socket.end();
          if (msg.ok) resolve(msg.result);
          else reject(new Error(msg.error));
        });
        return;
      }
    });
  });
}

export async function main(argv: string[]): Promise<number> {
  try {
    const { method, params } = parseArgv(argv);
    const result = await call(process.env.DOCTRINE_SOCKET ?? socketPath(), method, params);
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }
}

if (isDirectlyExecuted(import.meta.filename)) {
  process.exitCode = await main(process.argv.slice(2));
}
