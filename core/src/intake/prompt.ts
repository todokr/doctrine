import type { IntakeRunPurpose } from "../db/schema.ts";
import type { IssueDetail } from "../../../shared/intake/github.ts";
import type { Pfd } from "../../../shared/intake/pfd.ts";
import type { FrozenPart } from "./pfd/validate.ts";

/**
 * 調査・分解エージェントへ送る文面。guidePrompt.ts と同じく expand() に通さず、
 * テンプレートリテラルで直接組む（Issue 本文の {{ }} をテンプレートとして読まないため）。
 * 文面を別ファイルに出さない（deno compile が別ファイルを同梱しない）。
 */

const DECOMPOSITION_RULES = `## PFD の書き方

要素は成果物とプロセスの 2 種類だけである。プロセスは成果物を入力に取り、別の成果物を出力する。
プロセスは成果物の id だけを参照する。他のプロセスを参照する書き方は無い。

PFD は次の形の JSON で返す（\`issue\` のキーは無い）。

\`\`\`json
{
  "title": "Issue のタイトル",
  "goal": ["feature"],
  "artifacts": [
    { "id": "schema", "name": "既存スキーマ", "given": true },
    {
      "id": "new-table",
      "name": "集計テーブル",
      "given": false,
      "description": "何であるかを 1〜2 文で",
      "verify": "この成果物だけを確かめる方法（テスト・コマンド・目視の手順）"
    },
    {
      "id": "policy",
      "name": "集計の方針",
      "given": true,
      "decision": "q1"
    },
    {
      "id": "feature",
      "name": "集計画面",
      "given": false,
      "description": "goal の成果物。これがマージされたら Issue は完了",
      "verify": "画面のテストが通る"
    }
  ],
  "processes": [
    {
      "id": "1",
      "name": "マイグレーションを書く",
      "actor": "agent",
      "inputs": ["schema"],
      "outputs": ["new-table"],
      "purpose": "なぜこの作業が要るか",
      "steps": "何をどの順でやるか",
      "done_when": "何をもって終わりとするか"
    },
    {
      "id": "2",
      "name": "集計の定義を決める",
      "actor": "human",
      "inputs": ["schema"],
      "outputs": ["metric-definition"],
      "purpose": "何を決めるのか",
      "done_when": "何が決まっていれば終わりか"
    }
  ]
}
\`\`\`

- **成果物から先に決める。** 「何を作れば Issue が終わるか」を \`goal\` に置き、それを作るのに何が要るかを遡る。
  作業の一覧から始めない
- \`given: true\` は最初から baseBranch にあるもの。\`verify\` は要らない。それ以外の成果物には \`verify\` を書く
- 成果物は**もの**である（テーブル、API、部品、決定事項）。「〜の実装」「〜の対応」は成果物ではない
- プロセスの名前は「〜を〜する」の形にする
- \`purpose\` \`steps\` \`done_when\` は、その文だけを読んだエージェントが作業できるように書く。
  プロセスを実行するエージェントは、この会話も、他のプロセスの定義も見ない
- **実行しなければ決められない判断**（計測してみないと分からない、試作を見ないと選べない、など）は、
  エージェントに推測させず、\`actor: "human"\` のプロセスにする。仕様の選択、外部との調整、運用上の判断も同じ
- **分解の前に人が決めた事項**（質問への回答と、仮定への応答）のうち、プロセスの前提になるものは、
  \`decision\` にその質問か仮定の id を入れた \`given: true\` の成果物として最初から揃っているものとして置く。
  決定の中身は doctrine が回答と応答から埋めるので、\`description\` に決定の中身を書かない。
  分解の形だけを左右した決定は成果物にしない

## 粒度 — どこで割るのをやめるか

プロセスは、次の 4 つを**すべて**満たすまで割る。

1. **人が一度でレビューしきれる PR 1 つに収まる**
2. **エージェントが 1 回の実行でやりきれる**（計画 → 実装 → レビューの 1 周で終わる）
3. **単独でマージしても baseBranch が壊れない**
4. **出力の成果物が単独で検証できる**（\`verify\` に、その成果物だけを確かめる方法が書ける）

成果物は baseBranch へのマージで下流に渡る。下流のプロセスは、上流の PR がマージされるまで始まらない。
だから 3 と 4 が切り方を縛る。

- 悪い切り方: 「API の前半を書く」「API の後半を書く」— 前半だけでは検証できず、マージすれば壊れる
- 良い切れ目: まだ誰も使っていなくてもマージできるもの — テーブル、呼び出し元の無い関数や部品、
  フラグの裏に置いた機能

**割りすぎを避ける。** 依存の連鎖は、段ごとに人の PR レビューを待つ。1 つの PR で無理なくレビューできる
ものを 3 つに割れば、待ちが 3 倍になる。並列にできる枝を見つけることを優先する。`;

const QUESTION_RULES = `## 論点の規則 — 質問と仮定

- PFD を作るうえで論点になることを、自分で決められるものも含めて**すべて**洗い出し、まとめて 1 回で返す。
  黙って決めたことを残さない
- 論点は 2 つに分ける
  - **質問**: 人の判断が要るもの（方針、優先順位、トレードオフの選び方など）
  - **仮定**: Issue・コード・慣習から導けるもの。リポジトリを読んで確かめ、結論と根拠を返す
- 質問には、選択肢と判断の材料（文章・表・コード片・図）を付ける。**推奨は書かない。**
  選択肢の説明と判断の材料でも、どれかを推す書き方をしない。人が材料を比べて自分で選ぶ
- 仮定には、結論（\`statement\`）、根拠（\`evidence\`。Issue の引用、コードの箇所、慣習のどれか 1 つ以上）、
  崩れたときに計画のどこが変わるか（\`impact\`）を書く。根拠は、人がそれだけを読んで結論を確かめられるように引く
- 仮定は、崩れたときの影響が大きい順に並べる
- 質問と仮定の id は、この Intake の中で一意にする（前に出した質問・仮定とも、互いとも重ねない）
- 質問も仮定も無ければ、\`questions\` と \`assumptions\` に空配列を返す`;

function formatIssue(issue: IssueDetail): string {
  const comments = issue.comments.length === 0 ? "（コメントなし）" : issue.comments
    .map((c) => `### ${c.author ?? "（削除されたユーザー）"}（${c.createdAt}）\n\n${c.body}`)
    .join("\n\n");
  return `URL: ${issue.url}
タイトル: ${issue.title}

### 本文

${issue.body}

## Issue のコメント（古い順）

${comments}`;
}

/** 会話の最初に 1 回だけ送る。調査の実行として、質問だけを返させる。 */
export function buildInitialPrompt(input: { issue: IssueDetail }): string {
  return `あなたは、Issue を PFD（Process Flow Diagram）で分解する前に、分解の論点を洗い出して人に確かめてもらう役です。
リポジトリは読むだけで、書き換えません。出力は最終応答の構造化出力で返し、ファイルには書きません。

## Issue

${formatIssue(input.issue)}

${DECOMPOSITION_RULES}

この規則は、あとで PFD を書くときに使います。どこが分解の論点になるかを見つけるためにも、先に読んでください。

${QUESTION_RULES}

## 今回の出力

この実行では PFD を返しません。Issue とリポジトリを調べ、\`kind: "questions"\` で質問と仮定のまとまりを返してください。
\`pfd\` と \`replies\` は null にします。
`;
}

function formatFrozen(frozen: FrozenPart): string {
  if (frozen.processes.length === 0 && frozen.artifacts.length === 0) {
    return "固定された部分はありません。";
  }
  const lines = [
    "次のプロセスと成果物は、投入済みか完了済み、またはその入出力です。",
    "id・中身・入出力とも一字も変えずに、新しい案へ含めてください。変えた案は受け付けません。",
    "",
  ];
  for (const p of frozen.processes) lines.push(`- プロセス ${p.id}「${p.name}」`);
  for (const a of frozen.artifacts) lines.push(`- 成果物 ${a.id}「${a.name}」`);
  return lines.join("\n");
}

/** 改訂の会話の最初に送る。承認済みの計画・固定された部分・決定の記録・改訂のコメントを載せる。 */
export function buildRevisionPrompt(input: {
  issue: IssueDetail;
  approved: Pfd;
  frozen: FrozenPart;
  retiredProcessIds: readonly string[];
  /** decisionTexts の結果（質問・仮定の id → 決定の文章）。 */
  decisions: Record<string, string>;
  /** buildFeedback(approved, 改訂の開始コメント) の結果。 */
  feedback: string;
}): string {
  const retired = input.retiredProcessIds.length === 0 ? "" : `## 使えない id

前の改訂で取りやめたプロセスの id は、新しい案で使えません。別の id にしてください。

${input.retiredProcessIds.map((id) => `- ${id}`).join("\n")}

`;
  const decided = Object.entries(input.decisions);
  const decisions = decided.length === 0
    ? "なし"
    : decided.map(([id, text]) => `- ${id}: ${text}`).join("\n");
  return `あなたは、承認されて進行中の計画（PFD）を、人のコメントに沿って直す役です。
リポジトリは読むだけで、書き換えません。出力は最終応答の構造化出力で返し、ファイルには書きません。

## Issue

${formatIssue(input.issue)}

${DECOMPOSITION_RULES}

${QUESTION_RULES}

## 承認済みの計画

\`\`\`json
${JSON.stringify(input.approved, null, 2)}
\`\`\`

## 固定された部分

${formatFrozen(input.frozen)}

${retired}## 人が決めたこと

${decisions}

固定されたプロセスが入力に取っていない決定は、質問か仮定を出し直して問い直してかまいません。
そのときは新しい id を使います。

${input.feedback}

## 今回の出力

固定された部分を含めた計画全体を \`kind: "pfd"\` で返してください。
人に確かめてもらう論点があれば、PFD の代わりに \`kind: "questions"\` で質問と仮定を返してかまいません。
`;
}

/** 調査で質問も仮定も無かったとき（Q-4）。分解へ進ませる。 */
export function buildNoQuestionsMessage(): string {
  return `論点は無いと判断しました。上の規則で PFD を書き、\`kind: "pfd"\` で返してください。
\`replies\` は空配列にします。分解の途中で新しい論点が出たら、PFD の代わりに質問と仮定を返してかまいません。`;
}

/** 検証に落ちた出力を返す。purpose が investigate なら「調査は質問だけを返す」を添える。 */
export function buildInvalidOutputMessage(purpose: IntakeRunPurpose, issues: string[]): string {
  const lines = [
    "前回の出力は受け付けられませんでした。次の点を直して、もう一度返してください。",
    "",
  ];
  for (const issue of issues) lines.push(`- ${issue}`);
  if (purpose === "investigate") {
    lines.push("", "この実行は調査です。PFD ではなく、質問と仮定だけを返してください。");
  }
  return lines.join("\n");
}
