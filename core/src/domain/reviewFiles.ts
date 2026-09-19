import { join, SEPARATOR } from "@std/path";

/** 1ファイルあたりの上限。これを超えたら中身を返さない。 */
export const MAX_REVIEW_FILE_BYTES = 64 * 1024;

export type ReviewFileStatus = "ok" | "missing" | "too_large" | "outside_worktree" | "binary";

/** 宣言されたファイル1件の読み出し結果。path は常に宣言されたとおりの worktree 相対パス。 */
export type ReviewFile =
  | { path: string; status: "ok"; content: string; size: number }
  /** そこに無い。読もうとして予期しない I/O エラーになった場合もここに倒す。 */
  | { path: string; status: "missing" }
  /** 実在するが上限を超えた。中身は返さず、大きさだけ返す。 */
  | { path: string; status: "too_large"; size: number }
  /** realpath が worktree の外を指した。中身も大きさも読まない。 */
  | { path: string; status: "outside_worktree" }
  /** 実在するが UTF-8 として読めない。 */
  | { path: string; status: "binary"; size: number };

/**
 * approval ステップが宣言したファイルを読む。doctrine は中身を理解しない —
 * 読んで、worktree の中にあることを確かめて、そのまま渡す。
 *
 * 1件ずつ独立に扱う。1つのファイルが読めないことで、他の宣言まで見えなくならない。
 */
export async function readReviewFiles(
  worktreePath: string,
  paths: string[],
): Promise<ReviewFile[]> {
  // worktree のパスも実パスに揃えてから比べる（macOS の /tmp は /private/tmp への
  // symlink なので、DB に入っている表記と realPath の結果が食い違う）。
  const root = await Deno.realPath(worktreePath).catch(() => null);
  if (root === null) return paths.map((path) => ({ path, status: "missing" }));
  return await Promise.all(paths.map((path) => readOne(root, path)));
}

async function readOne(root: string, path: string): Promise<ReviewFile> {
  let real: string;
  try {
    real = await Deno.realPath(join(root, path));
  } catch {
    return { path, status: "missing" };
  }
  // 区切り文字まで含めて比べる。startsWith(root) だけだと、/w/task に対して
  // /w/task-evil/x が配下として通る。
  if (!real.startsWith(root + SEPARATOR)) return { path, status: "outside_worktree" };

  // 通常ファイルかどうかを open 前に確かめる。名前付きパイプ（FIFO）は isFile が
  // false になるので stat だけで弾ける ―― open してしまうと書き手のいない FIFO で
  // Deno.open がブロックし続け、readReviewFiles 全体が固まる（Promise.all の一部として
  // 待たれているため）。
  let preStat: Deno.FileInfo;
  try {
    preStat = await Deno.stat(real);
  } catch {
    return { path, status: "missing" };
  }
  if (!preStat.isFile) return { path, status: "missing" };

  // この stat から open までの間に real の指す先が差し替えられる窓は塞げないが、
  // 承認待ちに入った時点で書き手のステップは既に終了しているため、ここでレースする
  // 書き手は現在のアーキテクチャには存在しない。open 以降は同一ハンドルで
  // サイズ確認と読み出しを行い、その窓だけは塞ぐ。
  let file: Deno.FsFile;
  try {
    file = await Deno.open(real, { read: true });
  } catch {
    return { path, status: "missing" };
  }

  try {
    const stat = await file.stat();
    if (!stat.isFile) return { path, status: "missing" };
    if (stat.size > MAX_REVIEW_FILE_BYTES) return { path, status: "too_large", size: stat.size };

    const bytes = new Uint8Array(await new Response(file.readable).arrayBuffer());
    // stat から読み出しまでの間にファイルが伸びている可能性があるので、実際に
    // 読めたバイト数でも上限を再判定する。
    if (bytes.byteLength > MAX_REVIEW_FILE_BYTES) {
      return { path, status: "too_large", size: bytes.byteLength };
    }

    try {
      const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return { path, status: "ok", content, size: bytes.byteLength };
    } catch {
      return { path, status: "binary", size: bytes.byteLength };
    }
  } catch {
    return { path, status: "missing" };
  } finally {
    try {
      file.close();
    } catch {
      // file.readable を最後まで読むと Deno 側で既に fd が閉じられている場合があるため、
      // 二重 close のエラーは無視する。
    }
  }
}
