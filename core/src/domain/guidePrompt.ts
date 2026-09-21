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

### 影響（\`impact\`）

\`impact\` は、その項目が悪い方に転んだときに起きることの大きさです。どこを読んでほしいかでは選びません。
「悪い方に転ぶ」は、種類ごとに次を指します。

- \`breaks\`: 壊しうるものが実際に壊れる
- \`assumption\`: 置いた前提が崩れる
- \`unknown\`: 分かっていないことが悪い側だった
- \`considered\`: 問題ないという判断が外れていた

- \`high\`: データが失われる・壊れる、権限や秘密が外に出る、または元に戻すのにコードを戻す以上のこと（データの修復、外に出たものの回収、公開した形の互換対応）が要る
- \`medium\`: 既存の動作が変わる、または誤った結果を返す。ただしコードを戻せば元に戻る
- \`low\`: 利用者から見える動作は変わらない（内部の型、テスト、ログの文言、開発者の手元だけ）

\`kind\` と \`impact\` は別々に選びます。\`considered\` にも、その判断が外れていたときの \`impact\` を付けます。
\`body\` には、選んだ \`impact\` の根拠（悪い方に転んだとき何が起きるか）を事実として書きます。
決めきれないときは高いほうを選び、決めきれなかった理由を \`body\` に書きます。

### considered に残すもの

計画レビュー・セルフコードレビュー・人からの指摘で論点になり、問題ないと結論したものと、計画が比べて退けた懸念を書きます。
自分で確かめて問題が無かったことを、すべては並べません。

「ここを確かめてください」のような読み手への指示は書かない。

## 図と読む順

図と読む順は、スキーマの定義に従ってください。
図は sequence と graph の 2 形だけです。アニメーションや描き方の指定は要りません。
読む順は、diff を上から読み進められる並びにします。

## 出力の形

スキーマに沿った JSON を最終応答にします。\`version\` は \`1\` を書きます。
封筒の \`tree\` と \`createdAt\` は doctrine が付けるので書かない。
`;
}
