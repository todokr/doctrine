# doctrine Intake 画面設計

- 日付: 2026-09-21
- 状態: 承認待ち
- issue: [#60](https://github.com/todokr/doctrine/issues/60)
- 前提: [overview](../../overview.md)、[Intake の PRD](../../prd/intake.md)、[Intake コア設計](2026-09-21-intake-core-design.md)、[レビューアプリ設計](2026-09-13-review-app-design.md)
- プロトタイプ: [`prototype/intake-ui.html`](../../../prototype/intake-ui.html)（例のデータで各面を辿れる。ブラウザで直接開く）

## 1. 位置づけ

コア設計 17 章は「アプリの画面と、PFD の図の描き方」を範囲外にして、この spec に委ねた。
本 spec はそれを決める。コアが渡すデータ（`IntakeSummary` `IntakeDetail` `ProcessStatus` `GhStatus` `WatchHealth`）と
RPC・イベント（コア設計 13 章）を前提にし、アプリ（`app/src/`）の側だけを扱う。

- Intake の画面は、既存の画面にない種類の面を 4 つ持つ。Intake ビューの一覧と選択、質問に答える面、PFD を読んで判断する面、進行中を見守る面である。
  部品を並列に作る前に、構成と部品の境界を決めるのが本 spec の役目である
- **画面に載せるのは、判断と操作に要るものだけである。** アプリの挙動を説明する文（何が起きるか、何が起きないか、なぜそうなるか）は画面に置かない。
  本 spec が画面に出すと書く文言は、状態の語・操作の名前・見出し・データの中身に限る
- 何を画面に載せるかの基準は、レビューアプリ設計と同じ「理解と判断に効くか」である
- 新しい依存パッケージは足さない。新しい色のトークンも足さない（ワークフローレール設計と同じ）
- コードは含まない。型と関数は名前とシグネチャだけを書き、中身は後続の実装が書く

## 2. 決定の要約

| 項目 | 決定 | 章 |
| --- | --- | --- |
| 画面の文言 | 判断と操作に要るものだけを置く。挙動を説明する文は置かない | 1 |
| レールの入口 | 最上部（「タスク」より上）に「Intake」を置く。`View` に `"intake"` を足す | 3 |
| 人の対応が要る数え方 | デーモンが渡す `IntakeSummary.needs_human` を数える。画面は状態から数え直さない。レールは点で示し、件数は `title` に出す | 3 |
| ビューの構成 | サイドバーが Intake の一覧、main が状態で振り分ける面。すべての面に共通の見出しを置く | 3 |
| Issue の選択 | 面の上端でプロジェクトを選び、gh から取った open な Issue の一覧と本文を並べる。番号・URL の直接入力も持つ | 4 |
| gh が使えないとき | 一覧の代わりに理由と直し方の箱を出す。gh の出力は等幅でそのまま添える | 4 |
| 質問の面 | 1 回分の質問を縦に並べ、全部に答えてから一度に送る。判断材料を選択肢より先に出す。推奨は選択肢の中に理由付きで示し、初めから選ばない | 5 |
| 回答の送信 | 確認のモーダルに `buildAnswerText` の文面を出し、その文面が会話に届く | 5 |
| PFD の図の描き方 | **Intake 専用の描画にする。** Review Guide の図の 5 つ目の種類にはしない。配置だけ `layoutGraph` を借りる | 6 |
| 状態の塗り分け | 承認後だけ、塗り・枠・印・語の 4 つで 8 状態を区別する。既存のトークンだけを使う | 6 |
| 段の見せ方 | 図の中のプロセスの段の数字だけで示す | 6 |
| コメントの印 | コメントのある要素の右上に件数の丸を付ける | 6 |
| 計画レビュー | 図と、選んだ要素の欄を並べる。要素と全体にコメントを付け、差し戻す・承認する | 7 |
| 差し戻しの文面 | `buildFeedback` を画面とデーモンが共有し、モーダルで送る文面を見せる | 7 |
| 承認 | 表示している案の `draft_id` と `hash` を送る。キーは割り当てない | 7 |
| 進行中の面 | 「操作が必要」を先頭に置き、状態で塗った図とプロセスの欄を出す | 8 |
| 改訂中の見せ方 | 状態ではなく、どの面の上にも出る帯（「改訂中」と「改訂をやめる」）と、操作の違いで表す | 8 |
| 過去の質問・案の読み返し | 面の下に畳んだ経緯として出す（PRD の Q-7・R-10） | 15 |
| 全タスクでの見せ方 | サイドバーの行に「Intake #N」の印、見出しに Intake へ戻るリンクを足す | 10 |
| 下書きの永続化 | `drafts.json` の中身を `{ tasks; intakes }` に変える。Rust は変えない | 11 |
| 部品の境界 | 純関数（`pfd.ts` `intake.ts`）と、props だけの表示部品（図・要素の欄・質問・判断材料）に分ける。図と質問はフィクスチャだけで作れる | 12 |
| コアへの追加 | `intake.draft`（案 1 件を中身込みで返す RPC）と `buildAnswerText`（回答の文面の純関数） | 13 |

## 3. 画面の構成とレールの入口（V-1・V-2・V-3・V-4・V-7・C-8）

### 3.1 レールとビュー

- レール（`app/src/components/Sidebar.tsx` の `Rail`）の**最上部**、「タスク」より上に「Intake」ボタンを置く。
  ボタンの並びは「Intake」「タスク」「終了したタスク」「設定」になる。`View`（`app/src/model.ts`）を `"tasks" | "done" | "intake"` に広げる
- 点（`pip`）は、既存のレビュー待ちと同じ作りにする。条件は `intakes.some((i) => i.needs_human)` である。
  **全プロジェクトを数える。** `countReview` が絞り込みに関係なく数えるのと同じ理由で、絞り込みの外にある対応を見逃さないためである
- 件数は点に出さず、ボタンの `title` に「Intake（対応が要るもの N 件）」と出す。既存のレビュー待ちが件数でなく点であることに揃える
- 数えるのは `IntakeSummary.needs_human` だけである。純関数 `countIntakeAttention(intakes: IntakeSummary[]): number` は
  `needs_human` が true の行を数える。状態から数え直すと、コア設計 5 章の `needsHuman`（`active` でプロセスに `your_turn` か `needs_attention` があるとき、を含む）と食い違うためである。
  1 つの Intake に「あなたの番」が 3 つあっても 1 件と数える

### 3.2 サイドバー（Intake の一覧）

`view === "intake"` のとき、サイドバーは Intake の一覧になる。区分と並びは次のとおりである。

| 区分 | 含めるもの | 並び |
| --- | --- | --- |
| 対応が要る | `needs_human = true` | 更新の古い順（待たせているものが上） |
| 調査・分解中 | `investigating` / `decomposing`（上限待ちを含む） | 更新の新しい順 |
| 進行中 | `active` で `needs_human = false` | 更新の新しい順 |
| 終了（既定で隠す。V-7） | `completed` / `canceled` | 終了の新しい順 |

- 各行に出すもの: Issue の番号とタイトル、状態の語のピル、`progress.done / progress.total`（承認前は出さない）、
  対応が要るなら ◆、改訂中なら「改訂中」、上限待ちなら「HH:MM 再開」、プロジェクトの色の点。
  Issue の番号は `issue_url` の末尾から表示用に取るだけで、参照には使わない（コア設計 3 章「番号を前提にしない」）
- 終了した Intake は、サイドバー見出しの切り替え（`seg`）「進行中 / すべて」で出す
- 見出しのプロジェクト絞り込み（既存の `<select>`）は Intake にも効く。「＋」は `intakeSel = "new"`（4 章）にする
- j/k は `intake` ビューでは Intake の一覧を動く。順は純関数 `intakeOrder(intakes, project, showClosed): IntakeSummary[]` が返す（上の表の区分順）

### 3.3 状態の持ち方

`State`（`app/src/model.ts`）に足すもの:

```ts
intakes: IntakeSummary[];
intakeSel: string | "new" | null;            // "new" は Issue の選択の面（4 章）
showClosedIntakes: boolean;
intakeDetails: Record<string, Loaded<IntakeDetail>>;
intakeGen: Record<string, number>;
intakeDrafts: Record<string, IntakeDraft>;   // 11 章
```

- 選択は `sel`（タスク id）と分けて `intakeSel` で持つ。タスクのビューへ戻ったときに、タスクの選択が消えないようにするためである
- 一覧の取得は `refresh()`（`app/src/store.tsx`）の `Promise.all` に足す。**`intake.list { include_closed: s.showClosedIntakes }` で取る。**
  `{}` 固定にすると、切り替えで出した終了分を 15 秒後の取り直しが消してしまう。
  `ratelimit.recent` と同じく `.catch(() => [])` を付け、Intake の取得が落ちてもタスクの一覧は出す。
  点の数え方は `needs_human` だけを見るので、終了分が混ざっても変わらない
- 詳細は選んだ Intake だけ `intake.get` で取る。`Loaded<IntakeDetail>` と世代（`intakeGen`）で古い応答を捨てる形は、`task.diff` と同じである
- イベント（コア設計 13 章）の扱い:
  - `intake.stateChanged`: 一覧の該当行の `state` と `revising` を書き換え、その Intake の詳細を捨てて取り直す
  - `intake.updated`: その Intake の詳細を捨てて取り直す

### 3.4 状態ごとの面（V-4）

Intake を開くと、main に状態に応じた面を出す。面は `state` で分ける。`revising` は状態ではないので、面ではなく帯と操作の違いで表す（8 章）。

| state | 面 | 章 |
| --- | --- | --- |
| `investigating` / `decomposing` | 経過の面（走っている実行、上限待ちなら再開時刻、`intake.logs` の末尾） | 9 |
| `answering` | 質問の面 | 5 |
| `reviewing` | 計画レビューの面 | 7 |
| `needs_attention` | 要確認の面（`AttentionReason` の種類ごとの内容、「やり直す」、ログ） | 9 |
| `active` / `completed` | 進行中の面 | 8 |
| `canceled` | 読むだけの進行中の面（操作なし） | 8 |

すべての面の上に共通の見出しを置く: Issue のタイトルと外部リンク、プロジェクト、状態のピル、改訂中の帯、「中止…」（終端でなければ。C-8。調査・分解・質問の段階からも中止できる）。

## 4. Issue の選択と gh が使えないとき（S-1〜S-6）

### 4.1 面の入口

- 「＋」で `intakeSel = "new"` にすると、Issue の選択の面（`IssuePicker`）が出る。上端でプロジェクトを選ぶ（絞り込みで 1 つに決まっていればそれ）
- 面を開いたとき、`github.status { project }` を取る。gh が使えるかはプロジェクトごとに違うため、プロジェクトを変えるたびに取り直す

### 4.2 gh が使えないとき（S-5）

`ok: false` なら、Issue の一覧の代わりに理由と直し方の箱を出す。文言は純関数 `ghGuidance(status)` が返す。

| reason | 見出し | 直し方 |
| --- | --- | --- |
| `not_installed` | gh が見つかりません | gh を入れる（https://cli.github.com）。デーモンの PATH から見えることも確かめる |
| `not_logged_in` | gh にログインしていません | 端末で `gh auth login` を実行する |
| `no_github_remote` | このリポジトリに GitHub の remote がありません | GitHub の remote を持つリポジトリで使う |

- `message`（gh の出力）は、そのまま等幅で添える。人が gh の言葉で調べられるようにするためである
- 「もう一度確かめる」ボタンで `github.status` を取り直す

### 4.3 Issue の一覧と開始（S-1〜S-4）

- `ok: true` なら `github.issues` を取る。既定は `assignee: "me"` で、切り替え（`seg`）「自分が担当 / すべて」を持つ（S-1）
- タイトル検索は、入力して Enter で `search` 付きで取り直す。打鍵のたびに gh を呼ばないためである
- 一覧の行は番号・タイトル・担当・更新を出す。`intake_id` がある行は「Intake あり」の印を付け、押すと開始ではなくその Intake を開く（S-3）
- 行を選ぶと、右に `github.issue` の本文とコメントを `Markdown` で出し、「Intake を開始」ボタンを置く（S-2）
- 番号か URL を直接入れる欄も持つ。純関数 `parseIssueInput(input: string, repo: { nameWithOwner: string }): string | null` が、
  `#123` / `123` / `https://github.com/<owner>/<repo>/issues/123` を URL にする。別のリポジトリの URL と空文字は `null` にする
- 開始は `intake.start` を呼ぶ。成功したら `intakeSel` を返ってきた id にする。`alreadyActive` が true でも同じで、新しく作らずに、進行中のその Intake を開く（S-3）。
  コアが失敗にしないのは、既存の id を返すためである（コア設計 13 章）
- S-4（同時に複数）は、画面に制限を置かないことで満たす。S-6（プロセスが 1 つ）は、画面に特別扱いを持たないことで満たす。プロセス 1 つの図もそのまま描ける

## 5. 質問に答える面（Q-2・Q-3・Q-6）

`answering` の Intake は、`intake_question_sets` の未回答の 1 行を面にする。Q-1・Q-4・Q-5・Q-8 はコアが担う。
Q-7（過去の質問と回答の読み返し）は、面の下に畳んだ経緯として出す。

- 1 回分の質問を縦に並べ、全部に答えてから一度に送る（Q-2・Q-6）。小出しに送る操作は持たない
- 質問 1 件のカードが持つもの: 番号、`prompt`、種類の語（**単一選択**／**複数選択**／**自由記述**）、判断材料、選択肢、「その他」、補足

### 5.1 判断材料の見せ方

判断材料 `Material` は、カードの中で**選択肢より先に**出す。材料を読んでから選ぶ順にするためである。

| kind | 描き方 |
| --- | --- |
| `text` | `Markdown`（`app/src/components/text.tsx`） |
| `table` | `caption` と `<table>`。既存の `th` の CSS を使う |
| `code` | `caption`・`path`（あれば）と、`highlightLines(code, language)` による等幅ブロック |
| `diagram` | `DiagramView`（Review Guide の図をそのまま） |

`MaterialView({ material })` は props だけで描く（12 章）。`DiagramView` は store を読まないので、そのまま入れられる。

### 5.2 選択肢と推奨

- `single` はラジオ、`multiple` はチェックで、各選択肢に `label` と `description` を出す。`free` は textarea である
- **推奨の理由（`recommendation.reason`）は、推奨の選択肢の中に出す。** その選択肢の `label` と `description` の下に「推奨」の印と理由を置く。
  `multiple` で推奨が複数あれば、推奨の選択肢それぞれに同じ理由を出す。カードの下にはまとめて出さない
- `free` に推奨があれば、推奨の答え（`recommendation.text`）と理由を、選択肢と同じ形の行で出す（`label` に当たる位置に答え、その下に「推奨」の印と理由）。この行は選べない。答えは textarea に自分で書く
- **推奨を、初めから選んだ状態にしない。** 押すだけで通る形は、推奨を読まずに承認する癖を作るためである。
  レビューアプリ設計 6 章が「見た」印を入れなかった理由と同じである。推奨を選ぶための専用のボタンも置かない。推奨の選択肢も、ほかと同じ操作で選ぶ
- どの質問にも「その他（選択肢以外の答え）」と「補足」の欄を持つ（Q-3）。`Answer` の `other` と `note` に対応する

### 5.3 送る前の確かめ

- 送れるかは純関数 `answerIssues(questions: Question[], answers: Answer[]): { questionId: string; message: string }[]` で決める。
  規則はコア設計 8 章の回答の検証と同じである（全問に答えがある、`single` は 1 つか `other`、選択肢 id が存在する）。
  空でなければ送信ボタンを止め、足りない質問のカードに印を付ける。デーモンが弾く前に画面で気づけるようにするためである
- 「回答を送る…」で確認のモーダルを開く。モーダルは `buildAnswerText(questions, answers)`（13 章）の文面を `<pre>` で出し、「送る」で `intake.answer` を呼ぶ。
  差し戻しの確認と同じ作法で、送る前に会話へ届く文面を見せる。送れたときだけ下書きを消す（11 章）
- 回答中の入力は下書きに残し、アプリを閉じても消えない

## 6. PFD の図（R-2・R-3・R-4・R-7・V-5・C-3・D-2）

### 6.1 決定: Intake 専用の描画にする

**Review Guide の図の 5 つ目の種類にはせず、Intake 専用の描画にする。ただし層配置は `layoutGraph` を借りる。**

- Review Guide の `Diagram`（`shared/guide/schema.ts`）は、ガイドを書くエージェントへの指示を兼ねたスキーマである。
  5 つ目を足すと、ガイドの書き手が出してはいけない形がスキーマに混ざる
- PFD のノードは成果物とプロセスの 2 種で、形・担い手・`given`・goal・8 状態・コメントの印・選択・固定の印を持つ。
  `Diagram` の同質なノード `{ id, label, change }` には載らない
- 一方、配置の問題（左から右への層、交差を減らす並び）は同じである。`layoutGraph` をアダプタ越しに使い、配置の計算を 2 つ持たない
- 前の案からの差分（追加・削除・変更）は、`Change`（`app/src/diagram.ts`）と同じ軸である。型と見た目（枠の色）は再利用する
- Mermaid は採らない。PFD 分解 spec 9 章の試作は Mermaid を CDN から読むので、R-2 の「ネットワークが無くても描ける」に反する。バンドルに入れると新しい依存になる

### 6.2 置き場所と形

純関数は `app/src/pfd.ts` に置く（テストは `app/src/pfd.test.ts`）。副作用を持たない。`app/src/rail.ts` と同じ流儀である。

```ts
export type PfdNodeKind = "artifact" | "process";
export type PfdLook = "waiting" | "ready" | "running" | "pr_open" | "merged" | "your_turn" | "done" | "needs_attention";
export type PfdNode = {
  id: string; kind: PfdNodeKind; label: string;
  x: number; y: number; w: number; h: number;
  human: boolean;        // actor: human のプロセス
  given: boolean;        // 最初から揃っている成果物
  goal: boolean;         // 末端の成果物（Pfd.goal）
  decision: boolean;     // 決定の記録から来た成果物
  stage: number | null;  // プロセスの段（1 始まり）。成果物は null
  look: PfdLook | null;  // 承認前は null（塗らない）
  available: boolean;    // 成果物が揃っているか（承認後だけ意味を持つ）
  comments: number;      // この要素へのコメント数（下書き＋送ったもの）
  change: Change | null; // 前の案からの変化
  frozen: boolean;       // 改訂で変えられない
};
export type PfdEdge = { from: string; to: string; d: string };
export type PfdView = {
  width: number; height: number;
  nodes: PfdNode[]; edges: PfdEdge[];
  removed: { id: string; kind: PfdNodeKind; label: string }[];
};

export function buildPfdView(pfd: Pfd, o?: {
  statuses?: Record<string, ProcessStatus>;   // 承認後だけ渡す。キーは process id
  comments?: Record<string, number>;
  previous?: Pfd;
  frozen?: ReadonlySet<string>;
}): PfdView;
export function processStages(pfd: Pfd): string[][];                                      // 段ごとのプロセス id。図の段の数字のためだけに使う
export function frozenIds(pfd: Pfd, processes: IntakeDetail["processes"]): Set<string>;   // C-3 の固定集合
export const LOOK: Record<PfdLook, { word: string; mark: string; cls: string }>;
```

`Pfd` `ProcessStatus` `IntakeDetail` は `shared/intake/` の型である（コア設計 6・11.4・13 章）。`PfdView` は、承認前の案でも承認後の計画でも同じ形で返す。

### 6.3 配置

- 成果物とプロセスを 1 つの `kind: "dependency"` のグラフに写し、`layoutGraph` の座標を使う。`diagram.ts` は変えない
- 辺は「入力の成果物 → プロセス」「プロセス → 出力の成果物」である。左から右へ、成果物とプロセスの層が交互に並ぶ
- ノードの並びは `pfd.artifacts` → `pfd.processes` の順で渡す。同じ層は渡した順に上から置かれるので、同じ案は毎回同じ配置になる
- **ノード id の衝突を避ける。** 成果物とプロセスの id は別々の名前空間なので、アダプタは `a:<id>` と `p:<id>` の接頭辞を付けて `layoutGraph` へ渡し、戻ってきた座標を元の id に写す
- `GraphBody` は `diagram.ts` の外へ export されていない。アダプタは `Parameters<typeof layoutGraph>[0]` の形で値を作る。型の export を足すかどうかは実装が決める（`diagram.ts` の変更はその 1 行に限る）
- PFD は検証で閉路が無いので、戻る辺は出ない。`dropped`（描けなかった辺）は 0 になるはずで、0 でなければ実装の誤りである

### 6.4 段（D-2）

- プロセスの段は「入力を出すプロセスの段の最大 + 1」とする。入力がすべて `given` なら 1 である。同じ段のプロセスは並列に走れる。`processStages` が段ごとのプロセス id を返す
- **段は、図の中のプロセスの左上に出す小さな数字（「1」「2」…）だけで示す。** 図の下に段ごとの一覧は置かない

### 6.5 形と印

| 対象 | 見た目 |
| --- | --- |
| 成果物 | 角の小さい四角（`rx` 4） |
| プロセス | 両端の丸い形（`rx = h / 2`） |
| 人のプロセス | 二重の枠と「人」の印 |
| `given` の成果物 | `--surface-2` の塗りと「既存」の印 |
| 決定の成果物 | 「決定」の印 |
| goal の成果物 | 太い枠（2px）と「◎」 |

形と印の両方で区別するのは、色だけに頼らないためである。

### 6.6 状態の塗り分け（V-5・W-9）

承認後だけ塗る。承認前の案は塗らない（`statuses` を渡さないと、全ノードの `look` は null になる）。
既存のトークンだけを使い、塗り・枠・印・語の 4 つで区別する。`your_turn` `pr_open` `ready` が、どれも「人を待つ・注意」系の色に寄りやすいので、塗りだけでなく印と語でも分ける。
文章版は持たないので、色に頼らずに区別できるかは、この印と語だけで決まる。

| ProcessStatus | 塗り | 枠 | 印 | 語 |
| --- | --- | --- | --- | --- |
| `waiting` | なし | 破線 `--line` | なし | 入力待ち |
| `ready` | なし | 実線 `--ink-3` | ▷ | 着手可能（`blockedBy` があれば、「改訂中」「一時停止中」「sub-issue 待ち」の語を添える） |
| `running` | `--run-bg` | `--run` | ⟳ | 実行中 |
| `pr_open` | `--run-bg` | `--run` の太線 | PR | PR レビュー中 |
| `merged` | `--ok-bg` | `--ok` | ✓ | マージ済み |
| `your_turn` | `--accent-soft` | `--accent` の太線 | ◆ | あなたの番 |
| `done` | `--ok-bg` | `--ok` | ✓ | 完了（人） |
| `needs_attention` | `--danger-bg` | `--danger` | ! | 要確認（`task_stopped` / `no_pr` / `pr_closed` を語で添える） |

- 成果物は、揃っていれば `--ok-bg`、まだなら塗らない
- `LOOK` が状態ごとの語・印・CSS クラスを持つ。図と 8 章の欄が同じ語を使うためである
- 上限待ちと watch の失敗は図に出さない。図の状態はプロセスのものに限る（見張りの失敗は 8.3 の箱で出す）

### 6.7 前の案からの変化（R-7）

- 追加・変更は、枠の色（`--ok` / `--accent`）と「＋」「～」の印で重ねる。塗りは状態、枠の色は変化という別の軸として重ねる
- 削除された要素は、図に描かない。今の案の配置に居場所が無いためである。図の下に「前の案から消えた要素」として一覧にする（`PfdView.removed`）
- 差分は `shared/intake/` の純関数（コア設計 9 章。2 つの案の正規化 JSON を id ごとに比べる）で求める。`previous` に前の案を渡す

### 6.8 コメントの印と固定の印

- **コメントの印（R-4）**: コメントのある要素の右上に、件数の丸（`--accent`）を出す。全体へのコメントは図の外（面の下の欄。7 章）に件数を出す
- **固定の印（C-3）**: 固定集合はコア設計 6 章のとおり、「`current_task_id` を持つか `human_done_at` のあるプロセス」と、その入力と出力の成果物である。
  画面では `frozenIds` が、「`task_ids` が空でない、または状態が `done` のプロセス」と、その入出力として求める。人のプロセスを落とさないためである。
  改訂中は、固定集合の要素に「固定」の鍵の印と薄い塗りを付ける。固定の要素にはコメント欄を出さない

### 6.9 選択・大きさ

- **要素の選択**: ノードは `<g role="button" tabIndex={0}>` とする。クリックか Enter で選び、選んだ要素は枠を強調する。選んだ要素の定義は、図の横の欄（7 章・8 章）に出る
- **大きさ**: 横にはみ出したら、横スクロールの入れ物に入れる（ワークフローレールと同じ）。拡大・パン・ドラッグは持たない
- **ネットワーク無しで描ける**: 手書きの SVG だけで描き、外部の読み込みを持たない

### 6.10 部品

`app/src/components/PfdDiagram.tsx` に置く。store を読まない。

```ts
export function PfdDiagram(p: {
  view: PfdView;
  selected: string | null;
  onSelect: (id: string) => void;
}): JSX.Element;
```

## 7. 計画レビューの面（R-1〜R-9・C-2・C-4）

`reviewing` の Intake の面（`PlanReview`）である。R-1 の通知はコア（既存の通知の仕組み）が担い、画面は一覧と点で示す（3 章）。

### 7.1 構成

- 見出し: 共通の見出しに「N 回目の案」（`seq`）と、案が届いてからの時間を足す
- 本体: 上に図（6 章）、その右に選んだ要素の欄を置く。欄は、ガイドの欄と同じく sticky にする。
  何も選んでいなければ、計画の題名と goal を出す

### 7.2 要素の欄（R-3）

部品 `PfdElementPanel` が描く。props だけで完結する。

| 要素 | 出すもの |
| --- | --- |
| 成果物 | 名前・id・`description`・`verify`（確かめ方）・`given` か決定か（決定なら、その質問と回答の文を出す）・**前段**（その成果物を作るプロセス）・**後続**（その成果物を使うプロセス）。前段と後続は、押すとそのプロセスを選ぶ。該当が無いときは「なし」とだけ出す |
| プロセス | 名前・id・担い手・`purpose`・`steps`・`done_when`・入力と出力（押すと選ぶ）・段 |

- エージェントのプロセスは、「タスクのプロンプト」を畳んで置く。開いたときに `intake.processPrompt { intake_id, draft_id, process_id }` を取る。
  コアが、実際にタスクになったときの prompt と同じ関数で作る（コア設計 9・11.5 章）
- 欄の下に、その要素へのコメント欄（R-4）を置く。前の回のその要素へのコメントと、エージェントの返答（`replies`。R-7）があれば並べる

### 7.3 コメントと下書き（R-4）

- 全体へのコメントは、下の判断の欄（`ReviewView` の `footer.decide` と同じ位置）の textarea に書く
- 下書きは 11 章の `IntakeDraft` である。コメントは `{ target_kind, target_id, body }`（コア設計 13 章の `NewComment`）で持つ。図の印と件数はここから数える
- コメントのあるところが図の上で分かる。印は 6.8 のとおり

### 7.4 差し戻し（R-5・R-6）

- 「差し戻す…」は、コメントが 1 つ以上のときだけ押せる。純関数 `canRejectIntake(draft)` で決める
- 押すとモーダルを開く。`buildFeedback(pfd, comments)`（コア設計 9 章）の文面を `<pre>` で出し、その `comments` を `intake.reject { intake_id, draft_id, comments }` で送る。
  **画面とデーモンが同じ関数を使うので、見た文面と届く文面は食い違わない**
- 成功したら下書きを消す。`sendDecision`（`app/src/decision.ts`）の作法に従い、成功したときだけ後片付けをする
- R-6（同じ会話の続きとして届く）はコアが担う

### 7.5 承認（R-8・R-9）

- 「承認する」は、表示している案の `draft_id` と `hash` を `intake.approve` に送る
- 失敗（案が新しくなった、状態が変わった）は、トーストで理由を出し、詳細を取り直す。承認は表示していた案に対して記録されるので、案が変わっていれば失敗して構わない
- 承認にキーは割り当てない。既存の承認・差し戻しにキーを割り当てていないことに揃える
- 承認の操作は画面にしか無い（R-9）。保証はコア設計 6 章である

### 7.6 前の案との比較（R-7）

2 回目以降の案では次を出す。

- 図の変化の印（6.7）と、凡例「前の案からの変化」
- 前の回のコメントとその返答の一覧（コメントごとに「対象の要素 → 返答」）
- 前の案の中身は `intake.draft`（13 章）で取る。`IntakeDetail.drafts` は最新の案だけ中身込みで返すためである

## 8. 進行中の面（V-5・H-1〜H-4・C-1〜C-7・W-4・W-9〜W-12・D-2）

`active` / `completed` / `canceled` の面（`IntakeProgress`）である。`canceled` は読むだけで、操作を出さない。

### 8.1 操作が必要

見出しの下の先頭に、「操作が必要」の欄を置く（PRD 2.1 の目標 5）。次の 2 種を並べる。

- **`your_turn` のプロセス（H-1・H-2）**: プロセスの目的と完了条件、「決めた内容」の textarea、「完了を記録する」ボタン。
  - 内容は必須で、空白だけは不可である（コアも同じ規則で弾く）。空のあいだは「完了を記録する」を押せない
  - 「完了を記録する」は `intake.completeHumanProcess` を呼ぶ。成功したときだけ、下書きの内容を消す
- **要確認のプロセス（C-6）**: 理由の語、そのタスクへのリンク、「再投入する」ボタン（`intake.redispatch`）

### 8.2 図とプロセスの欄（V-5）

- 図（6 章）を状態で塗って出す。表示するのは承認された案（`approval.draft_id`）である。最新の案と違えば `intake.draft` で取る
- プロセスを選ぶと、7.2 と同じ定義に加えて、次の 3 つを**それぞれ別の欄（見出し付き）**で出す。1 つの欄にまとめない。

  | 欄の見出し | 出すもの |
  | --- | --- |
  | sub-issue | sub-issue のリンク |
  | タスク | `task_ids`。今のものを先頭に置き、古いものを続けて並べる。押すと `view = "tasks"` にして、そのタスクを選ぶ（既存のタスク画面・レビュー画面へ移る） |
  | PR | PR のリンクと状態 |

### 8.3 見張りの健全さ（W-12）

`watch.consecutiveFailures > 0` なら、「GitHub の確認に N 回続けて失敗しています」の箱を出す。`lastError` と、最後に成功した時刻を添える。
進行中の失敗は Intake の状態を変えない（コア設計 5 章）ので、この箱が唯一の知らせになる。

### 8.4 操作

| 操作 | RPC | 要求 |
| --- | --- | --- |
| いま確認する | `intake.refresh` | W-4 |
| 自動投入を一時停止 / 再開 | `intake.setDispatchPaused` | W-10 |
| 改訂に入る… | 8.5 | C-1 |
| 中止… | 8.6 | C-7 |
| Issue を閉じる（完了したとき） | `intake.closeIssue` | W-11 |

### 8.5 改訂（C-1〜C-5）

- 「改訂に入る…」で、承認済みの図にコメントを付けるモードになる。固定の要素にはコメントできない（6.8）
- コメントが 1 つ以上あれば「改訂を始める」が押せる。`intake.revise { intake_id, comments }` を呼ぶ
- 改訂中（`revising = true`）は、どの面の上にも帯を出す。**帯に置くのは「改訂中」の語と、「改訂をやめる」ボタン（C-5。`intake.abandonRevision`）だけである。** 説明の文は置かない
- 改訂中の計画レビューでは、新しい案を固定の印付きで出す。承認済みの案からの変化を、6.7 の印で示す。再承認（C-4）は 7.5 と同じ操作である

### 8.6 中止（C-7・C-8）

- 確認のモーダルを出す。`active` なら、次の 2 つを選ばせる。
  - そのままにする（`leave`）
  - タスクを止め、sub-issue を取りやめとして閉じる（`stop`）
- 承認前（`active` でない）は選択肢を出さず、`leave` で送る。止めるタスクも閉じる sub-issue も無いためである

### 8.7 完了

`completed` の面は、見出しを「完了しました」とする。その下に、全プロセスの結果の図と「Issue を閉じる」を出す。

## 9. 調査中・分解中・要確認の面（Q-1・D-5）

### 9.1 経過の面

`investigating` / `decomposing` の面である。

- 走っている実行の `purpose`（調査・分解・改訂）と、経過時間
- 上限待ちなら、`rate_limited_until` の時刻
- `intake.logs` の末尾。「読み込み直す」ボタンと `intake.updated` で取り直す。ライブ配信は範囲外である（16 章）

### 9.2 要確認の面

`needs_attention` の面である。`AttentionReason` の種類ごとに、次を出す。

| kind | 出すもの |
| --- | --- |
| `agent_failed` | `message` |
| `invalid_output` | 違反（`issues`）の一覧 |
| `wrote_repository` | 書き換えたパス（`paths`）の一覧 |

どの種類にも「やり直す」ボタン（`intake.retry`）とログを出す。改訂中の `needs_attention` でも同じ面である。
sub-issue の失敗にはこの面を使わず、8.3 の箱で見せる。`intake.retry` は sub-issue の失敗には使えない（コア設計 13 章）。

## 10. 全タスクでの Intake 由来のタスク（V-6）

- `Task`（`app/src/types.ts`）に `intake: { id: string; processId: string; issueUrl: string | null; parentIssueUrl: string | null } | null` を足す。
  `toTask`（`app/src/model.ts`）が、`TaskSummary` の 4 列（`intake_id` `intake_process_id` `issue_url` `parent_issue_url`。コア設計 12 章）から作る
- サイドバーの行（`Item`）の下段に、「Intake #<親 Issue の番号>」の小さな印を足す。タイトルはプロセス名のままにする（W-8）
- タスク画面・レビュー画面の見出し（`Crumbs`）に、「Intake: <Issue のタイトル> / <プロセス id>」のリンクを足す。押すと `view = "intake"`・`intakeSel = intake.id` にする。
  Issue のタイトルは `s.intakes` から引く。無ければ番号だけを出す
- Intake 由来のタスクは、通常のタスクとして「全タスク」の区分に並ぶ。Intake をタスクの一覧に混ぜることはしない（PRD 5.2。18 章）

## 11. 下書き

```ts
export type IntakeDraft = {
  /** 計画レビュー・改訂のコメント（NewComment と同じ形） */
  comments: { target_kind: "artifact" | "process" | "whole"; target_id: string | null; body: string }[];
  /** 回答中の答え。question_set_id が変わったら捨てる */
  answers: { questionSetId: number; answers: Answer[] } | null;
  /** 人のプロセスの「決めた内容」。キーは process_id */
  notes: Record<string, string>;
};
```

- 保存先は既存の `drafts.json` のままにし、中身の形を `{ tasks: Record<string, Draft>; intakes: Record<string, IntakeDraft> }` に変える。
  `loadDrafts` / `saveDrafts`（`app/src/daemon/client.ts`）の型をこの形に書き換え、参照を全部書き換える。
  Rust 側（`app/src-tauri/src/lib.rs`）は `serde_json::Value` のまま中身を見ないので、変更は要らない
- 古い形の読み替えは作らない。doctrine にはまだ利用者がいない
- 送れたときだけ消す。対象は、差し戻し・承認・回答・完了の記録・改訂の開始である。失敗したときは残す
- Intake が一覧から消えたら、その下書きを捨てる（タスクの下書きが `sync` の `keep` で捨てられるのと同じ）

## 12. 部品の境界

| 層 | 置き場所 | 条件 |
| --- | --- | --- |
| 純関数 | `app/src/pfd.ts`（図のモデル）、`app/src/intake.ts`（`countIntakeAttention` `intakeOrder` `parseIssueInput` `answerIssues` `canRejectIntake` `ghGuidance` など画面の導出） | 副作用を持たず、vitest でテストする |
| 表示だけの部品 | `PfdDiagram`、`PfdElementPanel`、`QuestionCard` / `QuestionForm`（`{ questions; answers; onChange }`）、`MaterialView`（`{ material }`） | store を読まず props だけで完結する |
| 画面 | `IntakeView`（状態で面を振り分ける）、`IssuePicker`、`PlanReview`、`IntakeProgress`、Intake のサイドバー（`Sidebar.tsx` の中で `view === "intake"` のとき）、モーダル（回答の確認・差し戻しの確認・中止） | store を読み、RPC を呼ぶ |

- 「フィクスチャで作れる」とは、store を読まず props だけで完結し、描く中身を純関数で作ってテストできる形のことである。
  既存の `DiagramView` と `rail.ts` の形である
- **図の部品と質問の部品は、`shared/intake/` の型のフィクスチャだけで描けること。** 画面の State と RPC に依存しない。
  Intake の標本は `app/src/fixtures.ts` に足す。`fixtures.ts` は「テスト用の標本。画面はこれを使わない」という既存の位置づけを変えない
- 次の 4 単位で、作業を並列に分けられる。

  | 単位 | 中身 | 互いに待つもの |
  | --- | --- | --- |
  | 図の部品 | `pfd.ts`・`PfdDiagram`・`PfdElementPanel` | `shared/intake/` の型だけ |
  | 質問の部品 | `intake.ts` の `answerIssues`・`QuestionForm`・`MaterialView` | `shared/intake/` の型だけ |
  | 画面の骨格とストア | `View`・`State`・`refresh`・サイドバー・面の振り分け・`IssuePicker`・下書き | コアの RPC の型 |
  | タスク側の紐づけ | `Task.intake`・`toTask`・`Item` の印・`Crumbs` のリンク | コアの `TaskSummary` の列 |

- 計画レビュー・進行中・経過・要確認の面（`PlanReview` `IntakeProgress` ほか）は、図の部品と質問の部品と画面の骨格が揃ってから組む

## 13. コアへの追加

コア設計 13 章の RPC と `shared/intake/` に、画面の都合で次の 2 つを足す。ワークフローレール設計 3 章が `task.get` に `steps` を足したのと同じ書き方である。コア設計の本文は書き換えない。

- **`intake.draft`** — `{ intake_id; draft_id } → { id: number; seq: number; pfd: Pfd; hash: string; replies: CommentReply[]; created_at: string }`。
  コア設計 13 章の `IntakeDetail.drafts` は最新の案だけ中身込みである。次の 2 つは最新でない案の中身を要る。
  - R-7 の、前の案からの差分（7.6）
  - 改訂中に、承認済みの案と新しい案を並べて見ること（8.2・8.5）

  `IntakeDetail` に全部の案の中身を載せると、取り直しのたびに重くなる。そのため 1 件ずつ取る形にする
- **`buildAnswerText(questions: Question[], answers: Answer[]): string`** — `shared/intake/` の純関数。
  コア設計 8 章の「人が答えた内容を会話へ返す文面は `shared/intake/` の純関数で作る」に名前を与える。画面のモーダルとデーモンが同じ関数を使う

## 14. テスト

後続の実装が書くテストである。この spec の作業自体はコードを含まないので、テストを追加しない。

`app/src/pfd.test.ts`

- 「buildPfdView: 成果物とプロセスが交互の層に並ぶ」— 成果物 3・プロセス 2 の直列の PFD → プロセスの `x` が入力の成果物より右、出力の成果物より左
- 「buildPfdView: 承認前は塗らない」— `statuses` 無し → 全ノードの `look` が null
- 「buildPfdView: ProcessStatus を LOOK に写す」— 8 種それぞれ → 同名の `look`、`LOOK[look].word` が 6.6 の表の語
- 「buildPfdView: given・goal・human・decision の見分け」— それぞれを持つ標本 → 対応するフラグが true
- 「buildPfdView: コメントの件数」— `comments: { p1: 2 }` → `p1` の `comments` が 2、ほかは 0
- 「buildPfdView: 前の案からの変化」— 1 要素を足し・1 要素を変え・1 要素を消した `previous` → `change` が `added` / `changed`、消えた要素は `removed` の一覧にだけ出る
- 「buildPfdView: プロセスの段」— 直列の 2 つのプロセス → `stage` が 1・2、成果物の `stage` は null
- 「processStages: 並列に走れる組」— 入力が given だけのプロセス 2 つと、その両方の出力を入力に取るプロセス 1 つ → `[[a, b], [c]]`
- 「frozenIds: 投入済みのプロセスと入出力」— `task_ids` を持つプロセス 1 つ → そのプロセスと入出力の成果物の id
- 「frozenIds: 完了を記録した人のプロセスも固定に入る」— 状態が `done` の人のプロセス 1 つ（`task_ids` は空）→ そのプロセスと入出力の成果物の id。`waiting` のプロセスは入らない

`app/src/intake.test.ts`

- 「countIntakeAttention: needs_human だけを数える」— needs_human が true 2・false 3 → 2
- 「intakeOrder: 対応が要るものが先頭」— 区分の順と、既定で終了を含まないこと
- 「parseIssueInput: 番号と URL」— `#12` / `12` / 同じリポジトリの URL → URL、別リポジトリの URL・空文字 → null
- 「answerIssues: 未回答と single の複数選択」— 1 問未回答 → その質問の指摘 1 件、`single` で 2 つ選択 → 指摘、`single` で `other` だけ → 指摘なし
- 「canRejectIntake: コメントが無いと押せない」— コメント 0 → false、全体へのコメント 1 → true
- 「ghGuidance: 理由ごとの直し方」— 3 つの reason → 4.2 の表の見出しと直し方

`app/src/model.test.ts`

- 「reduce: intake.stateChanged で一覧の状態を書き換え、詳細を捨てる」
- 「toTask: Intake の紐づけ列を写す」— 4 列あり → `intake` が埋まる、`intake_id` null → `intake` が null

## 15. PRD の要求との対応

PRD 7 章の V・S・Q・R・H・C の要求について、画面が担うものが本 spec のどの章で満たされるかを示す。
画面が担わないものは「コア」または「画面では扱わない」と書き、コア設計の章を併記する。S の要求は同じ表に入れる。

| 要求 | 章 |
| --- | --- |
| V-1 | 3.1（レールの入口） |
| V-2 | 3.2（一覧の行と区分） |
| V-3 | 3.1（`countIntakeAttention`） |
| V-4 | 3.4（面の対応表） |
| V-5 | 6.6（塗り分け）、8.2（プロセスの欄） |
| V-6 | 10 |
| V-7（S） | 3.2（「進行中 / すべて」）、3.3（`include_closed`） |
| S-1 | 4.3 |
| S-2 | 4.3 |
| S-3 | 4.3（「Intake あり」の印と `alreadyActive`） |
| S-4 | 4.3（画面に制限を置かない） |
| S-5 | 4.2（直し方の表） |
| S-6（S） | 4.3（特別扱いを持たない）。判定はコア（コア設計 6・11） |
| Q-1 | コア（コア設計 7・10）。画面は 9.1 の経過の面 |
| Q-2 | 5（まとめて 1 回で答える） |
| Q-3 | 5.2（その他と補足） |
| Q-4 | コア（コア設計 7）。画面は質問の面を経ずに分解中へ進むだけ |
| Q-5 | コア（コア設計 4・6）。画面は 7.2 の要素の欄で決定の成果物を示す |
| Q-6 | 5（まとめて答える）。起こすのはコア（コア設計 5・7） |
| Q-7 | 面の下に畳んだ経緯として出す（経緯はコアが追記だけの表で保持する。コア設計 4・13） |
| Q-8 | コア（コア設計 7）。画面は 6.5 の人のプロセスの形 |
| R-1 | コア（コア設計 5・9）。画面は 3.2 の一覧と点 |
| R-2 | 6（専用の描画、6.9 のネットワーク無し） |
| R-3 | 7.2（要素の欄と `intake.processPrompt`） |
| R-4 | 6.8（印）、7.3（コメント欄）、11 |
| R-5 | 7.4 |
| R-6 | コア（コア設計 7・9）。画面は 7.4 の送信 |
| R-7（S） | 6.7（変化の印）、7.6（返答）、13 |
| R-8 | 7.5（`draft_id` と `hash`） |
| R-9 | 7.5（操作は画面だけ）。保証はコア設計 6 |
| R-10 | 面の下に畳んだ経緯として出す。前の案の中身は `intake.draft` で取る（経緯はコアが追記だけの表で保持する。コア設計 4・13） |
| H-1 | 8.1（操作が必要の欄）、3.1（点） |
| H-2 | 8.1 |
| H-3 | コア（コア設計 11.5・11.6）。画面は載ることを示さない |
| H-4 | 8.1。保証はコア設計 11.6 |
| C-1 | 8.5（改訂に入る・帯） |
| C-2 | 8.5、7 |
| C-3 | 6.8（固定の印）、8.5。検証はコア設計 6 |
| C-4 | 7.5、8.5（再承認）。sub-issue の整えはコア設計 10 |
| C-5（S） | 8.5（改訂をやめる） |
| C-6 | 8.1（再投入） |
| C-7 | 8.6（中止のモーダル） |
| C-8 | 3.4（共通の見出しの中止）、8.6 |

画面が担う W の要求と D-2 も、同じ形で示す。

| 要求 | 章 |
| --- | --- |
| W-4 | 8.4（いま確認する） |
| W-9 | 6.6（塗り分け）、8.2 |
| W-10（S） | 8.4（一時停止・再開） |
| W-11 | 8.4・8.7（Issue を閉じる） |
| W-12 | 8.3（見張りの健全さ） |
| D-2 | 6.4（図の中の段の数字） |

## 16. 範囲外

- 通知（N-1）とトレイ。既存の仕組みが拾う
- `dctl` の表示（N-2）
- PFD を画面で直接編集すること（PRD 12 章）
- 図の拡大・パン・ドラッグ、交差を最小にする高度な配置
- Intake の実行ログのライブ配信（`intake.logs` で読むだけにする）
- Linear
- 実装そのもの（本 spec はコードを含まない）

## 17. 決めていないこと

- プロセスが数十を超えたときの図の読みやすさ。`layoutGraph` は数十ノードを前提にしている。成功の基準（PRD 10 章）を回して見直す
- 判断材料に、スクリーンショットなど図以外の種類が要るか（コア設計 18 章と同じ）
- Issue 一覧の検索を gh に投げる頻度。Enter で投げる形で足りるか

## 18. 検討して採らなかった案

- **Review Guide の図に 5 つ目の種類（`pfd`）を足す。** ガイドの書き手への指示を兼ねるスキーマに、書き手が出してはいけない形が混ざる。PFD のノードは `Diagram` の同質なノードに載らない（6.1）
- **Mermaid で描く。** CDN から読むのでネットワークが要る。バンドルすれば新しい依存になる（6.1）
- **推奨の選択肢を初めから選んでおく。** 推奨を読まずに承認する癖を作る（5.2）
- **「推奨を選ぶ」ボタンを置く。** 推奨の選択肢を、ほかの選択肢と別の操作で選ばせる理由が無い。推奨は選択肢の中に理由付きで見せれば足りる（5.2）
- **図の文章版と、図の下の「着手の順」の一覧を置く。** 段は図の中の数字で読めれば足りる。状態は印と語で区別する（6.4・6.6）
- **画面の挙動を説明する文を添える。** 判断と操作に要らない（1 章）
- **Intake をサイドバーのタスクの一覧に混ぜる。** Intake はタスクではない（PRD 5.2）。混ぜると `sel` の意味が崩れる。Intake 由来のタスクだけを通常のタスクとして並べ、印で戻れるようにする（10 章）
- **レールに件数の数字を出す。** 既存のレビュー待ちの点と揃える。件数は `title` に出す（3.1）
- **`IntakeDetail` に全部の案の中身を載せる。** 取り直しのたびに重くなる。`intake.draft` で 1 件ずつ取る（13 章）
- **状態から人の対応が要る件数を数え直す。** デーモンの `needsHuman` と食い違う（3.1）
