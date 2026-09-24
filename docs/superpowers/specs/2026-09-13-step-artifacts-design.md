# doctrine ステップ間の成果物受け渡し設計

- 日付: 2026-09-13
- 状態: 承認済み、実装計画の作成待ち
- issue: [#15](https://github.com/todokr/doctrine/issues/15)
- 前提: [overview](../../overview.md)、[コア設計spec](2026-09-12-agent-orchestrator-core-design.md)

> （#45 で `stdout` / `stderr` は `last_stdout` / `last_stderr` に改名した。本文の例は
> 現行の名前に更新してある。）

## 1. 位置づけ

overview 4章が目標とするワークフローは、**役割の違うエージェントが1つのタスクの中で
交代し、前の成果を次が使う**形をしている（計画 → 計画レビュー → 実装 → コードレビュー →
Review Guide 生成）。今のコアはこの形を組めない。overview はこれを「未確定」として
2つの問いに分けている。

- **問い1**: セッションをタスク単位で持つか、ステップ単位で持つか
- **問い2**: 計画・レビュー・テスト結果の全文を、後段のエージェントにどう渡すか

overview は「片方だけ先に決めないこと」と釘を刺している。ステップ単位のセッションに
すると会話の文脈が引き継がれないので問い2の答えが必ず要り、タスク単位のままなら
役割の分離（計画した本人が計画をレビューしない）ができない。本specは両方を1つの
決定として確定させる。

**③ Review Guide の spec（#18）の前提**である。ガイドを作るエージェントは計画・計画
レビュー・diff・コードレビュー・テスト結果の全文を入力にする（overview 5.3）。ここで
決まる受け渡しの形が、③の入力の形になる。

## 2. 決定の要約

| 項目 | 決定 | 章 |
| --- | --- | --- |
| 問い1: セッションの単位 | **役割単位**（`agent` ステップに `session: <role>`、省略時は既定ロール1つ） | 3 |
| 問い2: 全文の受け渡し | **worktree 内ファイル**（`.doctrine-out/` に前段が書き、後段が `{{ worktree.path }}` 経由で読む） | 4 |
| `.doctrine-out/` の扱い | doctrine が worktree 作成時に `.git/info/exclude` へ追記する。プロジェクトの `.gitignore` は書かない | 4 |
| DB | `tasks.claude_session_id` を廃し `task_sessions(task_id, role, session_id)` を追加 | 5 |
| 互換性 | `session` を書かないワークフロー（既存の scaffold 含む）は無変更で動く | 3, 6 |

## 3. 問い1 — セッションの単位は役割単位

### 採らなかった案

- **タスク単位のまま**（issue の案3）: 役割の分離ができない。計画した本人がそのまま
  レビューに回ってしまい、overview 4.2 の手順 2・4 が表現できない
- **ステップ単位**（issue の案1）: `onReject: goto implement` で同じ会話を `--resume`
  する、という core spec 3章の前提（「やり直しではない」）が壊れる。差し戻しのたびに
  実装エージェントが文脈を失い、③が読む「経緯」（コードレビューの指摘と実装の対応の
  やり取り）が会話としては繋がらなくなる

### 採る案 — 役割単位

`agent` ステップに `session?: string` を持たせる。同じ `session` 値を持つステップは
同じ会話を共有し、`--resume` で継続する。省略時は暗黙のロール名 `"default"` が使われる
——**これは今の「タスクに1つの会話」と完全に同じ挙動**であり、既存のワークフロー
（scaffold の `default.yaml` 含む）は一切変更なしで動く。

```yaml
name: feature
steps:
  - id: plan
    type: agent
    session: planner
    prompt: "{{ task.prompt }}\n計画を .doctrine-out/plan.md に書いてください"

  - id: plan-review
    type: approval
    title: "計画を確認してください"
    review:
      files: [".doctrine-out/plan.md"]
    onReject:
      goto: plan
      maxAttempts: 3
      feed: "計画レビューで却下された:\n{{ steps.plan-review.last_stdout }}"

  - id: implement
    type: agent
    session: implementer
    prompt: |
      次の計画を実装してください: {{ worktree.path }}/.doctrine-out/plan.md

  - id: code-review
    type: agent
    session: reviewer
    prompt: "{{ worktree.path }} の差分をレビューし、問題があれば列挙してください"
    onFailure:
      goto: implement
      maxAttempts: 3
      feed: "コードレビューで指摘された:\n{{ steps.code-review.last_stdout }}"
```

`plan` に戻る差し戻しは `session: planner` の会話を再開し、`implement` に戻る差し戻しは
`session: implementer` の会話を再開する。役割ごとに独立した文脈が保たれる。

役割単位はタスク単位（ロールが1つだけ）とステップ単位（ロールが毎回ユニーク）の
両方を特殊ケースとして包含する。書き手はワークフローの粒度に合わせてどちらの形にも
寄せられる。

### バリデーション

- `session` の値は `stepId` と同じ形式（`z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/)`）
- ロール名の予約語はない（`RESERVED_STEP_IDS` とは別の名前空間なので衝突しない）
- `command` / `approval` ステップは `session` を持てない（`.strict()` のスキーマに
  フィールド自体を持たせない）。会話を始めるのは `agent` ステップだけという core spec
  3章の原則は変えない

### エンジンの変更

- `engine.ts` の `hadSession = task.claude_session_id !== null` を、
  `hadSession(task, step.session ?? "default")` のようにロール別の判定に置き換える
- `commitStepBoundary` の `taskPatch` に単一の `claude_session_id` を書く代わりに、
  ロール別のセッション行を upsert する新しい書き込み経路を足す（5章）
- `contextFor` などテンプレート展開に影響する箇所は無い。`{{ steps.<id>.* }}` は
  ステップid単位のままで、セッションのロールとは独立している

### 復帰（クラッシュリカバリ）

`classifyInterruptedStep`（`recovery.ts`）は現行どおり `current_step_id` からワーク
フロー定義を引いてステップ種別を判定する。この判定は変わらない。変わるのは resume
に使うセッションIDの取り出し方だけで、`step.type === "agent"` と分かった後に
`step.session ?? "default"` でロールを引き、そのロールの `session_id` を
`task_sessions` から読んで `--resume` する。

## 4. 問い2 — 全文の受け渡しは worktree 内ファイル

### 採らなかった案

- **ログファイルのパスを変数として公開する**（issue の案2）: `{{ steps.<id>.log_path }}`
  のような新しい変数系統が要る。`template.ts` が閉じている変数の系統
  （`task.*` / `worktree.path` / `project.path` / `steps.<id>.*`）を増やすことになり、
  かつログはアダプタ固有の NDJSON 形式なので、後段のエージェントがそれを読むのは
  アダプタの境界（core spec 6章「アダプタの境界」）の外にある知識を要求する
- **DBに全文を持つ**（issue の案3）: core spec 4章が「ログ本文はDBに入れない」と決めた
  理由（一覧クエリが道連れで重くなる）とそのまま衝突する

### 採る案 — worktree 内ファイル + 既存の `worktree.path` 変数

前段のエージェントに、成果物を worktree 内の決まった場所へファイルとして書かせる。
場所と中身はワークフローの書き手（プロンプト）が決め、**コアはパスも中身も一切
解釈しない**。後段のエージェントは既存の `{{ worktree.path }}` 変数でパスを組み立てて
プロンプトに埋め込むだけで足り、**テンプレート変数の追加は不要**。

```
{{ worktree.path }}/.doctrine-out/plan.md
```

### `.doctrine-out/` という名前

②のspec（6章 `review.files` の例、`docs/superpowers/specs/2026-09-13-review-app-design.md`）
が既にこの名前を例として使っている。②はそこで「この項目がoverview4章の受け渡し方法を
縛らない」と明言しているが、本specがその受け渡し方法を決める以上、同じ名前をそのまま
採用し、②との齟齬を無くす。**doctrine 自身はこのディレクトリ名を強制しない**
（ワークフローの書き手がプロンプトで指示する自由な文字列であり、コードに埋め込まれた
定数ではない）。ただし5章の `.git/info/exclude` への追記は、この規約に合わせて
`doctrine` が自動で行う。

### `.doctrine-out/` を git 管理外にする理由

`.doctrine-out/` に書かれたファイルが git 管理下にあると、2つの問題が起きる。

1. **`completed` の後始末が誤って削除を拒否する。** core spec 5章は「完了時に
   未コミットの変更が残っていたら削除を拒否し、警告を出す」と決めている
   （`hasUncommittedChanges` は `git status --porcelain` を見る、`src/core/worktree.ts`）。
   `.doctrine-out/plan.md` のような中間成果物を最終コミットに含める理由はなく、
   含めなければ**すべての正常終了タスクが「未コミットの変更あり」で削除拒否**になり、
   ②の要確認・通知（②spec 5, 8章）が常に鳴ることになる
2. **②の `task.diff` に紛れ込む。** ②spec 9章の `task.diff` は
   `GIT_INDEX_FILE=<tmp> git add -A && git write-tree` で未追跡ファイルを含めて
   diff を作る。`.doctrine-out/` が対象に入ると、人がレビューする diff に
   実装と無関係な中間ファイルが混ざる

どちらも同じ1つのルール——「`.doctrine-out/` は git に知らせない」——で解決する。
実測で確認済み: `.git/info/exclude` に1行加えると、`git status --porcelain` も
`GIT_INDEX_FILE=<tmp> git add -A && git write-tree` も、リンクされた worktree 内から
実行してもそのパスを除外する（`info/exclude` は共有 `.git` ディレクトリに1つだけ存在し、
全 worktree に効く）。

### 置き場所の決定 — `project.yaml` でも `.gitignore` でもなく `info/exclude`

- **プロジェクトの `.gitignore` は書かない。** `project-add` は「既存のファイルは
  上書きしない」「ユーザーが書いていない手順を勝手に作らない」という原則
  （README 1章）を持つ。`.gitignore` はユーザーのリポジトリの資産であり、doctrine が
  無断で書き換えるべきではない
- **`.git/info/exclude` に doctrine が追記する。** これはリポジトリの内容物ではなく
  ローカルなgitの設定であり、共有されない（コミットもされない）。worktree 作成時
  （`createWorktree`、`src/core/worktree.ts`）に、`.doctrine-out/` の行が無ければ1行
  追記する。既に同じ行があれば何もしない（複数タスクが同じリポジトリに対して
  何度も worktree を作るので冪等にする）

## 5. DB — `tasks.claude_session_id` から `task_sessions` テーブルへ

役割単位のセッションは複数の値を1タスクに対して持つ必要があり、単一列では表せない。

```ts
// 新規テーブル
task_sessions: {
  task_id: string;      // references tasks.id
  role: string;         // agent ステップの session（省略時 "default"）
  session_id: string;
  // 複合主キー (task_id, role)
}
```

- **マイグレーション**: 新しいバージョン番号で `task_sessions` を作成し、既存の
  `tasks.claude_session_id` が非nullの行を `role: "default"` として1行ずつ移す。
  移行後も `tasks.claude_session_id` 列自体は残す（SQLiteの `ALTER TABLE` で
  `NOT NULL` でない列の削除はできるが、他の外部キー・インデックスとの整合を
  確かめるコストに見合わないため、実装計画で削除するかを判断する。列を残しても
  コードから参照しなければ実害はない）
- **`commitStepBoundary`（`src/db/boundary.ts`）の変更**: `taskPatch` から
  `claude_session_id` を外し、`sessionUpsert?: { role: string; session_id: string }`
  を新設する。ステップ開始のコミットで、`agent` ステップのときだけこれを渡す
  （現行の「`command` ステップでは書かない」という制約はロール単位でも同様に保つ —
  一度も `start` していないロールが「会話がある」ことにされてはいけない）
- **既存のテストの流儀に従う**: `task_sessions` の読み書きも `requireState` 付きの
  トランザクションに乗せる（読んでから書く経路の競合を避けるという core spec 4章の
  原則をそのまま適用する）

### `step_outputs` / `step_runs` への影響

無し。ステップ出力・実行記録はステップid単位のままであり、セッションのロールとは
独立した軸である。②spec 9章が決めた `step_outputs` の主キーを `step_run_id` に
変える件（却下コメントの履歴を残すため）とも独立で、互いに競合しない。

## 6. ワークフロースキーマの変更

`src/workflow/schema.ts` の `agent` ステップに `session?: string` を追加する。

```ts
z.object({
  id: stepId, type: z.literal("agent"), prompt: z.string().min(1),
  session: z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/, "roleは英数字・ハイフン・アンダースコアのみ").optional(),
  permissionMode: z.string().optional(), model: z.string().optional(), onFailure: branch.optional(),
}).strict(),
```

`command` / `approval` ステップのスキーマは変えない。

②spec 9章が同じ `.strict()` の approval スキーマに `review?: { files: string[] }` を
足すと決めている。両方の変更は同じファイルの別の判別ユニオン枝（`agent` と
`approval`）に対する追加であり、互いに独立して適用できる。

## 7. 互換性

- `session` を書かないワークフローは、すべての `agent` ステップが暗黙の
  `"default"` ロールを共有する。これは今の「タスクに会話は1本だけ」と同一の挙動であり、
  README「既知の制約」の該当記述はこの1文に書き換える:
  「`session` を指定しない `agent` ステップは全て同じ会話を共有する。役割ごとに
  会話を分けたい場合は `session: <role>` を指定する」
- scaffold（`src/workflow/scaffold.ts` の `DEFAULT_WORKFLOW_YAML`）は変更不要
  （`implement` の1ステップだけで `session` を書かないため、既存のまま動く）

## 8. 範囲外

- **`step_runs.status` に `interrupted` を足す件**（README「既知の制約」）。
  本specとは独立した既知の課題であり、テーブル再構築を要するため別のPRで扱う
- **`.doctrine-out/` の中身の形式**（Markdown か構造化データか）。
  ワークフローの書き手が決めるものであり、doctrine のコアもこのspecも規定しない
- **③ Review Guide がどのファイルを読むか**。本specは受け渡しの器（役割単位の
  セッション、worktree 内ファイル）を決めるだけで、③がそれをどう組み合わせて
  ガイドを作るかは③のspec（#18）で決める
- **`.doctrine-out/` の掃除**。`completed` になった worktree はディレクトリごと削除
  されるため（core spec 5章）、放置される心配は `failed` / `canceled` の worktree
  （証拠として残す方針）に限られ、既存の「古い worktree」の仕組みでカバーされる

## 9. テスト方針

- **スキーマ**: `session` の形式検証、`command`/`approval` に `session` を書くと
  `.strict()` で弾かれること
- **エンジン**: 同じ `session` を持つ2つの `agent` ステップの2回目が `--resume` される
  こと、異なる `session` は独立した session_id を持つこと、`session` 省略時は
  `"default"` ロールとして今までどおり1本の会話になること（既存テストの回帰）
- **復帰**: `classifyInterruptedStep` がロール別にセッションを解決すること
- **worktree**: `createWorktree` が `.git/info/exclude` に `.doctrine-out/` を
  冪等に追記すること、追記後は `hasUncommittedChanges` が `.doctrine-out/` 配下の
  変更を無視すること
- **マイグレーション**: 既存の `tasks.claude_session_id` が `task_sessions` の
  `role: "default"` 行に正しく移されること

## 10. 検討して採らなかった案（補足）

- **`.doctrine-out/` をコミット対象にし、最終コミット前に削除するステップを
  ワークフローに書かせる**: ワークフローの書き手に毎回同じ後始末コマンドを
  書かせることになり、忘れれば5章の問題がそのまま起きる。仕組み側で一度
  `info/exclude` に追記する方が、書き手の負担も失敗の余地も小さい
- **役割ごとに別の worktree を切る**: overview 4章のワークフローは1つのタスクに
  1つの worktree・1つのブランチという前提（用語集）を崩す。役割は会話の単位で
  あって作業ディレクトリの単位ではない
