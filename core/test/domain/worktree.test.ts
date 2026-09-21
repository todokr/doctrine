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
  createDetachedWorktree,
  createWorktree,
  findOrphans,
  hasUncommittedChanges,
  intakeWorktreePathFor,
  listWorktrees,
  removeWorktree,
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
  assert.equal(branchNameFor("abc123", "ログイン画面を直す"), "doctrine/abc123-ログイン画面を直す");
  assert.equal(slugify("Fix the login screen!"), "fix-the-login-screen");
  assert.equal(slugify("  a///b  "), "a-b");
  assert.ok(slugify("x".repeat(100)).length <= 40);
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
  assert.deepEqual(await listWorktrees(repo), [created]);
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
  assert.equal(await realpath(worktrees[0]!), await realpath(wt));
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

test("slugify はコードポイント単位で切り詰め、サロゲートペアを分断しない", () => {
  // U+20000（CJK統合漢字拡張B、\p{Lo} = 文字なので除去されない）はUTF-16では
  // サロゲートペア（2コード単位）。先頭に1文字のBMP文字を置いて位置をずらすと、
  // UTF-16コード単位で40切り詰める旧実装ではペアの片方だけが残ってしまう。
  const astral = String.fromCodePoint(0x20000);
  const title = "a" + astral.repeat(60);
  const slug = slugify(title);
  assert.ok(Array.from(slug).length <= 40);
  // 孤立サロゲートは UTF-8 往復で失われる／壊れるため、往復一致は分断されていない証拠になる。
  assert.equal(slug, Buffer.from(slug, "utf8").toString("utf8"));
});

test("slugify は40文字を超えるBMP日本語タイトルをちょうど40コードポイントに切り詰める", () => {
  const title = "あ".repeat(50);
  const slug = slugify(title);
  assert.equal(Array.from(slug).length, 40);
});

test("branchNameFor は記号だけのタイトルで doctrine/<id> にフォールバックする", () => {
  assert.equal(branchNameFor("abc123", "!!! ???"), "doctrine/abc123");
});

test("intakeWorktreePathFor は worktreePathFor と同じ置き場の intake-<id> を返す", () => {
  process.env.DOCTRINE_STATE_DIR = join(root, "state");
  assert.equal(
    intakeWorktreePathFor(repo, "i1"),
    join(root, "state", "worktrees", basename(repo), "intake-i1"),
  );
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
