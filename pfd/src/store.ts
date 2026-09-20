import { basename, join } from "@std/path";
import { z } from "zod";

/** doctrine（core/src/util/home.ts）と同じ規則。core は import しないので、規則だけを揃えている。 */
export function stateRoot(): string {
  const dir = Deno.env.get("DOCTRINE_STATE_DIR");
  if (dir) return dir;
  const home = Deno.env.get("HOME");
  if (!home) {
    throw new Error(
      "HOME が設定されていません（DOCTRINE_STATE_DIR で状態ディレクトリを指定してください）",
    );
  }
  return join(home, ".local", "state", "doctrine");
}

export async function hashOf(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function projectKey(projectPath: string): Promise<string> {
  return `${basename(projectPath)}-${(await hashOf(projectPath)).slice(0, 8)}`;
}

export async function pfdDir(projectPath: string, issue: number): Promise<string> {
  return join(stateRoot(), "pfd", await projectKey(projectPath), String(issue));
}

export interface DispatchRecord {
  approved: { hash: string; at: string } | null;
  tasks: Record<string, { task_id: string; branch: string; at: string }>;
  done: Record<string, { note: string; at: string }>;
}

export function emptyRecord(): DispatchRecord {
  return { approved: null, tasks: {}, done: {} };
}

const recordSchema = z.object({
  approved: z.object({ hash: z.string(), at: z.string() }).nullable(),
  tasks: z.record(z.unknown()),
  done: z.record(z.unknown()),
});

export async function readRecord(dir: string): Promise<DispatchRecord> {
  const file = join(dir, "dispatch.json");
  let text: string;
  try {
    text = await Deno.readTextFile(file);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return emptyRecord();
    throw err;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`dispatch.json を読めません: ${file}`);
  }
  if (!recordSchema.safeParse(raw).success) {
    throw new Error(`dispatch.json の形が正しくありません: ${file}`);
  }
  return raw as DispatchRecord;
}

export async function writeRecord(dir: string, record: DispatchRecord): Promise<void> {
  const target = join(dir, "dispatch.json");
  const tmp = `${target}.tmp`;
  await Deno.writeTextFile(tmp, JSON.stringify(record, null, 2) + "\n");
  await Deno.rename(tmp, target);
}
