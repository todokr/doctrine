/**
 * 外部コマンドを最後まで走らせ、stdout / stderr を文字列で返す。
 * 非0終了は例外にする — 呼び出し側（git / ps）は失敗を例外として扱う前提で書かれている。
 */
export async function runCommand(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): Promise<{ stdout: string; stderr: string }> {
  const out = await new Deno.Command(cmd, {
    args, cwd: opts.cwd, env: opts.env, stdin: "null", stdout: "piped", stderr: "piped",
  }).output();
  const decoder = new TextDecoder();
  const stdout = decoder.decode(out.stdout);
  const stderr = decoder.decode(out.stderr);
  if (!out.success) {
    throw new Error(`Command failed: ${[cmd, ...args].join(" ")}\n${stderr}`);
  }
  return { stdout, stderr };
}

/**
 * 子プロセスの終了コード。シグナルで殺された場合は null を返す（Deno は 128+シグナル番号を
 * code に入れるが、それを「コマンドが返した終了コード」として記録すると区別がつかなくなる）。
 */
export function exitCodeOf(status: Deno.CommandStatus): number | null {
  return status.signal === null ? status.code : null;
}
