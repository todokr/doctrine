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

export type DiffFile = {
  path: string;
  /** R のときだけ入る。 */
  old_path?: string;
  status: "A" | "M" | "D" | "R";
  /** バイナリなら 0。 */
  additions: number;
  deletions: number;
  binary: boolean;
};

export type DiffResult = { files: DiffFile[]; patch: string; truncated: boolean };

/**
 * `.doctrine-out/` は info/exclude により未追跡としてツリーに入らないが、
 * 過去に誤ってコミットされたリポジトリでも diff に出さないよう pathspec でも外す。
 * 「diff に出さない」を exclude の設定が正しいことだけに依存させない。
 */
const PATHSPEC = [".", ":(exclude).doctrine-out/"];

/**
 * patch のバイト数の上限。ファイル数では打ち切らない — 1個の巨大な生成ファイルという
 * 一番効く形を守れないため。守りたいのはデーモンのメモリと画面の描画であり、
 * それを直接測っているのはバイト数である。
 *
 * 2 MiB は普通のタスクなら絶対に当たらない大きさ（40バイト/行として約5万行）。
 * 当たったときは truncated を見て人が worktree を直接見に行けばよい、という割り切り。
 */
export const PATCH_LIMIT_BYTES = 2 * 1024 * 1024;

const LF = 0x0a;

/**
 * 上限以内の最後の改行の直後で切る。行の途中で切ると unified diff のパーサが壊れ、
 * 画面が「壊れた diff」ではなく「間違った diff」を描きかねない。
 * 上限以内に改行が1つも無い（極端に長い1行）ときだけ、上限でそのまま切る。
 */
function truncatePatch(
  patch: string,
  limitBytes: number,
): { patch: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(patch);
  if (bytes.length <= limitBytes) return { patch, truncated: false };
  const head = bytes.subarray(0, limitBytes);
  const lastLf = head.lastIndexOf(LF);
  const cut = lastLf >= 0 ? head.subarray(0, lastLf + 1) : head;
  return { patch: new TextDecoder().decode(cut), truncated: true };
}

/**
 * base ブランチとの共通祖先。worktree を作った後に base が進んでいても
 * 正しい基準になるよう、毎回取り直す。
 */
export async function mergeBase(
  worktreePath: string,
  baseBranch: string,
): Promise<string> {
  const { stdout } = await runCommand("git", [
    "-C",
    worktreePath,
    "merge-base",
    baseBranch,
    "HEAD",
  ]);
  return stdout.trim();
}

/** `-z` は NUL 区切り。末尾の空要素を落とす。 */
function splitZ(s: string): string[] {
  const parts = s.split("\0");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/**
 * `M\0b.bin\0R075\0old.txt\0new.txt\0A\0new.txt\0` を読む。
 * R / C だけ類似度スコアが付き、パスが旧・新の2つ来る。
 * C（コピー）は `-C` を渡さない限り出ないが、来ても R として扱う
 * — レビューする人にとって「別の場所から来た」以上の区別に意味が無い。
 */
function parseNameStatus(
  out: string,
): Map<string, { status: DiffFile["status"]; old_path?: string }> {
  const parts = splitZ(out);
  const result = new Map<string, { status: DiffFile["status"]; old_path?: string }>();
  for (let i = 0; i < parts.length;) {
    const letter = parts[i][0];
    if (letter === "R" || letter === "C") {
      result.set(parts[i + 2], { status: "R", old_path: parts[i + 1] });
      i += 3;
    } else {
      // T（型の変更）・U（未マージ）は M として見せる。どちらも「中身が変わった」。
      const status = letter === "A" || letter === "D" ? letter : "M";
      result.set(parts[i + 1], { status });
      i += 2;
    }
  }
  return result;
}

/**
 * `-\t-\tb.bin\0` / `1\t0\t\0old.txt\0new.txt\0` / `1\t0\tnew.txt\0` を読む。
 * リネームのときだけ3つ目が空になり、その後に旧・新が NUL 区切りで続く。
 * バイナリは追加・削除が `-` で来る。
 */
function parseNumstat(
  out: string,
): Map<string, { additions: number; deletions: number; binary: boolean }> {
  const parts = splitZ(out);
  const result = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  for (let i = 0; i < parts.length;) {
    const [add, del, path] = parts[i].split("\t");
    const binary = add === "-";
    const counts = {
      additions: binary ? 0 : Number(add),
      deletions: binary ? 0 : Number(del),
      binary,
    };
    if (path === "") {
      result.set(parts[i + 2], counts);
      i += 3;
    } else {
      result.set(path, counts);
      i += 1;
    }
  }
  return result;
}

async function gitDiff(
  worktreePath: string,
  args: string[],
  fromRef: string,
  toRef: string,
): Promise<string> {
  const { stdout } = await runCommand("git", [
    "-C",
    worktreePath,
    "diff",
    ...args,
    fromRef,
    toRef,
    "--",
    ...PATHSPEC,
  ]);
  return stdout;
}

export async function computeDiff(o: {
  worktreePath: string;
  fromRef: string;
  toRef: string;
  patchLimitBytes?: number;
}): Promise<DiffResult> {
  const [nameStatus, numstat, rawPatch] = await Promise.all([
    gitDiff(o.worktreePath, ["--name-status", "-z", "-M"], o.fromRef, o.toRef),
    gitDiff(o.worktreePath, ["--numstat", "-z", "-M"], o.fromRef, o.toRef),
    gitDiff(o.worktreePath, ["-M"], o.fromRef, o.toRef),
  ]);

  const statuses = parseNameStatus(nameStatus);
  const counts = parseNumstat(numstat);
  // 出力順は一致するが、順序ではなく新しいパスをキーに突き合わせる。
  const files: DiffFile[] = [];
  for (const [path, s] of statuses) {
    const c = counts.get(path) ?? { additions: 0, deletions: 0, binary: false };
    files.push({
      path,
      ...(s.old_path ? { old_path: s.old_path } : {}),
      status: s.status,
      ...c,
    });
  }

  const { patch, truncated } = truncatePatch(
    rawPatch,
    o.patchLimitBytes ?? PATCH_LIMIT_BYTES,
  );
  return { files, patch, truncated };
}
