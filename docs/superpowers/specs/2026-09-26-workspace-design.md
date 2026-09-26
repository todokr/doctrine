# doctrine 複数リポジトリを 1 つの workspace として扱う設計

- 日付: 2026-09-26
- 状態: 設計合意
- 前提: [Intake のコア設計](2026-09-21-intake-core-design.md)、[PFD によるタスク分解](2026-09-20-pfd-decomposition-design.md)、[ディレクトリ構成](2026-09-19-directory-layout-design.md)

## 1. 何が足りないか

doctrine はプロジェクト（git リポジトリ 1 つ）を単位に動く。Issue はそのリポジトリのトラッカーから取り、
Intake はそのリポジトリだけを読んで分解し、タスクもそのリポジトリにだけ作る。

しかし 1 つの Issue が複数のリポジトリにまたがることは多い。たとえば「新しい DB を足す」は
assured-terraform でインフラを作り、assured-tp でコードを変え、assured-kubernetes でデプロイ定義を変える。
いまはこれを 3 つの Issue に人が分けて、それぞれのリポジトリで Intake するしかない。
分け方と順番を決めることこそ Intake に任せたい仕事なのに、そこが人に残っている。

**workspace は 1〜N 個のプロジェクトを束ねる単位である。Issue の取り込みと Intake の分解は workspace で行い、
タスクは分解の各プロセスが指すプロジェクトに作る。**

リポジトリが 1 つだけのときも「プロジェクトが 1 つの workspace」として扱い、workspace の無いプロジェクトは作らない。
トラッカーの置き場所を 1 か所に保つためである。

## 2. 決定の要約

| 項目 | 決定 | 章 |
| --- | --- | --- |
| 単位 | workspace は常にある。プロジェクトはちょうど 1 つの workspace に属する | 3, 4 |
| workspace の設定 | workspace のルートに `.doctrine/workspace.yaml`。name・projects・tracker を持つ | 3 |
| プロジェクトの設定 | `.doctrine/project.yaml` から `tracker` を外す。残りは変えない | 3 |
| プロジェクトの名前 | `workspace.yaml` の `projects` のキー。PFD のプロセスが指す名前になる | 3 |
| Linear | workspace ごとに team を 1 つ（いまと同じ） | 3 |
| 登録 | `dctl workspace-add` / `workspace-update` が `project-add` / `project-update` を置き換える | 4 |
| Intake の所属 | `intakes.project_id` を `workspace_id` に置き換える | 4 |
| Intake の調査 | プロジェクトごとに detached worktree を作り、その親ディレクトリを cwd にする | 5 |
| PFD | プロセスに `project` を足す。agent のプロセスは必須、human は任意 | 6 |
| 投入 | タスクは `process.project` のプロジェクトに作る | 7 |
| GitHub の Issue 一覧 | 全プロジェクトのリポジトリの Issue を合わせる | 8 |
| GitHub の sub-issue | プロセスのプロジェクトのリポジトリに作る。project の無い human のプロセスは親 Issue のリポジトリ | 8 |

## 3. 設定ファイル

設定は持ち主ごとに 4 か所に分かれる。

| ファイル | 持ち主 | 中身 |
| --- | --- | --- |
| `<repo>/.doctrine/project.yaml` | リポジトリ（コミットする） | setup・defaultWorkflow・maxConcurrent・baseBranch |
| `<repo>/.doctrine/workflows/*.yaml` | リポジトリ（コミットする） | いまと同じ |
| `<root>/.doctrine/workspace.yaml` | workspace | name・projects・tracker |
| `<stateRoot>/config.json` | マシン | globalLimit・linearApiKey（いまと同じ） |

プロジェクトの設定はリポジトリの中身に縛られる（setup のコマンドもワークフローもそのリポジトリでしか意味を持たない）ので、
リポジトリにコミットしたまま残す。どのリポジトリを束ねるか・Issue をどこから取るかは、どの 1 つのリポジトリにも属さないので
workspace に置く。API キーのようにマシンに属するものは `config.json` のままにする。

```yaml
# ~/work/tp/.doctrine/workspace.yaml
name: tp
projects:
  terraform:  assured-terraform
  tp:         assured-tp
  kubernetes: assured-kubernetes
tracker:
  kind: github
```

```yaml
tracker:
  kind: linear
  team: ENG
  states: { todo: Todo, inProgress: In Progress, inReview: In Review }
```

- **root** は `workspace.yaml` の置かれた `.doctrine/` の親ディレクトリ。`~/work/tp` のように git 管理の外のディレクトリでよい。
- **projects** のキーはプロジェクトの名前で、`[a-z0-9-]+`。値は root からの相対パスで、git リポジトリのルートを指す。
  `../` で root の外を指してもよい。
- **tracker** の形は、いまの `project.yaml` の `tracker` と同じ。省略すると `{ kind: github }`。
- **name** は画面に出す名前。省略すると root のディレクトリ名。

リポジトリが 1 つだけなら、そのリポジトリ自体を root にして `projects: { doctrine: . }` と書く。
`workspace.yaml` は `project.yaml` の隣に置かれ、リポジトリと一緒にコミットされる。

## 4. 登録と DB

### 4.1 登録

`dctl workspace-add --path <root>` は、`<root>/.doctrine/workspace.yaml` が無ければ雛形を書き、
各プロジェクトに `.doctrine/project.yaml` が無ければ雛形を書き（いまの `project-add` と同じ内容から `tracker` を除いたもの）、
workspace とプロジェクトを DB に登録する。

`dctl workspace-update --path <root>` は `workspace.yaml` と各 `project.yaml` を読み直して DB を合わせる。
`projects` に足されたプロジェクトは登録し、消されたプロジェクトは登録を外す。
登録を外すプロジェクトに `queued`・`running`・`suspended`・`paused`・`rate_limited`・`waiting` のタスクが残っていれば、
何も変えずに投げる。

`project-add` / `project-update` は消す。プロジェクト単位の設定の保存（`project.config.save`）は残る。

読むときに確かめること（どれかに反すれば登録も更新もせずに投げる）:

- プロジェクトの名前が `[a-z0-9-]+` で、workspace の中で重なっていない
- パスが git リポジトリのルートである
- そのリポジトリがほかの workspace に登録されていない。ただし、ほかの workspace がそのリポジトリ 1 つだけでできていて、
  終わっていない Intake（`completed`・`canceled` 以外）を持たなければ、その workspace を吸収する。
  プロジェクトと終わった Intake を新しい workspace に付け替え、空になった workspace の行を消す。
  マイグレーション（4.2）が既存のプロジェクトを 1 つずつの workspace にするので、この例外が無いと
  `~/work/tp` のように既存のリポジトリを束ね直せない

### 4.2 DB

- `workspaces(id, path UNIQUE, name)` を足す。`path` は root の実パス。
- `projects` に `workspace_id NOT NULL REFERENCES workspaces` と `name` を足し、`(workspace_id, name)` を UNIQUE にする。
  `path` はいまも UNIQUE で、これが「ちょうど 1 つの workspace に属する」を守る。
- `intakes.project_id` を `workspace_id NOT NULL REFERENCES workspaces` に置き換える。
- `tasks.project_id` は変えない。

マイグレーションは既存のプロジェクトを 1 つずつ「そのリポジトリを root とするプロジェクト 1 つの workspace」に移す。
プロジェクトの名前はリポジトリのディレクトリ名から `[a-z0-9-]+` に丸めて作る。Intake は元のプロジェクトの workspace に付け替える。
移したあとの workspace には `workspace.yaml` がまだ無いので、トラッカーは 8.3 の `workspace_config_missing` になる。
doctrine 自身のリポジトリには、この変更と同じコミットで `.doctrine/workspace.yaml` を足す。

## 5. Intake の調査

Intake のエージェントは workspace のすべてのプロジェクトを読める必要がある。プロジェクトごとに detached worktree を作り、
それらを並べた親ディレクトリを cwd にする。

```
stateDir()/worktrees/intake-<intakeId>/     ← エージェントの cwd（git リポジトリではない）
  terraform/      ← assured-terraform の detached worktree（そのプロジェクトの baseBranch）
  tp/
  kubernetes/
```

- ディレクトリ名をプロジェクトの名前と同じにする。エージェントが読むパスと PFD に書く `project` がそのまま対応する。
- 置き場を `stateDir()/worktrees` の下にするのは、worktree の削除が置き場の配下かどうかを確かめている（`isUnderWorktreesDir`）から。
- `intakes.worktree_path` は親ディレクトリを持つ。各実行の最初に、`workspace.yaml` のプロジェクトのうち worktree がまだ無いものを作り足す。
  登録を外されたプロジェクトの worktree は Intake が終わるまで残す。
- 改訂の最初の会話で baseBranch に戻す処理（`checkoutDetached`）、書き換えの検出と巻き戻し（`changedPaths` / `restoreWorktree`）は、
  すべての worktree に対して行う。どれか 1 つでも書き換えられていれば、いまと同じく `wrote_repository` で `needs_attention` にする。
  `paths` は `<プロジェクト名>/<パス>` で持つ。
- Intake が終わったときの worktree の片付けは、親ディレクトリごと、各 worktree を `git worktree remove` してから消す。
- worktree の一覧（`worktreeEntries`）と削除の対象の引き当ては、いまと同じくプロジェクトごとの `git worktree list` から始める。
  Intake との対応は「`intake.worktree_path` と一致する」から「親ディレクトリが `intake.worktree_path` と一致する」に変える。
  Intake はプロジェクトではなく workspace から引く（`listIntakes({ workspaceId })`）。

最初のプロンプトには、プロジェクトの一覧（名前・ディレクトリ・baseBranch・GitHub ならリポジトリの `owner/name`）を載せる。

**git の許可はプロジェクトごとに作る。** cwd が git リポジトリでないと、`Bash(git log:*)` の許可では
`git -C tp log`・`cd tp && git log` のどちらも拒否される（2026-09-26 に `claude -p --permission-prompts none` で実測。
cwd を git リポジトリにすると同じ許可で通る）。一方 `Bash(git -C tp log:*)` と書けば `git -C tp log` は通る。
そこで Intake の `allowedTools` は、`READ_ONLY_TOOLS` の git の許可（`git status`・`git diff`・`git log`・`git show`）を
プロジェクトの名前ごとに `Bash(git -C <名前> log:*)` の形へ展開して作り、プロンプトでは git を `git -C <名前>` で呼ぶよう指示する。
`Bash(git -C:*)` は書き込みの git も通してしまうので使わない。git 以外の読み取りの許可（`grep`・`cat` など）はそのまま使う。

## 6. PFD の `project`

プロセスに `project` を足す。

```ts
const processSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  actor: z.enum(["agent", "human"]),
  project: z.string().min(1).optional(),
  // ...
});
```

- `actor: agent` のプロセスは `project` が必須。無ければ規則の検証（core の `validatePfd`）で落とし、いまの検証落ちと同じく
  理由をエージェントに返して直させる。
- `project` は workspace のプロジェクトの名前でなければならない。これも `validatePfd` が確かめる。
  プロジェクトの一覧は、回答や改訂の固定集合と同じく外から渡す。
- `actor: human` のプロセスは任意。`terraform apply` のようにリポジトリに結びつく作業には書き、決めるだけのプロセスには書かない。

プロジェクトをまたぐ順番は、いまの入出力の仕組みで守られる。下流のプロセスは上流の出力が揃ったとき（上流のタスクが
`merged`、または人のプロセスが `done`）にだけ着手できるので、terraform → tp → kubernetes の順は PFD の辺がそのまま表す。
下流のタスクは自分のリポジトリの baseBranch から始まるので、上流の変更の中身はタスクの prompt に載る上流の sub-issue の URL と
成果物の説明から知る。

画面の PFD の図では、プロセスにプロジェクトの名前を出す。

## 7. 投入

`dispatchIntake` / `redispatchProcess` は、タスクを `process.project` の名前の、その workspace のプロジェクトに作る
（いまは `project_id: intake.project_id`）。ワークフロー・ブランチ・worktree・プロジェクト枠は、いまと同じくそのプロジェクトのものを使う。

投入のときに `process.project` のプロジェクトが workspace に無ければ（承認のあとに `workspace-update` で外された）、
そのプロセスだけ `DispatchReport.errors` に入れて見送る。

## 8. トラッカー

### 8.1 引き方

`TrackerOf` の引数をプロジェクトのパスから workspace に変え、`workspace.yaml` の `tracker` から作る。
`workspace.yaml` を書き換えたらデーモンの再起動なしで効くよう、いまと同じく呼ぶたびに読む。

`Tracker` の各メソッドが受ける `projectPath` は残す。GitHub ではこれがどのリポジトリで `gh` を実行するかを決める。

| 呼び出し | 渡すプロジェクト |
| --- | --- |
| `status` / `listIssues` | workspace のすべてのプロジェクト（GitHub は 1 つずつ呼んで合わせる。Linear は 1 回） |
| `readIssue` / `findSubIssues` / `updateIssue` / `closeIssue` / `advanceIssue` | GitHub は Issue の URL の `owner/name` に一致するプロジェクト。Linear はどれでもよい（team で引く） |
| `createSubIssue` | プロセスの `project` のプロジェクト。`project` の無いプロセスは親 Issue のリポジトリのプロジェクト |

### 8.2 GitHub

- Issue の一覧は、全プロジェクトのリポジトリの Issue を合わせて `updatedAt` の新しい順に並べる。
  一部のリポジトリで `gh` が失敗しても、取れたリポジトリの分だけを返す。失敗したリポジトリは `tracker.status` の
  `target` にそのリポジトリの失敗として出る。すべて失敗したときだけ一覧も失敗にする。
- `intake.start` は、Issue の URL の `owner/name` が workspace のどのプロジェクトのリポジトリとも一致しなければ断る。
  sub-issue もすべてプロジェクトのリポジトリに作るので、Intake が触る GitHub の Issue は必ずどれかのプロジェクトに対応する。
  `IssueSummary.identifier` は、プロジェクトが 2 つ以上なら `tp#112` のようにプロジェクトの名前を付ける。
- sub-issue はプロセスのプロジェクトのリポジトリに作り、親 Issue に付ける。GitHub はリポジトリをまたいだ sub-issue を、
  同じ organization の中でだけ、両方のリポジトリに triage 以上の権限があるときに許す。
  作れなければ、いまの sub-issue 同期の失敗（`failures` の `op: "create"`）として記録する。

### 8.3 状態

`tracker.status` の `target` を配列にする。GitHub はリポジトリごとの成否を並べ、Linear は team を 1 つ並べる。
`workspace.yaml` が無い・読めないときは `{ ok: false, reason: "workspace_config_missing" }` を返し、画面は置き場所を案内する。

## 9. RPC と画面

- `tracker.status` / `tracker.issues` / `tracker.issue` / `intake.start` / `intake.list` は `{ project }` の代わりに `{ workspace }`（root のパス）を受ける。
- `IntakeSummary` / `IntakeDetail` の `project_id` を `workspace_id` にする。
- `workspace.list` / `workspace.add` / `workspace.update` を足す。`workspace.list` は各 workspace のプロジェクトも返す。
- Issue を選ぶ画面（`IssuePicker`）と Intake のサイドバーのプロジェクト選択を workspace 選択にする。トラッカーのキャッシュのキーも workspace にする。
- タスク・ワークフロー・プロジェクト設定の画面はいまと同じくプロジェクト単位のまま。

## 10. テスト

- `workspace.yaml` の読み取りと検証（名前の形・重なり・git ルートでないパス・ほかの workspace との重なり）。
- マイグレーション: 既存のプロジェクトと Intake が 1 プロジェクトの workspace に移ること（`migrate.test.ts` の列集合の突き合わせも含む）。
- `validatePfd`: agent のプロセスの `project` の欠落と、workspace に無い名前を落とすこと。human のプロセスは `project` 無しで通ること。
- Intake の実行: 複数の worktree が作られ、どれか 1 つの書き換えで `wrote_repository` になり、すべてが巻き戻ること。
- Intake の `allowedTools`: プロジェクトごとに `Bash(git -C <名前> log:*)` などが並び、素の `Bash(git log:*)` を含まないこと。
- 投入: プロセスごとに別のプロジェクトへタスクができること。外されたプロジェクトのプロセスが `errors` に入ること。
- GitHub トラッカー: 複数リポジトリの一覧の合わせ方と、sub-issue がプロセスのプロジェクトのリポジトリに作られること（`test/helpers/gh.ts` の偽物で）。
- 1 プロジェクトの workspace で、いまの Intake の結合テストがそのまま通ること。

## 11. 範囲の外

- `pfd/` の単体 CLI（`pfd-decompose` スキル）はプロジェクト単位のまま変えない。
- workspace をまたいだ Issue の取り込み、Linear の複数 team。
- プロジェクトが複数の workspace に属すること。

## 12. 置き換える記述

- [Intake のコア設計](2026-09-21-intake-core-design.md) の「Intake はプロジェクトに属する」「worktree は 1 つ」「トラッカーは project.yaml から引く」という記述は、4・5・8 章が置き換える。
- `docs/overview.md` と `README.md` のプロジェクト登録（`project-add`）の説明は、`workspace-add` に書き換える。
