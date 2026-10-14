/**
 * stepRunner がすべての `agent` ステップに `--append-system-prompt` として常に渡す文面。
 *
 * 別ファイル（`.md`）にしないのは、単一バイナリ（`core/scripts/build.ts` の esbuild + SEA）に
 * 別ファイルが同梱されないため。
 */
export const BUILTIN_APPEND_SYSTEM_PROMPT = `Bash ツールは1回の呼び出しにつき1コマンドだけ実行すること。
- \`;\` \`&&\` \`||\` \`|\` でコマンドを繋がない。
- リダイレクト（\`>\` \`>>\`）、\`for\` などのループ、コマンド置換で複数のことをまとめない。
- 複数のことをしたいときは、Bash を複数回に分けて呼ぶ。
許可は先頭一致のパターンで判定されるため、繋いだ形はどのパターンにも一致せず拒否される。

git は作業ディレクトリ（worktree）でそのまま動くので、\`-C\` でパスを指定しないこと。
- \`git -C /path/to/worktree diff\` ではなく \`git diff\` と書く。
\`git -C\` は \`git diff\` や \`git log\` の先頭一致に合わず拒否される。`;
