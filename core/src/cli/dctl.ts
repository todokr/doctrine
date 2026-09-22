#!/usr/bin/env -S deno run --allow-all
import { socketPath } from "../daemon/server.ts";
import type { Response, ServerEvent, TaskLogs } from "../../../shared/protocol.ts";

const NUMERIC = new Set(["priority", "limit", "tail", "step_run_id"]);
const BOOLEAN = new Set(["force", "follow", "include_closed"]);

/** 最初の応答を待つ最大時間。`followLogs` は末尾の応答を受け取った後は
 * タイムアウトしない（log.line を待ち続けること自体が正しい動作のため）。 */
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
  logs <task-id> [--tail <n>] [--step_run_id <n>] [--follow]
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
  gc --path <path> [--force]      dctl worktrees が出すパスを消す

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
      // task_id と path の排他はデーモンが検査する。task_id のキーは指定があるときだけ載せる。
      return {
        method: "worktree.remove",
        params: positional[0] === undefined ? flags : { task_id: positional[0], ...flags },
      };
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

/** ソケットに繋ぐ。無ければデーモン未起動のメッセージで投げる。 */
async function connect(path: string): Promise<Deno.UnixConn> {
  try {
    return await Deno.connect({ transport: "unix", path });
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      throw new Error(`デーモンが起動していないようです（ソケットが見つかりません: ${path}）`);
    }
    throw err;
  }
}

/** リクエストを 1 行 JSON で書き切る。 */
async function send(
  conn: Deno.UnixConn,
  id: number,
  method: string,
  params: Record<string, unknown>,
): Promise<void> {
  const request = new TextEncoder().encode(JSON.stringify({ id, method, params }) + "\n");
  let offset = 0;
  while (offset < request.length) offset += await conn.write(request.subarray(offset));
}

/**
 * 受信バイト列を改行で切って JSON.parse し、1 件ずつ返す。
 * 相手が閉じたら（read が null）終わる。JSON として読めない行は抜粋付きで投げる。
 */
async function* readMessages(conn: Deno.UnixConn): AsyncGenerator<Response | ServerEvent> {
  const decoder = new TextDecoder();
  const bytes = new Uint8Array(64 * 1024);
  let buf = "";
  while (true) {
    const n = await conn.read(bytes);
    if (n === null) return;
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
  const state: { conn?: Deno.UnixConn } = {};
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
    try {
      state.conn?.close();
    } catch { /* 既に閉じている */ }
  }
}

function closeQuietly(conn: Deno.UnixConn): void {
  try {
    conn.close();
  } catch { /* 既に閉じている */ }
}

/**
 * task.logs を follow: true で送り、返ってきた末尾を 1 行ずつ out に渡した後、
 * 同じ接続に届く、このタスクの log.line を 1 行ずつ out に渡し続ける。
 * signal が中断されたら接続を閉じて resolve する。デーモンが接続を閉じたら reject する。
 */
export async function followLogs(
  path: string,
  params: Record<string, unknown>,
  out: (line: string) => void,
  signal: AbortSignal,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<void> {
  if (signal.aborted) return;
  const requestId = 1;
  const conn = await connect(path);
  const onAbort = () => closeQuietly(conn);
  signal.addEventListener("abort", onAbort);
  // 接続を待つ間に中断されていたら、リスナーを付ける前の abort は拾えない。
  if (signal.aborted) onAbort();

  let timedOut = false;
  // 最初の応答を待つ間だけ張る。応答が来たら追従に入るので解除する。
  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    timedOut = true;
    closeQuietly(conn);
  }, timeoutMs);
  const timeoutError = () =>
    new Error(`デーモンからの応答がありません（${timeoutMs}ミリ秒待ちました）`);

  let answered = false;
  try {
    if (signal.aborted) return;
    await send(conn, requestId, "task.logs", params);
    for await (const msg of readMessages(conn)) {
      if (signal.aborted) return;
      if (answered) {
        if (isEvent(msg) && msg.event === "log.line" && msg.task_id === params.task_id) {
          out(msg.line);
        }
        continue;
      }
      // 応答より前の log.line は捨てる（末尾と重なるため）
      if (isEvent(msg)) continue;
      if (msg.id === null) throw new Error(msg.ok ? "不明なプロトコルエラーです" : msg.error);
      if (msg.id !== requestId) continue;
      clearTimeout(timer);
      timer = undefined;
      if (!msg.ok) throw new Error(msg.error);
      answered = true;
      const lines = (msg.result as TaskLogs).lines;
      // ファイルが改行で終わると split で末尾に空要素が 1 つ付く
      const tail = lines.at(-1) === "" ? lines.slice(0, -1) : lines;
      for (const line of tail) out(line);
    }
    if (signal.aborted) return;
    if (timedOut) throw timeoutError();
    throw new Error(
      answered ? "デーモンが接続を閉じました" : "デーモンが応答を返す前に接続を閉じました",
    );
  } catch (err) {
    // 外から接続を閉じると保留中の read が reject する
    if (signal.aborted) return;
    if (timedOut) throw timeoutError();
    throw err;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    closeQuietly(conn);
  }
}

export async function main(argv: string[]): Promise<number> {
  try {
    const { method, params } = parseArgv(argv);
    const path = Deno.env.get("DOCTRINE_SOCKET") ?? socketPath();
    if (method === "task.logs" && params.follow === true) {
      const controller = new AbortController();
      const onSigint = () => controller.abort();
      Deno.addSignalListener("SIGINT", onSigint);
      try {
        await followLogs(path, params, (line) => console.log(line), controller.signal);
      } finally {
        Deno.removeSignalListener("SIGINT", onSigint);
      }
      return 0;
    }
    const result = await call(path, method, params);
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
