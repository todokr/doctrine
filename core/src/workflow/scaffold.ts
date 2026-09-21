import { join } from "@std/path";
import { runCommand } from "../util/exec.ts";
import { parseProjectConfig } from "./project.ts";

/** project-add が雛形を作るときのワークフロー名 */
export const DEFAULT_WORKFLOW_NAME = "default";

/**
 * project-add は最初に叩くコマンドなので、足りない `.doctrine/` の雛形をここで作る。
 *
 * - 既存のファイルは決して上書きしない。ユーザーが書いた設定を黙って消さないため
 * - project.yaml が既にあるなら、それが指すワークフローを勝手に作らない。
 *   無ければ分かる形で失敗させる（ユーザーが書いていない手順を実行させない）
 * - git リポジトリのルートでなければ何も作らない。doctrine はタスクごとに
 *   git worktree を切るので、関係ないディレクトリに .doctrine をばら撒かない
 *
 * 作ったファイルのパスを返す。ユーザーのリポジトリに未追跡ファイルが増えるので、
 * 呼び出し側はそれを伝えること。コミットはしない — 何をコミットするかはユーザーが決める。
 */
export async function ensureProjectScaffold(path: string): Promise<{ created: string[] }> {
  await assertRepoRoot(path);

  const dir = join(path, ".doctrine");
  const projectYaml = join(dir, "project.yaml");
  const created: string[] = [];

  if (await exists(projectYaml)) {
    const cfg = parseProjectConfig(await Deno.readTextFile(projectYaml));
    const workflow = join(dir, "workflows", `${cfg.defaultWorkflow}.yaml`);
    if (!(await exists(workflow))) {
      throw new Error(
        `project.yaml の defaultWorkflow が指すワークフローがありません: ${workflow}` +
          `（.doctrine/workflows/${cfg.defaultWorkflow}.yaml を作成するか、defaultWorkflow を直してください）`,
      );
    }
    return { created };
  }

  const base = await detectBaseBranch(path);
  await Deno.mkdir(join(dir, "workflows"), { recursive: true });
  const workflowYaml = join(dir, "workflows", `${DEFAULT_WORKFLOW_NAME}.yaml`);
  if (!(await exists(workflowYaml))) {
    await Deno.writeTextFile(workflowYaml, defaultWorkflowYamlFor(base), { createNew: true });
    created.push(workflowYaml);
  }
  await Deno.writeTextFile(projectYaml, projectYamlFor(base), { createNew: true });
  created.push(projectYaml);
  return { created };
}

async function assertRepoRoot(path: string): Promise<void> {
  let top: string;
  try {
    top = (await runCommand("git", ["-C", path, "rev-parse", "--show-toplevel"])).stdout.trim();
  } catch {
    throw new Error(
      `git リポジトリではありません: ${path}` +
        `（doctrine はタスクごとに git worktree を作るため、git リポジトリのルートを指定してください）`,
    );
  }
  // git はシンボリックリンク解決後の実パスを返すので、こちらも揃えてから比べる
  if (await Deno.realPath(path) !== top) {
    throw new Error(
      `リポジトリのルートを指定してください: ${top}（${path} はそのサブディレクトリです）`,
    );
  }
}

/**
 * main 決め打ちにしない。master / develop を使うリポジトリで最初から間違えないように、
 * リモートの既定ブランチ → 現在のブランチの順に見る。どちらも取れなければ（detached HEAD など）
 * undefined を返し、project.yaml には書かずに既定値へ任せる。
 */
async function detectBaseBranch(root: string): Promise<string | undefined> {
  try {
    const ref =
      (await runCommand("git", ["-C", root, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"]))
        .stdout.trim();
    if (ref.startsWith("origin/")) return ref.slice("origin/".length);
  } catch {
    // origin が無い、または origin/HEAD が設定されていない
  }
  try {
    const current = (await runCommand("git", ["-C", root, "branch", "--show-current"])).stdout
      .trim();
    if (current) return current;
  } catch {
    // 取れなければ既定値に任せる
  }
  return undefined;
}

async function exists(p: string): Promise<boolean> {
  try {
    await Deno.stat(p);
    return true;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return false;
    throw e;
  }
}

/** setup は書かない — doctrine はパッケージマネージャを強制しない（spec 3章） */
function projectYamlFor(baseBranch: string | undefined): string {
  const lines = [
    "# doctrine のプロジェクト設定（dctl project-add が雛形として作成）",
    "#",
    "# setup: 新しい worktree で最初に走らせるコマンド。例: pnpm install --frozen-lockfile",
    "#   doctrine はパッケージマネージャを決めないので、必要なら自分で書く。",
    `defaultWorkflow: ${DEFAULT_WORKFLOW_NAME}`,
    "maxConcurrent: 1",
  ];
  if (baseBranch) lines.push(`baseBranch: ${baseBranch}`);
  return lines.join("\n") + "\n";
}

/** 調べるだけの役（計画・審査・ガイド）に渡す Bash の許可。書き込むコマンドは含めない */
export const READ_ONLY_TOOLS = [
  "Bash(git status:*)",
  "Bash(git diff:*)",
  "Bash(git log:*)",
  "Bash(git show:*)",
  "Bash(git apply --stat:*)",
  "Bash(grep:*)",
  "Bash(cat:*)",
  "Bash(head:*)",
  "Bash(tail:*)",
  "Bash(wc:*)",
  "Bash(ls:*)",
  "Bash(find:*)",
  "Bash(sed -n:*)",
];

function toolLines(tools: string[]): string {
  return tools.map((t) => `      - "${t}"`).join("\n");
}

/**
 * spec 4章の手順（計画 → 計画レビュー → 実装 → 検証 → コードレビュー → ガイド → 人のレビュー）。
 * どのプロジェクトでも検証を通る一般形にしてあり、プロジェクトごとに違う verify の run と
 * allowedTools はコメントで「ここを書き換える」と示す。open-pr は入れない。
 *
 * テンプレート変数に baseBranch が無いので、agent-review が読む diff の範囲だけは
 * 雛形を作った時点の値を文字列で埋め込む。
 */
export function defaultWorkflowYamlFor(baseBranch: string | undefined): string {
  const base = baseBranch ?? "main";
  const readOnly = toolLines(READ_ONLY_TOOLS);
  const implementTools = toolLines([...READ_ONLY_TOOLS, "Bash(git add:*)", "Bash(git commit:*)"]);
  return `# doctrine の既定ワークフロー（dctl project-add が雛形として作成）
# plan → plan-review → plan-gate → implement → verify → agent-review → review-gate → guide → review
#
# エージェントを planner / plan-reviewer / implementer / code-reviewer / guide の5つの役割に分け、
# 役割の間は .doctrine-out/ のファイルで成果物を受け渡す。
# 審査役を計画用と実装用で分けているのは、agent-review が計画審査のときの
# 探索履歴を抱えたまま再開されないようにするため。
# guide も同じ理由で独立した役割にしてあり、実装や審査の探索履歴を継がずに
# 差分だけを読んでガイドを書く。
#
# 自分のプロジェクトに合わせて書き換えるのは次の2か所。
#   - verify の run: いまは何も検証しない "true"。型検査・テストのコマンドに書き換える
#   - implement の allowedTools: acceptEdits では Bash がすべて拒否されるので、
#     実装中に流させたいコマンド（テストや lint）をここへ足す
#
# 2つのゲート（plan-gate / review-gate）は、審査役が書いた成果物ファイルの
# 1行目の verdict を grep で見るだけの command ステップ。
# reject なら成果物ファイルを stdout に出して落ち、onFailure で前の工程へ戻る。
# feed はゲート自身の last_stdout（＝審査結果のファイルの中身）を渡す。
#   plan-gate   が落ちたら plan へ（最大3回）
#   verify      が落ちたら implement へ（最大3回）
#   review-gate が落ちたら implement へ（最大3回）
#   guide       の検証が落ちたら guide 自身へ（最大3回。onFailure を書かない既定の分岐）
#   review（人の承認）で却下されたら implement へ（最大5回）
# maxAttempts を使い切ってもゲートが通らない場合、タスクは failed になる。
# そのとき worktree は削除されずに残るので、中を見て手で直すか、タスクを作り直す。
#
# review-gate は「verdict: escalate」も通す。implement が自分では直せない指摘
# （許可されていないコマンドが要る、など）を implement へ戻しても同じ reject を
# 繰り返して maxAttempts を使い切るだけなので、人の review へ進めて判断を仰ぐ。
#
# agent-review の git diff / git log の範囲（${base}）は、雛形を作った時点の
# project.yaml の baseBranch を埋め込んである。テンプレート変数に baseBranch が無いため、
# 後から baseBranch を変えたら、このファイルの ${base}... も直すこと。
#
# command ステップはクラッシュ復帰時に頭から再実行されるので、
# 再実行しても安全なコマンドにすること（grep や pnpm test は安全、gh pr create は危険）。
name: ${DEFAULT_WORKFLOW_NAME}
steps:
  - id: plan
    type: agent
    session: planner
    permissionMode: acceptEdits
    allowedTools:
${readOnly}
    prompt: |
      次のタスクの実装計画を立ててください。

      ---
      {{ task.prompt }}
      ---

      リポジトリを調べたうえで、計画を {{ worktree.path }}/.doctrine-out/plan.md に書いてください。
      この計画を読む実装者は、あなたの調査結果を知らない別のエージェントです。
      実装者がリポジトリを調べ直さずに着手できるように、調べて分かったことを計画に残します。
      見出しは次の5つにします。

      - 「調べて分かったこと」: 再利用する既存の関数・型・テストヘルパー（パスと名前）、
        周辺コードが従っている書き方、実装者がはまりそうな点。
      - 「変更するファイル」: パスごとに、触る関数名・型名と行番号の範囲。新規ファイルはその旨。
      - 「変更内容」: 作業の順序とコミットの単位。追加・変更するシグネチャと型定義は書きます。
        関数の中身は書かず、何をするかを文章で書きます。
      - 「テスト」: 追加するテストファイルのパス、テストケースの名前、入力と期待値。
      - 「やらないこと」

      変更対象・方針・手順・影響範囲・テスト方針・リスクが読み取れるようにしてください。
      実装者が読む必要のないファイルは挙げないでください。
      計画を書くだけで、リポジトリのコードは変更しないでください。

      差し戻されて再度呼ばれた場合は、指摘を踏まえて plan.md を全文書き直してください。

  - id: plan-review
    type: agent
    session: plan-reviewer
    permissionMode: acceptEdits
    allowedTools:
${readOnly}
    prompt: |
      {{ worktree.path }}/.doctrine-out/plan.md を毎回読み直して審査し、結果を
      {{ worktree.path }}/.doctrine-out/plan-review.md に上書きしてください。

      元のタスクは次のとおりです。

      ---
      {{ task.prompt }}
      ---

      見るのは次の3点です。

      - タスクの要求を満たす計画か。余計なことをしていないか
      - 実装者がリポジトリを調べ直さずに着手できる具体さか（触る関数、シグネチャ、テストケースが書いてあるか）
      - 計画に書かれたパス・関数名・型名が実在するか。grep や sed -n で、挙げられた箇所だけを確かめます

      リポジトリ全体を調べ直す必要はありません。計画が挙げた箇所を確かめれば足ります。

      plan-review.md の1行目は必ず「verdict: approve」か「verdict: reject」のどちらかにします。
      2行目以降に指摘を書いてください。修正が必要な具体的な指摘があるときだけ reject にします。

      指摘は plan-review.md から後続のステップへ渡ります。最終応答は verdict の1行だけで構いません。

  - id: plan-gate
    type: command
    run: "grep -q '^verdict: approve' .doctrine-out/plan-review.md || { cat .doctrine-out/plan-review.md || echo 'plan-review.md が書かれていない'; exit 1; }"
    onFailure:
      goto: plan
      maxAttempts: 3
      feed: |
        計画がレビューで却下された:
        {{ steps.plan-gate.last_stdout }}

  - id: implement
    type: agent
    session: implementer
    permissionMode: acceptEdits
    # 自分のプロジェクトのテスト・lint のコマンドをここへ足す（例: "Bash(pnpm test:*)"）。
    # 許可は「&&」や「cd」でつないだ各コマンドに個別に照合されるので、つないだ形は通らない。
    allowedTools:
${implementTools}
    prompt: |
      {{ worktree.path }}/.doctrine-out/plan.md を読んでから実装してください。

      元のタスクは次のとおりです。

      ---
      {{ task.prompt }}
      ---

      plan.md は、リポジトリを調べたうえで書かれ、審査を通っています。
      plan.md が挙げたファイルと行から着手し、それ以外は必要になるまで読まないでください。
      plan.md が実際のコードと食い違っていたら、コードに合わせて実装し、食い違いを最終応答に書いてください。

      テストを先に書いてから実装します。コミットする前に、verify ステップと同じコマンドを自分で通してください。

      差し戻されて再度呼ばれた場合は、指摘を直して再度コミットしてください。

      最後に {{ worktree.path }}/.doctrine-out/implement-notes.md を毎回上書きしてください。書くのは次の3点です。

      - 今回やったこと
      - 実行して通した検証コマンド
      - できなかったこと。権限で拒否されたコマンドはコマンド名をそのまま書き、
        人に代わりにやってほしい手順があればそれも書きます。無ければ「なし」と書きます

      必要なコマンドが権限で拒否されたときは、回避策を取らず、
      できる範囲までコミットして、できなかったことを implement-notes.md に書いて終えてください。

  # ここを自分のプロジェクトの型検査・テストのコマンドに書き換える（例: pnpm test）。
  # いまの "true" は何も検証しない。常に落ちるコマンドにすると implement へ戻り続けて
  # タスクが failed になるので、雛形では通る値にしてある。
  # 標準出力と標準エラーのどちらに失敗の詳細が出るかはコマンドによるので、両方を渡す。
  - id: verify
    type: command
    run: "true"
    onFailure:
      goto: implement
      maxAttempts: 3
      feed: |
        型検査かテストが失敗した:
        {{ steps.verify.last_stdout }}
        {{ steps.verify.last_stderr }}

  - id: agent-review
    type: agent
    session: code-reviewer
    permissionMode: acceptEdits
    allowedTools:
${readOnly}
    prompt: |
      直前の verify ステップに書かれたコマンドが通っています。自分で回す必要はありません。

      implement が積んだコミットを毎回読み直して審査し、結果を
      {{ worktree.path }}/.doctrine-out/review.md に上書きしてください。

      「git diff ${base}...HEAD」と「git log ${base}..HEAD」で実装の差分とコミットを読み、
      {{ worktree.path }}/.doctrine-out/plan.md と突き合わせます。
      {{ worktree.path }}/.doctrine-out/implement-notes.md も読みます。実装者が、やったこと・
      通した検証・できなかったことを書いています。見るのは次の3点です。

      - plan.md との乖離
      - テスト不足
      - リポジトリの規約（CLAUDE.md など）の違反

      review.md の1行目は必ず「verdict: approve」「verdict: reject」「verdict: escalate」の
      どれかにします。2行目以降に指摘を書いてください。

      - reject: 修正が必要な具体的な指摘があり、実装者が直せるとき。実装者へ差し戻されます
      - escalate: 修正が必要な指摘が残っているが、実装者には直せないとき。人のレビューへ進みます。
        implement-notes.md に権限で拒否されたコマンドが書かれていて指摘の対応にそのコマンドが要る場合や、
        前回と同じ指摘なのに HEAD が動いていない場合がこれに当たります。
        同じ指摘で reject を繰り返さないでください。
        2行目以降の先頭に、人にやってほしい手順をコマンドつきで書きます
      - approve: それ以外

      指摘は review.md から後続のステップへ渡ります。最終応答は verdict の1行だけで構いません。

  - id: review-gate
    type: command
    run: "grep -qE '^verdict: (approve|escalate)' .doctrine-out/review.md || { cat .doctrine-out/review.md || echo 'review.md が書かれていない'; exit 1; }"
    onFailure:
      goto: implement
      maxAttempts: 3
      feed: |
        実装がレビューで却下された:
        {{ steps.review-gate.last_stdout }}

  # プロンプトは doctrine が組み立てるので prompt は書けない（書くとスキーマで落ちる）。
  # onFailure を書いていないのは、guide ステップの既定が「自分へ戻る・3回・
  # {{ steps.guide.last_stderr }} を feed」で、ここに置きたい値と同じため。
  # 組み込みプロンプトが git diff を実行するので Bash(git diff:*) は外せない。
  - id: guide
    type: guide
    session: guide
    permissionMode: acceptEdits
    allowedTools:
${readOnly}

  - id: review
    type: approval
    title: "変更を確認してください"
    onReject:
      goto: implement
      maxAttempts: 5
      feed: |
        人のレビューで却下された:
        {{ steps.review.last_stdout }}
    review:
      files:
        - .doctrine-out/review.md
        - .doctrine-out/implement-notes.md
        - .doctrine-out/plan.md
`;
}
