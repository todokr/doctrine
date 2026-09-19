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
/**
 * HEAD が解決できるか（＝コミットが1つ以上あるか）。最初のコミットがまだ無い
 * リポジトリでは read-tree HEAD が失敗するので、その前に確かめる。
 */
async function hasHead(
  worktreePath: string,
  opts: { env: Record<string, string>; clearEnv: boolean },
): Promise<boolean> {
  try {
    await runCommand("git", ["-C", worktreePath, "rev-parse", "--verify", "HEAD"], opts);
    return true;
  } catch {
    return false;
  }
}

export async function captureTree(worktreePath: string): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "doctrine-index-" });
  try {
    // デーモンの環境に GIT_DIR / GIT_WORK_TREE が入っていると、-C worktreePath が
    // 効かなくなって**別のリポジトリ**のツリーを記録してしまう。env に渡したものだけを
    // 環境にして（clearEnv）、この2つを確実に落とす。
    const env: Record<string, string> = {
      ...Deno.env.toObject(),
      GIT_INDEX_FILE: join(dir, "index"),
    };
    delete env.GIT_DIR;
    delete env.GIT_WORK_TREE;
    const opts = { env, clearEnv: true };

    // 空のインデックスに対する `git add -A` は「ignore されていないファイルを足す」
    // でしかないので、HEAD に入っているが .gitignore に一致するファイル
    // （git add -f で追跡させたビルド生成物など）や sparse-checkout のコーン外の
    // ファイルが落ちる。HEAD からインデックスを起こしてから -A することで、
    // 「worktree に実際にあるもの」（spec 5.1）を落とさずに記録できる。
    // 副次的に stat キャッシュが効き、大きな worktree でも全ファイルを
    // 再ハッシュせずに済む（approval への遷移が止まる時間が縮む）。
    //
    // 最初のコミットがまだ無いリポジトリでは HEAD が無いので read-tree は省く。
    if (await hasHead(worktreePath, opts)) {
      await runCommand("git", ["-C", worktreePath, "read-tree", "HEAD"], opts);
    }
    await runCommand("git", ["-C", worktreePath, "add", "-A"], opts);
    const { stdout } = await runCommand("git", ["-C", worktreePath, "write-tree"], opts);
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
