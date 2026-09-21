# doctrine Intake コア設計

- 日付: 2026-09-21
- 状態: 承認待ち
- issue: [#60](https://github.com/todokr/doctrine/issues/60)
- 前提: [overview](../../overview.md)、[Intake の PRD](../../prd/intake.md)、[PFD による分解](2026-09-20-pfd-decomposition-design.md)

## 1. 位置づけ

Intake の PRD は要求だけを定め、テーブル定義・RPC の形・エージェントの走らせ方を設計 spec に委ねている。
本 spec はそのうち **コア（`core/` と `shared/protocol.ts`）の分**を決める。後続の実装はすべてこの spec を前提にする。

- デーモンが受け持つのは決定論的な部分である。状態の保持、PFD の検証、入力の揃い具合の判定、タスクと sub-issue の作成。
  Issue の解釈と分解はエージェントに任せる（PRD 5.2、PFD spec 5 章の引き継ぎ）
- Intake は**タスクではない**（PRD 5.2）。`TaskState` の FSM に相乗りせず、別の状態と遷移表を持つ。
  ただし実行枠と上限待ちは通常のタスクと同じ規則に従う（D-6。7 章）
- デーモンはネットワークに触ってよい。GitHub には `gh` を介して触れる（overview 7 章、PRD 5.3）
- アプリの画面（図の描画・ビューの配置）は別の spec が決める。本 spec はアプリへ渡すデータと RPC までを決める

## 2. 決定の要約

| 項目 | 決定 | 章 |
| --- | --- | --- |
| 置き場所 | `core/src/intake/`（ドメイン）、`core/src/github/`（`gh`）、`shared/intake/`（アプリと共有する型と純関数） | 3 |
| GitHub への口 | `Tracker` と `PrWatcher` の 2 つの interface に閉じる。Issue の参照は URL で持つ | 3 |
| データ | 追記だけの表（案・質問・回答・コメント・承認）と、進行の表（`intakes`・`intake_processes`）に分ける。マイグレーションは `0009_intake` と、改訂の範囲の列を足す `0010_intake_revision` | 4 |
| 同じ Issue の Intake | 終わっていないものは 1 つだけ。部分 unique index で固める | 4 |
| 状態 | `IntakeState` 8 値と `revising` フラグ。「改訂中」は状態にしない | 5 |
| 進行中の失敗 | sub-issue や `gh` の失敗は Intake の状態を変えない。見張りのエラーとプロセスの状態で見せる | 5・10・11 |
| 人の対応が要るか | 状態から計算する関数で、列に持たない | 5 |
| PFD の正本 | `intake_drafts.pfd`（正規化した JSON）。書いたら変えない | 6 |
| 承認 | 案の id とハッシュを受け、最新の案・ハッシュ一致・レビュー待ちをトランザクションの中で確かめる | 6 |
| 決定の成果物 | `decision` を持つ成果物の中身はデーモンが回答から埋める。エージェントは書き換えられない | 6 |
| 改訂の固定 | 投入済み・完了記録済みのプロセスと、その入出力の成果物は、正規化した JSON が同じでなければならない | 6 |
| 作業ディレクトリ | Intake ごとの専用 worktree（ブランチを作らない `--detach`）。Intake の間ずっと同じパス | 7 |
| 許す道具 | 読むだけの道具。書き込み・`gh`・`dctl` は許さない。実行後に `git status` で書き換えを検出する | 7 |
| 出力の受け取り | `--json-schema` の構造化出力 1 つ（`DecomposerOutput`）。ファイルには書かせない | 7 |
| 検証落ちのやり直し | 同じ会話へ違反を返し、同じ種類の実行で検証落ちが 3 回続いたら要確認 | 7 |
| 実行枠 | 全体枠だけを取り、プロジェクト枠は取らない。タスクより先に受け付ける | 7 |
| 上限待ち | タスクと同じ判定。`rate_limited_until` の列と tick で表し、同じ会話で再開する | 7 |
| 質問の形 | 判断材料を構造化する。図は Review Guide の図を再利用し、表とコード片を足す | 8 |
| 差し戻しの文面 | 純関数 `buildFeedback` を画面とデーモンが共有する | 9 |
| sub-issue の作成 | GraphQL の `createIssue` に `parentIssueId` を渡す 1 回の呼び出し | 10 |
| sub-issue の重複防止 | 本文の目印で探して採用する。代わりの表現（タスクリスト）は持たない | 10 |
| 見張りの周期 | 120 秒。プロジェクトごとに 1 周期 1 回の GraphQL で全ブランチの PR を引く | 11 |
| マージの判定 | `state = MERGED` かつ `baseRef` が baseBranch。投入前に `origin/<baseBranch>` へ取り込む | 11 |
| 二重投入の防止 | タスクの挿入と `current_task_id` の更新を 1 トランザクションで行う | 11 |
| タスクの紐づけ | `tasks` に `intake_id` `intake_process_id` `issue_url` `parent_issue_url` を足す | 4・12 |
| ワークフロー変数 | `{{ issue.url }}` `{{ issue.parent_url }}` `{{ issue.closes }}`。Intake 由来でなければ空文字 | 12 |
| RPC とイベント | `github.*` 3 件、`intake.*` 17 件、イベント 2 件 | 13 |
| 再起動時の復旧 | 実行中だった実行を中断として閉じ、同じ会話で立て直す。投入は 1 トランザクションなので直すものが無い | 14 |

## 3. 構成

- 置き場所: `core/src/intake/`（新設）に Intake のドメイン、`core/src/github/` に `gh` の呼び出し、
  `shared/intake/` にアプリと共有する型と純関数を置く
- `pfd/src/model.ts` `validate.ts` `status.ts` `prompt.ts` は `core/src/intake/pfd/` へ移す。移植は別の作業である。
  `pfd/` の削除は PRD 13 章のとおり最後のプロセスに置く
- 依存の向き: `intake → db / domain（createTask・scheduler）/ adapter / github`。`domain/engine.ts` は Intake を知らない
- GitHub への口は interface に閉じる。テストで偽物に差し替えるためである（`pfd/src/ports.ts` と同じ考え方）。
  PRD 11 章の 4 つの操作（Issue の一覧・読み込み、sub-issue の作成、整え）と PR の見張りに限る

```ts
/** core/src/github/tracker.ts。Issue の参照は URL で持ち、番号を前提にしない（PRD 11 章）。 */
export type IssueRef = { url: string; nodeId: string };

export interface Tracker {
  status(projectPath: string): Promise<GhStatus>;
  listIssues(projectPath: string, o: { assignee: "me" | "any"; search?: string }): Promise<IssueSummary[]>;
  /** 本文とコメント。 */
  readIssue(projectPath: string, url: string): Promise<IssueDetail>;
  createSubIssue(projectPath: string, parent: IssueRef, o: { title: string; body: string }): Promise<IssueRef>;
  findSubIssues(projectPath: string, parent: IssueRef): Promise<{ ref: IssueRef; body: string; state: "OPEN" | "CLOSED" }[]>;
  updateIssue(projectPath: string, issue: IssueRef, o: { title: string; body: string }): Promise<void>;
  closeIssue(projectPath: string, issue: IssueRef, reason: "completed" | "not_planned"): Promise<void>;
}

export interface PrWatcher {
  /** head ブランチごとの PR。1 回の呼び出しで複数のブランチを引く（11 章）。 */
  pullRequests(projectPath: string, branches: string[]): Promise<Map<string, PrFact[]>>;
}

export type PrFact = {
  number: number;
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  baseRef: string;
  mergedAt: string | null;
  mergeCommit: string | null;
};
```

## 4. データモデル

マイグレーション `0009_intake` で足す。`core/src/db/schema.ts` の Kysely 型が唯一の定義という作法を守る。
マイグレーションを足すのは、開発中の手元の DB を作り直さずに済ませるためである。

| テーブル | 1 行が表すもの | 主な列 |
| --- | --- | --- |
| `intakes` | Intake 1 件 | `id`(uuid) `project_id` `issue_url` `issue_node_id` `issue_title` `state` `revising`(0/1) `attention_reason`(null 可) `dispatch_paused`(0/1) `worktree_path` `claude_session_id` `child_pid` `child_started_at` `rate_limited_until` `revision_run_id`(今の改訂の最初の `revise` 実行。改訂中でなければ null。`0010_intake_revision`) `created_at` `updated_at` `ended_at` |
| `intake_runs` | 分解エージェントの実行 1 回（`step_runs` に当たる） | `id` `intake_id` `purpose`(`investigate`/`decompose`/`revise`) `attempt` `status`(`queued`/`running`/`success`/`failed`/`rate_limited`/`interrupted`) `started_at` `ended_at` `log_path` `cost_usd` `num_turns` `duration_ms` `output`(検証を通った JSON) `issues`(検証に落ちた理由) `permission_denials` |
| `intake_question_sets` | 一度に届いた質問のまとまり（Q-2・Q-6） | `id` `intake_id` `run_id` `questions`(JSON) `answers`(JSON、回答前は null) `answered_at` |
| `intake_drafts` | PFD の案 1 回分。**書いたら変えない** | `id` `intake_id` `seq` `run_id` `pfd`(正規化した JSON 文字列) `hash` `replies`(R-7、コメントへの返答の JSON) `created_at` |
| `intake_comments` | 差し戻し・改訂のコメント 1 件（R-4） | `id` `intake_id` `draft_id`(改訂の開始時は承認済みの案) `target_kind`(`artifact`/`process`/`whole`) `target_id`(`whole` は null) `body` `run_id`(改訂の開始コメントだけが、その改訂の最初の実行を指す。それ以外は null。`0010_intake_revision`) `created_at` |
| `intake_approvals` | 承認 1 回（R-8・R-10） | `id` `intake_id` `draft_id` `hash` `approved_at` |
| `intake_processes` | 承認済みの計画にあるプロセス 1 つの進行 | `intake_id` `process_id` `sub_issue_url` `sub_issue_node_id` `sub_issue_hash`(本文を最後に揃えた内容のハッシュ) `sub_issue_closed` `current_task_id` `human_note` `human_done_at` `retired_at`(改訂で消えた)。主キーは (`intake_id`, `process_id`) |
| `pr_observations` | 見張りで見た PR の最新の事実 | `task_id`(主キー) `pr_number` `pr_url` `state` `base_ref` `merged_at` `merge_commit` `observed_at` |

- `tasks` に列を足す: `intake_id`(null 可) `intake_process_id`(null 可) `issue_url`(sub-issue の URL、null 可) `parent_issue_url`(null 可)。
  CHECK で「`intake_id` と `intake_process_id` は両方 null か両方非 null」を固める（`0006_step_run_bounced` の CHECK と同じ作法）。
  `pr_observations` を別表にするのは、Intake 由来でないタスクの行に PR の列を空で持たせないためである
- `intakes` に部分 unique index（`issue_url` について、`state NOT IN ('completed','canceled')`）を張り、
  同じ Issue の Intake が同時に 2 つ進まないことを DB で固める（S-3）。異なる Issue の Intake は何件でも同時に進められる（S-4）
- `intake_processes` の行は、**最初の承認のトランザクションで**案の全プロセス分を挿入する（`sub_issue_url` と `current_task_id` は null）。
  再承認では、増えたプロセスを挿入し、消えたプロセスに `retired_at` を入れ、残るプロセスはそのままにする。
  これが「承認 → sub-issue → 投入」（W-1）の最初の一歩になる
- 回答・コメント・案・承認はすべて行を足すだけで上書きしない。これが R-10・Q-7（経緯を後から読める）を満たす
- 「決定の記録」（Q-5）は `intake_question_sets.answers` そのものである。別表にしない

## 5. Intake の状態と遷移

```ts
export type IntakeState =
  | "investigating"   // 調査中
  | "answering"       // 回答待ち
  | "decomposing"     // 分解中
  | "reviewing"       // レビュー待ち
  | "active"          // 進行中
  | "needs_attention" // 要確認
  | "completed"       // 完了
  | "canceled";       // 中止
```

**改訂中は `revising = 1` で表す。** 改訂中の内側は `answering` / `decomposing` / `reviewing` / `needs_attention` に
`revising = 1` が付いた形である。PRD の図の「改訂中」を 1 つの状態にすると、内側の 3 状態を二重に持つことになり、
遷移表が倍になる。`revising = 1` は承認済みの計画があることも意味する。

遷移表は `core/src/domain/states.ts` の `TRANSITIONS` と同じく `Record<IntakeState, readonly IntakeState[]>` と
`assertIntakeTransition` で持つ。各辺に、引き起こす出来事と、それを書いた章を併記する。**この表にない移り方を、他の章は書かない。**

| from | to | 契機（章） |
| --- | --- | --- |
| investigating | answering | 調査の実行が質問を返した（7・8） |
| investigating | decomposing | 調査の実行が空の質問を返した（Q-4。7） |
| investigating | needs_attention | エージェントの失敗・検証落ち 3 回・書き換えの検出（7） |
| answering | decomposing | `intake.answer`（8） |
| decomposing | answering | 分解の実行が質問を返した（Q-6。7） |
| decomposing | reviewing | 検証を通った案を保存した（R-1。6・9） |
| decomposing | needs_attention | エージェントの失敗・検証落ち 3 回・書き換えの検出（7） |
| reviewing | decomposing | `intake.reject`（9） |
| reviewing | active | `intake.approve`（6） |
| active | decomposing | `intake.revise`。`revising = 1` を立てる（C-1・C-2） |
| active | completed | goal の成果物が揃った（W-11。11） |
| needs_attention | investigating | `intake.retry`。失敗した実行の `purpose` が `investigate` のとき |
| needs_attention | decomposing | `intake.retry`。失敗した実行の `purpose` が `decompose` / `revise` のとき |
| answering / decomposing / reviewing / needs_attention（`revising = 1` のときだけ） | active | `intake.abandonRevision`（C-5）。`reviewing` からは `intake.approve` による再承認（C-4）でも移る |
| completed / canceled 以外のすべて | canceled | `intake.cancel`（C-7・C-8） |
| completed / canceled | なし | |

- 「`revising = 1` のときだけ」の辺は、表の値ではなく関数 `canIntakeTransition(from, to, revising)` で検査する。
  改訂中に `needs_attention` になっても `revising = 1` は保ったままにし、`intake.retry` は同じく失敗した実行の `purpose`（`revise`）から `decomposing` へ戻す
- PRD の図は「調査中 → 要確認」「分解中 → 要確認」「要確認 → 分解中（やり直す）」だけを描いている。
  調査で落ちたものを分解中で再開すると、質問を一度も出さないまま分解に入ってしまう。そのため**要確認から調査中へ戻る辺を足す**
- **`active` から `needs_attention` へ移る辺は持たない。** 進行中に起きる失敗（sub-issue を作れない・閉じられない、`gh` の失敗、
  プロセスのタスクが止まった）は Intake の状態を変えず、見張りのエラー（11 章の `WatchHealth`）とプロセスの状態
  （11 章の `ProcessStatus`）で見せる。進行中の Intake には、走っているタスクと、投入を待つ別のプロセスがある。
  1 つのプロセスの sub-issue が作れないことで Intake 全体を止めると、他のプロセスの投入まで止まる。
  W-12 と同じく、次の周期でやり直し続け、失敗が続いていることを見せる
- 上限待ちは状態にしない。`investigating` / `decomposing` のまま `rate_limited_until` が入る。
  タスクと違い、上限待ちの間に枠を握る状態が要らないためである。画面は `rate_limited_until` の列で見分ける
- `attention_reason` は判別ユニオンで持つ（JSON 文字列）。どれも調査・分解の実行（7 章）で起きるもので、進行中には起きない:

  ```ts
  export type AttentionReason =
    | { kind: "agent_failed"; runId: number; message: string }
    | { kind: "invalid_output"; runId: number; issues: string[] }
    | { kind: "wrote_repository"; runId: number; paths: string[] };
  ```

  `runId` から失敗した実行の `purpose` を引き、`intake.retry` のやり直し先を決める
- 「人の対応が要る」（V-3・PRD 8 章）は、状態から計算する関数 `needsHuman(intake, processStatuses): boolean` にし、列に持たない。
  `scheduler.ts` の「カウンタは持たない。状態から数える」と同じ理由である。
  `answering` / `reviewing` / `needs_attention` のとき、または `active` でプロセスに `your_turn` か `needs_attention` があるとき true にする
- 完了（W-11）: `active` で goal の成果物がすべて揃ったとき、見張りの周期か人のプロセスの完了記録の直後に `completed` へ移す。
  親 Issue は自動では閉じない。`intake.closeIssue` を人が呼ぶ（13 章）

## 6. PFD の正本と承認

**正本は `intake_drafts.pfd`（JSON 文字列）である。** 案 1 回ごとに行を足し、書き換えない。
試作の YAML はやめる。分解エージェントの出力を構造化出力で受け取るので、YAML を挟む理由が無い。

モデルは `pfd/src/model.ts` から次を変える。

- `issue`（番号）を消す。Issue の参照は `intakes` が持つ（PRD 11 章）
- 成果物に `decision?: string`（質問の id）を足す。`decision` を持つ成果物は `given: true` でなければならず、
  **中身はエージェントではなくデーモンが回答から埋める**。エージェントが決定の内容を書き換える経路を持たない（Q-5）

```ts
export type Artifact = {
  id: string;
  name: string;
  given: boolean;
  decision?: string;
  description?: string;
  verify?: string;
};
export type Process = {
  id: string;
  name: string;
  actor: "agent" | "human";
  inputs: string[];
  outputs: string[];
  purpose?: string;
  steps?: string;
  done_when?: string;
};
export type Pfd = { title: string; goal: string[]; artifacts: Artifact[]; processes: Process[] };
```

- **正規化とハッシュ**: zod で読んだ結果を、キーの順を固定して `JSON.stringify` した文字列を保存し、
  **その文字列の SHA-256（16 進）** を `hash` にする（`pfd/src/store.ts` の `hashOf` を移す）
- **承認（R-8・R-9）**: `intake.approve` は `draft_id` と `hash` を受け、次の 3 つを 1 トランザクションの中で確かめてから
  `intake_approvals` に書き、`intake_processes` を作る（4 章）。(a) その案が最新の案である、(b) 保存された `hash` と一致する、
  (c) Intake が `reviewing` である。画面が表示していた案と違えば失敗する。
  読んで判断してから書くまでの間に状態が動く場合は、`core/src/db/boundary.ts` の `commitStepBoundary` と同じく、
  書くトランザクションの中で状態を確かめる（食い違えば何も書かない）。Intake の書き込みはすべてこの形にする
- 投入の前にも、最新の承認の `hash` と案の `hash` を照合する（`pfd/src/dispatch.ts` の引き継ぎ）。
  承認の後で案が変わることは通常起きないが、起きたときに承認が無効になることを、投入の側でも保証する（R-8）
- **承認は人だけが行える（R-9）。** 承認の経路は RPC だけで、`dctl` に承認のコマンドは持たせない（N-2）。
  分解エージェントの道具に `dctl` とソケットは無い（7 章）。エージェントが自分の案を承認する経路が無いことが、この保証である
- **検証（D-5）**: `pfd/src/validate.ts` の 13 規則（`duplicate_artifact` / `duplicate_process` / `no_input` / `no_output` /
  `undefined_artifact` / `multiple_producers` / `given_has_producer` / `no_producer` / `unused_artifact` / `no_verify` /
  `missing_definition` / `cycle` / `goal_unreachable`）をそのまま引き継ぎ、次を足す。
  - `decision_not_given`: `decision` を持つ成果物が `given: true` でない
  - `unknown_decision`: `decision` が、答えのある質問を指していない
  - `frozen_changed`: 改訂のとき、固定された部分が変わっている（下記）
- **改訂の固定（C-3）**: 固定集合は「`current_task_id` を持つか `human_done_at` のあるプロセス」と「それらの入力と出力の成果物」である。
  新しい案は、固定集合の各要素を**正規化した JSON が同じ**形で含まなければならない（id・中身・入出力とも）。違えば `frozen_changed` で弾く。
  決定の成果物は、固定されたプロセスの入力なら固定され、そうでなければ改訂の中で問い直してよい
  - 取りやめたプロセス（`retired_at` のある行）の id は、後の改訂で使い回せない（`retired_reused`）。
    `validatePfd` の規則ではなく、`core/src/intake/revision.ts` が DB の履歴から検証する。
    行を生き返らせず、閉じた sub-issue を目印で採用してしまうことも避ける
- **D-2**: 実行の順序は案に書かせない。着手できるプロセスと並列に走れる組は、成果物の入出力から 11 章の状態計算で決まる
- **PFD 記法の出典**（PRD 13 章）: PFD spec 10 章の「PFD の記法の出典」の未決をそのまま引き継ぐ。記法の規則は変えないので、コアの決定には影響しない。
  PFD spec 10 章のほかの未決のうち、止まったタスクの再投入と承認後の改訂は、PRD の C-6 と C-1〜C-4 が要求に採ったので、それぞれ 11 章と本章が実装する

## 7. 分解エージェントの走らせ方

| 項目 | 決定 | 根拠 |
| --- | --- | --- |
| 作業ディレクトリ | Intake ごとに専用の worktree を、baseBranch から**ブランチを作らずに** `git worktree add --detach` で作る。パスは `worktreePathFor` と同じ置き場の `intake-<id>`。Intake が終わる（`completed` / `canceled`）まで同じパスを使い、改訂に入るときに `git checkout --detach <最新の baseBranch>` で進める。終わったときに `removeWorktree`（`force: false`）で消す。読むだけなので未コミットの変更は下の保証で常に無い | 本体の作業ツリー（人が触っている）を読ませない。会話が cwd に結びつくので、会話を続ける間はパスを変えない（**前提・要実測**）。`createWorktree`（`core/src/domain/worktree.ts`）は `-b` 固定なので、detached で作る関数を別に足す |
| 孤児の照合 | `findOrphans(project.path, known)` を呼ぶ 2 箇所（`daemon/main.ts` の起動時と、`handlers.ts` の `worktree.list`）の `known` に `intakes.worktree_path` を含める | 含めないと、Intake の worktree が起動のたびに「対応するタスクのない worktree」として警告され、`worktree.list` にも孤児として出る |
| 許す道具 | `Read` `Grep` `Glob` と、`core/src/workflow/scaffold.ts` の `READ_ONLY_TOOLS`（`git status` / `git diff` / `git log` / `git show` / `grep` / `cat` / `ls` / `find` / `sed -n` など。export して共有する）。`permissionMode` は指定しない。`Write` `Edit` `gh` `dctl` は許さない | `--permission-prompts none` の下で、許可に無い道具は拒否される |
| Issue の渡し方 | デーモンが `Tracker.readIssue` で本文とコメントを取り、prompt に埋める。エージェントに `gh` を持たせない | ネットワークの呼び出しを 1 か所（デーモン）に閉じる |
| 書き換えない保証（D-4） | 道具の制限に加え、実行の後に `git status --porcelain` を見る。変更があれば出力を捨て、worktree を `git checkout -- .` と `git clean -fd` で戻し、`needs_attention`（`wrote_repository`）にする | 道具の許可は先頭一致なので、抜け道を 2 重に塞ぐ |
| PFD と質問の受け取り方 | `--json-schema` の構造化出力。ファイルに書かせない。形は下の `DecomposerOutput` | `core/src/domain/stepRunner.ts` の `runGuideStep` と同じ型である。ファイルを読む経路（realpath の検査など）が要らず、書き込みの道具を許さずに済む |
| 実行の種類（`purpose`） | `investigate`: 開始時と、調査で落ちた後のやり直し。`questions` だけを許す。`decompose`: 回答の後・差し戻しの後・分解で落ちた後のやり直し。`questions` と `pfd` のどちらも許す。`revise`: 改訂に入った後。`decompose` と同じ出力を許し、prompt に承認済みの計画と固定集合を載せる | 調査で落ちたものを `decompose` で再開すると、質問を一度も出さずに分解へ入る（5 章で `needs_attention → investigating` を持つ理由） |
| 会話 | 開始から最初の承認までは 1 つの会話（調査 → 回答 → 分解 → 差し戻し）。改訂に入るときに新しい会話を始め、承認済みの計画・固定集合・決定の記録・改訂のコメントを prompt に載せる。`intake.retry` は同じ会話を続ける（会話が作られる前に落ちたなら新しく始める）。最初の呼び出しが上限で弾かれたら、会話の記録を消して新しい id で始め直す（`engine.ts` のタスクと同じ） | R-6（差し戻しは同じ会話の続き）。改訂は数日後で baseBranch も進んでいるので、古い会話を続けない。改訂の会話の範囲は `revision_run_id` 以降の実行と案で、開始コメントは `intake_comments.run_id` で選ぶ（改訂をやめて入り直したとき、前の改訂の実行・案・コメントを持ち込まない） |
| 検証に通らないとき | 違反の一覧を同じ会話へ返して直させる。やり直しは毎回 `adapter.resume` の新しい子プロセスなので、`intake_runs` の行が 1 回ごとに立つ。**同じ `purpose` の行を新しい順に見て、検証落ち（`status = 'failed'` かつ `issues` あり）が 3 行続いたら** `needs_attention`（`invalid_output`）にする。上限待ちの行（`rate_limited`）は数えず、連続も切らない。`attempt` は実行を新しく立てるたびに進め、上限待ちからの再開では進めない（ログのパスを実行ごとに分けるため） | Review Guide の既定（自分へ戻る・3 回）と揃える。数え方は `core/src/domain/rateLimit.ts` の `consecutiveRateLimited` が `step_runs` の連続を数えるのと同じ形である |
| エージェント自体の失敗 | result が ok でない、または子が落ちた場合は、ただちに `needs_attention`（`agent_failed`）にする。やり直しは人が `intake.retry` で行う | PRD 8 章の「エージェントの失敗 → 要確認」 |
| 実行枠（D-6） | **全体枠だけを取り、プロジェクト枠は取らない。** `currentUsage`（`core/src/domain/scheduler.ts`）が `intake_runs.status = 'running'` の数を全体枠に足す。受付は tick の中で、queued のタスクより先に `intake_runs.status = 'queued'` を受け付ける | 全体枠の理由（マシンの負荷と API のコスト）は分解にも当たる。プロジェクト枠の理由（同じリポジトリでのマージの困難）は、読むだけの分解には当たらない。分解は人を待たせているので先に通す。D-6 の「同じ実行枠」を、枠の理由が当てはまる分だけ同じ規則に従う、と読む |
| 上限待ち（D-6・PRD 8 章） | `engine.ts` の `decideRateLimit` と同じ判定を使う。待つなら `intake_runs` を `rate_limited` で閉じ、`intakes.rate_limited_until` を入れる。tick が期限の来たものを `queued` の実行として立て直し、同じ会話で再開する。`hasActiveRateLimit` は Intake の上限待ちも数える | 上限はアカウント全体に掛かる。待ちを sleep にしない理由もタスクと同じで、再起動で待ちが消えないようにするためである |
| ログ | `logPathFor` と同じ規則で `<logRoot>/intake-<id>/<purpose>.<attempt>.log` | `task.logs` と同じ読み方ができる |

```ts
/**
 * 分解エージェントの構造化出力。--json-schema にはこの 1 つのオブジェクトの形を渡し、
 * kind による判別はデーモンの zod で行う（トップレベルの oneOf を渡せるかは未確認）。
 */
export type DecomposerOutput =
  | { kind: "questions"; questions: Question[] }        // 空配列なら「質問は無い」（Q-4）
  | { kind: "pfd"; pfd: Pfd; replies: CommentReply[] }; // replies は差し戻しのコメントへの返答（R-7）
export type CommentReply = { commentId: number; reply: string };
```

- `purpose` が `investigate` の実行が `pfd` を返したら、検証落ちとして扱う（「調査の実行は質問だけを返す」を違反として返す）。
  出力が無いことも検証落ちの 1 件である（`stepRunner.ts` の `checkOutput` と同じ）
- **未実測の前提**: 構造化出力を読むキー名は、`core/src/adapter/claude.ts` の `structuredOutputOf` が `structured_output` と仮置きしている。
  本 spec はこれを前提として引き継ぎ、実測して直す（18 章）
- prompt は `core/src/intake/prompt.ts` がデーモンの側で組み立てる（`domain/guidePrompt.ts` と同じ扱い）。載せるものは次のとおり。
  Issue の本文とコメント。PFD の規則（PFD spec 6 章）と粒度の 4 条件・割りすぎの基準（D-3・D-7。`pfd/skill/pfd-decompose/SKILL.md` の文面を移す）。
  「Issue・コード・慣習から導けることは質問にしない」（Q-4）。「実行しないと決められないことは人のプロセスにする」（Q-8）。
  「分解の形だけを左右した決定は成果物にしない」（Q-5）
- システムプロンプトは `BUILTIN_APPEND_SYSTEM_PROMPT`（`core/src/domain/systemPrompt.ts`）を渡す

## 8. 質問と回答の形式

PRD 13 章「質問の形式」への答えである。

```ts
export type Question = {
  id: string;
  prompt: string;
  kind: "single" | "multiple" | "free";
  /** free では空配列。 */
  options: { id: string; label: string; description: string }[];
  /** 推奨が無ければ null。free のときは text で推す。 */
  recommendation: { optionIds: string[]; text: string | null; reason: string } | null;
  materials: Material[];
};

/** 判断材料。図は Review Guide の図（shared/guide/schema.ts の Diagram）をそのまま使う。 */
export type Material =
  | { kind: "text"; body: string }
  | { kind: "table"; caption: string; columns: string[]; rows: string[][] }
  | { kind: "code"; caption: string; language: string; path: string | null; code: string }
  | { kind: "diagram"; caption: string; diagram: Diagram };

/** 回答 1 件（Q-3: 選択肢以外の答えと補足を書ける）。 */
export type Answer = { questionId: string; optionIds: string[]; other: string | null; note: string | null };
```

- **決定: 判断材料は構造化データとして持つ。** 図は Review Guide の 4 種（sequence と、graph の relation・dependency・state）を再利用できる。
  比較表とコード片は Review Guide に型が無いので、Intake 側に足す。型は `shared/intake/` に置き、アプリと共有する
- 質問の検証（デーモン）: 質問 id と選択肢 id の重複がないこと、`recommendation.optionIds` が選択肢にあること、
  `single` の推奨が 1 つであること、`free` は選択肢を持たないこと、表の各行の列数が `columns` と同じであること。
  違反は 7 章の「検証に通らないとき」と同じ扱いにする
- 回答の検証（`intake.answer`）: すべての質問に答えがあること、`single` は選択が 1 つか `other` があること、選択肢 id が存在すること
- 質問は 1 回の実行で `questions` としてまとめて届き、`intake_question_sets` の 1 行になる（Q-2・Q-6）。回答も 1 回でまとめて返す
- 人が答えた内容を分解の会話へ返す文面は、`shared/intake/` の純関数で作る（9 章と同じく、送る前に画面で確かめられるようにする）

## 9. 計画レビュー

- コメントは、差し戻しのときにまとめて送る（`task.reject` と同じ）。R-5 の「コメントが 1 つ以上」をデーモンでも確かめる。
  `target_kind` が `artifact` / `process` のときは、`target_id` がその案にあることを確かめる
- エージェントへ届く文面は `shared/intake/feedback.ts` の純関数 `buildFeedback(pfd, comments): string` で作る。
  アプリは同じ関数でプレビューを出し（R-5）、デーモンは同じ関数で会話へ送る。送った文面と画面の文面が食い違わない
- 直した案では、`replies` で各コメントへの返答を受ける（R-7、S）。前の案との差分（追加・削除・変更）は、
  2 つの案の正規化 JSON を id ごとに比べる純関数を `shared/intake/` に置いて求める
- R-1: 検証を通った案を保存したら `reviewing` に移し、`intake.stateChanged` を配る。通知は既存の仕組みが拾う（N-1）
- R-3: 図の要素の定義の全文は `Pfd` から読める。プロセスがタスクになったときの prompt は `intake.processPrompt` が返す（11 章の prompt と同じ関数）

## 10. GitHub との接続

- 呼び出しはすべて `core/src/util/exec.ts` の `runCommand("gh", args, { cwd: project.path })` で行う。リポジトリは `gh` が remote から決める
- **使えるかの判定（S-5）**: `gh --version`（起動できない → `not_installed`）、`gh auth status`（非 0 → `not_logged_in`）、
  `gh repo view --json id,nameWithOwner`（非 0 → `no_github_remote`）の順に確かめる。
  結果はプロジェクトごとに覚え、Intake の画面を開くたびに取り直せるようにする

  ```ts
  export type GhStatus =
    | { ok: true; repo: { id: string; nameWithOwner: string } }
    | { ok: false; reason: "not_installed" | "not_logged_in" | "no_github_remote"; message: string };
  ```

- **Issue の一覧（S-1）**: `gh issue list --state open --json url,number,title,assignees,updatedAt --limit 100`。
  既定は `--assignee @me`、検索は `--search`。進行中の Intake がある Issue は `issue_url` で突き合わせて印を付ける（S-3）
- **Issue の読み込み（S-2・Q-1）**: `gh issue view <url> --json url,id,title,body,comments`
- **sub-issue の作成（I-1）: GraphQL の `createIssue` に `parentIssueId` を渡す 1 回の呼び出し**（`gh api graphql`）。
  REST では、Issue を作り、その内部 id を取り、その id を渡して親に紐づける、という 3 回の呼び出しになる。途中で落ちると「作ったが紐づいていない Issue」が残る。
  GraphQL なら作成と紐づけが 1 回で済む。`repositoryId` は `GhStatus.repo.id`、親の node id は `intakes.issue_node_id` を使う
- **重複を作らない（I-5）**: sub-issue の本文の末尾に、目印 `<!-- doctrine:intake=<intake_id> process=<process_id> -->` を入れる。
  作る前に `intake_processes.sub_issue_url` を見る。無ければ親の sub-issue 一覧を取って目印で探し、見つかれば採用して DB に書く。
  見つからないときだけ作る。別の手段で紐づけ直すことがあれば、同じ親子の二重の紐づけは 422 で拒まれるので、
  422 は「すでに紐づいている」として成功に数える
- **本文（I-2）**: プロセスの目的・入力と出力の成果物・完了条件と、先に終わっている必要があるプロセスの sub-issue の URL。
  作る関数は `shared/intake/` の純関数にする
- **改訂（I-6）**: 無くなったプロセスは `closeIssue` を `not_planned` で閉じる。増えたプロセスは作る。
  変わったプロセスは、本文の内容のハッシュが `sub_issue_hash` と違うときだけ `updateIssue` で更新する
- **人のプロセス（I-4）**: 完了の記録の後に `completed` で閉じる。閉じられなければ `sub_issue_closed = 0` のまま残し、次の見張りの周期でやり直す
- **進行の正本は DB（I-7）**: sub-issue の状態を読んで進行を決めることはしない。人が閉じても書き換えても、Intake は自分の記録で進む
- **失敗したとき**: sub-issue の作成・更新・閉じるの失敗は、Intake の状態を変えない（5 章）。作れなかったプロセスは `ready` のまま投入されず（W-1）、
  見張りの周期ごとにやり直す。失敗は `IntakeSummary.watch`（13 章）に、最後のエラーと連続失敗回数として出る
- **代わりの表現は持たない**（PRD 13 章「sub-issue が使えないリポジトリ」への答え）。sub-issue の機能が使えないリポジトリでは、
  上の「失敗したとき」のとおり、作成の失敗が続いていることを `gh` の応答のまま見せる。人は Intake を中止して手で進める。
  最初の版の対象は github.com であり、代わりの表現（タスクリスト）を持つと、I-5・I-6 の整え方が 2 通りになる
- **前提・要実測**: `closeIssue` の `stateReason`、親の `subIssues` の取得、`createIssue` の `parentIssueId` が返す値の形。
  REST が 3 回の呼び出しになること、GraphQL の `createIssue` に `parentIssueId` があること、二重の紐づけが 422 で拒まれることは確認済みである

## 11. 投入とマージの見張り

### 11.1 2 つの周期

- **1 秒の tick（既存）**: Intake の実行の受付、承認済みで入力の揃ったプロセスの投入。どちらも DB だけで済む
- **見張りの周期（新規、120 秒）**: `gh` が要る仕事（PR の見張り、sub-issue の作成・更新・閉じる）。
  `tick`（`daemon/handlers.ts`）と同じ `WeakSet` の再入ガードを持ち、`tickCycle`（`daemon/main.ts`）と同じく決して reject しない
- 見張りの周期を待たずに走らせる契機: 承認の直後（sub-issue を作る）、`intake.refresh`（W-4）、Intake 由来のタスクが `completed` になったとき、デーモンの起動直後
- **W-3（5 分以内）**: 120 秒の周期と `gh` 1 回の時間で、マージから投入まで最悪でも 2 分強で済む。
  1 回失敗しても次の周期で間に合う

### 11.2 呼び出し回数の抑え方

- 見張る対象は「Intake 由来で、マージが観測されていないタスクのブランチ」だけである
- **プロジェクトごとに 1 周期 1 回**、GraphQL の 1 クエリにブランチごとの別名を並べて引く
  （`pullRequests(headRefName: "...", states: [OPEN, MERGED, CLOSED])` を `b0` `b1` … として並べる）。
  返す列は `number url state baseRefName mergedAt mergeCommit{oid}` である。
  1 時間に 30 回 × プロジェクト数で、GitHub の上限（GraphQL は 1 時間 5000 点）に届かない。
  1 クエリに並べる別名は 50 までとし、超えたら分ける
- ブランチごとに `gh pr list` を叩く試作の方式（`pfd/src/status.ts`）は、プロセス数 × Intake 数の呼び出しになるので採らない

### 11.3 マージの判定と、baseBranch の取り込み

- **マージの判定（W-2 の (b)）**: `state = MERGED` かつ `baseRef = projects.base_branch`。
  ブランチの head を祖先として見る判定は使わない（squash マージで成り立たない。PFD spec 7 章）。
  観測した事実は `pr_observations` に書き、一度 `MERGED` を見たタスクは見張りの対象から外す
- **baseBranch を取り込んでから投入する。** `createWorktree`（`core/src/domain/worktree.ts`）は local の baseBranch から切る。
  GitHub 上でマージされても、手元の baseBranch を誰かが pull しない限り、下流のタスクは上流の成果物を持たずに始まってしまう。
  PRD 5.1 の前提（マージの後に作られた下流は上流を持つ）を成り立たせるため、次の 2 つを行う。
  - 投入の前に `git fetch origin <baseBranch>` を行い、Intake 由来のタスクの worktree は `origin/<baseBranch>` から切る
  - 入力を出したタスクの `merge_commit` が `git merge-base --is-ancestor <merge_commit> origin/<baseBranch>` で含まれていることを確かめ、
    含まれていなければ投入を次の周期へ延ばす

  実装では、tick の `createWorktree` の呼び出し（`handlers.ts`）が `task.intake_id` で起点を分けることになる。
  `merge-base --is-ancestor <merge_commit>` は squash マージでも成り立つ。見るのは baseBranch の上にできたマージのコミットであり、
  PFD spec 7 章が退けたのは、ブランチの head を祖先として見る判定のほうである

### 11.4 プロセスの状態

`pfd/src/status.ts` の計算を引き継ぎ、W-9 の 8 状態に写す。試作の `lost`（`dctl ls` の照合で見つからない）は、タスクが同じ DB にあるので消える。

```ts
export type ProcessStatus =
  | { state: "waiting"; missing: string[] }                                       // 入力待ち
  | { state: "ready"; blockedBy: "revising" | "paused" | "no_sub_issue" | null } // 着手可能（投入の前。止まっている理由があれば示す）
  | { state: "running"; taskId: string }                                          // 実行中（タスクが終端でなく PR が無い）
  | { state: "pr_open"; taskId: string; pr: PrFact }                              // PR レビュー中
  | { state: "merged"; taskId: string; pr: PrFact }                               // マージ済み
  | { state: "your_turn" }                                                        // あなたの番
  | { state: "done"; note: string; at: string }                                   // 完了（人）
  | { state: "needs_attention"; taskId: string; reason: "task_stopped" | "no_pr" | "pr_closed" }; // 要確認
```

- `task_stopped` はタスクが `failed` / `canceled` で止まったとき。`no_pr` はタスクが `completed` で、見張りで PR が見つからないとき。
  `pr_closed` は PR がマージされずに閉じたとき
- baseBranch 以外へマージされた PR は、マージ済みに数えず `pr_closed` と同じ扱いにする（W-2 の「baseBranch に」の帰結）
- プロセスの要確認は Intake の状態を変えない（5 章）

### 11.5 投入

- **投入の条件（W-1）**: Intake が `active` で `revising = 0`、`dispatch_paused = 0`。最新の承認の `hash` が案と一致する。
  プロセスが `ready` で `actor = "agent"`。**`sub_issue_url` がある**（順序は「承認 → sub-issue → 投入」）
- **二重投入の防止（W-5・C-6）**: タスクの挿入と `intake_processes.current_task_id` の更新を **1 トランザクション**にし、
  更新は `WHERE current_task_id IS <読んだ値>` の比較付きで行う（0 行なら巻き戻して見送る）。
  投入に外部の副作用は無い（タスクは DB の行である）ので、トランザクションの外で落ちても半端な状態は残らない。
  試作のタイトル接頭辞と `dctl ls` の照合（`pfd/src/dispatch.ts`）は、この DB の保証に置き換える。
  再投入（C-6）は `current_task_id` を新しいタスクで置き換え、古いタスクは `intake_process_id` を持ったまま経緯として残る
- **タスクの作成**: `handlers.ts` の `task.create` の中身（検証・`insertTask`・`branchNameFor`）を、ドメイン関数 `createTask(db, input)` に切り出して共有する。
  タイトルはプロセスの `name`（接頭辞なし。W-8）、優先度は既定の 2、ワークフローはプロジェクトの既定（PRD 12 章）。
  W-7 のとおり、Intake は枠を予約しない
- **prompt（W-6・H-3）**: `pfd/src/prompt.ts` を引き継ぎ、先頭に親 Issue と sub-issue の URL を並べ、
  `人が決めたこと:` に、決定の成果物（回答）と人のプロセスの `note` を載せる。R-3 のプレビューも同じ関数で作る

### 11.6 人のプロセスと一時的な失敗

- **人のプロセス（H-1〜H-4）**: 入力が揃った人のプロセスは `your_turn` になり、`needsHuman` が true になる。
  `intake.completeHumanProcess` は `note` を必須とし、空白だけも認めない。RPC の経路だけで、エージェントの道具には無い。
  記録した `note` は `human_note` に残り、下流のタスクの prompt に載る
- **一時的な失敗（W-12）**: `gh` の失敗（PR の見張り・sub-issue）は Intake を止めない。
  プロジェクトごとに「最後に成功した時刻・連続失敗回数・最後のエラー」をメモリに持ち、`IntakeSummary.watch` として返す。
  再起動で消えてよい（次の周期で取り直す）

  ```ts
  export type WatchHealth = { lastSucceededAt: string | null; consecutiveFailures: number; lastError: string | null };
  ```

## 12. タスクの紐づけとワークフロー変数

- `TaskSummary`（`shared/protocol.ts`）に `intake_id` `intake_process_id` `issue_url` `parent_issue_url`（いずれも `string | null`）を足す（W-8・V-6）。
  紐づけはタイトルではなくこの列で持つので、タスクのタイトルを直しても切れない
- テンプレート変数に `issue` 系統を足す（`core/src/workflow/template.ts` の `TemplateContext`）:

  | 変数 | 値 | Intake 由来でないタスク |
  | --- | --- | --- |
  | `{{ issue.url }}` | sub-issue の URL | 空文字 |
  | `{{ issue.parent_url }}` | 親 Issue の URL | 空文字 |
  | `{{ issue.closes }}` | `Closes <sub-issue の URL>` | 空文字 |

  空文字にするのは、同じワークフローを Intake 由来のタスクとそうでないタスクの両方が使うためである。
  エラーにすると、標準ワークフローが Intake 専用になる。
  `issue.closes` を持つのは、PR 本文に `Closes ` だけが残る書き方をワークフローの作者にさせないためである（I-3）。
  URL で書くのは、番号を前提にしない（PRD 11 章）ため
- 標準ワークフロー（`.doctrine/workflows/default.yaml` の `open-pr`、`scaffold.ts` の雛形）を `issue.closes` に対応させる書き換えは、別の作業とする

## 13. RPC とイベント

`shared/protocol.ts` の `Methods` 表に足す。型は本 spec で定義する（`IntakeSummary` `IntakeDetail` `IssueSummary` `IssueDetail` `GhStatus` `WatchHealth`）。

| メソッド | params | result | 要求 |
| --- | --- | --- | --- |
| `github.status` | `{ project }` | `GhStatus` | S-5 |
| `github.issues` | `{ project; assignee?: "me" \| "any"; search?: string }` | `(IssueSummary & { intake_id: string \| null })[]` | S-1・S-3 |
| `github.issue` | `{ project; url }` | `IssueDetail` | S-2 |
| `intake.start` | `{ project; issue_url }` | `IntakeSummary & { alreadyActive: boolean }`（進行中があれば新しく作らず、成功としてそれを返す） | S-2〜S-4 |
| `intake.list` | `{ project?; include_closed?: boolean }` | `IntakeSummary[]` | V-2・V-3・V-7 |
| `intake.get` | `{ intake_id }` | `IntakeDetail` | V-4・V-5・Q-7・R-10 |
| `intake.answer` | `{ intake_id; question_set_id; answers: Answer[] }` | `IntakeSummary` | Q-3・Q-5 |
| `intake.reject` | `{ intake_id; draft_id; comments: NewComment[] }` | `IntakeSummary` | R-4〜R-6 |
| `intake.approve` | `{ intake_id; draft_id; hash }` | `IntakeSummary` | R-8・R-9・C-4 |
| `intake.revise` | `{ intake_id; comments: NewComment[] }` | `IntakeSummary` | C-1・C-2 |
| `intake.abandonRevision` | `{ intake_id }` | `IntakeSummary` | C-5 |
| `intake.retry` | `{ intake_id }` | `IntakeSummary`（`needs_attention` のときだけ。`attention_reason.runId` の実行の `purpose` をやり直す: `investigate` → `investigating`、`decompose` / `revise` → `decomposing`） | PRD 8 章「要確認 → やり直す」。5 章の遷移表 |
| `intake.processPrompt` | `{ intake_id; draft_id; process_id }` | `{ prompt: string }` | R-3 |
| `intake.completeHumanProcess` | `{ intake_id; process_id; note }` | `IntakeDetail` | H-2・H-4 |
| `intake.redispatch` | `{ intake_id; process_id }` | `IntakeDetail`（要確認のプロセスだけ） | C-6 |
| `intake.refresh` | `{ intake_id }` | `IntakeDetail`（見張りの周期を今すぐ回す。sub-issue の作成のやり直しも含む） | W-4 |
| `intake.setDispatchPaused` | `{ intake_id; paused: boolean }` | `IntakeSummary` | W-10 |
| `intake.cancel` | `{ intake_id; mode: "leave" \| "stop" }` | `IntakeSummary` | C-7・C-8 |
| `intake.closeIssue` | `{ intake_id }` | `IntakeSummary`（`completed` のときだけ） | W-11 |
| `intake.logs` | `{ intake_id; run_id?; tail? }` | `TaskLogs` と同じ形 | 調査・分解の経過 |

- `intake.start` を失敗にしないのは、`shared/protocol.ts` の失敗応答が `error: string` しか持てず、既存の id を返せないためと、
  S-3 が「開始の代わりにその Intake を開く」ためである。`project.add` の `alreadyRegistered` と同じ作法である。
  二重に始まらないことは、4 章の部分 unique index でも固める
- `intake.retry` は sub-issue の失敗には使わない。それは Intake の状態を変えないので、`intake.refresh` で見張りの周期を回し直す（10 章）
- `github.*` と `intake.*` を分けるのは、Issue の一覧と可否の判定が、Intake の有無に関係なく引けるためである
- `NewComment = { target_kind: "artifact" | "process" | "whole"; target_id: string | null; body: string }`
- `IntakeSummary` は一覧の 1 行（V-2）である: `id` `project_id` `issue_url` `issue_title` `state` `revising` `attention_reason` `dispatch_paused`
  `rate_limited_until` `progress: { done: number; total: number }` `needs_human: boolean` `watch: WatchHealth` `created_at` `updated_at`。
  `rate_limited_until` は、上限待ちが状態でないため、画面が上限待ちを見分ける材料になる（5 章）。
  `TaskSummary` と同じく、UI に見せてよい列をこの型で宣言する
- `IntakeDetail` は `IntakeSummary` に次を足したもの: `drafts`（id・seq・created_at。最新の案は中身込み）、`approval`、`question_sets`、`comments`、
  `processes: ({ id: string } & ProcessStatus & { sub_issue_url: string | null; task_ids: string[] })[]`、`runs`
- `intake.cancel` の `stop` は、走っているタスクを `task.cancel` と同じ経路で止め、開いている sub-issue を `not_planned` で閉じる。
  PR には触らない（マージは Intake の範囲外）。`leave` はどちらもしない
- イベント（`ServerEvent` に足す）:
  - `{ event: "intake.stateChanged"; intake_id: string; from: IntakeState; to: IntakeState; revising: boolean }`
  - `{ event: "intake.updated"; intake_id: string }` — 状態以外（プロセスの状態・sub-issue・観測した PR・見張りの失敗）が変わった。アプリは `intake.get` を取り直す
  - タスク側は既存のイベントのままにする。Intake 由来のタスクの状態変化で Intake の表示が変わるときは、デーモンが `intake.updated` も配る
- N-2: `dctl intake ls` は `intake.list` を表示するだけである。開始・承認・差し戻しのコマンドは作らない

## 14. デーモン再起動時の復旧

`recoverOnStartup`（`core/src/domain/recovery.ts`）と並べて、`recoverIntakesOnStartup(db, probe)` を起動時に呼ぶ。
1 件の失敗で残りを止めない（`recovery.ts` と同じ作法）。

- `intake_runs.status = 'running'` の行: 子を `killStaleChild`（pid と開始時刻の照合）で SIGKILL し、行を `interrupted` で閉じる。
  そのうえで、同じ `purpose` で同じ会話を再開する `queued` の実行を立てる
- 分解の worktree に変更が残っていれば、7 章の保証と同じく戻す
- 投入は 1 トランザクションなので、復旧で直すものは無い（W-5。11 章）
- sub-issue は目印で採用し直すので、作成の途中で落ちても、次の見張りの周期が整える（I-5。10 章）
- 上限待ちは `rate_limited_until` の列が残っているので、再起動しても tick が拾う
- 見張りの状態（`WatchHealth`）はメモリなので消える。起動直後に 1 回、見張りを回す

## 15. PRD の要求との対応

PRD 7 章の M の要求のうち、コアが担うものが、どの章で満たされるかを示す。アプリだけで満たすものは「アプリ側」と書き、コアが渡すデータの章を併記する。
S の要求は、扱うものを同じ表に入れる。

| 要求 | 章 |
| --- | --- |
| V-1 | アプリ側（レールの入口。コアの分は無い） |
| V-2 | 13（`intake.list` と `IntakeSummary`）、5 |
| V-3 | 5（`needsHuman`）、13 |
| V-4 | 13（`intake.get` と `IntakeDetail`）、5 |
| V-5 | 11.4（`ProcessStatus`）、13 |
| V-6 | 4・12（`tasks` の紐づけ列と `TaskSummary`） |
| V-7（S） | 13（`intake.list` の `include_closed`） |
| S-1 | 10（`gh issue list`）、13（`github.issues`） |
| S-2 | 10（`gh issue view`）、13（`github.issue`・`intake.start`） |
| S-3 | 4（部分 unique index）、13（`intake.start` の `alreadyActive`） |
| S-4 | 4 |
| S-5 | 10（`GhStatus`）、13（`github.status`） |
| S-6（S） | 6・11（プロセスが 1 つの案も検証を通り、そのまま投入される） |
| Q-1 | 7（Issue の渡し方・`investigate`）、10 |
| Q-2 | 8（`Question`）、4（`intake_question_sets`） |
| Q-3 | 8（`Answer` の `other` と `note`） |
| Q-4 | 7（`investigate` の空の質問・prompt）、5（`investigating → decomposing`） |
| Q-5 | 4（決定の記録）、6（`decision` の成果物）、11.5（prompt） |
| Q-6 | 5（`decomposing → answering`）、7 |
| Q-7 | 4（追記だけ）、13（`intake.get`） |
| Q-8 | 7（prompt）、11.6 |
| D-1 | 6（`Pfd`） |
| D-2 | 6、11.4 |
| D-3 | 7（prompt） |
| D-4 | 7（許す道具・書き換えない保証） |
| D-5 | 6（検証）、7（やり直し 3 回）、5（`invalid_output`） |
| D-6 | 7（実行枠・上限待ち） |
| D-7 | 7（prompt） |
| R-1 | 5・9（`decomposing → reviewing`）、13（`intake.stateChanged`） |
| R-2 | アプリ側（図の描画）。コアは 6 の `Pfd` と 11.4 の `ProcessStatus` を渡す |
| R-3 | 9・11.5（`intake.processPrompt`） |
| R-4 | 4（`intake_comments`）、9、13 |
| R-5 | 9（`buildFeedback`）、13（`intake.reject`） |
| R-6 | 7（会話）、9 |
| R-7（S） | 9（`replies` と差分の純関数） |
| R-8 | 6（承認とハッシュ）、4 |
| R-9 | 6（承認は RPC だけ） |
| R-10 | 4（追記だけ）、13 |
| I-1 | 10（sub-issue の作成） |
| I-2 | 10（本文） |
| I-3 | 12（`issue.closes`） |
| I-4 | 10（人のプロセス） |
| I-5 | 10（目印）、14 |
| I-6 | 10（改訂） |
| I-7 | 10（進行の正本は DB） |
| W-1 | 4・11.5（投入の条件） |
| W-2 | 11.3（マージの判定） |
| W-3 | 11.1・11.2 |
| W-4 | 13（`intake.refresh`）、11.1 |
| W-5 | 11.5（1 トランザクション）、14 |
| W-6 | 11.5（prompt） |
| W-7 | 11.5（枠を予約しない） |
| W-8 | 4・12（紐づけ列） |
| W-9 | 11.4（`ProcessStatus`） |
| W-10（S） | 13（`intake.setDispatchPaused`）、11.5 |
| W-11 | 5（`active → completed`）、13（`intake.closeIssue`） |
| W-12 | 11.6（`WatchHealth`）、5 |
| H-1 | 5（`needsHuman`）、11.6 |
| H-2 | 11.6・13（`intake.completeHumanProcess`） |
| H-3 | 11.5（prompt）、11.6 |
| H-4 | 11.6（RPC の経路だけ） |
| C-1 | 5（`active → decomposing`）、11.5（`revising` で投入が止まる） |
| C-2 | 7（`revise`）、9、13（`intake.revise`） |
| C-3 | 6（改訂の固定） |
| C-4 | 6・10（再承認と sub-issue の整え）、13 |
| C-5（S） | 5・13（`intake.abandonRevision`） |
| C-6 | 11.5（再投入）、13（`intake.redispatch`） |
| C-7 | 13（`intake.cancel`） |
| C-8 | 5（どの状態からも `canceled`） |
| N-1（S） | 9・13（`intake.stateChanged` を既存の通知が拾う） |
| N-2（S） | 6・13（`dctl intake ls` だけ） |

## 16. PRD 13 章「決めていないこと」への答え

| PRD 13 章の項目 | 答え | 章 |
| --- | --- | --- |
| 分解エージェントの走らせ方 | 専用の worktree、読むだけの道具、構造化出力、実行枠は全体枠だけ | 7 |
| 質問の形式 | 判断材料を構造化する。図は Review Guide の 4 種を再利用し、表とコード片は Intake 側に足す | 8 |
| PFD の図の描き方 | 範囲外。アプリの spec が決める。コアは `Pfd` と `ProcessStatus` を渡すだけである | 17 |
| 見張りの周期と `gh` の抑え方 | 120 秒。プロジェクトごとに 1 周期 1 回の GraphQL | 11 |
| sub-issue の作り方と代わりの表現 | GraphQL `createIssue` の `parentIssueId`、目印で冪等にする。代わりの表現は持たない | 10 |
| PFD 記法の出典 | PFD spec 10 章の未決をそのまま引き継ぐ | 6 |
| Intake の作り方そのもの | 範囲外。この spec の分解は試作の `pfd` で行う。`pfd/` の削除は最後のプロセスに置く | 17 |

## 17. 範囲外

- アプリの画面と、PFD の図の描き方（Review Guide の図を 5 つ目の種類へ広げるか、Intake 専用の描画にするか）
- 標準ワークフロー（`.doctrine/workflows/default.yaml`、`scaffold.ts` の雛形）の `issue.closes` への対応
- overview・README・PFD spec の更新（PRD 9 章の影響表にある書き換え）
- `pfd/` の移植と削除
- Intake の作り方そのもの（PRD 13 章の最後の項目。分解の進め方と `pfd/` の削除時期）
- Linear
- PR のマージの自動化（#61）、定時起動（#59）
- Intake の実行ログのライブ配信（`log.line` 相当）。`intake.logs` で読むだけにする
- 移行と後方互換の仕掛け。doctrine にはまだ利用者がいないので、旧タイトル接頭辞（`[pfd:…]`）の読み替えも、`pfd` の状態ディレクトリの引き継ぎも作らない

## 18. 決めていないこと

- `structured_output` のキー名（`core/src/adapter/claude.ts` の仮置き）と、`--json-schema` に渡せる形の制約。
  **未実測（2026-09-21）**: 実装の作業では `claude` の実行が権限で拒否された（`claude` は npx のエイリアスで、実行に承認が要る）。
  `structured_output` の仮置きのまま、トップレベルを 1 つのオブジェクトにし `nullable` を使う形で進めている。
  実測するときは、`decomposerJsonSchema()` の出力を渡してエラーにならないか、result 行のどのキーにオブジェクトが入るかを見る
- 会話が作業ディレクトリに結びつくこと（7 章で worktree のパスを固定する理由）の実測。**未実測（2026-09-21）**: 同じ理由。
  worktree のパスを固定する作りは、結びつくかに関わらず変えない（人の作業ツリーを読ませないため）
- `closeIssue` の `stateReason` と、親の `subIssues` の取得の形の実測
- 分解のやり直し回数 3 と、見張りの周期 120 秒が実際に妥当か。成功の基準（PRD 10 章）を回して見直す
- 質問の `Material` に、図以外の種類（スクリーンショットなど）が要るか

## 19. 検討して採らなかった案

- **Intake をワークフローとして実装する。** PRD 5.2 が退けた
- **PFD を YAML のまま正本にする。** 構造化出力を YAML に直す理由が無い
- **sub-issue を REST の 3 回の呼び出しで作る。** 途中で落ちると、紐づいていない Issue が残る
- **sub-issue の失敗で Intake を要確認にする。** 1 つのプロセスの失敗で、他のプロセスの投入まで止まる（5 章）
- **要確認からのやり直しを常に分解中から始める。** 調査で落ちたものが、質問を出さずに分解へ入る（5・7 章）
- **ブランチごとに `gh pr list` を叩く。** 呼び出しが Intake の数 × プロセスの数になる
- **分解エージェントをプロジェクト枠に数える。** 同じリポジトリを読むだけの分解が、そのプロジェクトのタスクを止める
- **分解エージェントにファイル（`.doctrine-out/pfd.json` など）を書かせる。** 書き込みの道具を許すことになり、D-4 の保証が弱まる
