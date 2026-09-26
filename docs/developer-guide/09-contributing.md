# 9. 変更の進め方

## 9.1 spec と plan

大きめの変更は、設計（spec）→ 実装計画（plan）→ 実装の順に進める。

- `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md` — 何が足りないか、決定の要約（表）、各論（型・状態遷移・YAML 例・「なぜ〜か」）、変わるもの、やらないこと。
  冒頭に日付・状態・issue・前提の spec を書く
- `docs/superpowers/plans/YYYY-MM-DD-<topic>.md` — Global Constraints、タスクの並び、タスクごとの Files / Interfaces と、テスト → 失敗の確認 → 実装 → 通過の確認 → コミットのチェックボックス

大きな Issue は PFD で分解してから流すのが今の進め方である（Intake の実装そのものも、spec を書くことを含めて PFD のタスクとして doctrine に流した）。
小さな変更は spec も plan も無しに直接タスクにしてよい。

spec と plan は**書いた時点の記録**で、後から更新されないことがある。古い spec はディレクトリ構成が今と違う（`src/core/...` のようなパス）。
spec を読むときは [10 章](10-known-gaps.md) で食い違いを確かめる。

## 9.2 コードの規約

plan の Global Constraints に繰り返し書かれている約束が、事実上の規約になっている。

- **後方互換の仕掛けを作らない。** doctrine にはまだ利用者がいない。破壊的な変更では、旧名のエイリアス・旧名を案内するエラー・古い形を受け止める分岐を作らず、名前を変えて参照を全部書き換える
- **コードコメントには、そのコード固有の事実だけを書く。** 一般的な実装原則や設計の理由は spec の地の文に書く
- コメント・エラーメッセージ・テスト名は日本語
- 一度コミットしたマイグレーションは書き換えない。新しい番号で足す
- `shared/protocol.ts` の union に値を足したら、app 側の網羅的な `Record` も同じ変更で足す
- core は `deno fmt`（`lineWidth: 100`）と `deno lint` を通す。CI が見る
- プロンプトなどの文面を別ファイルに出さない。`deno compile` の単一バイナリに同梱できないため
- エージェントに渡す文字列を組むとき、利用者由来の文字列（Issue の本文、タスクの prompt）を `template.ts:expand` に通さない。`{{ }}` が展開されてしまうため

## 9.3 コミットと PR

- コミットメッセージは日本語の一行で、動詞で終わる常体にする（「〜を作る」「〜を足す」「〜にする」）。`feat:` などの接頭辞は使わない
- PR は `develop` へ squash マージし、件名の末尾に `(#N)` が付く
- 必須チェックは CI の `ci` ジョブ 1 つ（[2.5](02-repository-and-tooling.md)）。push の前に、触ったサブプロジェクトの検査を手元で通す

```bash
mise run core:check && mise run core:test && (cd core && deno fmt --check && deno lint)
mise run app:build && mise run app:test
(cd app/src-tauri && cargo test --locked)   # Rust を触ったとき
```

## 9.4 よくある変更の手順

### RPC メソッドを足す

1. `shared/protocol.ts` の `Methods` に params と result の型を足す
2. `core/src/daemon/handlers.ts:createHandler` の `switch` に `case` を足す。引数は `req` / `reqNumber` / `reqProject` で検査する
3. dctl から呼べるようにするなら `core/src/cli/dctl.ts:parseArgv` と `USAGE` に足す（人だけが行う操作は足さない）
4. `core/test/daemon/` にテストを書く
5. アプリから呼ぶなら `app/src/store.tsx` の該当するフックに足す。**Rust は変えない**

### イベントを足す

1. `shared/protocol.ts` の `ServerEvent` に足す
2. 出すところで `ctx.broadcast(ev)` を呼ぶ。特定の追従者だけに送るなら `{ followKey, followersOnly: true }`
3. `app/src/model.ts:reduce` の `daemon` で反映する。イベントには連番も再送も無いので、取りこぼしても取り直しで正しくなる形にする

### マイグレーションを足す

1. `core/src/db/migrations.ts` の `migrations` の**末尾に**次の番号のキー（例 `"0015_xxx"`）を足す。既存のものは書き換えない
2. `up(db: Kysely<any>)` で書く。`schema.ts` の型（最新の形）や、`attemptCount` のようなコードの関数は使わない（将来変わるため）
3. 変更の種類で書き方を選ぶ
   - 列の追加・改名: `alterTable(...).addColumn / renameColumn`
   - CHECK の値を変える: テーブルの再構築が要る。`rebuildWithCheck(db, table, from, to)` を使う（CREATE 文の CHECK だけを置き換えて作り直すので、過去に ALTER で足した列を落とさない）
   - 再構築では `PRAGMA foreign_keys = OFF` と `defer_foreign_keys = ON` を並べ、最後に `foreign_key_check` で違反が無いことを確かめてから戻す。参照される側を DROP すると子の行が連鎖で消えるおそれがあるなら、子を先に退避する（0006・0008 の例）
4. `core/src/db/schema.ts` の型を最新の形に直す
5. `core/test/db/migrate.test.ts` を直す。列集合の一致を見る `COLUMNS` 表、表の一覧、`idx_` で始まる索引の一覧、再構築を越えて行・索引・外部キーが残ること
6. マイグレーションはトランザクションに入らない（[4.5](04-daemon-and-persistence.md)）。途中で失敗しても壊れない順序で書く

### タスクの状態を足す

`rate_limited` と `waiting` がこの手順で足された（`0005_rate_limited`、`0013_waiting`）。

1. マイグレーションで `tasks.state` の CHECK を広げる（`rebuildWithCheck`）
2. `core/src/db/schema.ts:TaskState` と `core/src/domain/states.ts:TRANSITIONS`、`holdsGlobalSlot` / `holdsProjectSlot`
3. `core/src/domain/scheduler.ts` の枠の数え方と、期限で戻すなら解放の関数
4. `task.resume` / `task.pause` / `task.cancel` が受けるか
5. `recoverOnStartup` の対象にするか
6. `shared/protocol.ts` の型、`app/src/tone.ts` の色、`app/src/model.ts` のサイドバーの区分（`groupOf`）

### ワークフローのステップの種類や項目を足す

1. `core/src/workflow/schema.ts` の zod スキーマ（strict なので足さないと弾かれる）と、日本語のエラー
2. `core/src/domain/engine.ts:runTask` と `core/src/domain/stepRunner.ts`
3. `workflow.get` / `workflow.save` が扱う形（`handlers.ts:toStepDetail`、`core/src/workflow/save.ts`）と、アプリの `app/src/workflowEdit.ts`
4. 雛形（`core/src/workflow/scaffold.ts`）に入れるか
5. README 2 章の説明

### Review Guide のスキーマを変える

1. `shared/guide/schema.ts`。`describe` がそのまま書き手への指示になる
2. `core/test/guide/jsonSchema.test.ts` の制約（[5.4](05-review-guide.md)）を満たすか確かめ、スナップショットを更新する
3. `core/src/domain/guidePrompt.ts` のプロンプト
4. `shared/guide/examples/step-artifacts.guide.json`（core と app のテストが共有する見本）
5. アプリの表示（`app/src/guide.ts`、`app/src/flow.ts`、`app/src/components/Guide.tsx`）

### ソケットパスや状態ディレクトリの規則を変える

TypeScript（`core/src/daemon/server.ts:resolveSocketPath`、`core/src/util/home.ts:stateRoot`）と Rust（`app/src-tauri/src/daemon.rs`）の**両方**を直し、両方のテストを直す。
