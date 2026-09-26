# 10. 既知の食い違いと未実装

このガイドを書く過程で見つかった、ドキュメントとコードの食い違い、コード同士の食い違い、設計にあって実装に無いものをまとめる。
2026-09-26 時点（`f0a4c01`）のもので、直したらこの章からも消す。

## 10.1 設計にあって実装に無いもの

| 項目 | 設計の出どころ | 現状と影響 |
| --- | --- | --- |
| `intake.retry`（`needs_attention` からのやり直し） | intake-core spec 5 章・13 章、intake-ui spec 9.2 | 遷移表の辺と `intakeStates.ts:retryStateFor` はあるが、RPC もハンドラも無い。`needs_attention` から抜ける道は中止（改訂中なら改訂の放棄も）だけ |
| Intake の実行のクラッシュ復帰（`recoverIntakesOnStartup`） | intake-core spec 14 章 | `recoverOnStartup` はタスクしか見ない。デーモンが落ちたときに `running` だった `intake_runs` の行はそのまま残り、全体枠を 1 つ使い続け、その Intake は止まる |
| Intake の worktree の自動削除 | intake-core spec 7 章 | 終わった Intake の worktree は `worktree.remove` で手で消す |
| Intake 由来のタスクの完了を見張りの契機にする | intake-core spec 11.1 | 見張りは 120 秒周期と明示の要求でだけ回る |
| アプリのトレイ・single-instance・dctld の同梱 | review-app spec 4 章・8 章 | 未実装。dctld は PATH か `DOCTRINE_DCTLD` で探す |
| 「エディタで開く」 | review-app spec 6 章・7 章 | Rust の `open_path` と `app/src/daemon/client.ts:openPath` はあるが、画面のボタン（`app/src/components/ReviewView.tsx:OpenInEditor`）は「まだありません」のトーストのまま |

## 10.2 コードの注意点

| 箇所 | 内容 |
| --- | --- |
| `engine.ts:runTask` | `TemplateError` などで例外が出ると、ステップ開始の後なので step_run 行が `running` のまま残る。タスクは `failed` になるので復帰処理の対象にもならない |
| `engine.ts:runTask` と `recovery.ts` | 復帰や pause の後の再開では `pending_feed` が失われ、feed で入っていたステップは `step.prompt` で resume される。回数も 1 つ進む |
| `recovery.ts:classifyInterruptedStep` | 返す `action` はログに出るだけで、再開の仕方は `runTask` が会話の有無で決める。コメントは古い `claude_session_id` を前提にしている |
| `states.ts:TRANSITIONS` | `queued → failed` の辺を書くコードは無い |
| `engine.ts:applyApproval` のコメント | 「ワークフローは承認のたびにディスクから読み直される」とあるが、固定済みのタスクは読み直さない |
| `db/migrations.ts:migrateToLatest` の doc | 「SQLite の DDL はトランザクションに入るので、失敗したら丸ごと巻き戻る」とあるが、Kysely の `Migrator` は SQLite でトランザクションを張らない。同じファイルの `0005_rate_limited` のコメントの方が正しい |
| `db/schema.ts` の `goto_step_id` のコメント | CHECK を足したのは `0005_step_run_bounced` とあるが、実際は `0006_step_run_bounced` |
| `daemon/config.ts` | `config.json` に知らないキーが 1 つでもあると `linearApiKey` ごと捨てた既定値で動く。その状態で `daemon.setGlobalLimit` を呼ぶと、ファイルから `linearApiKey` が消える |
| `domain/worktree.ts:stateDir` | `DOCTRINE_STATE_DIR` が空文字だと相対パスを使う（`util/home.ts:stateRoot` は空文字を未設定として扱う）。worktree の置き場だけが DB やログと食い違う |
| `cli/dctl.ts:main` | `DOCTRINE_SOCKET ?? socketPath()` なので、空文字の `DOCTRINE_SOCKET` を空のパスとして使う |
| `daemon/handlers.ts` の `task.list` | 未登録のプロジェクトを渡すと絞り込みが外れて全件を返す（`intake.list` は空を返す） |
| `daemon/handlers.ts` の `task.logs` | `step_run_id` がそのタスクのものかを確かめない（`intake.logs` は確かめる） |
| `shared/protocol.ts:Methods` | `project.add` / `project.update` が載っていない。中継は素通しなのでアプリからも呼べる |
| `domain/guidePrompt.ts` | エージェントに実行させる diff が `git diff -M` で `-C` が無い。hunk 一覧は `-M -C` で作るので、コピーを含む変更では id が合わない |
| `domain/guideInputs.ts` | diff が 2 MiB で打ち切られても、プロンプトにはそれが伝わらない |
| `adapter/claude.ts:structuredOutputOf` | 構造化出力のキー `structured_output` は、コメント自身が「未実測」としている |
| `shared/guide/hunkId.ts` / `shared/diff/moves.ts` | git 既定の `a/` `b/` 接頭辞を前提にしている。`diff.mnemonicPrefix` などを設定したリポジトリではパスが合わない |
| `app/src/model.ts:composeRejection` | 行番号が変更前・変更後のどちら側かを示さない。リネームしたファイルの削除行へのコメントは、新しいパスと古い行番号の組になる |
| `intake/runner.ts` | 改訂のとき worktree を local の baseBranch に進めるので、人が pull していなければ古い base を読む |
| `.doctrine/workflows/default.yaml` | `verify` が fmt・lint・cargo を流さないので、通っても CI で落ちうる。`agent-review` のプロンプトが `CLAUDE.md` を見るよう指示しているが、リポジトリに `CLAUDE.md` は無い |
| `.github/workflows/ci.yml` | `.doctrine/` の変更で core のテストが流れない（`defaultWorkflow.test.ts` がそのファイルを読むのに） |
| `core/deno.json` | `zod` の範囲が `^3.24.0` だが、`shared/` が使う `zod/v4` は 3.25 以降にしか無い。lock で救われている |

## 10.3 app/README.md との食い違い

`app/README.md` は古い。`PfdDiagram` は「どの画面にもまだ置いていない」とあるが `PlanReview` と `IntakeProgress` が使っている。
`settings.json`・`open_path`・Intake や設定の画面・Rust のテストの走らせ方に触れていない。

## 10.4 overview との食い違い

| 箇所 | 実際 |
| --- | --- |
| 5.2「`poll` は待っている間は実行枠を占有しない」 | 全体枠は返すが、プロジェクト枠は握る |
| 4.2・5.4「標準ワークフローは PR を開いた後も `poll` でマージを待つ」 | それは doctrine 自身の `.doctrine/workflows/default.yaml`。`dctl project-add` の雛形は `review` で終わる |
| 5.5「枠が明ければ同じ会話から続く」 | その役割の最初の呼び出しで上限に当たったときは、新しい会話で始め直す |
| 5.3「解説生成の入力には Issue ... を用いる」 | プロンプトに入るのはタスクの prompt・テスト結果・差し戻しで、計画などはエージェントが `.doctrine-out/` から自分で読む |
| 5.3「コピーも移動として表示する」 | コピーは「コピー」と表示する。移動は畳むだけで diff から除かない |
| 9 章「実行枠 — 同時に実行中でいられるタスクの数」 | プロジェクト枠は `running` 以外（suspended など）も数える |

## 10.5 spec との食い違い

spec は書いた時点の記録なので、後の変更で古くなっているものが多い。主なものを挙げる。

- **状態の欄が古い**: 実装済みなのに「承認待ち」（task-context、intake-core、intake-ui）、「承認済み、実装計画の作成待ち」（agent-orchestrator-core、review-app、step-artifacts、review-record、task-diff）、「設計合意」（merge-wait）のまま
- **パスが古い**: directory-layout（2026-09-19）より前の spec と plan は `src/core/...`、`src/daemon/protocol.ts` を指す。今は `core/src/domain/...`、`shared/protocol.ts`
- **agent-orchestrator-core**: ステップ 3 種・状態 7 つ・変数 4 系統・`degraded` のまま。今はステップ 5 種・状態 9 つ・変数 5 系統で、`degraded` は 0008 で消えた。アプリの技術は「Deno Desktop」とあるが Tauri になった
- **merge-wait**: 回数切れで `decide` が返す kind を `suspend` と書いている箇所があるが、実装は `escalate`
- **rate-limit-wait**: 上限の判定は agent だけとあるが、guide にも掛かる
- **task-diff**: `-M` だけでコピーを R として扱うとあるが、実装は `-M -C` でコピーを C として返す
- **review-record**: 却下は `failed` とあるが、goto 先があれば `bounced`
- **tauri-dctld-relay**: Tauri のコマンドは 2 つとあるが今は 7 つ。`has_degraded` は存在しない
- **intake-core / intake-ui**: `github.*` の RPC と `ghCache` は `tracker.*` と `trackerCache` に改名された。PRD 11 章は「トラッカーの抽象は作らない」としていたが、Linear 対応で作った
- **workflow-rail / review-app**: ワークフローやプロジェクト設定を画面から編集しない、とあるが今は編集できる
