import { realpathSync } from "node:fs";

/**
 * `node_modules/.bin/<name>` はシンボリックリンクなので、そこ経由で起動すると
 * `process.argv[1]` はリンク自身のパス、`import.meta.filename` は解決済みの
 * 実体パスになり、素の `===` 比較は一致しない。すると起動処理が一度も
 * 呼ばれないまま exit code 0 で終わる — 何もしていないのに成功したように
 * 見える、最悪の壊れ方をする。両辺を realpath してから比較することで、
 * シンボリックリンク越しの起動でも正しく判定できるようにする。
 *
 * `dctl` / `dctld` の両エントリポイントがこの判定を必要とする。コピーを
 * 2つ持つと片方だけ直されて他方がずれる（実際に `dctld` 側で一度起きた）ので、
 * 共通のヘルパーとしてここに1つだけ置く。
 */
export function isDirectlyExecuted(entryFilename: string): boolean {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    return realpathSync(entryFilename) === realpathSync(invoked);
  } catch {
    return false;
  }
}
