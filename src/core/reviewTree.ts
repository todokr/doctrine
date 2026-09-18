import { join } from "@std/path";
import { runCommand } from "../util/exec.ts";

/**
 * レビュー1回のツリーを指す参照の名前。step_runs.id を名前に持つので、
 * 「レビュー1件 = 参照1つ」の対応がそのまま名前に出る。
 */
export function reviewRefName(taskId: string, stepRunId: number): string {
  return `refs/doctrine/reviews/${taskId}/${stepRunId}`;
}

/**
 * コミットの作者・コミッタを doctrine で固定する。git は user.email が未設定の
 * リポジトリでは commit-tree を拒否するので、人の設定に依存させない
 * （ここで失敗すると、人が待っているレビューの基準点だけが理由もなく欠ける）。
 */
const IDENTITY = {
  GIT_AUTHOR_NAME: "doctrine",
  GIT_AUTHOR_EMAIL: "doctrine@localhost",
  GIT_COMMITTER_NAME: "doctrine",
  GIT_COMMITTER_EMAIL: "doctrine@localhost",
};

/**
 * worktree の「今あるもの全部」をツリーにする。未コミットの変更も未追跡の
 * ファイルも入る — 人が承認するのは worktree に実際にあるものであって、
 * コミットされたものではない。
 *
 * 一時インデックスを使うので worktree の .git/index には触らない（エージェントが
 * 作業中のステージング状態を doctrine が書き換えてはいけない）。
 * `.doctrine-out/` は .git/info/exclude によって最初から入らない。
 */
export async function captureTree(worktreePath: string): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "doctrine-index-" });
  try {
    const env = { ...Deno.env.toObject(), GIT_INDEX_FILE: join(dir, "index") };
    await runCommand("git", ["-C", worktreePath, "add", "-A"], { env });
    const { stdout } = await runCommand("git", ["-C", worktreePath, "write-tree"], { env });
    return stdout.trim();
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

/**
 * ツリーを指すコミットを作り、参照を張って `git gc` から守る。参照が無いツリーは
 * 到達不能なオブジェクトとして刈られる。
 *
 * コミットを1つ挟むのは、参照がコミットを指していれば `git diff <ref>` が
 * そのまま使えるため（task.diff がツリーの特別扱いを持たずに済む）。親は持たせない
 * — 比較に要らず、持たせると worktree の履歴に依存した意味が生まれる。
 *
 * 参照は worktree とリポジトリ本体で共有されるので、worktree のパスから書いてよい。
 */
export async function retainTree(o: {
  worktreePath: string;
  taskId: string;
  stepRunId: number;
  tree: string;
}): Promise<void> {
  const { stdout } = await runCommand(
    "git",
    [
      "-C",
      o.worktreePath,
      "commit-tree",
      o.tree,
      "-m",
      `doctrine review ${o.taskId}#${o.stepRunId}`,
    ],
    { env: { ...Deno.env.toObject(), ...IDENTITY } },
  );
  await runCommand("git", [
    "-C",
    o.worktreePath,
    "update-ref",
    reviewRefName(o.taskId, o.stepRunId),
    stdout.trim(),
  ]);
}

/**
 * そのタスクのレビュー参照をすべて消す。worktree を消すときに呼ぶ
 * （worktree が無くなればレビューの基準点を使う相手もいなくなる）。
 *
 * 参照が1つも無くても失敗しない（ツリーを1度も記録できなかったタスクがある）。
 */
export async function releaseTrees(repoPath: string, taskId: string): Promise<void> {
  const { stdout } = await runCommand("git", [
    "-C",
    repoPath,
    "for-each-ref",
    "--format=%(refname)",
    `refs/doctrine/reviews/${taskId}`,
  ]);
  for (const ref of stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0)) {
    await runCommand("git", ["-C", repoPath, "update-ref", "-d", ref]);
  }
}
