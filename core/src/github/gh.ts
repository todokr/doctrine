import { z } from "zod";
import { runCommand } from "../util/exec.ts";

/**
 * gh を cwd で走らせて stdout を返す。非 0 終了は Error、gh が PATH に無ければ
 * Deno.errors.NotFound を投げる。
 */
export type GhRun = (args: string[], cwd: string) => Promise<string>;

/** 例外は包まずに伝える。呼び出し側が NotFound で「gh が無い」を見分ける。 */
export const defaultGhRun: GhRun = async (args, cwd) => {
  const { stdout } = await runCommand("gh", args, { cwd });
  return stdout;
};

export function parseGhJson<T>(schema: z.ZodType<T>, stdout: string, label: string): T {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    throw new Error(`${label} の出力を JSON として読めません: ${stdout.slice(0, 200)}`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`${label} の出力が想定した形ではありません: ${detail}`);
  }
  return parsed.data;
}

/**
 * `gh api graphql` の引数を組む。変数はすべて -f（生の文字列）で渡す。-F は値を型変換し、
 * `@` で始まる値をファイルとして読むので、本文やブランチ名には使わない。
 * repoVars は `{owner}` `{repo}` を gh に置き換えさせる（-F でだけ置き換わる）。
 */
export function graphqlArgs(
  query: string,
  vars: Record<string, string>,
  opts: { repoVars?: boolean } = {},
): string[] {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [k, v] of Object.entries(vars)) args.push("-f", `${k}=${v}`);
  if (opts.repoVars) args.push("-F", "owner={owner}", "-F", "name={repo}");
  return args;
}
