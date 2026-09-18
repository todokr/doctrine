import { runCommand } from "../util/exec.ts";

/**
 * リネームだけが「前のパス」を持つ。他の状態で old_path を読めないようにし、
 * 「R なのに old_path が無い／R でないのに old_path がある」という不正な状態を
 * 型で作れなくする。
 */
type Renamed = { status: "R"; old_path: string };
type NotRenamed = { status: "A" | "M" | "D" };

/**
 * バイナリは行数を数えられない。additions/deletions に 0 を入れると
 * 「1行も変わっていないテキスト」と見分けがつかなくなるので、
 * バイナリのときはフィールドごと持たせない。
 */
type Counted = { binary: false; additions: number; deletions: number };
type NotCounted = { binary: true };

export type DiffFile = { path: string } & (Renamed | NotRenamed) & (Counted | NotCounted);

export type DiffResult = { files: DiffFile[]; patch: string; truncated: boolean };

/** `task.diff` の応答の形。レビュー画面がこの型を読む（②spec 9章）。 */
export type TaskDiff = {
  base: { branch: string; merge_base: string };
  since_step_run_id: number | null;
  files: DiffFile[];
  patch: string;
  truncated: boolean;
};

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
 * patch をバイト数の上限以内に切り詰める、汎用の純粋関数。
 * 上限以内の最後の改行の直後で切る。行の途中で切ると unified diff のパーサが壊れ、
 * 画面が「壊れた diff」ではなく「間違った diff」を描きかねない。
 * 上限以内に改行が1つも無い（極端に長い1行）ときだけ、上限でそのまま切る
 * （`computeDiff` が渡す patch には git のヘッダによる改行が必ず早い位置にあるため
 * この分岐には来ないが、関数自体の契約としては成り立つようにしておく）。
 */
export function truncatePatch(
  patch: string,
  limitBytes: number,
): { patch: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(patch);
  if (bytes.length <= limitBytes) return { patch, truncated: false };
  const head = bytes.subarray(0, limitBytes);
  const lastLf = head.lastIndexOf(LF);

  if (lastLf >= 0) {
    return {
      patch: new TextDecoder().decode(head.subarray(0, lastLf + 1)),
      truncated: true,
    };
  }

  // 改行が無いときはバイト位置で切るしかないが、そのままだと UTF-8 の
  // マルチバイト文字を分断し、TextDecoder が U+FFFD（3バイト）に置き換える。
  // 置換後に再エンコードすると上限を超えうるので、文字の切れ目まで戻す。
  //
  // 切れ目かどうかは「切る位置のバイト」＝最初に捨てるバイトで判定する
  // （最後に残すバイトではない）。継続バイト 10xxxxxx でなければ、そこから
  // 次の文字が始まっているので既に切れ目にいる。
  let cut = limitBytes;
  while (cut > 0 && (bytes[cut] & 0xc0) === 0x80) cut -= 1;
  return { patch: new TextDecoder().decode(bytes.subarray(0, cut)), truncated: true };
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
function parseNameStatus(out: string): Map<string, Renamed | NotRenamed> {
  const parts = splitZ(out);
  const result = new Map<string, Renamed | NotRenamed>();
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
function parseNumstat(out: string): Map<string, Counted | NotCounted> {
  const parts = splitZ(out);
  const result = new Map<string, Counted | NotCounted>();
  for (let i = 0; i < parts.length;) {
    const fields = parts[i].split("\t");
    const [add, del] = fields;
    // パスにタブが入っていても壊れないよう、3つ目以降は繋ぎ直す
    // （-z ではパスがクォートされず生で出るため）。
    const path = fields.slice(2).join("\t");
    const binary = add === "-";
    const counts: Counted | NotCounted = binary
      ? { binary: true }
      : { binary: false, additions: Number(add), deletions: Number(del) };
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
    const c = counts.get(path);
    // --name-status に出たパスは --numstat にも必ず出るはずで、無ければ
    // 2つの git 呼び出しの出力がずれている ＝ このパーサのどこかの前提が崩れている。
    // ここを 0 件で黙って埋めると「バイナリでも変更0行でもない、パースの取りこぼし」
    // を「変更なし」に偽装してしまう（過去のレビューで一度指摘済み）ので、
    // 隠さずに例外にして気付けるようにする。
    if (c === undefined) {
      throw new Error(`numstat に ${path} の行数情報が無い（name-status とずれている）`);
    }
    files.push(
      s.status === "R"
        ? { path, status: "R", old_path: s.old_path, ...c }
        : { path, status: s.status, ...c },
    );
  }

  const { patch, truncated } = truncatePatch(
    rawPatch,
    o.patchLimitBytes ?? PATCH_LIMIT_BYTES,
  );
  return { files, patch, truncated };
}
