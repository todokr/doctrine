import { basename, dirname, isAbsolute, join, resolve, SEPARATOR } from "@std/path";
import { runCommand } from "../util/exec.ts";
import { homeDir } from "../util/home.ts";

export class UncommittedChangesError extends Error {
  readonly worktreePath: string;

  constructor(worktreePath: string) {
    super(`未コミットの変更が残っています: ${worktreePath}`);
    this.name = "UncommittedChangesError";
    this.worktreePath = worktreePath;
  }
}

/** テストから差し替えられるよう環境変数を見る。 */
export function stateDir(): string {
  return Deno.env.get("DOCTRINE_STATE_DIR") ?? join(homeDir(), ".local", "state", "doctrine");
}

export function worktreePathFor(projectPath: string, taskId: string): string {
  return join(stateDir(), "worktrees", basename(projectPath), taskId);
}

export function slugify(title: string): string {
  const collapsed = title
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .toLowerCase();
  // コードポイント単位で切る（UTF-16 コード単位で切ると絵文字などのサロゲート
  // ペアを分断してしまう）。トリムは切り詰めた「後」に行う — そうしないと
  // 切り詰め境界にちょうどハイフンが来たとき末尾にハイフンが残ってしまう。
  const truncated = Array.from(collapsed).slice(0, 40).join("");
  return truncated.replace(/^-+|-+$/g, "");
}

export function branchNameFor(taskId: string, title: string): string {
  const slug = slugify(title);
  return slug ? `doctrine/${taskId}-${slug}` : `doctrine/${taskId}`;
}

/**
 * 前段のエージェントが worktree 内に書く中間成果物の置き場所。doctrine 自身は
 * この名前を強制しない（ワークフローの書き手がプロンプトで決める自由な文字列）が、
 * git に見せないための exclude 設定だけはこの規約に合わせて自動で行う
 * （step-artifacts spec 4章）。
 */
const DOCTRINE_OUT_EXCLUDE_LINE = ".doctrine-out/";

/**
 * `.doctrine-out/` を `.git/info/exclude` に追記し、git status / task.diff の
 * write-tree の両方から見えなくする。プロジェクトの `.gitignore` は書き換えない
 * （project-add が「既存のファイルを上書きしない」原則を持つのと同じ理由）。
 *
 * `git rev-parse --git-path` は、リポジトリのルートから呼ぶと相対パスを、
 * リンクされた worktree から呼ぶと絶対パスを返す（common dir を指すため）。
 * どちらでも動くよう、絶対パスでなければ repoPath からの相対として解決する。
 *
 * 既に同じ行があれば何もしない（複数タスクが同じリポジトリに何度も worktree を
 * 作るので冪等にする）。
 */
export async function ensureDoctrineOutExcluded(repoPath: string): Promise<void> {
  const { stdout } = await runCommand("git", [
    "-C",
    repoPath,
    "rev-parse",
    "--git-path",
    "info/exclude",
  ]);
  const raw = stdout.trim();
  const excludePath = isAbsolute(raw) ? raw : join(repoPath, raw);

  let content = "";
  try {
    content = await Deno.readTextFile(excludePath);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  if (content.split("\n").some((l) => l.trim() === DOCTRINE_OUT_EXCLUDE_LINE)) return;

  const withTrailingNewline = content.length > 0 && !content.endsWith("\n")
    ? content + "\n"
    : content;
  await Deno.mkdir(dirname(excludePath), { recursive: true });
  await Deno.writeTextFile(excludePath, withTrailingNewline + DOCTRINE_OUT_EXCLUDE_LINE + "\n");
}

/**
 * 作成は自前の git worktree add。ライフサイクルの権威を1箇所に保つ。
 *
 * worktree のパスは「シンボリックリンク解決済みの実パス」の表記で持つ。git が
 * `worktree list` で報告するのがこの表記で、DB に対応のない孤児はこの表記でしか
 * 得られないため。呼び出し側は渡したパスではなく戻り値を DB に保存する。
 */
export async function createWorktree(o: {
  repoPath: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
}): Promise<string> {
  await runCommand("git", [
    "-C",
    o.repoPath,
    "worktree",
    "add",
    "-b",
    o.branch,
    o.worktreePath,
    o.baseBranch,
  ]);
  await ensureDoctrineOutExcluded(o.repoPath);
  return await canonical(o.worktreePath);
}

/** Intake 由来のタスクの worktree の起点。GitHub 上のマージを持つよう、origin 側から切る（spec 11.3）。 */
export const originRef = (baseBranch: string) => `origin/${baseBranch}`;

/** origin の baseBranch を取り込む。手元の baseBranch は動かさない。 */
export async function fetchBaseBranch(repoPath: string, baseBranch: string): Promise<void> {
  await runCommand("git", ["-C", repoPath, "fetch", "origin", baseBranch]);
}

/** commit が ref に含まれるか。commit が手元に無い（まだ取り込んでいない）ときも false。 */
export async function containsCommit(
  repoPath: string,
  ref: string,
  commit: string,
): Promise<boolean> {
  const out = await new Deno.Command("git", {
    args: ["-C", repoPath, "merge-base", "--is-ancestor", commit, ref],
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).output();
  return out.success;
}

/** Intake の worktree の置き場。worktreePathFor と同じ置き場の intake-<id>（spec 7 章）。 */
export function intakeWorktreePathFor(projectPath: string, intakeId: string): string {
  return worktreePathFor(projectPath, `intake-${intakeId}`);
}

/** ブランチを作らずに baseBranch から detached で作る。戻り値は実パス（createWorktree と同じ）。 */
export async function createDetachedWorktree(o: {
  repoPath: string;
  worktreePath: string;
  baseBranch: string;
}): Promise<string> {
  await runCommand("git", [
    "-C",
    o.repoPath,
    "worktree",
    "add",
    "--detach",
    o.worktreePath,
    o.baseBranch,
  ]);
  await ensureDoctrineOutExcluded(o.repoPath);
  return await canonical(o.worktreePath);
}

/** 既存の worktree を ref の位置へ detached で進める（改訂に入るとき。spec 7 章）。 */
export async function checkoutDetached(worktreePath: string, ref: string): Promise<void> {
  await runCommand("git", ["-C", worktreePath, "checkout", "--detach", ref]);
}

export async function hasUncommittedChanges(worktreePath: string): Promise<boolean> {
  const { stdout } = await runCommand("git", ["-C", worktreePath, "status", "--porcelain"]);
  return stdout.trim().length > 0;
}

/** git status --porcelain に出るパス。変更が無ければ空配列。名前の変更は変更後の名前。 */
export async function changedPaths(worktreePath: string): Promise<string[]> {
  const { stdout } = await runCommand("git", [
    "-C",
    worktreePath,
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]);
  return stdout
    .split("\n")
    .filter((line) => line.length > 3)
    .map((line) => {
      const path = line.slice(3);
      const arrow = path.indexOf(" -> ");
      return arrow >= 0 ? path.slice(arrow + " -> ".length) : path;
    });
}

/** 追跡中のファイルの変更を捨て、未追跡のファイルを消す（git checkout -- . と git clean -fd）。 */
export async function restoreWorktree(worktreePath: string): Promise<void> {
  await runCommand("git", ["-C", worktreePath, "checkout", "--", "."]);
  await runCommand("git", ["-C", worktreePath, "clean", "-fd"]);
}

/**
 * completed の後始末はここを force なしで呼ぶ。未コミットの変更が残っていたら
 * 削除を拒否する — ワークフローの書き方のバグであり、黙って消してよいものではない。
 */
export async function removeWorktree(o: {
  repoPath: string;
  worktreePath: string;
  force: boolean;
}): Promise<void> {
  if (!o.force && await hasUncommittedChanges(o.worktreePath)) {
    throw new UncommittedChangesError(o.worktreePath);
  }
  const args = ["-C", o.repoPath, "worktree", "remove", o.worktreePath];
  if (o.force) args.push("--force");
  await runCommand("git", args);
}

/**
 * resolve は字句的な正規化のみでシンボリックリンクを解決しない
 * （例: macOS の /tmp は /private/tmp への symlink）。git はシンボリックリンク解決後の
 * 実パスを報告するため、比較側も realpath で解決してから揃える。パスが既に
 * 存在しない（削除済みの worktree など）場合は resolve にフォールバックする。
 */
export async function canonical(p: string): Promise<string> {
  try {
    return await Deno.realPath(p);
  } catch {
    return resolve(p);
  }
}

/**
 * `realPath`（canonical 済み）が stateDir()/worktrees の配下かを返す。置き場の側も
 * 実パスに直してから比べる。直さないと macOS の /var → /private/var で、正しいパスまで外と判定される。
 */
export async function isUnderWorktreesDir(realPath: string): Promise<boolean> {
  const root = await canonical(join(stateDir(), "worktrees"));
  return realPath.startsWith(root + SEPARATOR);
}

export type ListedWorktree = { path: string; branch: string | null };

/** メインの作業ツリーを除く。branch は refs/heads/ を外した名前、detached なら null。 */
export async function listWorktrees(repoPath: string): Promise<ListedWorktree[]> {
  const { stdout } = await runCommand("git", ["-C", repoPath, "worktree", "list", "--porcelain"]);
  const listed: ListedWorktree[] = [];
  for (const block of stdout.split(/\n\s*\n/)) {
    let path: string | null = null;
    let branch: string | null = null;
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice("worktree ".length).trim();
      else if (line.startsWith("branch ")) {
        branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
      }
    }
    if (path !== null) listed.push({ path, branch });
  }
  const resolvedRepoPath = await canonical(repoPath);
  // 先頭はメインの作業ツリー自身なので除く（git が報告するパスはシンボリックリンク
  // 解決済みなので、こちら側も canonical() で解決してから比較する）
  const results = await Promise.all(
    listed.map(async (w) => ({ worktree: w, resolved: await canonical(w.path) })),
  );
  return results.filter((r) => r.resolved !== resolvedRepoPath).map((r) => r.worktree);
}

/** 自動削除はしない。見つけて報告するだけ。 */
export async function findOrphans(repoPath: string, knownPaths: string[]): Promise<string[]> {
  const known = new Set(await Promise.all(knownPaths.map((p) => canonical(p))));
  const worktrees = await listWorktrees(repoPath);
  const withResolved = await Promise.all(
    worktrees.map(async (w) => ({ path: w.path, resolved: await canonical(w.path) })),
  );
  return withResolved.filter((r) => !known.has(r.resolved)).map((r) => r.path);
}
