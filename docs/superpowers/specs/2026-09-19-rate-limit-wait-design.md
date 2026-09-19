# doctrine 利用上限に当たった agent ステップを待って再開する設計

- 日付: 2026-09-19
- 状態: 実装済み
- 前提: [overview](../../overview.md)、[コア設計spec](2026-09-12-agent-orchestrator-core-design.md)

## 1. 何が起きていたか

Claude Code の利用上限（5時間枠・7日枠）に当たると、`claude` は
「You've hit your session limit · resets 12:20pm」という応答を返して exit 1 で終わる。
doctrine から見ると、これは「ステップが失敗した」と見分けが付かない。`onFailure` の
無いステップならタスクごと `failed` になる。

実例（task 23a3b9c6、2026-09-19 12:10 JST）では、plan と implement が終わってコミットまで
済んでいたタスクが、`agent-review` の開始 10 秒で丸ごと失敗した。失われたのは実行時間だけ
ではなく、worktree・ブランチ・会話の続きを人が拾い直す手間である。

**上限は失敗ではない。まだ終わっていない実行である。** 待って、同じステップ・同じ会話で
やり直せば、そのまま続きができる。

## 2. 決定の要約

| 項目 | 決定 | 章 |
| --- | --- | --- |
| 上限待ちの表現 | タスクの状態に `rate_limited` を足し、`tasks.rate_limited_until` に再開してよい時刻を持つ | 3 |
| 実行の記録 | `step_runs.status` に `rate_limited` を足す。失敗ではないので `failed` とは分ける | 3 |
| 待ち方 | runTask の中で sleep せず、タスク行に期限を書いて tick が拾う（スケジューラ駆動） | 4 |
| 判定の根拠 | 応答テキストの文字列一致はしない。`rate_limit_event` の `utilization` の飽和 + 実行の失敗 | 5 |
| 代替根拠 | イベントが1件も来なければ `rate_limit_samples` を見る。ただし**その実行の開始時刻以降**に限る | 5 |
| 待つ上限 | 6時間。超える `resetsAt` は待たずに `failed`（`onFailure` には渡さない。`last_stderr` に `resetsAt` を残す） | 6 |
| 待ちの下限 | 60秒 | 6 |
| 連続回数 | 同一ステップで5回まで。数えるのは step_runs の末尾に並ぶ `rate_limited` の数 | 6 |
| 待機中の他タスク | 始めない。既に `running` のものは止めない | 6 |
| attempt | 上限で待った回は試行として数えない（`maxAttempts` を食い潰さない） | 7 |
| feed | `pending_feed` に書き戻す。ただし feed 無しのステップでは書かない | 7 |
| 会話 | `resume` で弾かれたら同じ session を再開。`start` で弾かれたら会話の記録を消して作り直す | 7 |
| `rate_limit_samples` | 書き込み経路も形も変えない。読み取りを1つ足すだけ | 5 |

## 3. 状態

`rate_limited` は `running` からだけ入り、`queued`（解放・`task.resume`）・`paused` /
`canceled`（人の操作）・`failed`（tick の例外経路）へ出る。

`holdsGlobalSlot(rate_limited) = false` — 全体枠の理由はマシン負荷と API コストで、
待っている間はどちらも消費していない（`suspended` と同じ理由付け）。
`holdsProjectSlot(rate_limited) = true` — worktree とブランチを握ったままなので理由が消えていない。

**なぜ `paused` + 列で済ませないか。** `paused` は「人が止めた」という意味で、人が
`task.resume` するまで動かないもの。上限待ちを `paused` にすると、ラベルが嘘になるうえ、
人が resume した瞬間にまた弾かれる。状態を分けるのが正直である。

`step_runs.status` の `rate_limited` は「上限で打ち切られたが、同じ会話で続きをやる実行」。
`interrupted`（人の決定を待たずに外から閉じられた）とも `failed` とも意味が違う。

## 4. 待ち方はスケジューラ駆動

待ちをタスク行（`state` と `rate_limited_until`）に書き、tick が期限の来たものを `queued`
に戻す。runTask の中で sleep しない。

理由は再起動である。sleep にすると、デーモンを落とした瞬間に待ちが消え、タスクは
`running` のまま誰にも進められない行として残る。状態から導ける形にすれば、再起動を
またいでも壊れない（scheduler.ts の「カウンタは持たない。状態から数える」と同じ方針）。

解放したタスクのidは `releaseDueRateLimited` が返し、`tickOnce` が `task.stateChanged` を
配る。配らないと、アプリは次の取り直し（15秒）まで上限待ちのまま見え続ける。

## 5. 上限に当たったことの判定

### 5.1 実測（尺度と書式）

判定の前に、`utilization` が比なのか百分率なのか、`resetsAt` がどんな書式かを決める必要が
あった。`adapter/claude.ts` の `normalize` は `unifiedWindows` の値を `Number()` と
`??` で素通ししているだけなので、コードからは決まらない。

**根拠にしたのは `core/test/adapter/claude.test.ts` の `rate_limit_event` のフィクスチャ**である。
これは `normalize` がそれに対して書かれた唯一の具体例であり、`status` / `rateLimitType` /
`unifiedWindows` という欄の名前は doctrine 側で発明できるものではないので、実物の形を
写したものとして扱う。ただし**この1件を観測し直したわけではない**（下記）。

```json
{ "type": "rate_limit_event",
  "rate_limit_info": {
    "status": "allowed", "rateLimitType": "five_hour",
    "unifiedWindows": {
      "five_hour": { "utilization": 0.14, "resetsAt": "2026-09-12T05:00:00Z" },
      "seven_day": { "utilization": 0.04, "resetsAt": "2026-09-19T00:00:00Z" } } } }
```

- `utilization` は **0〜1 の比**。したがって飽和の判定は `utilization >= 1` でよい
- `resetsAt` は **ISO 8601 の文字列**
- `rate_limit_info.status` という欄があり、飽和していないときの値は `"allowed"`

**確かめられなかったこと。** 事故当時のログ（`~/.local/state/doctrine/logs/23a3b9c6*/`）と
`dctl ratelimit` の出力は、実装した worktree の外にあり読めなかった。よって
**「上限に当たった瞬間の実物」は未確認**であり、上のフィクスチャも飽和していない
（`utilization` が 0.14 の）例である。分かっていないのは次の2点:

1. 飽和した window の `utilization` がちょうど `1` になるのか、`1` を超えるのか
   （`>=` にしてあるのでどちらでも動く）
2. `status` が飽和時にどんな値になるのか（`"rejected"` など）。**値が分からないものを
   判定に使うことはできない**ので、`status` は今のところ `normalize` で捨てたままにする。
   実物を1件でも観測したら、`utilization` より直接的な根拠なので乗り換えてよい

**文字列一致は使っていない。** 応答テキストの「You've hit your session limit」を探す手も
あるが、この文言は claude 側の都合で変わり、多言語化もされ得る。表示のための文字列を
制御の根拠にすると、上流の文言変更で静かに壊れ、壊れ方は「上限のたびにタスクが失敗する」
という元の症状そのものになる。

### 5.2 読めない `resetsAt` は待たない

`resetsAt` の型注釈は `string` だが、アダプタは JSON を素通しするだけなので、実データは
数値（epoch）・空文字・不正な文字列であり得る。`parseResetsAt` は次を受け付ける:

- ISO 8601 の文字列（実測で確認した形）
- 数値、および数字だけの文字列。`1e12` 未満なら秒、以上ならミリ秒として読む
  （防御的に受けているだけで、この形は未観測）

どれとしても読めないもの、および `now` より過去の時刻は **上限扱いしない**。いつまで
待てばよいか決められないものを待ちに倒すと、永久に動かないタスクを作ってしまう。

### 5.3 材料は2つだけ

1. **その実行中に受け取った `rate_limit_event`**（`StepOutcome.rateLimits`、window ごとの最新）
2. **実行の結果**（`status === "failed"`）

成功・degraded・suspended は上限扱いしない。飽和した window が複数あるなら、`resetsAt` が
**最も遅いもの**まで待つ（片方だけ明けても通らない）。

### 5.4 代替根拠と、その窓の狭め方

実行中に1件も `rate_limit_event` を受け取れなかったときだけ、`rate_limit_samples` を見る。
このテーブルはタスク横断・実行横断の1本で、行はタスクidも step_run_id も持たない。
絞らずに「window ごとの最新行」を見ると、別のタスクが残した飽和行が未来の `resetsAt` を
持っている間、上限とは無関係に失敗した agent ステップ（テストが落ちた、レビューが
`is_error` で終わった等）まで `rate_limited` に倒され、`onFailure` の分岐が走らないまま
数時間待たされる。そこで **そのステップ実行の開始時刻以降に観測された行だけ**を見る
（`rateLimitsObservedSince(db, outcome.startedAt)`、比較は `>=`。開始と観測が同じミリ秒に
落ちることがある）。

**この窓でもなお残る誤判定**: 自分の実行中に別タスクが上限に当たり、自分は別の理由で
失敗した場合。それでもこの窓で十分と考える理由は、**そのとき実際に上限は来ている**ので、
待って再実行するのは無駄ではないから。失う可能性があるのは `onFailure` の即時分岐だけで、
待ち明けに同じ失敗をすればそこで分岐する。

`rate_limit_samples` にタスクidや step_run_id を足して誤判定を完全に消す道は取らない。
記録側（`insertRateLimitSample` と書き込み経路）を壊さないことを優先し、読み取りを
1つ足すだけに留める。

## 6. 待つ上限と、待っている間の他のタスク

- **待つ上限は6時間**（`MAX_WAIT_MS`）。5時間枠は最長でも5時間で明けるので必ず収まる。
  7日枠が飽和しているときは数日先になり得るが、その間 worktree とブランチを握ったまま
  黙って止まり続けるのは、人が「作り直すか・上限を上げるか」を決める機会を奪う。
  6時間を超える `resetsAt` は待たずに `failed` にし、`last_stderr` に `resetsAt` を書く
  （警告だけでは board 上で普通の失敗と区別が付かない）
- **下限は60秒**（`MIN_WAIT_MS`）。`resetsAt` が現在時刻とほぼ同じに見えるとき（時計のずれ）に
  即再実行してまた弾かれる回転を防ぐ
- **連続して上限に当たれるのは同一ステップで5回まで**（`MAX_CONSECUTIVE_RATE_LIMITS`）。
  数えるのはカウンタではなく「そのステップの step_runs の末尾に並ぶ `rate_limited` の数」。
  超えたら `failed`（`onFailure` には渡さない。理由を `last_stderr` に書く）
**待たないと決めた上限は、`onFailure` に渡さずそのままタスクを `failed` にする。**
step_run は `failed` として閉じ、理由を `last_stderr` に書いた上で、`decide` を通さない。
渡すと `onFailure` が同じステップをやり直し、**閉じていると分かっている枠**に対して
`maxAttempts` の回ぶん claude を起動し直す。しかも上限が原因の失敗がワークフロー本来の
試行回数を1つ食い、待ちの連続数も `failed` の行で切れて数え直しになるので、待ちは5回では
止まらなくなる（7章-3 が避けたかった事態そのものである）。ここで止めるのが、6時間を超える
待ちを拒む理由——「人が作り直すか・上限を上げるかを決める機会」——の中身である。

- **待っている間、新しいタスクは始めない。** 上限はアカウント全体に掛かるので、別タスクを
  admit しても同じように弾かれ、step_run と worktree だけが増える。`tickOnce` は
  `rate_limited` のタスクが1件でもいる間 `selectAdmissible` を呼ばない。
  **既に `running` のタスクは止めない**（実行中のものは自分で上限に当たれば同じ経路で待ちに入る）

**既知の帰結**: 上限待ちが2件あって `rate_limited_until` が違うとき、先に明けた方は
`queued` に戻るが、もう1件が待っている間は admit されない。アカウント全体の上限という
理由からは正しい（どのみち弾かれる）が、遅い方が7日枠で先の方が5時間枠、というような
組み合わせでは待ち時間が伸びる。

## 7. 上限に当たったときにエンジンが書くこと

ステップ終了のコミットを、上限のときだけ別の形にする（1トランザクション、
`requireState: "running"` 付き）。

- `taskPatch`: `state: "rate_limited"`、`rate_limited_until`、`child_pid` / `child_started_at` を null
- `stepRunUpdate`: `status: "rate_limited"`、`exit_code`、`ended_at`
- `outputs`: `last_stderr` に `resetsAt` と再開予定時刻を書く
- コミットの後、この経路は `setState` を通らないので、`onStateChanged` と
  `onStepRunFinished` を自分で呼ぶ。呼ばないとアプリは次の取り直しまで「実行中」のまま
  見え続け、「待っていることが分かる」という要件を満たさない

4つの落とし穴:

1. **feed を失わない。** 書き戻す値はエンジンのローカル変数（`goto` の時点で `expand` 済み）
   であって、`stepRunner` が展開したプロンプト文字列ではない。**feed が無いステップでは
   書き戻さない** — 展開済みの `step.prompt` を `pending_feed` に入れると、再開時の入力が
   ワークフロー定義由来から DB 由来に変わり、待っている間に worktree やステップ出力が
   変わっても古い文面が固定される。null のままなら、再開時は今までどおり `step.prompt` が
   その時点のコンテキストで展開される
2. **`start` で当たったか `resume` で当たったかで再開の仕方が違う。** その role の最初の
   呼び出しで弾かれた場合、会話が作られたかは分からず、失うものも無い。`sessionDelete` で
   `task_sessions` の行を消し、再開時は新しい session id で `start` する。`resume` 呼び出しで
   弾かれた場合だけ、同じ session を `--resume` で再開する
3. **attempt を進めない。** 上限はワークフロー上の試行ではない。進めると `onFailure` /
   `onReject` の `maxAttempts` を上限が食い潰す。ステップ開始時に「同じステップの直前の
   step_run が `rate_limited` なら `attempt_counts` を進めない」と状態から導く。結果として
   再開後の step_run は同じ attempt 番号を持ち、ログは同じファイルに追記される（同じ会話の
   続きなので読み物としても自然）
4. **上限に倒すのは agent ステップだけ。** `command` ステップはアダプタを通らないので、
   この分岐に入る余地がないことをコード上も明らかにしてある

## 8. マイグレーション 0005

`tasks.state` も `step_runs.status` も CHECK 制約なので、値を足すにはテーブル再構築が要る。
`tasks` は `step_runs` / `step_outputs` / `task_sessions` から参照される行を持ち得て、
`DROP TABLE tasks` は暗黙の DELETE を伴うため、そのままでは弾かれる。

Kysely の Migrator は、SqliteAdapter が `supportsTransactionalDdl: false` を返すため
**マイグレーションをトランザクションに入れない**（`db.connection()` で流す）。よって
0003 のコメントにある「マイグレーションはトランザクションの中なので `PRAGMA foreign_keys`
は切れない」という前提は成り立たず、ここでは切れる。0005 は `PRAGMA foreign_keys = OFF` と
`PRAGMA defer_foreign_keys = ON` を両方立て（将来トランザクションの中で流れるように
なったら後者が効く）、再構築の後に `PRAGMA foreign_key_check` で整合を確かめてから
`foreign_keys` を戻す。

トランザクションに入らないということは、このマイグレーションが途中で失敗すると DB は
中途半端な形で残るということでもある。`openDb` はそこで例外を投げて起動を止めるので、
壊れた形のまま走り続けることはない。

`rate_limit_samples` には触れない。0001〜0004 は書き換えない。

## 9. 見え方

- `dctl get <id>` — `state: "rate_limited"` と `rate_limited_until` がそのまま出る
- `dctl ls --state rate_limited` — 既存の絞り込みがそのまま効く
- アプリ — サイドバーに「上限待ち」の区分を作る（「実行中」と「待ち」の間、
  再開の早い順）。時刻欄は「12:20 再開」。**「要確認」には入れない**（人が何かする
  必要は無い）。`task.stateChanged` は期限を運ばないので、イベントで状態が変わってから
  次の取り直しが来るまでは「再開時刻は取得中」と出す（`Invalid Date` を出さない）
- ゲートで止まっている `queued` のタスクがなぜ動かないのかも、この区分の存在から辿れる

## 10. やらないこと

- **消費率に応じた実行枠の自動調整**（overview 8章の非ゴール）。見るのは「上限に当たったか」
  だけで、`utilization` が 0.8 だから枠を減らす、といった制御はしない
- **応答テキストの文字列一致による判定**（5.1）
- **`command` ステップの上限対応**
- **6時間より先の `resetsAt` を待つこと**、**`resetsAt` が読めないときに勘で待つこと**
- **上限待ち中に別のタスクを進めること**
- **`rate_limit_samples` の形と書き込み経路の変更**
- **上限待ちの通知**（トレイ・OS通知）。表示で分かる所までに留める
