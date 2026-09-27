import type { SetupPolicy } from "../../../shared/protocol.ts";
import { defaultWorkflowYamlFor, READ_ONLY_TOOLS } from "./scaffold.ts";

export const SETUP_WORKFLOW_NAME = "setup";

/**
 * 同梱ワークフローの本文（spec 5.2）。
 *
 * draft の prompt は実行時に expand() を通るので、雛形やステップの例のように
 * テンプレート変数を文字どおり含む文章はここに書けない。それらは setupPrompt が
 * タスクの prompt に入れ、{{ task.prompt }} で渡す（置き換えた値は再展開されない）。
 * ここで展開させる変数は task.prompt と worktree.path だけ。
 */
export function setupWorkflowYaml(): string {
  const tools = READ_ONLY_TOOLS.map((t) => `      - "${t}"`).join("\n");
  return `# doctrine の同梱ワークフロー（Quick Start の setup のタスクが使う）
# draft → validate → review → apply
#
# draft が .doctrine-out/default.yaml を書き、validate が dctl workflow-check と
# git status で確かめ、人が承認したら apply が元のリポジトリの
# .doctrine/workflows/default.yaml に置く。コミットはしない。
name: ${SETUP_WORKFLOW_NAME}
steps:
  - id: draft
    type: agent
    session: drafter
    permissionMode: acceptEdits
    allowedTools:
${tools}
    prompt: |
      このリポジトリで doctrine が使うワークフロー定義（default.yaml）を書いてください。
      書いたものは人が確認し、承認されるとリポジトリの .doctrine/workflows/default.yaml に置かれます。

      方針と、出発点にする雛形（と、方針によってはステップの例）は次のとおりです。

      ---
      {{ task.prompt }}
      ---

      手順は次のとおりです。

      1. リポジトリを調べて、次の3つを決めます。package.json・mise.toml・Makefile・justfile・
         deno.json・Cargo.toml・pyproject.toml・CI の設定（.github/workflows など）・README・
         CLAUDE.md のうち、あるものを読みます。
         - verify の run: 型検査・lint・テストを通すコマンド。CI が回しているものに揃えます。
           依存の取得が要るなら先頭に置きます（例: pnpm install --frozen-lockfile && pnpm test）。
         - implement の allowedTools: verify で使うコマンドと、実装中にテストを回すコマンドを
           "Bash(<コマンド>:*)" の形で足します。雛形にある読み取り系と git add / git commit は残します。
         - baseBranch: .doctrine/project.yaml の baseBranch と、リポジトリの既定ブランチ
           （git log や CI の設定から分かる範囲）を見ます。雛形の agent-review が差分を取る
           範囲（git diff <ブランチ>...HEAD）に使われているので、違っていたら書き換えます。
      2. 雛形を出発点に、方針に合わせてステップを削る・足す・書き換えます。
         ステップを削ったら、そのステップへの goto と、そのステップの成果物（plan.md など）を
         読むように書いたプロンプトも合わせて直します。
         雛形のプロンプトや feed にある二重の波括弧のテンプレート変数は、doctrine がそのワークフローの
         実行時に展開するものです。書き換えずにそのまま残してください。
      3. できたワークフローを {{ worktree.path }}/.doctrine-out/default.yaml に書きます。
      4. {{ worktree.path }}/.doctrine-out/setup-notes.md に次を書きます。承認の画面で人が読みます。
         - 決めたこと: verify の run、implement の allowedTools に足したコマンド、baseBranch と、
           それぞれの根拠にしたファイル
         - 方針とリポジトリの食い違い（例: remote が無いのに PR を開く方針）と、どちらを選んだか。
           食い違ったら、方針よりリポジトリで動く形を選びます。無ければ「なし」と書きます

      守ることは次のとおりです。

      - 書き換えてよいのは .doctrine-out/ の中だけです。.doctrine/ を含め、リポジトリの他のファイルは
        書き換えも作成もしないでください。次のステップが git status で確かめ、変更があれば差し戻されます。
      - 書いた default.yaml は次のステップで dctl workflow-check にかけられます。
      - ファイルは Write / Edit ツールで書きます。Bash に許可しているのは読み取り系のコマンドだけです。
      - 作業ディレクトリは worktree のルートです。Bash に渡すパスは worktree のルートからの相対で
        書いてください。コマンドは1つずつ実行します。&& や cd でつなぐと権限で拒否されます。
        git に -C を付けないでください。

      差し戻されて再度呼ばれた場合は、検証のエラーか人の却下コメントが渡されます。
      それを読んで default.yaml と setup-notes.md を直してください。

  # dctl はこのステップを走らせるシェルの PATH から探す。
  - id: validate
    type: command
    run: >-
      command -v dctl >/dev/null || { echo "dctl が PATH にありません（doctrine の core で deno task install を実行してください）" >&2; exit 1; };
      dctl workflow-check .doctrine-out/default.yaml &&
      { test -z "$(git status --porcelain)" || { echo "worktree の .doctrine-out/ の外が書き換えられています:" >&2; git status --porcelain >&2; exit 1; }; }
    onFailure:
      goto: draft
      maxAttempts: 3
      feed: "{{ steps.validate.last_stderr }}"

  - id: review
    type: approval
    title: "作ったワークフローを確認してください"
    onReject:
      goto: draft
      maxAttempts: 5
      feed: |
        人のレビューで却下された:
        {{ steps.review.last_stdout }}
    review:
      files:
        - .doctrine-out/default.yaml
        - .doctrine-out/setup-notes.md

  # 元のリポジトリに書く。何度走らせても同じ結果になる。
  - id: apply
    type: command
    run: "mkdir -p '{{ project.path }}/.doctrine/workflows' && cp .doctrine-out/default.yaml '{{ project.path }}/.doctrine/workflows/default.yaml'"
`;
}

/**
 * 方針を draft のエージェントが読む文章にする。タスクの prompt になる。
 * 雛形とステップの例もここに入れる（setupWorkflowYaml の説明を参照）。
 */
export function setupPrompt(policy: SetupPolicy, baseBranch: string): string {
  const openPr = policy.pr === "open_and_wait";
  const planApproval = policy.plan && policy.approval === "after_plan_and_implement";
  const lines = [
    "## 方針",
    "",
    policy.plan
      ? "- 計画を入れる。雛形の plan → plan-review → plan-gate をそのまま使う。"
      : "- 計画を入れない。plan・plan-review・plan-gate を削り、implement のプロンプトから plan.md を読む指示を外す。",
    policy.agentReview
      ? "- エージェントのコードレビューを入れる。雛形の agent-review → review-gate をそのまま使う。"
      : "- エージェントのコードレビューを入れない。agent-review・review-gate を削る。",
    policy.guide
      ? "- 変更のガイドを入れる。雛形の guide をそのまま使う。"
      : "- 変更のガイドを入れない。guide を削る。",
    planApproval
      ? "- 人の承認は計画の後と実装の後の2回。plan-gate の後に approval のステップ（review.files に .doctrine-out/plan.md）を足し、却下なら plan へ戻す。実装の後は雛形の review を使う。"
      : policy.plan || policy.approval === "after_implement"
      ? "- 人の承認は実装の後だけ。雛形の review を使う。"
      : "- 人の承認は計画の後と実装の後の方針だが、計画を入れないので実装の後だけにする。雛形の review を使う。",
    openPr
      ? `- 人が承認したら PR を開き（--base ${baseBranch}）、マージされるまで待つ。下のステップの例を review の後ろに足す。`
      : "- PR を開かない。承認で終わり、変更はブランチに積んだままにする。open-pr・wait-merge・sync は足さない。",
    ...(openPr
      ? [
        policy.sync
          ? `- PR を開く前に ${baseBranch} を取り込む（sync → verify-sync）。マージを待つ間に ${baseBranch} と conflict したときも sync へ戻って取り込み直す。`
          : `- ${baseBranch} の取り込みはしない。conflict は人が PR 上で解く。`,
      ]
      : []),
    "- ステップごとのモデル（model: に書く）:",
    `  - plan: ${policy.models.plan}`,
    `  - plan-review と agent-review: ${policy.models.review}`,
    `  - implement${openPr && policy.sync ? " と sync" : ""}: ${policy.models.implement}`,
    `  - guide: ${policy.models.guide}`,
    "  - 削ったステップのモデルは使わない。",
    "",
    "## 出発点の雛形",
    "",
    "dctl workspace-add が作る雛形です。テンプレート変数（{{ task.prompt }} など）は",
    "doctrine がそのワークフローの実行時に展開するので、そのまま残してください。",
    "",
    "```yaml",
    defaultWorkflowYamlFor(baseBranch) + "```",
  ];
  if (openPr) {
    lines.push(
      "",
      "## 足すステップの例",
      "",
      "doctrine 自身のワークフローから要点を写したものです。review の後ろにこの順で足します。",
      ...(policy.sync
        ? [
          "verify-sync の run は verify と同じコマンドにし、sync の allowedTools には verify で使う",
          "コマンドを足してください。",
        ]
        : []),
      "",
      "```yaml",
      prStepsExample(baseBranch, policy.sync) + "```",
    );
  }
  return lines.join("\n") + "\n";
}

function prStepsExample(base: string, sync: boolean): string {
  const syncSteps = String.raw`  - id: sync
    type: agent
    session: implementer
    permissionMode: acceptEdits
    allowedTools:
      - "Bash(git fetch:*)"
      - "Bash(git merge:*)"
      - "Bash(git status:*)"
      - "Bash(git diff:*)"
      - "Bash(git log:*)"
      - "Bash(git show:*)"
      - "Bash(git add:*)"
      - "Bash(git commit:*)"
      - "Bash(git checkout:*)"
      - "Bash(git rm:*)"
      - "Bash(grep:*)"
      - "Bash(sed -n:*)"
      - "Bash(cat:*)"
      - "Bash(ls:*)"
    prompt: |
      ${base} の最新をこのブランチに取り込んでください。

      1. git fetch origin ${base} を実行し、続けて git merge --no-edit origin/${base} を実行します。
      2. conflict が無ければ、それで終わりです。何も書かずに終えてください。
      3. conflict があれば、両側の意図を保つように解決し、検証を通してから
         git add と git commit --no-edit でマージコミットを作ってください。rebase はしないでください。
         解決したら {{ worktree.path }}/.doctrine-out/sync-notes.md に次を書きます。
         - conflict したファイル
         - それぞれをどう解決したか

      コマンドは1つずつ実行してください。&& や cd でつなぐと権限で拒否されます。

  - id: verify-sync
    type: command
    run: "true"
    onFailure:
      goto: sync
      maxAttempts: 3
      onExhausted: suspend
      feed: |
        ${base} を取り込んだ後の型検査かテストが失敗した:
        {{ steps.verify-sync.last_stdout }}
        {{ steps.verify-sync.last_stderr }}

`;
  const syncComment = sync
    ? String
      .raw` && if [ -f .doctrine-out/sync-notes.md ]; then gh pr comment --body-file .doctrine-out/sync-notes.md && rm .doctrine-out/sync-notes.md; fi`
    : "";
  const openPr = String
    .raw`  # 人の承認が済んだものだけを PR にする。command ステップはクラッシュ復帰のたびに
  # 頭から再実行されるので、既に PR があれば作らない形にしてある。
  # 本文は implement-notes.md。Intake から投入されたタスクなら {{ issue.closes }} の行を足す。
  - id: open-pr
    type: command
    run: "git push -u origin HEAD && { gh pr view --json url --jq .url || { cat .doctrine-out/implement-notes.md; if [ -n '{{ issue.closes }}' ]; then printf '\\n%s\\n' '{{ issue.closes }}'; fi; } | gh pr create --base ${base} --title \"{{ task.title }}\" --body-file -; }${syncComment}"

`;
  const waitMerge = sync
    ? String.raw`  # 終了コードは、マージされたら 0、まだなら 75、閉じられたら 2。
  # gh の出力は一度変数で受け、gh 自身の失敗を exit 1 として onFailure に届ける。
  - id: wait-merge
    type: poll
    interval: 1m
    run: |
      out=$(gh pr view --json state,mergeable --jq '.state + " " + .mergeable') || {
        echo "gh pr view に失敗しました"
        exit 1
      }
      set -- $out
      case "$1 $2" in
        "MERGED "*) exit 0 ;;
        "CLOSED "*) echo "PR がマージされずに閉じられました"; exit 2 ;;
        *" CONFLICTING") echo "${base} と conflict しています"; exit 1 ;;
        *) exit 75 ;;
      esac
    onFailure:
      goto: sync
      maxAttempts: 10
      onExhausted: suspend
      feed: |
        wait-merge が非0で終わりました。下の出力を読んでください。
        conflict なら ${base} を取り込み直して解決してください。
        conflict でない（gh の失敗など）なら、何もせずそのまま終えてください:
        {{ steps.wait-merge.last_stdout }}
`
    : String.raw`  # 終了コードは、マージされたら 0、まだなら 75、閉じられたら 2。
  # conflict は人が PR 上で解くので、まだとして待つ。
  # gh の出力は一度変数で受け、gh 自身の失敗を exit 1 として onFailure に届ける。
  - id: wait-merge
    type: poll
    interval: 1m
    run: |
      out=$(gh pr view --json state --jq .state) || {
        echo "gh pr view に失敗しました"
        exit 1
      }
      case "$out" in
        MERGED) exit 0 ;;
        CLOSED) echo "PR がマージされずに閉じられました"; exit 2 ;;
        *) exit 75 ;;
      esac
    onFailure:
      goto: wait-merge
      maxAttempts: 3
      onExhausted: suspend
`;
  return (sync ? syncSteps : "") + openPr + waitMerge;
}
