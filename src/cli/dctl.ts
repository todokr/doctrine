import { connect } from "node:net";
import { socketPath } from "../daemon/server.ts";
import type { Response, ServerEvent } from "../daemon/protocol.ts";

const NUMERIC = new Set(["priority", "limit", "tail", "step_run_id"]);
const BOOLEAN = new Set(["force", "follow"]);

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
      flags[key] = NUMERIC.has(key) ? Number(value) : value;
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

export function call(path: string, method: string, params: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const requestId = 1;
    const socket = connect(path);
    let buf = "";
    socket.setEncoding("utf8");
    socket.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        reject(new Error(`デーモンが起動していないようです（ソケットが見つかりません: ${path}）`));
      } else {
        reject(err);
      }
    });
    socket.on("connect", () => socket.write(JSON.stringify({ id: requestId, method, params }) + "\n"));
    socket.on("data", (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim() === "") continue;
        const msg = JSON.parse(line) as Response | ServerEvent;
        if (isEvent(msg)) continue; // このコマンドはイベント購読をしないので無視
        if (msg.id === null) {
          // id が null ということは、デーモンがリクエスト自体を JSON として
          // 読めなかったということ。この接続でこれ以上まともな応答は来ないので、
          // 無視して待ち続けるのではなく、ここで確定的に失敗させる。
          socket.end();
          reject(new Error(msg.ok ? "不明なプロトコルエラーです" : msg.error));
          return;
        }
        if (msg.id !== requestId) continue;
        socket.end();
        if (msg.ok) resolve(msg.result);
        else reject(new Error(msg.error));
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

if (import.meta.filename === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
