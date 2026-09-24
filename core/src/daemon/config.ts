import { dirname, join } from "@std/path";
import { z } from "zod";
import { formatZodIssues } from "../workflow/schema.ts";
import { DEFAULT_GLOBAL_LIMIT } from "../domain/scheduler.ts";
import { stateRoot } from "../util/home.ts";

export const CONFIG_FILE_NAME = "config.json";

/** 状態ディレクトリの設定ファイル。 */
export function defaultConfigPath(): string {
  return join(stateRoot(), CONFIG_FILE_NAME);
}

export type DaemonConfig = { globalLimit: number; linearApiKey?: string };

const schema = z.object({
  globalLimit: z.number().int().min(1).optional(),
  linearApiKey: z.string().min(1).optional(),
}).strict();

/** 1 以上の整数でなければ投げる。上限は無い。 */
export function validateGlobalLimit(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1) return value;
  throw new Error(`global_limit は 1 以上の整数で指定してください（渡された値: ${String(value)}）`);
}

export async function readDaemonConfig(
  path: string,
): Promise<{ config: DaemonConfig; warning: string | null }> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      return { config: { globalLimit: DEFAULT_GLOBAL_LIMIT }, warning: null };
    }
    return {
      config: { globalLimit: DEFAULT_GLOBAL_LIMIT },
      warning:
        `設定ファイル (${path}) を読めないため全体の実行枠は既定値 ${DEFAULT_GLOBAL_LIMIT} で動きます: ${
          (e as Error).message
        }`,
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return {
      config: { globalLimit: DEFAULT_GLOBAL_LIMIT },
      warning:
        `設定ファイル (${path}) を読めないため全体の実行枠は既定値 ${DEFAULT_GLOBAL_LIMIT} で動きます: ${
          (e as Error).message
        }`,
    };
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      config: { globalLimit: DEFAULT_GLOBAL_LIMIT },
      warning:
        `設定ファイル (${path}) を読めないため全体の実行枠は既定値 ${DEFAULT_GLOBAL_LIMIT} で動きます: ${
          formatZodIssues(parsed.error).join("; ")
        }`,
    };
  }
  return {
    config: { ...parsed.data, globalLimit: parsed.data.globalLimit ?? DEFAULT_GLOBAL_LIMIT },
    warning: null,
  };
}

export async function writeDaemonConfig(path: string, config: DaemonConfig): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${crypto.randomUUID()}.tmp`;
  await Deno.writeTextFile(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  try {
    await Deno.rename(tmp, path);
  } catch (e) {
    await Deno.remove(tmp).catch(() => {});
    throw e;
  }
}

/** 全体の実行枠だけを書き換え、config.json のほかの設定（linearApiKey）は残す。 */
export async function saveGlobalLimit(path: string, globalLimit: number): Promise<void> {
  const { config } = await readDaemonConfig(path);
  await writeDaemonConfig(path, { ...config, globalLimit });
}
