# 8. テスト

テストが実質的な仕様である。挙動を変えるときは、まず該当するテストを読んで何が固定されているかを確かめる。

## 8.1 置き場と走らせ方

| 対象 | 置き場 | 書き方 | 全部 |
| --- | --- | --- | --- |
| core | `core/test/`（`src/` とほぼ同じ構成 ＋ `helpers/`、`integration/`、`guide/`、`diff/`） | `@std/testing/bdd` の `test` ＋ `node:assert/strict` | `mise run core:test` |
| app（TypeScript） | `app/src/*.test.ts(x)`、`app/src/components/*.test.tsx` | Vitest。DOM を使わず `renderToStaticMarkup` の HTML 文字列を検査する | `mise run app:test` |
| app（Rust） | `app/src-tauri/src/*.rs` の `#[cfg(test)]`、`app/src-tauri/tests/relay.rs` | `#[tokio::test]`。関数名は日本語 | `cd app/src-tauri && cargo test --locked` |

### 1 つだけ走らせる

```bash
# core: 1 ファイル / テスト名の部分一致 / 正規表現
cd core
deno test --allow-all test/domain/states.test.ts
deno test --allow-all test/domain/states.test.ts --filter "waiting"
deno test --allow-all test/ --filter "/open-pr/"

# app: 1 ファイル / テスト名の部分一致
pnpm -C app exec vitest run src/model.test.ts
pnpm -C app exec vitest run src/model.test.ts -t "テスト名の一部"

# Rust: 結合テストだけ / 1 ケース / ライブラリ内だけ
cd app/src-tauri
cargo test --test relay
cargo test --test relay 応答が逆順
cargo test --lib relay::
```

- core のテストは `--allow-all` が要る。実際に `git init` や `git worktree` を作り、git・sh・偽の gh を子プロセスで起動し、`DOCTRINE_STATE_DIR` を書き換える
- CI は `TZ=UTC` と `TZ=Asia/Tokyo` の 2 通りで回す。時刻を扱う変更は手元でも `TZ=UTC deno task test` を試す
- テスト名・コメント・エラーメッセージは日本語で書く

## 8.2 core のヘルパー（`core/test/helpers/`）

| ファイル | export | 用途 |
| --- | --- | --- |
| `repo.ts` | `makeRepo(root, files)` | 使い捨ての git リポジトリを作り、ファイルを書いて最初のコミットまで済ませる。`user.email` / `user.name` をリポジトリに設定するので、CI の git 設定に依らない |
| | `until(pred, timeoutMs, description)` | 非同期に進む状態を 10ms ごとに見て待つ |
| | `tickWhenIdle(ctx)` | 走っているタスクが無くなってから `tick` を 1 回呼ぶ（再入ガードに阻まれないため） |
| `tracker.ts` | `fakeTracker()`、`constTrackerOf()` | **状態を持たない**軽い偽トラッカー。Issue を読むだけのテストと、`DaemonContext` を組むだけのテストで使う |
| `fakeTracker.ts` | `fakeTracker({ kind })` | **状態を持つ**偽トラッカー（名前が同じだが別物）。sub-issue の作成・検索・更新・クローズを内部に反映し、`failWhen` で失敗させ、`loseCreateResponseWhen` で「作成されたが応答が届かない」を再現する。sub-issue の同期を検証するときに使う |
| `gh.ts` | `fakeGh(respond)`、`parseGraphqlArgs` | `gh` の偽物。想定外の呼び出しは reject する |
| `linear.ts` | `fakeLinear(respond)` | `fetch` の偽物 |
| `prWatcher.ts` | `fakePrWatcher()` | PR の見張りの偽物 |
| `watcher.ts` | `noopWatcher()`、`fakeBaseSync()`、`fakeWorkflowLoader()` | 何もしない見張り、`git fetch` の偽物、固定の YAML を返すローダ |

### モックアダプタ（`core/src/adapter/mock.ts`）

`createMockAdapter(script)` は `AgentAdapter` を満たす偽物で、本体の `src/` に置いてある。

- `result`: 既定の結果の上書き
- `sequence`: 呼び出し（start / resume の通算）ごとの結果の列。「1 回目は壊れた出力、2 回目は正しい出力」などを表す
- `events` / `eventsSequence`: 流すイベントの列（「1 回目だけ利用上限のイベントを流す」など）
- 返り値の `calls` に `{ kind, prompt, sessionId, opts }` が積まれるので、プロンプトの中身や resume されたかを検査できる

**モックはファイルシステムに何もしない。** エージェントが作業した体の変更は、ワークフローの `setup` や `command` ステップで作る。

### Intake のフィクスチャ

- `core/test/intake/runnerHelper.ts`: `createFixture()` が一時ディレクトリ・git リポジトリ・インメモリ DB・プロジェクト・Intake を用意する。`drive(db, deps)` が `queued` の実行を無くなるまで回す。`questionsOut` / `pfdOut` でモックアダプタに返させる構造化出力を組む
- `core/test/intake/watchFixture.ts`: `seedActive()` が承認済みで `active` の Intake を持つ DB を作る
- `core/test/intake/pfd/fixture.ts`: `example()`（成果物 5・プロセス 4、うち 1 つが人）、`revised()`、`withDecision()`

## 8.3 統合テストの組み立て方

`core/test/integration/` の `fullCycle.test.ts`・`taskContext.test.ts`・`reviewRecord.test.ts` は、本物の RPC ハンドラと本物の git を使い、アダプタだけを偽物にする。

`core/test/integration/fullCycle.test.ts` から要所を抜き出すと次のようになる。

```ts
const NOOP_CONN = { follow() {}, unfollow() {}, isFollowing: () => false };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "doctrine-e2e-"));
  process.env.DOCTRINE_STATE_DIR = join(root, "state");
});
afterEach(async () => {
  // 走っているタスクが無くなるのを待ってから消す（書き込み中の worktree を消して ENOTEMPTY になるのを防ぐ）
  await until(() => contexts.every((c) => c.running.size === 0));
  await rm(root, { recursive: true, force: true });
});

async function context(adapter = createMockAdapter({ result: { ok: true, text: "やりました" } })) {
  const events: ServerEvent[] = [];
  const ctx: DaemonContext = {
    db: await openDb(":memory:"),
    adapter,
    broadcast: (ev) => events.push(ev),   // 配ったイベントを配列に溜める
    loadWorkflow: loadWorkflowFromDisk,
    workflowOf: (t, p) => taskWorkflow(t, p, loadWorkflowFromDisk),
    trackerOf: constTrackerOf(fakeTracker()),
    intakeWatcher: noopWatcher(),
    running: new Set(),
    // logRoot / globalLimit / configPath / runningIntakeRuns / warnings も埋める
  };
  return { ctx, events, handler: createHandler(ctx) };
}

test("setup → agent → command → approval → 承認 → 完了まで通る", async () => {
  const repo = await makeRepo(root, {
    ".doctrine/project.yaml": "setup: touch marker.txt\ndefaultWorkflow: feature\n...",
    ".doctrine/workflows/feature.yaml": WORKFLOW,
  });
  const { ctx, handler } = await context();
  await handler("project.add", { path: repo }, NOOP_CONN);
  const t = await handler("task.create", { project: repo, title: "...", prompt: "..." }, NOOP_CONN);
  await tick(ctx);
  await until(async () => (await getTask(ctx.db, t.id))?.state === "suspended", 5000, "承認待ちに着く");
  // listStepRuns、溜めたイベント、worktree の中のファイルを検査する
});
```

操作はすべて本物の RPC（`handler("task.create", ...)`）を通す。承認の後に再開させるときは `tickWhenIdle(ctx)` を使う。

`guideStep.test.ts` はもう一段低い層で、`insertProject` / `insertTask` で DB を直接用意して `runTask` を呼ぶ。
始める前に `ensureDoctrineOutExcluded(repo)` を呼ぶ（呼ばないと書き出した `guide-hunks.json` が次のツリーに混ざる）。

## 8.4 スナップショットとリポジトリのファイルを読むテスト

- スナップショットは core に 1 つだけある。`core/test/guide/jsonSchema.test.ts` が Review Guide の JSON Schema を固定する。
  スキーマを意図して変えたら `deno test --allow-all test/guide/jsonSchema.test.ts -- --update` で更新し、差分を確かめてからコミットする
- `core/test/workflow/defaultWorkflow.test.ts` はリポジトリの `.doctrine/workflows/default.yaml` を読み、`open-pr` と `wait-merge` のシェルスクリプトを偽の gh で実際に実行する。
  このファイルを変えると core のテストが落ちうる
- `core/test/guide/example.test.ts` は `shared/guide/examples/` の見本（patch と guide.json）が検証を通ることを確かめる。
  この見本は `app/src/flow.test.ts` と `app/src/guide.test.ts` も使う共有のフィクスチャである

## 8.5 app のテスト

- Vitest の既定設定で動く（`vite.config.ts` に `test` ブロックは無く、jsdom も Testing Library も入っていない）
- store を読む画面そのものではなく、**props だけで描く部品**と `submit*` 関数を export してテストする作りになっている（例: `TaskActions`、`SettingsFields`）
- Tauri は `vi.mock("@tauri-apps/api/core")` で `invoke` を差し替える（`app/src/store.test.ts`）
- 最も大きいのは `app/src/model.test.ts` で、reducer のすべての action とイベントの反映、取り直しの世代、並べ方の決定を固定している
- テストが無いもの: `StoreProvider` の購読と取り直しの配線、`App.tsx` のキー操作、`lib.rs` のコマンド、画面の E2E

## 8.6 Rust のテスト

`app/src-tauri/tests/common/mod.rs` にテスト用の部品がある。

- `Fake`: テストの中に立てる偽の dctld。一時ディレクトリにソケットを bind し、中継から届いた行を受け取り、返す行を送れる。同じパスで立て直せる（再接続のテスト）
- `collector()`: 中継の `emit` を差し替えてイベントを溜める。Tauri を起動せずに中継を観測できる
- `until(f, what)`: 最大 2 秒待ち、来なければ何を待っていたかを名指しして panic する（CI を固まらせない）

子プロセスを fork するクラッシュループのテストは `app/src-tauri/src/relay.rs` の単体テスト側に置いている。ソケットを bind するテストと同じバイナリに置くと、fd の複製で他のテストが揺れるため。
