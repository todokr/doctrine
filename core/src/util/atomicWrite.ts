import { rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** target と同じディレクトリの一時ファイルに書いてから rename する。失敗したら一時ファイルを消して投げ直す。 */
export async function writeTextFileAtomic(target: string, text: string): Promise<void> {
  const dir = dirname(target);
  const tmp = join(dir, `${target.slice(dir.length + 1)}.${crypto.randomUUID()}.tmp`);
  try {
    await writeFile(tmp, text);
    await rename(tmp, target);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}
