import { isAbsolute, join } from "@std/path";

/**
 * node:os の homedir() に相当する。HOME が無い環境で相対パスや `/` に黙って倒すと、
 * 状態ディレクトリ（DB・worktree・ログ）や設定ディレクトリが予期しない場所に作られるので、例外にする。
 */
export function homeDir(): string {
  const home = Deno.env.get("HOME");
  if (!home) {
    throw new Error(
      "HOME が設定されていません（DOCTRINE_STATE_DIR / DOCTRINE_CONFIG_DIR で置き場を指定してください）",
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

/** デーモンの設定（config.json）の置き場。人が決めた値なので状態ディレクトリとは分ける。 */
export function configRoot(): string {
  const dir = Deno.env.get("DOCTRINE_CONFIG_DIR");
  if (dir) return dir;
  // XDG の仕様で相対パスは無効。使うと起動した場所で config の位置が変わる
  const xdg = Deno.env.get("XDG_CONFIG_HOME");
  if (xdg && isAbsolute(xdg)) return join(xdg, "doctrine");
  return join(homeDir(), ".config", "doctrine");
}
