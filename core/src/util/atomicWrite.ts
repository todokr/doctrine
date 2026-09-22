import { dirname, join } from "@std/path";

/** target と同じディレクトリの一時ファイルに書いてから rename する。失敗したら一時ファイルを消して投げ直す。 */
export async function writeTextFileAtomic(target: string, text: string): Promise<void> {
  const dir = dirname(target);
  const tmp = join(dir, `${target.slice(dir.length + 1)}.${crypto.randomUUID()}.tmp`);
  try {
    await Deno.writeTextFile(tmp, text);
    await Deno.rename(tmp, target);
  } catch (e) {
    await Deno.remove(tmp).catch(() => {});
    throw e;
  }
}
