import { type ChildProcess, spawn } from "node:child_process";
import type { Readable } from "node:stream";

export type ExitStatus = { code: number | null; signal: NodeJS.Signals | null };

export type Child = {
  pid: number;
  stdout: Readable;
  stderr: Readable;
  status: Promise<ExitStatus>;
  kill(signal?: NodeJS.Signals): void;
};

/**
 * stdin を閉じ、stdout / stderr をパイプにして子プロセスを起こす。
 * 存在しないコマンドや cwd は `spawn` が投げずに `pid` を undefined にし、理由を後から
 * `error` イベントで伝える。起動できたかは同期で返し、失敗の理由は `failed` で届ける。
 */
export function startChild(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string> },
): { child: Child } | { failed: Promise<Error> } {
  let proc: ChildProcess;
  try {
    proc = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    return { failed: Promise.resolve(e as Error) };
  }
  if (proc.pid === undefined) {
    return { failed: new Promise((resolve) => proc.once("error", resolve)) };
  }
  // 起動後の error（kill の失敗など）でプロセスが落ちないように聞いておく。
  proc.on("error", () => {});
  const status = new Promise<ExitStatus>((resolve) => {
    proc.once("close", (code, signal) => resolve({ code, signal }));
  });
  return {
    child: {
      pid: proc.pid,
      stdout: proc.stdout!,
      stderr: proc.stderr!,
      status,
      kill: (signal = "SIGTERM") => {
        proc.kill(signal);
      },
    },
  };
}

/** startChild の失敗を reject にしたもの。 */
export async function spawnChild(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string> },
): Promise<Child> {
  const r = startChild(cmd, args, opts);
  if ("failed" in r) throw await r.failed;
  return r.child;
}

/**
 * 外部コマンドを最後まで走らせ、stdout / stderr を文字列で返す。
 * 非0終了は例外にする — 呼び出し側（git / ps）は失敗を例外として扱う前提で書かれている。
 */
export async function runCommand(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string>; clearEnv?: boolean } = {},
): Promise<{ stdout: string; stderr: string }> {
  // spawn の env は親の環境を置き換える。親が持つ変数を消したい呼び出し
  // （captureTree の GIT_DIR / GIT_WORK_TREE）だけが clearEnv を立て、env をそのまま渡す。
  const env = opts.clearEnv ? opts.env : opts.env && { ...process.env, ...opts.env };
  const child = await spawnChild(cmd, args, { cwd: opts.cwd, env: env as Record<string, string> });
  const [status, stdout, stderr] = await Promise.all([
    child.status,
    readAll(child.stdout),
    readAll(child.stderr),
  ]);
  if (status.code !== 0) {
    throw new Error(`Command failed: ${[cmd, ...args].join(" ")}\n${stderr}`);
  }
  return { stdout, stderr };
}

async function readAll(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** 子プロセスの終了コード。シグナルで殺された場合は null。 */
export function exitCodeOf(status: ExitStatus): number | null {
  return status.code;
}
