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
