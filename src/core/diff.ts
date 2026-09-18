import { isAbsolute, join } from "@std/path";
import { runCommand } from "../util/exec.ts";

/**
 * worktree の「今の状態」全体をツリーにして SHA を返す。未コミットの変更と
 * 未追跡のファイルを含む — 承認するのは worktree に実際にあるものであり、
 * コミット済みの分だけを見せると、コミットが権限で拒否された degraded の
 * 実行を「何もしていない」と取り違える。
 *
 * 本物の `.git/index` には書かない。エージェントが走っている最中に
 * レビュー画面が diff を要求するのは普通に起きるので、本物に `add -A` すると
 * エージェントが次に打つ `git commit` の中身を doctrine が黙って変えてしまう。
 *
 * 一時 index は本物のコピーから始める。空から始めると毎回すべてのファイルを
 * 再ハッシュすることになり、大きなリポジトリではレビューのたびに数秒かかる。
 * コピーすれば git の stat キャッシュが効く（`git stash create` と同じ手）。
 */
export async function writeWorktreeTree(worktreePath: string): Promise<string> {
  const tmpIndex = await Deno.makeTempFile({ prefix: "doctrine-index-" });
  try {
    // リンクされた worktree では index は共通ディレクトリではなく worktree 側にある。
    // `--git-path` はリポジトリのルートから呼ぶと相対、worktree から呼ぶと絶対を返す。
    const { stdout } = await runCommand("git", [
      "-C",
      worktreePath,
      "rev-parse",
      "--git-path",
      "index",
    ]);
    const raw = stdout.trim();
    const realIndex = isAbsolute(raw) ? raw : join(worktreePath, raw);
    // まだ一度も index が作られていないリポジトリもある。その場合は空から始める。
    await Deno.copyFile(realIndex, tmpIndex).catch((e: unknown) => {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    });

    const env = { GIT_INDEX_FILE: tmpIndex };
    // `add -A` は .gitignore と .git/info/exclude を尊重するので、
    // ensureDoctrineOutExcluded 済みの `.doctrine-out/` はツリーに入らない。
    await runCommand("git", ["-C", worktreePath, "add", "-A"], { env });
    const tree = await runCommand("git", ["-C", worktreePath, "write-tree"], { env });
    return tree.stdout.trim();
  } finally {
    await Deno.remove(tmpIndex).catch(() => {});
  }
}
