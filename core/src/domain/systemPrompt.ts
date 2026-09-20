/**
 * stepRunner がすべての `agent` ステップに `--append-system-prompt` として常に渡す文面。
 *
 * 別ファイル（`.md`）にしないのは、`core/deno.json` の build が
 * `deno compile -A --output dist/dctl src/cli/dctl.ts` で `--include` を持たず、
 * 別ファイルは単一バイナリに同梱されないため。
 */
export const BUILTIN_APPEND_SYSTEM_PROMPT =
  `Bash ツールは1回の呼び出しにつき1コマンドだけ実行すること。
- \`;\` \`&&\` \`||\` \`|\` でコマンドを繋がない。
- リダイレクト（\`>\` \`>>\`）、\`for\` などのループ、コマンド置換で複数のことをまとめない。
- 複数のことをしたいときは、Bash を複数回に分けて呼ぶ。
許可は先頭一致のパターンで判定されるため、繋いだ形はどのパターンにも一致せず拒否される。`;
