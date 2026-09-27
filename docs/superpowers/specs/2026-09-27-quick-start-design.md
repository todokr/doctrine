# doctrine の Quick Start: 初回ウィザードとワークフローを作るタスク

- 日付: 2026-09-27
- 状態: 設計合意
- 前提: [workspace の設計](2026-09-26-workspace-design.md)（stage1 の Task 3 まで。`workspace.add` / `workspace.update` / `workspace.list`）

## 1. 何が足りないか

doctrine を使い始めるには、workspace を登録し、プロジェクトごとの `.doctrine/workflows/default.yaml` をそのリポジトリに合わせて直す必要がある。
いまの入口は `dctl workspace-add` だけで、アプリには登録の手段が無い。登録すると雛形の default.yaml が置かれるが、
雛形は検証コマンドが `"true"` で、PR も開かない一般形なので、利用者が `writing-workflows` を読んで YAML を書き換えるまで実用にならない。
Quick Start のページも「準備中」のままである。

**アプリの初回起動で開くウィザードで workspace を登録し、ワークフローの方針を聞き、
各プロジェクトの default.yaml を doctrine のタスクとして作らせる。**
利用者は YAML を書かずに、自分のリポジトリに合ったワークフローを手に入れる。そのタスクは
エージェント → 機械的な検証 → 差し戻し → 人の承認、という doctrine の流れそのもので進むので、最初の 1 回が使い方の実演にもなる。

## 2. 決定の要約

| 項目 | 決定 | 章 |
| --- | --- | --- |
| 入口 | `workspace.list` が空ならアプリ起動時にウィザードを出す。以降はサイドバーの「workspace を追加」から | 4 |
| 登録 | ウィザードがプロジェクト構成とトラッカーを決め、`workspace.add` に渡す | 4 |
| 方針の聞き取り | workspace 共通の 7 問をウィザードのフォームで聞く。エージェントは使わない | 4.5 |
| 生成 | 対象プロジェクトごとに setup のタスクを 1 つ作る。ワークフローは doctrine に同梱し、タスクに直接 pin する | 5 |
| setup の対象 | `workspace.add` が今回 default.yaml の雛形を作ったプロジェクトだけ | 4.6 |
| 反映 | 承認の後、元リポジトリの `.doctrine/workflows/default.yaml` を未コミットで上書きする | 5.2 |
| 検証 | `dctl workflow-check <file>` を足し、`parseWorkflow` で確かめる | 5.3 |
| Intake | 触らない | 3 |

## 3. 採らなかった案

**setup を Intake で行う。** Issue の無い Intake（`intakes.kind = setup`）を作り、設計質問で方針を聞き、PFD でプロジェクトごとのプロセスに割る案。
書き出すと、Issue が無いこと、トラッカー連携（Linear の状態の進行、sub-issue、PR の観測、親 Issue の close）を飛ばすこと、
「質問に推奨を書かない」規則を仮定で迂回すること、PFD の形を外から固定すること、完了条件を別に作ること、がすべて setup のための特別扱いになる。
論点も分解の形も最初から決まっていて、Intake の持ち味（Issue を読んで論点を洗い出す、分け方を考える、sub-issue と PR で追う）を 1 つも使わない。

**セットアップ用の Issue をトラッカーに作り、普段どおり Intake する。** Intake の特別扱いは無くなり、
利用者が最初に毎日の流れ（Issue → Intake → タスク → PR）を一周できる。しかし、gh の認証か Linear の API キーが無いと最初の一歩が踏めない。
Intake の完了は PR のマージなので、雛形に open-pr を足すか利用者に PR を作らせる必要があり、反映も PR のマージになる。
チームで共有するトラッカーに Issue と sub-issue が作られる。Quick Start には「前提を最小にして、すぐ動く設定を手に入れる」ことを優先し、採らない。

## 4. 初回ウィザード

```
[ようこそ] → [ディレクトリ] → [プロジェクト構成] → [トラッカー] → [ワークフローの方針] → [確認] → タスク一覧へ
```

### 4.1 表示のきっかけ

アプリの起動時に `workspace.list` が空なら、ウィザードを全画面で出す。
workspace が 1 つ以上あれば出さず、サイドバーの「workspace を追加」から同じウィザードを開く。

### 4.2 ディレクトリ

Tauri のディレクトリ選択ダイアログで選ばせ、`workspace.detect` を呼ぶ。

```ts
"workspace.detect": {
  params: { path: string };
  result: {
    /** path が git リポジトリのルートか */
    isRepoRoot: boolean;
    /** path 直下（深さ 1）の git リポジトリのルート。isRepoRoot のときは空 */
    repositories: { dir: string; suggestedName: string }[];
    /** <path>/.doctrine/workspace.yaml があれば、parseWorkspaceConfig で読んだもの */
    existing: WorkspaceConfig | null;
    /** 既に登録済みの workspace なら true */
    alreadyRegistered: boolean;
  };
};
```

- `suggestedName` は `projectNameFrom` で丸めたディレクトリ名。
- `existing` があって読めなければ、エラーをそのまま画面に出して先へ進ませない。
- `alreadyRegistered` なら、その旨を出して先へ進ませない。
- path が git リポジトリのサブディレクトリなら、`ensureWorkspaceScaffold` と同じ文言で断る。

### 4.3 プロジェクト構成

- `existing` があるとき: 中身を表示するだけで編集させない。
- `isRepoRoot` のとき: そのリポジトリ 1 つ（`projects: { <suggestedName>: . }`）で確定し、確認だけ見せる。
- それ以外: `repositories` をチェックボックスで選ばせる。名前は `suggestedName` を初期値にして編集できる。
  名前が `[a-z0-9-]+` に合わない、重なる、1 つも選ばれていない、のいずれかなら先へ進ませない。
  直下にリポジトリが無ければ、その旨を出してディレクトリの選び直しに戻す。

### 4.4 トラッカー

github か linear を選ばせる。linear なら team と states を入力させる。API キーはウィザードでは扱わない（アプリに入力の画面は無く、config.json に書いて dctld を起動し直す）。linear を選んだときは、その手順（`trackerGuidance` と同じ文言）を画面に出す。setup のタスクはトラッカーを使わないので、キーが無くても Quick Start は最後まで進む。
`existing` があるときはこの画面を飛ばす。

### 4.5 ワークフローの方針

workspace 共通の方針を固定の 7 問で聞く。既定値は doctrine 自身の `.doctrine/workflows/default.yaml` に合わせる。

| 問 | 選択肢 | 既定 |
| --- | --- | --- |
| 計画と計画審査 | 入れる / 入れない | 入れる |
| AI によるコードレビュー | 入れる / 入れない | 入れる |
| レビューガイド | 入れる / 入れない | 入れる |
| 人の承認の位置 | 実装の後だけ / 計画の後にも | 実装の後だけ |
| PR とマージ待ち | PR を開いてマージを待つ / ブランチで止める | PR を開いてマージを待つ |
| base branch への追従 | PR の前に取り込む / 取り込まない | PR の前に取り込む |
| モデル | 役割（計画・実装・審査・ガイド）ごとに選ぶ | すべて claude-opus-5-5 |

base branch への追従は、PR を開く方針のときだけ聞く。

プロジェクトごとに違う事実（検証コマンド、許可するコマンド、baseBranch）はここでは聞かない。setup のタスクがリポジトリから決め、人が承認の画面で確かめる（5.1）。

```ts
type SetupPolicy = {
  plan: boolean;
  agentReview: boolean;
  guide: boolean;
  approval: "after_implement" | "after_plan_and_implement";
  pr: "open_and_wait" | "branch_only";
  sync: boolean; // pr が branch_only なら false
  models: { plan: string; implement: string; review: string; guide: string };
};
```

### 4.6 確認

登録するプロジェクト、トラッカー、方針と、setup の対象の決まり方（今回 `.doctrine/` の雛形を作るプロジェクトだけ）を並べて見せ、確定で次を順に呼ぶ。対象の名前は 1 の結果で初めて決まるので、確認画面では並べない。

1. `workspace.add { path, projects?, tracker? }`。`projects` と `tracker` は workspace.yaml が無いときだけ渡す（4.7）。
2. `workspace.setup { workspace, projects, policy }`（5 章）。`projects` は setup の対象。

**setup の対象**は、1 の結果の `created` に `<project>/.doctrine/workflows/default.yaml` が入っているプロジェクトに限る。
既に `.doctrine/` があるプロジェクトのワークフローは利用者が書いたものなので、上書きの候補にしない。
対象が 1 つも無ければ 2 を呼ばず、「ワークフローは既存のものを使う」と出してウィザードを閉じる。

1 が失敗したら、エラーを出して確認画面に留まる。1 が通って 2 が失敗したら、workspace は登録済みなので、
エラーと「タスク画面から手でワークフローを直す」旨を、閉じるまで消えない画面で出す。閉じるとタスク一覧に移る。

2 が通ったらタスク一覧に移り、作った setup のタスクを選んだ状態にする。

### 4.7 `workspace.add` の拡張

```ts
"workspace.add": {
  params: {
    path: string;
    /** workspace.yaml が無いときに書く projects。キーは名前、値は root からの相対パス */
    projects?: Record<string, string>;
    tracker?: TrackerConfig;
  };
  result: WorkspaceSummary & { created: string[]; alreadyRegistered: boolean };
};
```

- workspace.yaml が無く、`projects` が渡されたら、`projects` と `tracker` を書く。`workspaceYamlFor` はいま projects しか受け取らないので、tracker を任意の引数として足す。
  root が git リポジトリでなくても書ける（いまは git 管理外の root で workspace.yaml が無いと投げる）。
- workspace.yaml が無く、`projects` が無ければ、いまの `ensureWorkspaceScaffold` のとおり。
- workspace.yaml があれば、`projects` と `tracker` は使わない。既存のファイルは上書きしない。
- `dctl workspace-add` は `projects` を渡さない。CLI の挙動は変わらない。

## 5. setup のタスクと同梱ワークフロー

### 5.1 `workspace.setup`

```ts
"workspace.setup": {
  params: { workspace: number; projects: string[]; policy: SetupPolicy };
  result: TaskSummary[];
};
```

対象プロジェクトごとにタスクを 1 つ作る。

- タイトル: `<プロジェクト名> のワークフローを作る`
- `prompt`: `policy` を文章にしたものに、出発点の雛形 `defaultWorkflowYamlFor(project.base_branch)` と、PR を開く方針なら open-pr / wait-merge / sync の例を続けたもの（`setupPrompt(policy, baseBranch)`）。draft のエージェントが `{{ task.prompt }}` で読む。雛形や例をワークフローの prompt に直接書かないのは、ステップの prompt が `expand` を通り、`{{ }}` を字面のまま残す手段が無いため（`task.prompt` に入れた値は再展開されない）。
- `workflow_name`: `setup`
- `workflow_yaml`: 同梱ワークフローの本文（`setupWorkflowYaml()`）
- `workflow_setup`: NULL。`project.yaml` の setup（依存のインストールなど）は、YAML を書くだけのこのタスクには要らない。

`projects` に workspace に属さない名前があれば、何も作らずに投げる。

### 5.2 同梱ワークフロー

`core/src/workflow/setupWorkflow.ts` に、`scaffold.ts` の雛形と同じくコードの中の文字列として持つ。
利用者のリポジトリには置かない。doctrine の更新で中身を直せるようにするためである。

```
draft → validate → review → apply
```

| ステップ | 種類 | 中身 |
| --- | --- | --- |
| `draft` | agent | リポジトリを調べ、`{{ task.prompt }}` の方針に沿って `.doctrine-out/default.yaml` を書く |
| `validate` | command | `dctl workflow-check .doctrine-out/default.yaml` と、`git status --porcelain` が空であること（draft が `.doctrine-out/` の外を書き換えていない）。落ちたら draft へ（最大 3 回、feed は `{{ steps.validate.last_stderr }}`） |
| `review` | approval | `review.files: [.doctrine-out/default.yaml, .doctrine-out/setup-notes.md]`。却下で draft へ（最大 5 回） |
| `apply` | command | `mkdir -p '{{ project.path }}/.doctrine/workflows' && cp .doctrine-out/default.yaml '{{ project.path }}/.doctrine/workflows/default.yaml'` |

**draft** への指示:

- 出発点は `{{ task.prompt }}` に入っている雛形。方針に合わせて、雛形のステップを削る・足す。
  PR を開く方針なら、雛形のコメントにある open-pr の例と、doctrine 自身の `wait-merge` / `sync` の形を足す。
- 検証コマンド（verify の `run`）、implement の `allowedTools`、baseBranch は、リポジトリ（package.json・mise.toml・Makefile・CI の設定など）から決める。
- 方針とリポジトリが食い違えば（例: remote が無いのに PR を開く方針）、`.doctrine-out/setup-notes.md` に書き、方針よりリポジトリで動く形を選ぶ。
  決めたこと（検証コマンドを何にしたか、その根拠）も同じファイルに書く。承認の画面で人が読む。
- 差し戻されたら、feed（検証のエラーか、人の却下コメント）を読んで直す。
- `permissionMode: acceptEdits`。`allowedTools` は読み取り系（`READ_ONLY_TOOLS`）に限る。worktree の中で `.doctrine-out/` 以外を書き換えない。

**apply** は再実行しても同じ結果になる。

`.doctrine-out/` は `.git/info/exclude` に入っているので、worktree には変更が残らない。
タスクが completed になると、いまの `cleanupAfterRun` が worktree を消す。元のリポジトリには未コミットの default.yaml だけが残る。

### 5.3 `dctl workflow-check <file>`

デーモンを介さず、ファイルを読んで `parseWorkflow` に通す。

- 通れば終了コード 0。警告（非冪等なコマンドなど）は stderr に出す。
- 落ちれば終了コード 1 で、エラーを stderr に出す。draft へ戻す feed になる。
- ファイルが無ければ終了コード 1。

### 5.4 終わった後の案内

setup のタスク（`workflow_name = setup`）が completed になったら、タスク画面に次を出す。

> `.doctrine/workflows/default.yaml` を書き換えました（未コミット）。コミットしてから、Issue を取り込むかタスクを作ってください。

failed になったときは、いまのタスクと同じく worktree が残る。承認の画面に出ていた `.doctrine-out/default.yaml` を手で直して置くか、タスクを作り直す。

## 6. ドキュメント

- `site/src/content/docs/ja/quick-start/index.md`: ウィザードの手順から、最初の setup のタスクの承認とコミットまでを書く。
- `site/src/content/docs/ja/guide/writing-workflows.mdx`: 冒頭の前提を「Quick Start で作った default.yaml を直す」に変える。
- `docs/overview.md` 4.1（利用の流れ）: 最初に初回ウィザードを足す。
- `dctl workflow-check`: dctl のヘルプと `docs/developer-guide/` に載せる。

## 7. テスト

**core**

- `workspace.detect`: git のルート、直下にリポジトリがある、既存の workspace.yaml がある（読める・読めない）、登録済み、サブディレクトリ。
- `workspace.add` の `projects` / `tracker`: workspace.yaml が無いときは書く（git 管理外の root を含む）。あるときは使わない。
- `workspace.setup`: 対象ごとにタスクができる。`workflow_yaml` が同梱の本文、`workflow_setup` が NULL。prompt が方針を反映する。workspace に属さない名前で何も作らない。
- 同梱ワークフローが `parseWorkflow` を通る。
- `workflow-check`: 通る・落ちる・ファイルが無い、それぞれの終了コードと stderr。
- 結合テスト: 偽のエージェントで draft → validate → review（承認）→ apply まで流し、元リポジトリに default.yaml が書かれ、worktree が消える。validate が落ちたら draft へ戻る。

**app**

- ウィザードの表示のきっかけ（workspace が 0 件なら出す、1 件以上なら出さない）。
- 画面の分岐: git のルート / git 管理外 / workspace.yaml が既にある（プロジェクト構成は表示だけ、トラッカーは飛ばす）。
- PR を開かない方針のとき、追従の問を出さない。
- 確認で `workspace.add` → `workspace.setup` の順に呼ぶ。setup の対象が無ければ `workspace.setup` を呼ばない。
