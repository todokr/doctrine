#!/usr/bin/env -S deno run --allow-all
import { socketPath } from "../daemon/server.ts";
import type { Response, ServerEvent } from "../../../shared/protocol.ts";

const NUMERIC = new Set(["priority", "limit", "tail", "step_run_id"]);
const BOOLEAN = new Set(["force", "follow", "include_closed"]);

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
        if (!Number.isFinite(n)) {
          throw new Error(`--${key} には数値を指定してください（渡された値: ${String(value)}）`);
        }
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

export const USAGE = `使い方: dctl <コマンド> [引数]

タスク
  add --project <path> --title <t> --prompt <p> [--workflow <name>] [--priority <n>]
  ls [--project <path>] [--state <state>]
  get <task-id>
  approve <task-id>
  reject <task-id> --comment <text>
  pause | resume | cancel <task-id>
  logs <task-id> [--tail <n>] [--step_run_id <n>]
  diff <task-id> [--since last_review]

プロジェクト
  projects
  project-add --path <path>       .doctrine/ の雛形を作って登録する
  project-update --path <path>    .doctrine/project.yaml の変更を取り込む

Intake
  intake ls [--project <path>] [--include_closed]
  intake get <intake-id>
  開始・回答・差し戻し・承認・中止はアプリから行う

worktree
  worktrees
  gc <task-id> [--force]

その他
  ratelimit [--limit <n>]

環境変数 DOCTRINE_SOCKET でデーモンのソケットの場所を上書きできる。`;

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
    case "diff":
      return { method: "task.diff", params: { task_id: positional[0], ...flags } };
    case "projects":
      return { method: "project.list", params: {} };
    case "project-add":
      return { method: "project.add", params: flags };
    case "project-update":
      return { method: "project.update", params: flags };
    case "intake": {
      // 読むだけ。承認は人だけが行うので、操作のサブコマンドは足さない。
      const [sub, intakeId] = positional;
      switch (sub) {
        case "ls":
          return { method: "intake.list", params: flags };
        case "get":
          return { method: "intake.get", params: { intake_id: intakeId } };
        default:
          throw new Error(`未知のコマンドです: intake ${sub ?? ""}\n\n${USAGE}`);
      }
    }
    case "worktrees":
      return { method: "worktree.list", params: {} };
    case "gc":
      return { method: "worktree.remove", params: { task_id: positional[0], ...flags } };
    case "ratelimit":
      return { method: "ratelimit.recent", params: flags };
    case undefined:
    case "help":
    case "--help":
    case "-h":
      throw new Error(USAGE);
    default:
      throw new Error(`未知のコマンドです: ${cmd}\n\n${USAGE}`);
  }
}

/** サーバから来る1行が `Response`（idを持つ）か `ServerEvent`（eventを持つ）かを判定する。 */
function isEvent(msg: Response | ServerEvent): msg is ServerEvent {
  return "event" in msg;
}

export async function call(
  path: string,
  method: string,
  params: Record<string, unknown>,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<unknown> {
  const requestId = 1;
  // タイムアウト時に読み取り待ちの接続を閉じるため、接続は外から触れる場所に置く。
  const state: { conn?: Deno.UnixConn } = {};
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`デーモンからの応答がありません（${timeoutMs}ミリ秒待ちました）`));
    }, timeoutMs);
  });

  const exchange = (async (): Promise<unknown> => {
    try {
      state.conn = await Deno.connect({ transport: "unix", path });
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) {
        throw new Error(`デーモンが起動していないようです（ソケットが見つかりません: ${path}）`);
      }
      throw err;
    }
    const conn = state.conn;
    const request = new TextEncoder().encode(
      JSON.stringify({ id: requestId, method, params }) + "\n",
    );
    let offset = 0;
    while (offset < request.length) offset += await conn.write(request.subarray(offset));

    const decoder = new TextDecoder();
    const bytes = new Uint8Array(64 * 1024);
    let buf = "";
    while (true) {
      const n = await conn.read(bytes);
      if (n === null) throw new Error("デーモンが応答を返す前に接続を閉じました");
      buf += decoder.decode(bytes.subarray(0, n), { stream: true });
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
    }
  })();
  // タイムアウトが先に確定した後、閉じた接続の読み取りが reject しても未処理にしない。
  exchange.catch(() => {});

  try {
    return await Promise.race([exchange, timeout]);
  } finally {
    clearTimeout(timer);
    try {
      state.conn?.close();
    } catch { /* 既に閉じている */ }
  }
}

export async function main(argv: string[]): Promise<number> {
  try {
    const { method, params } = parseArgv(argv);
    const result = await call(Deno.env.get("DOCTRINE_SOCKET") ?? socketPath(), method, params);
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }
}

if (import.meta.main) {
  Deno.exitCode = await main(Deno.args);
}
