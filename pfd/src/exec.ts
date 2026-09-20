import type { Run } from "./ports.ts";

export const runStdout: Run = async (cmd, args, cwd) => {
  let out: Deno.CommandOutput;
  try {
    out = await new Deno.Command(cmd, {
      args,
      cwd,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    })
      .output();
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      throw new Error(`${cmd} が見つかりません（PATH を確認してください）`);
    }
    throw err;
  }
  const decoder = new TextDecoder();
  if (!out.success) {
    throw new Error(`${[cmd, ...args].join(" ")} が失敗しました:\n${decoder.decode(out.stderr)}`);
  }
  return decoder.decode(out.stdout);
};
