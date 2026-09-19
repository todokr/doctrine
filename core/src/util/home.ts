import { join } from "@std/path";

/**
 * node:os の homedir() に相当する。HOME が無い環境で相対パスや `/` に黙って倒すと、
 * 状態ディレクトリ（DB・worktree・ログ）が予期しない場所に作られるので、例外にする。
 */
export function homeDir(): string {
  const home = Deno.env.get("HOME");
  if (!home) {
    throw new Error(
      "HOME が設定されていません（DOCTRINE_STATE_DIR で状態ディレクトリを指定してください）",
    );
  }
  return home;
}

/**
 * DB・worktree・ログの置き場。macOS ではソケットもここに置く
 * （XDG_RUNTIME_DIR が無く /run が read-only なため）。
 */
export function stateRoot(): string {
  // 空文字は「指定なし」として扱う（`export DOCTRINE_STATE_DIR=` のような
  // 設定し忘れ）。そのまま使うと状態ディレクトリが相対パスになり、
  // 起動した場所によって DB とソケットの位置が変わる。
  const dir = Deno.env.get("DOCTRINE_STATE_DIR");
  if (dir) return dir;
  return join(homeDir(), ".local", "state", "doctrine");
}
