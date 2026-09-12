import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
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

/**
 * path.resolve は字句的な正規化のみでシンボリックリンクを解決しない
 * （例: macOS の /tmp は /private/tmp への symlink）。git はシンボリックリンク解決後の
 * 実パスを報告するため、比較側も realpath で解決してから揃える。パスが既に
 * 存在しない（削除済みの worktree など）場合は resolve にフォールバックする。
 */
async function canonical(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return resolve(p);
  }
}

export async function listWorktrees(repoPath: string): Promise<string[]> {
  const { stdout } = await run("git", ["-C", repoPath, "worktree", "list", "--porcelain"]);
  const paths: string[] = [];
  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) paths.push(line.slice("worktree ".length).trim());
  }
  const resolvedRepoPath = await canonical(repoPath);
  // 先頭はメインの作業ツリー自身なので除く（git が報告するパスはシンボリックリンク
  // 解決済みなので、こちら側も canonical() で解決してから比較する）
  const results = await Promise.all(
    paths.map(async (p) => ({ path: p, resolved: await canonical(p) })),
  );
  return results.filter((r) => r.resolved !== resolvedRepoPath).map((r) => r.path);
}

/** 自動削除はしない。見つけて報告するだけ。 */
export async function findOrphans(repoPath: string, knownPaths: string[]): Promise<string[]> {
  const known = new Set(await Promise.all(knownPaths.map((p) => canonical(p))));
  const worktrees = await listWorktrees(repoPath);
  const withResolved = await Promise.all(
    worktrees.map(async (p) => ({ path: p, resolved: await canonical(p) })),
  );
  return withResolved.filter((r) => !known.has(r.resolved)).map((r) => r.path);
}
