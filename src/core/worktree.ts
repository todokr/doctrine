import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

const run = promisify(execFile);

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
  return process.env.DOCTRINE_STATE_DIR ?? join(homedir(), ".local", "state", "doctrine");
}

export function worktreePathFor(projectPath: string, taskId: string): string {
  return join(stateDir(), "worktrees", basename(projectPath), taskId);
}

export function slugify(title: string): string {
  return title
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 40);
}

export function branchNameFor(taskId: string, title: string): string {
  const slug = slugify(title);
  return slug ? `doctrine/${taskId}-${slug}` : `doctrine/${taskId}`;
}

/** 作成は自前の git worktree add。ライフサイクルの権威を1箇所に保つ。 */
export async function createWorktree(o: {
  repoPath: string; worktreePath: string; branch: string; baseBranch: string;
}): Promise<void> {
  await run("git", ["-C", o.repoPath, "worktree", "add", "-b", o.branch, o.worktreePath, o.baseBranch]);
}

export async function hasUncommittedChanges(worktreePath: string): Promise<boolean> {
  const { stdout } = await run("git", ["-C", worktreePath, "status", "--porcelain"]);
  return stdout.trim().length > 0;
}

/**
 * completed の後始末はここを force なしで呼ぶ。未コミットの変更が残っていたら
 * 削除を拒否する — ワークフローの書き方のバグであり、黙って消してよいものではない。
 */
export async function removeWorktree(o: {
  repoPath: string; worktreePath: string; force: boolean;
}): Promise<void> {
  if (!o.force && await hasUncommittedChanges(o.worktreePath)) {
    throw new UncommittedChangesError(o.worktreePath);
  }
  const args = ["-C", o.repoPath, "worktree", "remove", o.worktreePath];
  if (o.force) args.push("--force");
  await run("git", args);
}

export async function listWorktrees(repoPath: string): Promise<string[]> {
  const { stdout } = await run("git", ["-C", repoPath, "worktree", "list", "--porcelain"]);
  const paths: string[] = [];
  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) paths.push(line.slice("worktree ".length).trim());
  }
  const resolvedRepoPath = resolve(repoPath);
  // 先頭はメインの作業ツリー自身なので除く（シンボリックリンクされた一時ディレクトリ対策で resolve して比較）
  return paths.filter((p) => resolve(p) !== resolvedRepoPath);
}

/** 自動削除はしない。見つけて報告するだけ。 */
export async function findOrphans(repoPath: string, knownPaths: string[]): Promise<string[]> {
  const known = new Set(knownPaths.map((p) => resolve(p)));
  return (await listWorktrees(repoPath)).filter((p) => !known.has(resolve(p)));
}
