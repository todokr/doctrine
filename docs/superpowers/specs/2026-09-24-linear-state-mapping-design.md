# doctrine Intake の進行を Linear の状態に映す設計

- 日付: 2026-09-24
- 状態: 実装済み（#204）
- 対象: [#112 Intake で Linear の Issue を扱う](https://github.com/todokr/doctrine/issues/112) の決めどころのうち「Linear の Issue の状態を Intake の進行に合わせて動かすか」
- 前提: [Intake の PRD](../../prd/intake.md) 11 章、[Intake のコア設計](2026-09-21-intake-core-design.md)

## 1. 何を決めたか

Linear の状態はチームごとに定義され、`In Progress` と `In Review` はどちらも種類（type）が `started` である。
**種類だけでは引き分けられない**、というのがこの spec が答える問いだった。

#112 の他の決めどころ（アクセス手段と認証・トラッカーの宣言の置き場・PR との結びつけ方）はここでは扱わない。

## 2. 決定の要約

| 項目 | 決定 | 章 |
| --- | --- | --- |
| 段階 | `todo` → `inProgress` → `inReview` の3段階。この順に進み、戻らない | 3 |
| sub-issue の段階 | タスクが無ければ `todo`、PR が OPEN か MERGED なら `inReview`、それ以外は `inProgress` | 3 |
| 親 Issue | Intake が始まったら `inProgress`。以後は動かさない | 3 |
| 閉じること | この仕組みでは扱わない。既存の `closeIssue` が担う | 3 |
| 動かし方 | 出来事を拾わず、いまの進行から段階を導いて、記録より先なら進める（冪等） | 4 |
| 状態の引き方 | `project.yaml` に名前があればそれ。無ければ種類（`inReview` だけ名前 `In Review`） | 5 |
| 戻さない規則 | 「種類の順 → position」で比べ、同じか先なら書かない | 6 |
| インターフェース | `Tracker` に `advanceIssue(projectPath, issue, phase)` を足す（PRD 11 章を意図して改める） | 7 |
| GitHub 実装 | 何もしない（open / closed しか持たないため） | 7 |
| 失敗の扱い | Intake の開始は成功させ、同期の失敗は見張りの報告に積んで次の周でやり直す | 8 |

## 3. 段階と、その段階にいるべき条件

Linear の状態そのものではなく、doctrine 側の3段階（`shared/intake/tracker.ts` の `IssuePhase`）で考える。
段階は前にしか進まない。

```ts
export type IssuePhase = "todo" | "inProgress" | "inReview";
export const ISSUE_PHASES: readonly IssuePhase[] = ["todo", "inProgress", "inReview"];
```

| 対象 | いまの進行 | あるべき段階 |
| --- | --- | --- |
| sub-issue | タスクがまだ無い | `todo`（作ったときのまま） |
| sub-issue | タスクがある。PR は無い | `inProgress` |
| sub-issue | PR が OPEN | `inReview` |
| sub-issue | PR が MERGED | `inReview` |
| 親 Issue | Intake が始まった | `inProgress` |

**マージを `inReview` に含める理由。** この仕組みは「進行を段階に写す」だけで、終わりを書かない。
マージされた sub-issue を閉じるのは既存の sub-issue の同期（`closeIssue`）で、そちらが `completed` の状態へ
動かす。段階に `done` を作ると、閉じる経路と二重に書くことになる。

**`needs_attention` を映さない理由。** これは doctrine が人を呼んでいる印であって、Linear のワークフローの
段階ではない。映すと、チームのボードに doctrine の内部事情の列が要ることになる。

**親を `inProgress` から先に進めない理由。** 親の完了は Intake の完了で、それは `closeIssue` が担う。

## 4. 出来事ではなく進行から導く

PR は見張りのポーリングで観測するので、`pr_open` を一度も見ないまま MERGED になることが普通に起きる。
出来事を拾って書く作りは、その回を取りこぼす。そこで純関数で「あるべき段階」を導く
（`core/src/intake/issueStateSync.ts`）。

```ts
export function desiredSubIssuePhase(progress: ProcessProgress | undefined): IssuePhase;
export function isAhead(a: IssuePhase, b: IssuePhase | null): boolean;
```

いまどの段階まで書いたかは DB が持つ（マイグレーション `0014_issue_phase`）。

- `intakes.issue_phase` — 親 Issue について書いた段階
- `intake_processes.sub_issue_phase` — その sub-issue について書いた段階

記録より先でなければ API を呼ばない（`isAhead`）。同じ周で何度呼んでも、進んでいなければ何も起きない。

同期は見張り（`watchProject`）の中で、**投入と PR の観測を済ませた後**に走る。同じ周で作ったタスクと
観測した PR が、その周の段階に入る。retired・sub-issue が無い・すでに閉じた行は飛ばす。

## 5. 状態の引き方

段階から Linear の状態を引く規則は2段構えである。

| 段階 | `project.yaml` に名前があるとき | 無いとき |
| --- | --- | --- |
| `todo` | その名前 | 種類が `unstarted` の状態 |
| `inProgress` | その名前 | 種類が `started` の状態 |
| `inReview` | その名前 | 名前が `In Review` の状態 |

種類で引くときは、その種類の中で `position` が最も小さいものを選ぶ。`inReview` を種類で引けないのは、
`In Progress` と同じ `started` だからで、ここだけは名前に頼る。

```yaml
# .doctrine/project.yaml
tracker:
  kind: linear
  team: ENG
  states:            # 段階ごとに、いる分だけ書ける（部分指定でよい）
    inReview: レビュー中
```

引けなかったときは投げる。`inReview` のメッセージは、`project.yaml` の `tracker.states.inReview` で
名前を変えられることを伝える（チームが `In Review` という名前を使っていない場合がある）。

## 6. 手で進めた状態は戻さない

人が先に Linear 上で進めていることがある（PR を出す前に `In Review` にした、`Done` にした）。
doctrine の書き込みでそれを引き戻してはいけない。

記録（4章）と段階の順で判断したうえで、**Linear の今の状態とも比べる**。比べ方は「種類の順 → position」。

```ts
const TYPE_ORDER = ["triage", "backlog", "unstarted", "started", "completed", "canceled"];
```

今の状態が目標と同じか先なら、何も書かずに返る。だから:

- 人が `Done`（`completed`）にしていた Issue を `In Progress` へ引き戻さない
- 連携や人が動かした `In Review` を `In Progress` へ引き戻さない（同じ `started` でも position が後ろ）
- 同じ状態への書き込みも起きない

**限界。** `In Progress` の position が `In Review` より小さい（同じ `started` の中で左にある）ことを前提に
している。逆に並べたチームでは `inReview` への前進が戻りと判定され、書かれない。

## 7. `Tracker` に `advanceIssue` を足す

PRD 11 章は「Intake がトラッカーに求めることは4つに限る」と書いている。状態を進めるのはその外側なので、
**PRD を意図して改め、5つ目の操作を足す**。

```ts
/** Intake の進行を状態へ写す。段階は前にしか進まない（spec 3 章）。 */
advanceIssue(projectPath: string, issue: IssueRef, phase: IssuePhase): Promise<void>;
```

`updateIssue` に相乗りさせないのは、内容の同期（title / body）と進行の反映が別の理由で走るからである。
片方だけ失敗したときに、どちらが失敗したのか呼び出し側で分かるようにしておく。

GitHub の実装は何もしない。GitHub の Issue は open / closed しか持たず、閉じることは `closeIssue` が担う。
同期の側にも `tracker.kind !== "linear"` の門があり、GitHub のプロジェクトでは段階を引くための問い合わせも
起きない。

## 8. 失敗したときにどうなるか

状態を写せないことは、Intake の進行そのものを妨げない。

- **Intake の開始時**（親を `inProgress` へ）: 失敗は `problems` に入れ、`intake.start` が警告として見せる。
  **開始は成功させる**
- **見張りの周回**: 失敗は Issue ごとに集めて見張りの報告（`report.errors`）に積む。記録は進めないので、
  次の周で同じ段階をやり直す

## 9. やらないこと

- **`needs_attention` を Linear に映すこと**（3章）
- **この仕組みで Issue を閉じること**（3章。`closeIssue` が担う）
- **Linear 側の状態の変更を読んで Intake を動かすこと。** 向きは doctrine → Linear の一方向
- **GitHub のトラッカーで状態を動かすこと**（7章）

## 10. 未決（この実装より後に出た論点）

設計の議論では次の2点を逆に決めていた。実装（#204）は決めた側ではなく、ここに書いた側になっている。
どちらが良いかは #112 で続けて判断する。

1. **`inReview` を誰が書くか。** Linear の GitHub 連携は PR の open / merge に反応して状態を動かせるので、
   「PR から分かる遷移は連携に任せ、doctrine は連携に見えないもの（投入時の `inProgress`）だけ書く」という
   案があった。いまは doctrine が `inReview` も書く。連携も有効なチームでは書き手が2人になる
2. **名前が無いときに `position` で拾うか。** 「推測せず、その遷移だけ動かさない」という案があった。
   いまは種類の中の `position` 最小を選ぶので、チームがワークフローを並べ替えると黙って別の状態へ書く
