import type { TemplateContext } from "../workflow/template.ts";
import { GUIDE_HUNKS_RELPATH } from "./guideInputs.ts";
import type { CommandResult } from "./taskContext.ts";

export type GuidePromptInput = {
  ctx: TemplateContext;
  /** collectGuideInputs が返した起点とツリー。プロンプトに書く diff のコマンドに入る。 */
  mergeBase: string;
  tree: string;
  /** 最後の command ステップの結果（＝テスト結果）。1 度も走っていなければ null。 */
  lastCommand: CommandResult | null;
  /**
   * 人がレビューで差し戻したときのコメント。古い順。無ければ空配列。
   * 呼び出し元が ReviewEntry から
   * `reviews.filter((r) => r.status === "rejected").map((r) => r.comment)` で作る。
   */
  rejections: string[];
};

function testResultSection(r: CommandResult | null): string {
  if (r === null) return "テストの結果は渡されていません。";
  const exit = r.exitCode === null ? "シグナルで終了" : `終了コード: ${r.exitCode}`;
  return `ステップ ${r.stepId} の最後の結果です。${exit}

標準出力:
${r.stdout}

標準エラー出力:
${r.stderr}`;
}

function rejectionsSection(rejections: string[]): string {
  if (rejections.length === 0) return "";
  const items = rejections.map((c, i) => `${i + 1}. ${c}`).join("\n");
  return `人がレビューで差し戻したときのコメントです。古い順に並べています。
ガイドは、これらの指摘を踏まえて読み手が迷わないように書いてください。

${items}

`;
}

/**
 * ガイド作成の組み込みプロンプトを組み立てる。
 *
 * 組み立てた文字列を template.ts の expand() に通してはいけない。task.prompt に
 * `{{ ... }}` が含まれていると TemplateError になるうえ、タスク指示からテンプレート変数を
 * 注入する経路になる。ここでは文字列を直接組み立てて返し、展開はしない。
 *
 * 文面を別ファイル（.md）に出さないのは、core/deno.json の build が deno compile に
 * --include を持たず、別ファイルは単一バイナリに同梱されないため（systemPrompt.ts と同じ）。
 */
export function buildGuidePrompt(input: GuidePromptInput): string {
  const { ctx, mergeBase, tree, lastCommand, rejections } = input;
  const out = `${ctx.worktree.path}/.doctrine-out`;
  const hunksPath = `${ctx.worktree.path}/${GUIDE_HUNKS_RELPATH}`;

  return `人がこの変更をレビューするための Review Guide を作ってください。
出力はガイドの JSON そのものです。最終応答にスキーマに沿った JSON を返し、ファイルには書きません
（ファイルへの保存は doctrine がします）。

元のタスクは次のとおりです。

---
${ctx.task.prompt}
---

## テスト結果

${testResultSection(lastCommand)}

${rejectionsSection(rejections)}## 自分で探すもの

入力はタスクのライフサイクル全体です。次のものを自分で読んでください。

- 計画: ${out}/plan.md
- 計画レビューの結果: ${out}/plan-review.md
- セルフコードレビューの結果: ${out}/review.md
- リポジトリの構造（変更されたファイルの周辺のコード）

.doctrine-out/ のファイル名は既定ワークフローの規約であって、強制ではありません。
上のファイルが無ければ、\`.doctrine-out/\` にあるものだけを読んで書いてください。
無いものを推測で補わないでください。

## diff の読み方

変更の本文は、次のコマンドで読んでください。

git diff -M ${mergeBase} ${tree} -- . ':(exclude).doctrine-out/'

このコマンドの結果が、下の hunk の一覧と同じ diff です。
\`git diff <ブランチ>...HEAD\` のような別の範囲で読むと、未コミットや未追跡のファイルが見えず、
一覧の id と突き合わなくなります。

## hunk の一覧

ガイドが指せる hunk は ${hunksPath} にあります。
\`{ id, path, header }\` の JSON 配列です。

- 箇所を指すときは、必ずこの一覧の id と path を使います。行番号では指さない。
- 位置の照合には header を使います。
- hunk に落とせない話（ファイルの新設、ファイル単位の役割の変化）は、\`hunk\` を省いてファイル全体を指します。
- すべての hunk をどこかのグループに入れる必要はありません。

## Risks の書き方

Risks には事実を書きます。種類（\`kind\`）は次の 4 つです。

- \`breaks\`: この変更で壊しうるもの
- \`assumption\`: この変更が置いた前提
- \`unknown\`: 分かっていないこと
- \`considered\`: 検討して、問題ないと判断したこと

「ここを確かめてください」のような読み手への指示は書かない。重大度も付けません。

## 図と読む順

図と読む順は、スキーマの定義に従ってください。
図は sequence と graph の 2 形だけです。アニメーションや描き方の指定は要りません。
読む順は、diff を上から読み進められる並びにします。

## 出力の形

スキーマに沿った JSON を最終応答にします。\`version\` は \`1\` を書きます。
封筒の \`tree\` と \`createdAt\` は doctrine が付けるので書かない。
`;
}
