import type { GhRun } from "../../src/github/gh.ts";

export type GhCall = { args: string[]; cwd: string };

/**
 * 引数ごとに応答を返す。応答が Error なら投げる。
 * どれにも当たらなければ「想定外の gh 呼び出し」で投げる。
 */
export function fakeGh(
  respond: (args: string[]) => string | Error | undefined,
): { run: GhRun; calls: GhCall[] } {
  const calls: GhCall[] = [];
  const run: GhRun = (args, cwd) => {
    calls.push({ args, cwd });
    const res = respond(args);
    if (res === undefined) {
      return Promise.reject(new Error(`想定外の gh 呼び出し: ${args.join(" ")}`));
    }
    return res instanceof Error ? Promise.reject(res) : Promise.resolve(res);
  };
  return { run, calls };
}

/** `gh api graphql` の引数から query と -f / -F の値を取り出す。 */
export function parseGraphqlArgs(
  args: string[],
): { query: string; raw: Record<string, string>; typed: Record<string, string> } {
  const raw: Record<string, string> = {};
  const typed: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag !== "-f" && flag !== "-F") continue;
    const kv = args[++i];
    const eq = kv.indexOf("=");
    (flag === "-f" ? raw : typed)[kv.slice(0, eq)] = kv.slice(eq + 1);
  }
  const query = raw.query ?? "";
  delete raw.query;
  return { query, raw, typed };
}
