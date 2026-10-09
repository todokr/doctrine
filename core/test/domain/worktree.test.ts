import { afterEach, beforeEach, test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, sep } from "node:path";
import {
  branchNameFor,
  changedPaths,
  checkoutDetached,
  containsCommit,
  createDetachedWorktree,
  createWorktree,
  fetchBaseBranch,
  findOrphans,
  hasUncommittedChanges,
  intakeWorktreePathFor,
  listIntakeWorktrees,
  listWorktrees,
  originRef,
  removeWorktree,
  repoOfWorktree,
  restoreWorktree,
  slugify,
  stateDir,
  UncommittedChangesError,
  worktreePathFor,
} from "../../src/domain/worktree.ts";

const run = promisify(execFile);
let repo: string;
let root: string;
let originalStateDir: string | undefined;

beforeEach(async () => {
  originalStateDir = process.env.DOCTRINE_STATE_DIR;
  root = await mkdtemp(join(tmpdir(), "doctrine-test-"));
  repo = join(root, "repo");
  await run("git", ["init", "-b", "main", repo]);
  await run("git", ["-C", repo, "config", "user.email", "t@example.com"]);
  await run("git", ["-C", repo, "config", "user.name", "t"]);
  await writeFile(join(repo, "README.md"), "hi\n");
  await run("git", ["-C", repo, "add", "."]);
  await run("git", ["-C", repo, "commit", "-m", "init"]);
});

afterEach(async () => {
  if (originalStateDir === undefined) delete process.env.DOCTRINE_STATE_DIR;
  else process.env.DOCTRINE_STATE_DIR = originalStateDir;
  await rm(root, { recursive: true, force: true });
});

test("ブランチ名を作る", () => {
  assert.equal(
    branchNameFor("abc123", "Fix the login screen!"),
    "doctrine/abc123-fix-the-login-screen",
  );
  assert.equal(slugify("Fix the login screen!"), "fix-the-login-screen");
  assert.equal(slugify("  a///b  "), "a-b");
  assert.equal(slugify("x".repeat(100)), "x".repeat(40));
});

test("baseBranch から worktree とブランチを生やす", async () => {
  const wt = join(root, "wt", "t1");
  await createWorktree({
    repoPath: repo,
    worktreePath: wt,
    branch: "doctrine/t1-x",
    baseBranch: "main",
  });
  assert.ok((await stat(join(wt, "README.md"))).isFile());
  const { stdout } = await run("git", ["-C", wt, "rev-parse", "--abbrev-ref", "HEAD"]);
  assert.equal(stdout.trim(), "doctrine/t1-x");
});

test("worktree作成時に .doctrine-out/ を .git/info/exclude に追記する", async () => {
  const wt = join(root, "wt", "t1");
  await createWorktree({
    repoPath: repo,
    worktreePath: wt,
    branch: "doctrine/t1-x",
    baseBranch: "main",
  });
  const content = await readFile(join(repo, ".git", "info", "exclude"), "utf8");
  assert.match(content, /^\.doctrine-out\/$/m);
});

test(".git/info/ が存在しなくても worktree作成時に .git/info/exclude を作成する", async () => {
  await rm(join(repo, ".git", "info"), { recursive: true, force: true });
  const wt = join(root, "wt", "t1b");
  await createWorktree({
    repoPath: repo,
    worktreePath: wt,
    branch: "doctrine/t1b-x",
    baseBranch: "main",
  });
  const content = await readFile(join(repo, ".git", "info", "exclude"), "utf8");
  assert.match(content, /^\.doctrine-out\/$/m);
});

test(".doctrine-out/ 配下の変更は hasUncommittedChanges で無視される", async () => {
  const wt = join(root, "wt", "t2");
  await createWorktree({
    repoPath: repo,
    worktreePath: wt,
    branch: "doctrine/t2-x",
    baseBranch: "main",
  });
  await mkdir(join(wt, ".doctrine-out"), { recursive: true });
  await writeFile(join(wt, ".doctrine-out", "plan.md"), "plan\n");
  assert.equal(await hasUncommittedChanges(wt), false);
});

test("2回 createWorktree しても info/exclude の行は重複しない", async () => {
  const wt1 = join(root, "wt", "a");
  const wt2 = join(root, "wt", "b");
  await createWorktree({
    repoPath: repo,
    worktreePath: wt1,
    branch: "doctrine/a",
    baseBranch: "main",
  });
  await createWorktree({
    repoPath: repo,
    worktreePath: wt2,
    branch: "doctrine/b",
    baseBranch: "main",
  });
  const content = await readFile(join(repo, ".git", "info", "exclude"), "utf8");
  const matches = content.match(/^\.doctrine-out\/$/gm) ?? [];
  assert.equal(matches.length, 1);
});

test("worktreePathFor はリポジトリの外のパスを組み立てる", async () => {
  const tmpState = await mkdtemp(join(tmpdir(), "doctrine-state-"));
  try {
    process.env.DOCTRINE_STATE_DIR = tmpState;
    // worktreePathFor が返すパス自体はまだ存在しないので realpath できない。
    // 実在する祖先ディレクトリ（tmpState）だけ realpath して残りのセグメントを
    // そのまま連結し、repo 側は実在するので普通に realpath する。
    const realTmpState = await realpath(tmpState);
    const realRepo = await realpath(repo);
    const resolvedWt = join(realTmpState, "worktrees", basename(repo), "t1");
    assert.equal(worktreePathFor(repo, "t1"), join(tmpState, "worktrees", basename(repo), "t1"));
    // startsWith による文字列前方一致ではなく、パスの区切り境界で比較する
    // （例えば repo と同名+接尾辞のきょうだいディレクトリが誤って一致しないように）。
    assert.notEqual(resolvedWt, realRepo);
    assert.ok(!resolvedWt.startsWith(realRepo + sep));
  } finally {
    await rm(tmpState, { recursive: true, force: true });
  }
});

test("未コミットの変更を検出する", async () => {
  const wt = join(root, "wt", "t1");
  await createWorktree({
    repoPath: repo,
    worktreePath: wt,
    branch: "doctrine/t1-x",
    baseBranch: "main",
  });
  assert.equal(await hasUncommittedChanges(wt), false);
  await writeFile(join(wt, "dirty.txt"), "x");
  assert.equal(await hasUncommittedChanges(wt), true);
});

test("未コミットの変更があるとき force なしの削除は拒否する", async () => {
  const wt = join(root, "wt", "t1");
  await createWorktree({
    repoPath: repo,
    worktreePath: wt,
    branch: "doctrine/t1-x",
    baseBranch: "main",
  });
  await writeFile(join(wt, "dirty.txt"), "x");
  await assert.rejects(
    () => removeWorktree({ repoPath: repo, worktreePath: wt, force: false }),
    UncommittedChangesError,
  );
  assert.ok((await stat(wt)).isDirectory());
});

test("force なら汚れた worktree も削除する", async () => {
  const wt = join(root, "wt", "t1");
  await createWorktree({
    repoPath: repo,
    worktreePath: wt,
    branch: "doctrine/t1-x",
    baseBranch: "main",
  });
  await writeFile(join(wt, "dirty.txt"), "x");
  await removeWorktree({ repoPath: repo, worktreePath: wt, force: true });
  await assert.rejects(() => stat(wt));
});

test("worktree を削除してもブランチは残る", async () => {
  const wt = join(root, "wt", "t1");
  await createWorktree({
    repoPath: repo,
    worktreePath: wt,
    branch: "doctrine/t1-x",
    baseBranch: "main",
  });
  await removeWorktree({ repoPath: repo, worktreePath: wt, force: false });
  const { stdout } = await run("git", ["-C", repo, "branch", "--list", "doctrine/t1-x"]);
  assert.match(stdout, /doctrine\/t1-x/);
});

test("DBに対応のない worktree を孤児として報告する", async () => {
  const known = join(root, "wt", "known");
  const orphan = join(root, "wt", "orphan");
  await createWorktree({
    repoPath: repo,
    worktreePath: known,
    branch: "doctrine/a",
    baseBranch: "main",
  });
  await createWorktree({
    repoPath: repo,
    worktreePath: orphan,
    branch: "doctrine/b",
    baseBranch: "main",
  });
  const orphans = await findOrphans(repo, [known]);
  // 孤児には DB 側のパスがないので、git が報告する実パスの表記で返る
  // （macOS の tmpdir は /var -> /private/var の symlink 配下にある）。
  assert.deepEqual(orphans, [await realpath(orphan)]);
});

test("createWorktree は DB に保存する表記として実パスを返す", async () => {
  const wt = join(root, "wt", "t1");
  const created = await createWorktree({
    repoPath: repo,
    worktreePath: wt,
    branch: "doctrine/t1-x",
    baseBranch: "main",
  });
  assert.equal(created, await realpath(wt));
  assert.deepEqual(await listWorktrees(repo), [{ path: created, branch: "doctrine/t1-x" }]);
});

test("stateDir は DOCTRINE_STATE_DIR を尊重する", () => {
  process.env.DOCTRINE_STATE_DIR = "/tmp/doctrine-custom-state";
  assert.equal(stateDir(), "/tmp/doctrine-custom-state");

  delete process.env.DOCTRINE_STATE_DIR;
  assert.ok(stateDir().endsWith(join(".local", "state", "doctrine")));
});

test("worktreePathFor は stateDir/worktrees/<project の basename>/<taskId> を組み立てる", () => {
  process.env.DOCTRINE_STATE_DIR = "/tmp/doctrine-known-state";
  const projectPath = "/home/dev/projects/my-app";
  assert.equal(
    worktreePathFor(projectPath, "task-42"),
    join("/tmp/doctrine-known-state", "worktrees", "my-app", "task-42"),
  );
});

test("listWorktrees はメインの作業ツリーを除外する", async () => {
  assert.deepEqual(await listWorktrees(repo), []);

  const wt = join(root, "wt", "t1");
  await createWorktree({
    repoPath: repo,
    worktreePath: wt,
    branch: "doctrine/t1-x",
    baseBranch: "main",
  });

  const worktrees = await listWorktrees(repo);
  assert.equal(worktrees.length, 1);
  assert.equal(await realpath(worktrees[0]!.path), await realpath(wt));
});

test("listWorktrees はブランチ名を返し、detached の worktree は null にする", async () => {
  const a = join(root, "wt", "a");
  const b = join(root, "wt", "b");
  await createWorktree({
    repoPath: repo,
    worktreePath: a,
    branch: "doctrine/a",
    baseBranch: "main",
  });
  await createDetachedWorktree({ repoPath: repo, worktreePath: b, baseBranch: "main" });

  const worktrees = await listWorktrees(repo);
  const byPath = new Map(worktrees.map((w) => [w.path, w.branch]));
  assert.equal(worktrees.length, 2);
  assert.equal(byPath.get(await realpath(a)), "doctrine/a");
  assert.equal(byPath.get(await realpath(b)), null);
});

test("slugify は切り詰めた後にトリムする（境界にハイフンが来ても末尾に残さない）", () => {
  // 39文字 + 区切り(空白→ハイフン化) + さらに文字列。collapsed の40文字目（index 39）が
  // ちょうど "-" になるよう仕組む。先にトリムしてから切り詰める実装だと、この "-" が
  // 末尾に残ってしまう。
  const title = "A".repeat(39) + " " + "B".repeat(10);
  const slug = slugify(title);
  assert.equal(slug.endsWith("-"), false);
  assert.equal(slug, "a".repeat(39));
});

test("slugify は日本語だけのタイトルで空文字を返す", () => {
  assert.equal(slugify("ログイン画面を直す"), "");
  assert.equal(slugify("あ".repeat(50)), "");
});

test("slugify は日本語と英数字が混ざったタイトルから ASCII の英数字だけを残す", () => {
  assert.equal(
    slugify("/healthz を clamd への PING で応答するように変える"),
    "healthz-clamd-ping",
  );
  assert.equal(slugify("ログイン画面の v2 を直す"), "v2");
  assert.equal(slugify("café を追加"), "caf");
  // 日本語は連続が "-" 1 つに畳まれるので 40 文字の上限に数えない。
  assert.equal(slugify("あ".repeat(50) + "abc"), "abc");
});

test("slugify は全角の英数字を半角にして残す", () => {
  assert.equal(slugify("ＡＢＣ１２３ を直す"), "abc123");
});

test("branchNameFor は ASCII の英数字が無いタイトルで doctrine/<id> にフォールバックする", () => {
  assert.equal(branchNameFor("abc123", "!!! ???"), "doctrine/abc123");
  assert.equal(branchNameFor("abc123", "ログイン画面を直す"), "doctrine/abc123");
});

test("branchNameFor は日本語が混ざったタイトルでも ASCII のブランチ名を作る", () => {
  const branch = branchNameFor(
    "4aa840a9-4686-4e92-bf6c-ee0152101834",
    "/healthz を clamd への PING で応答するように変える",
  );
  assert.equal(branch, "doctrine/4aa840a9-4686-4e92-bf6c-ee0152101834-healthz-clamd-ping");
  assert.match(branch, /^doctrine\/[a-z0-9-]+$/);
});

test("intakeWorktreePathFor は worktrees 直下の intake-<id> を返す", () => {
  process.env.DOCTRINE_STATE_DIR = join(root, "state");
  assert.equal(
    intakeWorktreePathFor("i1"),
    join(root, "state", "worktrees", "intake-i1"),
  );
});

test("listIntakeWorktrees は .git を持つ子だけを名前順で返す", async () => {
  await mkdir(join(root, "parent"), { recursive: true });
  const parent = await realpath(join(root, "parent"));
  const z = await createDetachedWorktree({
    repoPath: repo,
    worktreePath: join(parent, "z"),
    baseBranch: "main",
  });
  const a = await createDetachedWorktree({
    repoPath: repo,
    worktreePath: join(parent, "a"),
    baseBranch: "main",
  });
  await mkdir(join(parent, "plain"), { recursive: true });
  await writeFile(join(parent, "f.txt"), "x");

  const result = await listIntakeWorktrees(parent);
  assert.deepEqual(result, [
    { name: "a", path: a },
    { name: "z", path: z },
  ]);
});

test("repoOfWorktree はリンクされた worktree の元のリポジトリを返す", async () => {
  const wt = await createDetachedWorktree({
    repoPath: repo,
    worktreePath: join(root, "wt"),
    baseBranch: "main",
  });

  await removeWorktree({
    repoPath: await repoOfWorktree(wt),
    worktreePath: wt,
    force: false,
  });

  assert.deepEqual(await listWorktrees(repo), []);
});

test("createDetachedWorktree はブランチを作らない", async () => {
  const wt = join(root, "wt", "intake-i1");
  const created = await createDetachedWorktree({
    repoPath: repo,
    worktreePath: wt,
    baseBranch: "main",
  });
  assert.equal(created, await realpath(wt));
  assert.ok((await stat(join(wt, "README.md"))).isFile());
  await assert.rejects(run("git", ["-C", wt, "symbolic-ref", "-q", "HEAD"]));
  const { stdout } = await run("git", ["-C", repo, "branch", "--format=%(refname:short)"]);
  assert.deepEqual(stdout.trim().split("\n"), ["main"]);
});

test("checkoutDetached は既存の worktree を ref の位置へ detached で進める", async () => {
  const wt = join(root, "wt", "intake-i1");
  await createDetachedWorktree({ repoPath: repo, worktreePath: wt, baseBranch: "main" });
  await writeFile(join(repo, "next.txt"), "n\n");
  await run("git", ["-C", repo, "add", "."]);
  await run("git", ["-C", repo, "commit", "-m", "next"]);
  const head = (await run("git", ["-C", repo, "rev-parse", "main"])).stdout.trim();

  await checkoutDetached(wt, "main");
  assert.equal((await run("git", ["-C", wt, "rev-parse", "HEAD"])).stdout.trim(), head);
  assert.ok((await stat(join(wt, "next.txt"))).isFile());
  await assert.rejects(run("git", ["-C", wt, "symbolic-ref", "-q", "HEAD"]));
});

test("changedPaths と restoreWorktree", async () => {
  const wt = join(root, "wt", "intake-i1");
  await createDetachedWorktree({ repoPath: repo, worktreePath: wt, baseBranch: "main" });
  assert.deepEqual(await changedPaths(wt), []);

  await writeFile(join(wt, "README.md"), "changed\n");
  await writeFile(join(wt, "new.txt"), "n\n");
  assert.deepEqual((await changedPaths(wt)).sort(), ["README.md", "new.txt"]);

  await restoreWorktree(wt);
  assert.deepEqual(await changedPaths(wt), []);
  assert.equal(await readFile(join(wt, "README.md"), "utf8"), "hi\n");
});

test("fetchBaseBranch: origin の baseBranch を取り込み、手元の baseBranch より新しいコミットから worktree を切れる", async () => {
  // origin は repo を clone したもの。GitHub 上のマージを、origin にだけあるコミットで表す
  const origin = join(root, "origin");
  await run("git", ["clone", "-q", repo, origin]);
  await run("git", ["-C", origin, "config", "user.email", "t@example.com"]);
  await run("git", ["-C", origin, "config", "user.name", "t"]);
  await writeFile(join(origin, "merged.txt"), "m\n");
  await run("git", ["-C", origin, "add", "."]);
  await run("git", ["-C", origin, "commit", "-m", "merged upstream"]);
  const merged = (await run("git", ["-C", origin, "rev-parse", "HEAD"])).stdout.trim();
  await run("git", ["-C", repo, "remote", "add", "origin", origin]);

  assert.equal(await containsCommit(repo, originRef("main"), merged), false, "取り込む前は無い");
  await fetchBaseBranch(repo, "main");
  assert.equal(await containsCommit(repo, originRef("main"), merged), true);
  assert.equal(await containsCommit(repo, "main", merged), false, "手元の main は動かさない");

  const wt = await createWorktree({
    repoPath: repo,
    worktreePath: join(root, "wt", "t9"),
    branch: "doctrine/t9-x",
    baseBranch: originRef("main"),
  });
  assert.ok((await stat(join(wt, "merged.txt"))).isFile(), "上流の成果物を持って始まる");
});

test("containsCommit: 含まれない・手元に無いコミットは false", async () => {
  const head = (await run("git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim();
  assert.equal(await containsCommit(repo, "main", head), true);
  await run("git", ["-C", repo, "switch", "-q", "-c", "side"]);
  await writeFile(join(repo, "side.txt"), "s\n");
  await run("git", ["-C", repo, "add", "."]);
  await run("git", ["-C", repo, "commit", "-m", "side"]);
  const side = (await run("git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim();
  assert.equal(await containsCommit(repo, "main", side), false);
  assert.equal(
    await containsCommit(repo, "main", "0123456789abcdef0123456789abcdef01234567"),
    false,
  );
});
