# doctrine PR のマージを待ち、conflict を都度直す設計

- 日付: 2026-09-22
- 状態: 設計合意
- 前提: [コア設計spec](2026-09-12-agent-orchestrator-core-design.md)、[利用上限待ちの設計](2026-09-19-rate-limit-wait-design.md)

## 1. 何が足りないか

既定ワークフローは `open-pr` で終わる。PR を開いた時点でタスクは `completed` になり、
worktree も消える。その後 develop が進んで conflict が起きても、doctrine は気づかない。
人が手元でブランチを取り直して直すことになる。

**PR が開いたことはタスクの終わりではない。マージされたときが終わりである。**
マージまで待ち、conflict が起きたら同じ worktree・同じ会話で直して push し直す。

これを書くには、いまのエンジンに2つ足りない。

1. **待つ手段が無い。** `command` ステップの中で `gh pr view` をループさせると、待っている間
   `running` のままになり、全体枠を数時間〜数日埋め続ける。
2. **「寄り道して戻る」が書けない。** 分岐は失敗時の `onFailure.goto` だけで、ステップは直列に
   並ぶ。解決ステップを待ちの後ろに置けば、マージされたときに流れ込む。

1 は新しいステップ型で埋める。2 はエンジンを変えず、ステップの並べ方で解く（4章）。

## 2. 決定の要約

| 項目 | 決定 | 章 |
| --- | --- | --- |
| 待ちの表現 | ステップ型 `poll` を足す。「まだ」ならタスクを新しい状態 `waiting` にし、`tasks.waiting_until` の時刻を tick が拾う | 3 |
| poll の結果 | 終了コードで分ける。`0` 済み / `75` まだ / `2` 諦める / それ以外は失敗 | 3 |
| 間隔 | `interval` で書く。既定は 1 分 | 3 |
| attempt | 「まだ」で待って再開した回は数えない | 3 |
| ループの形 | 解決役の `sync` を `open-pr` の前に置き、`wait-merge` の conflict は `goto sync` | 4 |
| 解決の仕方 | `git merge origin/develop`。rebase はしない | 4 |
| 人の見直し | 挟まない。`verify-sync` を通し、解決の記録を PR にコメントする | 5 |
| 上限到達 | `onFailure.onExhausted: suspend` を足し、`failed` ではなく人の判断を待つ | 6 |
| PR が閉じた | poll の「諦める」で `canceled` にする | 3 |
| BEHIND | 追従しない。conflict（`CONFLICTING`）のときだけ直す | 4 |
| 枠 | 待っている間、全体枠は持たず、プロジェクト枠は持つ | 3 |

## 3. `poll` ステップと `waiting` 状態

```yaml
- id: wait-merge
  type: poll
  run: "..."          # 1回の確認。再実行しても安全なこと
  interval: 1m        # 省略時 1m。下限 30s
  onFailure: { goto: sync, maxAttempts: 10, feed: "{{ steps.wait-merge.last_stdout }}", onExhausted: suspend }
```

終了コードの意味:

| コード | 意味 | エンジンがすること |
| --- | --- | --- |
| `0` | 済んだ | 次のステップへ（無ければ `completed`） |
| `75`（EX_TEMPFAIL） | まだ | `waiting` にし、`waiting_until = now + interval` |
| `2` | 諦める | 分岐せずに `canceled`。`last_stdout` を理由として残す |
| その他 | 失敗 | `onFailure` へ |

**状態 `waiting`** は `running` からだけ入り、`queued`（tick が期限で戻す）・`paused` / `canceled`
（人の操作）・`failed`（tick の例外経路）へ出る。`rate_limited` と同じ形だが、
「利用上限」と表示されると嘘になるので状態を分ける。

- `holdsGlobalSlot(waiting) = false` — 待っている間、マシンも API も使っていない
- `holdsProjectSlot(waiting) = true` — worktree とブランチを握ったままで、同じリポジトリで開いている
  PR の数を枠に収めたい。人のマージが遅いと後続のタスクが始まらないが、それは受け入れる

**attempt。** `waiting` から戻った実行は attempt を進めない（`resumingAfterRateLimit` と同じ扱い）。
進めると、1 分間隔で 1 日待っただけで 1440 回になり、最初の conflict で `maxAttempts` を使い切る。
`wait-merge` の attempt が数えるのは「open-pr の後で待ちに入った回数」、つまり conflict を直した回数 + 1 になる。

**実行の記録は待ちの1周に1行。** 「まだ」で閉じる行は `step_runs.status = 'waiting'` にし、
次に入ったときは新しい行を足さず、その行を `running` に戻して使い直す。1 分間隔で行を足すと、
PR が3日開いているだけで step_runs が 4000 行を超え、履歴の表示もイベントも埋まる。
「待ちからの再開か」は `lastStepRunFor(...)?.status === "waiting"` で判定する（`rate_limited` と同じ）。

**PR が閉じられた（`2`）ときの行** は `interrupted` で閉じる。外から閉じられた実行、という既存の意味と合う。

**クラッシュ復帰。** `poll` は `command` と同じく頭から再実行する。`run` は読み取りだけにすること。
`NON_IDEMPOTENT` の検査も `command` と同じように掛ける。

## 4. ステップの並び

```
review(approval)
 → sync         agent。develop を取り込み、conflict があれば解決して commit
 → verify-sync  command。型検査とテスト。落ちたら goto sync
 → open-pr      command。push し、PR が無ければ作る。sync の記録があれば PR にコメント
 → wait-merge   poll。CONFLICTING なら goto sync
```

`sync` は初回も走る。そのときは「develop に追従してから PR を開く」役になり、CI が develop 取り込み後の
状態で回る。conflict が無ければ `git merge` 1回で終わるので、安いモデルで足りる。

エンジンに成功時の飛び先（`next:`）を足す案と、`goto implement` に戻す案は採らなかった。
前者はワークフローがグラフになって読みにくくなる。後者は conflict のたびに agent-review・guide・人の review が回る。

**merge にする理由。** rebase は force-push が要り、PR のレビューコメントの位置がずれる。

**BEHIND は追従しない。** conflict が無いのに develop が進むたびに sync・verify・CI を回すことになる。
ブランチ保護で「最新にしないとマージできない」を有効にしているなら、GitHub の Update branch に任せる。

`wait-merge` の `run`:

```sh
gh pr view --json state,mergeable --jq '.state + " " + .mergeable' | {
  read s m
  case "$s $m" in
    "MERGED "*)       exit 0 ;;
    "CLOSED "*)       echo "PR がマージされずに閉じられました"; exit 2 ;;
    *" CONFLICTING")  echo "develop と conflict しています"; exit 1 ;;
    *)                exit 75 ;;  # MERGEABLE / UNKNOWN（push 直後は UNKNOWN になる）
  esac
}
```

## 5. 人の見直しを挟まない

`sync` の解決は review の承認後に入る変更だが、approval は挟まない。conflict のたびに人を待たせると、
マージ待ちの間に人が張り付くことになり、この機能の意味が薄れる。代わりに:

- `verify-sync` で型検査とテストを必ず通す
- `sync` は解決したファイルと判断を `.doctrine-out/sync-notes.md` に書く
- `open-pr` はこのファイルがあれば `gh pr comment --body-file` で PR に残し、ファイルを消す

コメントはクラッシュ復帰で二重に付くことがある。`gh pr create` と同じく `NON_IDEMPOTENT` の警告対象になる。

## 6. 上限到達は人の判断へ

PR が開いている間、conflict は何度でも起きうる。上限に届くのは異常とは限らないので、`failed` にして
worktree を置き去りにするより、人に続けるかどうかを聞く。review-gate の `escalate` と同じ考え方である。

`Branch` に `onExhausted: "fail" | "suspend"` を足す（省略時 `fail`。いまの挙動）。`suspend` のとき、
`decide` は `maxAttempts` を超えたら `{ kind: "fail" }` の代わりに `{ kind: "suspend" }` を返し、タスクは
`suspended` になる。人の操作は approval と同じ2つ:

- **承認** — そのステップの attempt を 0 に戻し、`goto` 先から続ける（人が手で直してから承認してもよい）
- **却下** — `failed`

`wait-merge` と `verify-sync` の両方に付ける。

approval ステップの `onReject` には `onExhausted: suspend` を書けない（ワークフローの検証で弾く）。
approval の却下はすでに人の判断なので、上限到達でもう一度人を待たせる意味が無い。

`suspended` には「開いている awaiting の行がちょうど1件ある」という不変条件があり、`applyApproval` は
それを前提にしている。そこで上限に達したら、失敗した実行の行を閉じた後に、**そのステップの id で**
awaiting の行を立てて `suspended` にする（`decide` の新しい kind `escalate`）。`applyApproval` は、止まって
いるステップが approval でなければこちらの意味で解釈する。

- 承認: 状態を `queued` にし、`current_step_id = goto`、`attempt_counts` からそのステップを消し、
  `feed` を展開して `pending_feed` に入れる。awaiting の行は `bounced`（`goto_step_id = goto`）で閉じる
- 却下: 状態を `failed` にし、awaiting の行も `failed` で閉じる。コメントは他の却下と同じく出力に残す

アプリは suspended のタスクを ReviewView で開くので、承認と却下のボタンはそのまま使える。
`task.context` に `escalation`（止まったステップ・戻り先・回数）を足し、ReviewView はそれがあれば
「承認すると回数を戻して〜からやり直す」と説明を出す。

## 7. 変わるもの

- `core/src/workflow/schema.ts` — `PollStep`、`Branch.onExhausted`、`interval` の検証、`NON_IDEMPOTENT` に `gh pr comment`
- `core/src/domain/states.ts` — `waiting` と遷移、枠の判定
- `core/src/domain/engine.ts` — poll の実行と終了コードの解釈、`waiting` への遷移、attempt を進めない再開、`decide` の `onExhausted`
- `core/src/domain/scheduler.ts` — 期限の来た `waiting` を `queued` に戻す
- マイグレーション — `tasks.waiting_until`、状態の CHECK 制約
- `.doctrine/workflows/default.yaml` — `sync` / `verify-sync` / `wait-merge` を足し、`open-pr` にコメントを足す
  （`scaffold.ts` が他のリポジトリに作る雛形は変えない。ブランチ名も CI も分からないので、マージ待ちは入れない）
- アプリ — サイドバーに「マージ待ち」の区分（「要確認」には入れない）、WorkflowRail に poll ステップ、上限到達の承認 UI

## 8. やらないこと

- **BEHIND への追従**（4章）
- **CI の失敗を見て直すこと。** `wait-merge` が見るのは conflict だけ
- **レビューコメントへの対応**
- **webhook によるマージ検知。** ポーリングだけ
- **`next:` などの一般的な制御フローの追加**（4章）
