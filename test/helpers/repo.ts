import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const run = promisify(execFile);

/**
 * テスト用の使い捨て git リポジトリを作る。files は相対パス -> 中身。
 * 最初のコミットまで済ませた状態で返す（テストは worktree 作成などをすぐ試せる）。
 */
export async function makeRepo(root: string, files: Record<string, string>): Promise<string> {
  const repo = join(root, "repo");
  await run("git", ["init", "-b", "main", repo]);
  await run("git", ["-C", repo, "config", "user.email", "t@e.com"]);
  await run("git", ["-C", repo, "config", "user.name", "t"]);
  for (const [rel, content] of Object.entries(files)) {
    const path = join(repo, rel);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  await run("git", ["-C", repo, "add", "."]);
  await run("git", ["-C", repo, "commit", "-m", "init"]);
  return repo;
}

/**
 * 非同期に進む状態が条件を満たすまで待つ。tick が待たずに開始する runTask など、
 * テスト側から完了を観測する手段が無い処理を待つのに使う。
 */
export async function until(
  pred: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  description?: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  const suffix = description ? `: ${description}` : "";
  throw new Error(`タイムアウト: 条件が満たされませんでした${suffix}`);
}
