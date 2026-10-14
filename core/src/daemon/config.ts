import { isNotFound } from "../util/fsError.ts";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { formatZodIssues } from "../workflow/schema.ts";
import { DEFAULT_GLOBAL_LIMIT } from "../domain/scheduler.ts";
import { configRoot } from "../util/home.ts";

export const CONFIG_FILE_NAME = "config.json";

/** 設定ディレクトリの設定ファイル。 */
export function defaultConfigPath(): string {
  return join(configRoot(), CONFIG_FILE_NAME);
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
    text = await readFile(path, "utf8");
  } catch (e) {
    if (isNotFound(e)) {
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
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  try {
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

/** 全体の実行枠だけを書き換え、config.json のほかの設定（linearApiKey）は残す。 */
export async function saveGlobalLimit(path: string, globalLimit: number): Promise<void> {
  const { config } = await readDaemonConfig(path);
  await writeDaemonConfig(path, { ...config, globalLimit });
}
