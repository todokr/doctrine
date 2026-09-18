# Tauri アプリを dctld につなぐ中継 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tauri アプリが Unix ソケット越しに `dctld` と話せるようにし、サイドバーを本物のタスク一覧とイベントで動かす。

**Architecture:** Rust が 1 本のソケット接続を保持し、`invoke("rpc", { method, params })` に id を振って中継し、応答を対応付けて返す。ソケットから来たイベントは `emit("daemon-event")` で素通しする。Rust はメソッドの種類を知らない。接続が切れたら Rust が指数バックオフで再接続し、接続状態を `daemon-connection` で流す。フロントエンドは型付きの薄いクライアント越しに呼び、reducer は純関数のまま保つ。

**Tech Stack:** Rust 1.98.1 / Tauri 2 / tokio、React 19 + Vite 8 + vitest 5、Deno 2.9.4

## Global Constraints

- 対象 OS は **macOS と Linux** のみ。Windows は考えない
- **Rust はメソッドの種類を知らない。** `method` 文字列で分岐するコードを Rust に書かない
- Rust の結合テストは**実物の `dctld` を必要としない**。CI（Ubuntu）で `cargo test --locked` が通ること
- `tokio` を足したら `Cargo.lock` も同じコミットに入れる（CI は `cargo check --locked`）
- `src/` と `test/` の変更は `deno fmt --check` と `deno lint` を通す（`lineWidth` は 100）
- `app/` の変更は `pnpm build`（`tsc && vite build`）と `pnpm test` を通す。`tsconfig.json` は `strict` / `noUnusedLocals` / `noUnusedParameters` が有効
- リクエストのタイムアウトは **30 秒**（`src/cli/dctl.ts` の `REQUEST_TIMEOUT_MS` と揃える）
- 再接続のバックオフは **0.5 秒から倍、上限 30 秒**
- `dctld` の起動待ちは **100ms ごとに最大 5 秒**
- 画面の E2E テストは書かない
- ユーザー向けの文字列はすべて日本語

## File Structure

**新規（Rust）**

| ファイル | 責務 |
| --- | --- |
| `app/src-tauri/src/daemon.rs` | ソケットパスと状態ディレクトリの解決、`dctld` の探索と切り離し起動 |
| `app/src-tauri/src/relay.rs` | 接続の保持、id 採番、応答の対応付け、イベント転送、再接続 |
| `app/src-tauri/tests/common/mod.rs` | 偽のソケットサーバーと emit の収集（テスト専用） |
| `app/src-tauri/tests/relay.rs` | 中継の結合テスト |

**新規（フロントエンド）**

| ファイル | 責務 |
| --- | --- |
| `app/src/daemon/client.ts` | `rpc()` とイベント購読。Tauri の `invoke` / `listen` を包む唯一の場所 |
| `app/src/fixtures.ts` | テスト用のタスク・プロジェクトの標本（`mock.ts` から移す） |
| `app/src/components/ConnectionBanner.tsx` | 画面上部の接続状態 |

**変更**

| ファイル | 変更 |
| --- | --- |
| `src/util/home.ts` | `stateRoot()` を `main.ts` から移す |
| `src/daemon/server.ts` | `socketPath()` に macOS 分岐。純関数 `resolveSocketPath()` を切り出す |
| `src/daemon/main.ts` | `stateRoot()` を再 export に変える |
| `src/daemon/handlers.ts` | `task.list` に `has_degraded` を足す |
| `src/daemon/protocol.ts` | メソッドごとの params / result の型を足す |
| `app/src-tauri/src/lib.rs` | `rpc` コマンドと emit の配線 |
| `app/src-tauri/Cargo.toml` | `tokio` / `tempfile` |
| `app/tsconfig.json`・`app/vite.config.ts` | リポジトリルートの `src/daemon` を読めるようにする |
| `app/src/types.ts` | `State` から `workflows` を落とし、`conn` を足す |
| `app/src/model.ts` | `sync` / `daemon` / `connection` アクション、`toTask()` / `toProject()`。`stepDef()` を安全にする |
| `app/src/store.tsx` | mock を外し、取得・購読・取り直しを持つ |
| `app/src/App.tsx` | 接続バナー、`RejectModal` の `onReject` 表示を外す |
| `app/src/components/Sidebar.tsx` | プロジェクト未取得でも落ちないようにする |
| `app/src/components/ReviewView.tsx` | `stepDef` の欠落に耐える |
| `app/src/components/TaskView.tsx` | `workflows` 依存と偽のログ追従を外す |
| `app/src/model.test.ts` | `mock` ではなく `fixtures` を使う |

**削除**: `app/src/mock.ts`

---

### Task 1: stateRoot を移し、socketPath に macOS 分岐を入れる

macOS には `XDG_RUNTIME_DIR` が無く `/run` は read-only なので、今の `socketPath()` では `dctld` が起動できない。

`stateRoot()` は今 `src/daemon/main.ts` にあり、`main.ts` は `server.ts` を import している。`socketPath()` から呼ぶと循環するので `src/util/home.ts` へ移す。

**Files:**
- Modify: `src/util/home.ts`
- Modify: `src/daemon/server.ts:16-20`
- Modify: `src/daemon/main.ts:1-18`
- Test: `test/daemon/server.test.ts`

**Interfaces:**
- Consumes: なし
- Produces:
  - `src/util/home.ts`: `export function stateRoot(): string`
  - `src/daemon/server.ts`:
    ```ts
    export type SocketEnv = {
      doctrineSocket?: string;
      xdgRuntimeDir?: string;
      stateRoot: string;
      uid: number;
      os: "darwin" | "linux";
    };
    export function resolveSocketPath(env: SocketEnv): string;
    export function socketPath(): string;
    ```
  - `src/daemon/main.ts` は `stateRoot` を再 export し続ける（`export { stateRoot } from "../util/home.ts"`）

- [ ] **Step 1: 失敗するテストを書く**

`test/daemon/server.test.ts` の末尾に足す。ファイル先頭の import に `resolveSocketPath` を加える（`import { createServer, resolveSocketPath } from "../../src/daemon/server.ts";`）。

```ts
const socketEnv = (o: Partial<import("../../src/daemon/server.ts").SocketEnv> = {}) => ({
  stateRoot: "/home/u/.local/state/doctrine",
  uid: 501,
  os: "linux" as const,
  ...o,
});

test("resolveSocketPath: DOCTRINE_SOCKET があればそれを使う", () => {
  assert.equal(
    resolveSocketPath(socketEnv({ doctrineSocket: "/tmp/x.sock", xdgRuntimeDir: "/run/user/1" })),
    "/tmp/x.sock",
  );
});

test("resolveSocketPath: XDG_RUNTIME_DIR があれば OS によらずその下", () => {
  assert.equal(
    resolveSocketPath(socketEnv({ xdgRuntimeDir: "/run/user/501", os: "darwin" })),
    "/run/user/501/doctrine/dctld.sock",
  );
});

test("resolveSocketPath: Linux で XDG_RUNTIME_DIR が無ければ /run/user/<uid>", () => {
  assert.equal(resolveSocketPath(socketEnv()), "/run/user/501/doctrine/dctld.sock");
});

test("resolveSocketPath: macOS で XDG_RUNTIME_DIR が無ければ状態ディレクトリ", () => {
  // macOS には XDG_RUNTIME_DIR が無く /run は read-only なので、/run/user には作れない
  assert.equal(
    resolveSocketPath(socketEnv({ os: "darwin" })),
    "/home/u/.local/state/doctrine/dctld.sock",
  );
});

test("resolveSocketPath: 空文字の環境変数は未設定として扱う", () => {
  assert.equal(
    resolveSocketPath(socketEnv({ doctrineSocket: "", xdgRuntimeDir: "" })),
    "/run/user/501/doctrine/dctld.sock",
  );
});
```

- [ ] **Step 2: テストが落ちることを確かめる**

Run: `deno test --allow-all test/daemon/server.test.ts`
Expected: FAIL（`resolveSocketPath` が export されていない）

- [ ] **Step 3: stateRoot を src/util/home.ts へ移す**

`src/util/home.ts` の末尾に足す。

```ts
import { join } from "@std/path";

/**
 * DB・worktree・ログの置き場。macOS ではソケットもここに置く
 * （XDG_RUNTIME_DIR が無く /run が read-only なため）。
 */
export function stateRoot(): string {
  return Deno.env.get("DOCTRINE_STATE_DIR") ?? join(homeDir(), ".local", "state", "doctrine");
}
```

`src/daemon/main.ts` の `stateRoot` の定義（16-18 行）を消し、import と再 export に置き換える。

```ts
import { homeDir, stateRoot } from "../util/home.ts";

export { stateRoot };
```

（`main.ts` の他の場所で `homeDir` を使っていなければ import しない。`noUnusedLocals` は Deno 側には効かないが `deno lint` が未使用 import を拾う。）

- [ ] **Step 4: socketPath を書き換える**

`src/daemon/server.ts` の `socketPath()` を置き換える。ファイル先頭の import に `stateRoot` を足す（`import { stateRoot } from "../util/home.ts";`）。

```ts
export type SocketEnv = {
  doctrineSocket?: string;
  xdgRuntimeDir?: string;
  stateRoot: string;
  uid: number;
  os: "darwin" | "linux";
};

/** 環境を引数で受ける純関数。OS 分岐をテストから叩けるようにするため。 */
export function resolveSocketPath(env: SocketEnv): string {
  if (env.doctrineSocket) return env.doctrineSocket;
  if (env.xdgRuntimeDir) return join(env.xdgRuntimeDir, "doctrine", "dctld.sock");
  // macOS には XDG_RUNTIME_DIR が無く、/run は read-only なので mkdir が失敗する。
  // 状態ディレクトリ（DB と同じ場所、0o700）に置く。古いソケットファイルが
  // 再起動をまたいで残るが、assertSocketNotLive が扱う。
  if (env.os === "darwin") return join(env.stateRoot, "dctld.sock");
  return join(`/run/user/${env.uid}`, "doctrine", "dctld.sock");
}

/** TCPポートは開かない。ファイルパーミッションがそのまま認可になる。 */
export function socketPath(): string {
  return resolveSocketPath({
    doctrineSocket: Deno.env.get("DOCTRINE_SOCKET"),
    xdgRuntimeDir: Deno.env.get("XDG_RUNTIME_DIR"),
    stateRoot: stateRoot(),
    uid: Deno.uid() ?? 1000,
    os: Deno.build.os === "darwin" ? "darwin" : "linux",
  });
}
```

`src/cli/dctl.ts:180` は `Deno.env.get("DOCTRINE_SOCKET") ?? socketPath()` と書いていて二重になるが、`socketPath()` が同じ値を返すので害は無い。`dctl.ts` は触らない。

- [ ] **Step 5: テストが通ることを確かめる**

Run: `deno test --allow-all test/daemon/server.test.ts`
Expected: PASS

- [ ] **Step 6: 既存のテストと整形を確かめる**

Run: `deno task test && deno fmt --check && deno lint && deno task check`
Expected: すべて PASS

- [ ] **Step 7: macOS で実際にデーモンが起動することを確かめる**

```bash
DOCTRINE_STATE_DIR=$(mktemp -d) deno run -A src/daemon/main.ts &
sleep 2 && ls "$DOCTRINE_STATE_DIR"/dctld.sock && kill %1
```
Expected: `dctld.sock` が存在する（この手順の前は `/run` で失敗していた）

- [ ] **Step 8: commit**

```bash
git add src/util/home.ts src/daemon/server.ts src/daemon/main.ts test/daemon/server.test.ts
git commit -m "fix: macOS でソケットを状態ディレクトリに置く

XDG_RUNTIME_DIR が無い macOS では /run/user に倒れるが、/run は
read-only なので dctld がそもそも起動できなかった。"
```

---

### Task 2: task.list に has_degraded を足す

サイドバーの「要確認」は `failed`・削除拒否・degraded の 3 つを集める。degraded だけがデーモンの応答から判定できない。

**Files:**
- Modify: `src/daemon/handlers.ts`（`case "task.list"`）
- Test: `test/daemon/handlers.test.ts`

**Interfaces:**
- Consumes: なし
- Produces: `task.list` の各行に `has_degraded: boolean` が載る

- [ ] **Step 1: 失敗するテストを書く**

`test/daemon/handlers.test.ts` の末尾に足す。

```ts
test("task.list は degraded な step_run を持つタスクに has_degraded を立てる", async () => {
  const ctx = await context();
  const h = createHandler(ctx);
  await h("project.add", { path: repo }, NOOP_CONN);

  const clean = await h("task.create", { project: repo, title: "き", prompt: "p" }, NOOP_CONN) as
    { id: string };
  const dirty = await h("task.create", { project: repo, title: "よ", prompt: "p" }, NOOP_CONN) as
    { id: string };

  await ctx.db.insertInto("step_runs").values({
    task_id: dirty.id,
    step_id: "review",
    attempt: 1,
    status: "degraded",
    exit_code: 0,
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    log_path: join(root, "logs", "x.log"),
  }).execute();

  const rows = await h("task.list", {}, NOOP_CONN) as { id: string; has_degraded: boolean }[];
  assert.equal(rows.find((r) => r.id === dirty.id)?.has_degraded, true);
  assert.equal(rows.find((r) => r.id === clean.id)?.has_degraded, false);
});
```

- [ ] **Step 2: テストが落ちることを確かめる**

Run: `deno test --allow-all test/daemon/handlers.test.ts`
Expected: FAIL（`has_degraded` が `undefined`）

- [ ] **Step 3: handlers.ts の task.list を書き換える**

`listTasks()`（`src/db/tasks.ts`）は DB の行をそのまま返す関数なので触らない。API の都合は `handlers.ts` が足す。

```ts
      case "task.list": {
        const filter: { projectId?: number; state?: TaskState } = {};
        if (typeof params.project === "string") {
          filter.projectId = (await getProjectByPath(ctx.db, params.project))?.id;
        }
        if (typeof params.state === "string") filter.state = params.state as TaskState;
        const tasks = await listTasks(ctx.db, filter);
        // サイドバーの「要確認」に degraded を含めるために要る（レビューアプリ設計spec 5章）。
        // 1タスクずつ問い合わせると件数ぶん往復するので、一度に集めて突き合わせる。
        const degraded = new Set(
          (await ctx.db.selectFrom("step_runs").select("task_id").distinct()
            .where("status", "=", "degraded").execute()).map((r) => r.task_id),
        );
        return tasks.map((t) => ({ ...t, has_degraded: degraded.has(t.id) }));
      }
```

- [ ] **Step 4: テストが通ることを確かめる**

Run: `deno test --allow-all test/daemon/handlers.test.ts`
Expected: PASS

- [ ] **Step 5: 全体を確かめて commit**

```bash
deno task test && deno fmt --check && deno lint && deno task check
git add src/daemon/handlers.ts test/daemon/handlers.test.ts
git commit -m "feat: task.list に has_degraded を足す

サイドバーの「要確認」の判定に要る（レビューアプリ設計spec 5章）。"
```

---

### Task 3: protocol.ts にメソッドごとの型を足す

`protocol.ts` は今 `Request` / `Response` / `ServerEvent` しか持たない。フロントエンドが型付きで呼べるように、使うメソッドの params と result を足す。**正本は 1 つ**にし、アプリ側にコピーを置かない。

`task.approve` / `task.reject` / `task.cancel` は `getTask()` の行をそのまま返すので `has_degraded` を持たない。`task.list` だけが持つ。型でも分ける。

**Files:**
- Modify: `src/daemon/protocol.ts`
- Test: `test/daemon/handlers.test.ts`（型が実際の応答と合っているかを既存の流れで確かめる）

**Interfaces:**
- Consumes: Task 2 の `has_degraded`
- Produces:
  ```ts
  export type TaskState = "queued" | "running" | "suspended" | "paused"
    | "completed" | "failed" | "canceled";
  export type TaskSummary = { /* 下記 */ };
  export type TaskListEntry = TaskSummary & { has_degraded: boolean };
  export type ProjectSummary = { /* 下記 */ };
  export type Methods = { /* 下記 */ };
  export type Method = keyof Methods;
  export type ParamsOf<M extends Method> = Methods[M]["params"];
  export type ResultOf<M extends Method> = Methods[M]["result"];
  ```

- [ ] **Step 1: 型を足す**

`src/daemon/protocol.ts` の末尾に足す。**`src/db/schema.ts` を import しない。** DB の行の型をそのまま UI に配ると、画面が DB のスキーマに直結する。API が返す形として別に書く。

```ts
export type TaskState =
  | "queued"
  | "running"
  | "suspended"
  | "paused"
  | "completed"
  | "failed"
  | "canceled";

/**
 * task.* が返すタスク1件。デーモンは DB の行をそのまま返すので実際には
 * これより多くの列が載るが、UI に見せてよいのはここに書いた分だけである。
 */
export type TaskSummary = {
  id: string;
  project_id: number;
  title: string;
  prompt: string;
  workflow_name: string;
  state: TaskState;
  current_step_id: string | null;
  branch: string;
  worktree_path: string | null;
  priority: number;
  created_at: string;
  updated_at: string;
};

/** task.list だけが has_degraded を持つ（approve / reject / cancel は行をそのまま返す）。 */
export type TaskListEntry = TaskSummary & { has_degraded: boolean };

export type ProjectSummary = {
  id: number;
  path: string;
  default_workflow: string;
  max_concurrent: number;
  base_branch: string;
  setup: string | null;
};

/**
 * UI が呼ぶメソッドの表。増えたらここに足す。Rust の中継はこの表を知らない
 * （method を素通しするだけ）。
 */
export type Methods = {
  "task.list": { params: { project?: string; state?: TaskState }; result: TaskListEntry[] };
  "project.list": { params: Record<string, never>; result: ProjectSummary[] };
  "task.approve": { params: { task_id: string }; result: TaskSummary };
  "task.reject": { params: { task_id: string; comment: string }; result: TaskSummary };
  "task.cancel": { params: { task_id: string }; result: TaskSummary };
};

export type Method = keyof Methods;
export type ParamsOf<M extends Method> = Methods[M]["params"];
export type ResultOf<M extends Method> = Methods[M]["result"];
```

- [ ] **Step 2: 型が実際の応答と噛み合うことをテストで縛る**

`test/daemon/handlers.test.ts` の末尾に足す。ファイル先頭の import に型を足す（`import type { ProjectSummary, TaskListEntry } from "../../src/daemon/protocol.ts";`）。

```ts
test("task.list / project.list の応答が protocol.ts の型を満たす", async () => {
  const ctx = await context();
  const h = createHandler(ctx);
  await h("project.add", { path: repo }, NOOP_CONN);
  await h("task.create", { project: repo, title: "た", prompt: "p" }, NOOP_CONN);

  // 型注釈そのものが表明である（噛み合わなければ deno task check が落ちる）。
  const tasks: TaskListEntry[] = await h("task.list", {}, NOOP_CONN) as TaskListEntry[];
  const projects: ProjectSummary[] = await h("project.list", {}, NOOP_CONN) as ProjectSummary[];

  // 型が「ある」と言っている欄が実行時にも来ることを確かめる。
  for (const key of ["id", "state", "branch", "updated_at", "has_degraded"] as const) {
    assert.ok(key in tasks[0], `task.list に ${key} がありません`);
  }
  for (const key of ["id", "path", "default_workflow", "base_branch"] as const) {
    assert.ok(key in projects[0], `project.list に ${key} がありません`);
  }
});
```

- [ ] **Step 3: テストが通ることを確かめる**

Run: `deno test --allow-all test/daemon/handlers.test.ts && deno task check`
Expected: PASS

- [ ] **Step 4: 整形して commit**

```bash
deno fmt && deno fmt --check && deno lint
git add src/daemon/protocol.ts test/daemon/handlers.test.ts
git commit -m "feat: protocol.ts にメソッドごとの params / result の型を足す

アプリが型付きで呼べるようにする。型の正本は protocol.ts の1つに保つ。"
```

---

### Task 4: Rust — パスの解決

環境変数からソケットパスと状態ディレクトリを決める。環境変数はプロセス全体で共有なので、テストが並行に書き換えると壊れる。**環境を引数で受ける純関数**にして、そこをテストする。

**Files:**
- Create: `app/src-tauri/src/daemon.rs`
- Modify: `app/src-tauri/src/lib.rs`（`pub mod daemon;` を足すだけ）

**Interfaces:**
- Consumes: なし
- Produces:
  ```rust
  pub enum Os { Macos, Linux }
  pub struct PathEnv { pub doctrine_socket: Option<String>, pub xdg_runtime_dir: Option<String>,
                       pub state_root: PathBuf, pub uid: u32, pub os: Os }
  pub fn resolve_state_root(state_dir: Option<String>, home: Option<String>) -> Result<PathBuf, String>
  pub fn resolve_socket_path(env: &PathEnv) -> PathBuf
  pub fn current_env() -> Result<PathEnv, String>
  pub fn socket_path() -> Result<PathBuf, String>
  ```

- [ ] **Step 1: 失敗するテストを書く**

`app/src-tauri/src/daemon.rs` を作り、テストだけ先に書く。

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn env(os: Os) -> PathEnv {
        PathEnv {
            doctrine_socket: None,
            xdg_runtime_dir: None,
            state_root: PathBuf::from("/home/u/.local/state/doctrine"),
            uid: 501,
            os,
        }
    }

    #[test]
    fn doctrine_socket_wins() {
        let mut e = env(Os::Linux);
        e.doctrine_socket = Some("/tmp/x.sock".into());
        e.xdg_runtime_dir = Some("/run/user/1".into());
        assert_eq!(resolve_socket_path(&e), PathBuf::from("/tmp/x.sock"));
    }

    #[test]
    fn xdg_runtime_dir_is_used_on_both_os() {
        let mut e = env(Os::Macos);
        e.xdg_runtime_dir = Some("/run/user/501".into());
        assert_eq!(resolve_socket_path(&e), PathBuf::from("/run/user/501/doctrine/dctld.sock"));
    }

    #[test]
    fn linux_falls_back_to_run_user() {
        assert_eq!(
            resolve_socket_path(&env(Os::Linux)),
            PathBuf::from("/run/user/501/doctrine/dctld.sock")
        );
    }

    #[test]
    fn macos_falls_back_to_state_root() {
        // macOS には XDG_RUNTIME_DIR が無く /run は read-only
        assert_eq!(
            resolve_socket_path(&env(Os::Macos)),
            PathBuf::from("/home/u/.local/state/doctrine/dctld.sock")
        );
    }

    #[test]
    fn state_root_prefers_explicit_dir() {
        assert_eq!(
            resolve_state_root(Some("/x".into()), Some("/home/u".into())).unwrap(),
            PathBuf::from("/x")
        );
        assert_eq!(
            resolve_state_root(None, Some("/home/u".into())).unwrap(),
            PathBuf::from("/home/u/.local/state/doctrine")
        );
        assert!(resolve_state_root(None, None).is_err());
    }
}
```

- [ ] **Step 2: テストが落ちることを確かめる**

`app/src-tauri/src/lib.rs` の先頭に `pub mod daemon;` を足してから:

Run: `cd app/src-tauri && cargo test --lib daemon`
Expected: FAIL（`resolve_socket_path` などが無い）

- [ ] **Step 3: 実装を書く**

`app/src-tauri/src/daemon.rs` のテストの上に足す。

```rust
use std::env;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Os {
    Macos,
    Linux,
}

pub struct PathEnv {
    pub doctrine_socket: Option<String>,
    pub xdg_runtime_dir: Option<String>,
    pub state_root: PathBuf,
    pub uid: u32,
    pub os: Os,
}

/// DB・ログ・（macOS では）ソケットの置き場。`src/util/home.ts` の stateRoot と同じ規則。
pub fn resolve_state_root(state_dir: Option<String>, home: Option<String>) -> Result<PathBuf, String> {
    if let Some(d) = state_dir.filter(|s| !s.is_empty()) {
        return Ok(PathBuf::from(d));
    }
    let home = home
        .filter(|s| !s.is_empty())
        .ok_or("HOME が設定されていません（DOCTRINE_STATE_DIR を指定してください）")?;
    Ok(Path::new(&home).join(".local").join("state").join("doctrine"))
}

/// `src/daemon/server.ts` の resolveSocketPath と同じ規則。**両方を直すこと。**
/// 片方だけ直すと、症状は「繋がらない」としか出ない。
pub fn resolve_socket_path(env: &PathEnv) -> PathBuf {
    if let Some(p) = env.doctrine_socket.as_deref().filter(|s| !s.is_empty()) {
        return PathBuf::from(p);
    }
    if let Some(x) = env.xdg_runtime_dir.as_deref().filter(|s| !s.is_empty()) {
        return Path::new(x).join("doctrine").join("dctld.sock");
    }
    match env.os {
        // macOS には XDG_RUNTIME_DIR が無く /run は read-only
        Os::Macos => env.state_root.join("dctld.sock"),
        Os::Linux => Path::new(&format!("/run/user/{}", env.uid))
            .join("doctrine")
            .join("dctld.sock"),
    }
}

pub fn current_env() -> Result<PathEnv, String> {
    Ok(PathEnv {
        doctrine_socket: env::var("DOCTRINE_SOCKET").ok(),
        xdg_runtime_dir: env::var("XDG_RUNTIME_DIR").ok(),
        state_root: resolve_state_root(
            env::var("DOCTRINE_STATE_DIR").ok(),
            env::var("HOME").ok(),
        )?,
        // libc を足さずに実 uid を取る。macOS には /proc が無いが、
        // macOS の分岐は uid を見ないので既定値で構わない。
        uid: std::fs::metadata("/proc/self").map(|m| m.uid()).unwrap_or(1000),
        os: if cfg!(target_os = "macos") { Os::Macos } else { Os::Linux },
    })
}

pub fn socket_path() -> Result<PathBuf, String> {
    Ok(resolve_socket_path(&current_env()?))
}
```

- [ ] **Step 4: テストが通ることを確かめる**

Run: `cd app/src-tauri && cargo test --lib daemon`
Expected: 5 tests PASS

- [ ] **Step 5: commit**

```bash
git add app/src-tauri/src/daemon.rs app/src-tauri/src/lib.rs
git commit -m "feat(app): ソケットパスと状態ディレクトリの解決を Rust に足す"
```

---

### Task 5: Rust — dctld の探索と切り離し起動

ソケットが無ければアプリが `dctld` を起こす。**アプリの終了で道連れにしない。** Unix では親が死んでも子は残るが、ターミナルの Ctrl-C は前面プロセスグループ全体に SIGINT を送るので、`pnpm tauri dev` を Ctrl-C で止めると巻き添えになる。新しいプロセスグループに移して断つ。

**Files:**
- Modify: `app/src-tauri/src/daemon.rs`

**Interfaces:**
- Consumes: Task 4 の `current_env()`
- Produces:
  ```rust
  pub fn find_dctld() -> Result<PathBuf, String>
  pub fn spawn_dctld() -> Result<(), String>
  ```

- [ ] **Step 1: 失敗するテストを書く**

`daemon.rs` の `mod tests` に足す。`find_dctld` は PATH を引数で受ける形にしてテストする。

```rust
    #[test]
    fn finds_dctld_on_path() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("dctld");
        std::fs::write(&bin, "#!/bin/sh\n").unwrap();
        let found = find_dctld_in(None, Some(dir.path().to_string_lossy().into_owned()));
        assert_eq!(found.unwrap(), bin);
    }

    #[test]
    fn explicit_override_wins() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("mydctld");
        std::fs::write(&bin, "#!/bin/sh\n").unwrap();
        let found = find_dctld_in(Some(bin.to_string_lossy().into_owned()), None);
        assert_eq!(found.unwrap(), bin);
    }

    #[test]
    fn missing_dctld_says_how_to_install() {
        let dir = tempfile::tempdir().unwrap();
        let err = find_dctld_in(None, Some(dir.path().to_string_lossy().into_owned())).unwrap_err();
        assert!(err.contains("deno task install"), "案内が無い: {err}");
    }

    #[test]
    fn explicit_override_that_is_missing_is_an_error() {
        let err = find_dctld_in(Some("/nope/dctld".into()), None).unwrap_err();
        assert!(err.contains("DOCTRINE_DCTLD"), "どの設定が悪いか分からない: {err}");
    }
```

`app/src-tauri/Cargo.toml` に dev-dependency を足す。

```toml
[dev-dependencies]
tempfile = "3"
```

- [ ] **Step 2: テストが落ちることを確かめる**

Run: `cd app/src-tauri && cargo test --lib daemon`
Expected: FAIL（`find_dctld_in` が無い）

- [ ] **Step 3: 実装を書く**

`daemon.rs` に足す。

```rust
use std::fs::OpenOptions;
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};

/// 探索の規則そのもの。環境変数を読まないのでテストできる。
pub fn find_dctld_in(explicit: Option<String>, path: Option<String>) -> Result<PathBuf, String> {
    if let Some(p) = explicit.filter(|s| !s.is_empty()) {
        let p = PathBuf::from(p);
        return if p.is_file() {
            Ok(p)
        } else {
            Err(format!("DOCTRINE_DCTLD が指すファイルがありません: {}", p.display()))
        };
    }
    for dir in env::split_paths(&path.unwrap_or_default()) {
        let candidate = dir.join("dctld");
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err("dctld が見つかりません（deno task install で入ります）".into())
}

pub fn find_dctld() -> Result<PathBuf, String> {
    find_dctld_in(env::var("DOCTRINE_DCTLD").ok(), env::var("PATH").ok())
}

/// dctld を切り離して起動する。アプリを終了しても、ターミナルで Ctrl-C しても残る。
///
/// 子は待たない（待つとアプリが止まる）。dctld が先に死ぬとアプリが終わるまで
/// ゾンビが1つ残るが、dctld はアプリより長生きする前提なので受け入れる。
pub fn spawn_dctld() -> Result<(), String> {
    let bin = find_dctld()?;
    let root = current_env()?.state_root;
    std::fs::create_dir_all(&root)
        .map_err(|e| format!("状態ディレクトリを作れません ({}): {e}", root.display()))?;

    // 切り離すと stdout / stderr の行き先が無くなる。dctld は起動時の復帰結果・
    // 孤児の検出・tick の失敗をここにしか書かないので、捨てずにログへ追記する。
    let log_path = root.join("dctld.log");
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("ログを開けません ({}): {e}", log_path.display()))?;
    let err = log.try_clone().map_err(|e| format!("ログを複製できません: {e}"))?;

    Command::new(&bin)
        .process_group(0) // Ctrl-C は前面プロセスグループ全体に届く。そこから抜ける
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(err))
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("dctld を起動できません ({}): {e}", bin.display()))
}
```

- [ ] **Step 4: テストが通ることを確かめる**

Run: `cd app/src-tauri && cargo test --lib daemon`
Expected: 9 tests PASS

- [ ] **Step 5: commit**

```bash
git add app/src-tauri/src/daemon.rs app/src-tauri/Cargo.toml app/src-tauri/Cargo.lock
git commit -m "feat(app): dctld を探して切り離して起動する

process_group(0) で Ctrl-C の巻き添えを断ち、stderr は
状態ディレクトリの dctld.log に追記する。"
```

---

### Task 6: Rust — 中継の往復とイベント転送

接続を 1 本張り、id を採番して応答を対応付ける。ソケットから来たイベントは素通しする。再接続は Task 7 で足す。

**Files:**
- Create: `app/src-tauri/src/relay.rs`
- Create: `app/src-tauri/tests/common/mod.rs`
- Create: `app/src-tauri/tests/relay.rs`
- Modify: `app/src-tauri/src/lib.rs`（`pub mod relay;`）
- Modify: `app/src-tauri/Cargo.toml`（`tokio`）

**Interfaces:**
- Consumes: Task 5 の `daemon::spawn_dctld()`
- Produces:
  ```rust
  pub type Emit = std::sync::Arc<dyn Fn(&str, serde_json::Value) + Send + Sync>;
  pub struct RelayOptions { pub request_timeout: Duration, pub backoff_initial: Duration,
                            pub backoff_max: Duration, pub spawn_daemon: bool,
                            pub spawn_grace: Duration }
  impl Default for RelayOptions
  pub struct Relay
  impl Relay {
      pub fn new(socket: PathBuf, emit: Emit, options: RelayOptions)
          -> (Arc<Relay>, impl Future<Output = ()> + Send + 'static);
      pub async fn call(&self, method: String, params: Value) -> Result<Value, String>;
  }
  ```
  `new` が返す Future を呼び出し側が spawn する。Tauri は `tauri::async_runtime::spawn`、テストは `tokio::spawn` を使うので、`relay.rs` は tauri に依存しない。

- [ ] **Step 1: Cargo.toml に tokio を足す**

```toml
[dependencies]
tauri = { version = "2", features = [] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tokio = { version = "1", features = ["net", "io-util", "sync", "time", "rt", "macros"] }

[dev-dependencies]
tempfile = "3"
tokio = { version = "1", features = ["net", "io-util", "sync", "time", "rt-multi-thread", "macros"] }
```

- [ ] **Step 2: 偽のデーモンを書く**

`app/src-tauri/tests/common/mod.rs`:

```rust
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixListener;
use tokio::sync::mpsc;

/// テスト内に立てる偽の dctld。実物のバイナリは要らない。
pub struct Fake {
    pub path: PathBuf,
    pub dir: tempfile::TempDir,
    /// 中継から届いた行
    pub sent: mpsc::UnboundedReceiver<String>,
    /// 中継へ返す行（改行は自動で付く）
    pub reply: mpsc::UnboundedSender<String>,
    task: tokio::task::JoinHandle<()>,
}

impl Fake {
    pub async fn start() -> Fake {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("dctld.sock");
        Fake::listen(dir, path)
    }

    /// 同じパスで立て直す（再接続のテスト用）。
    pub fn restart(dir: tempfile::TempDir, path: PathBuf) -> Fake {
        let _ = std::fs::remove_file(&path);
        Fake::listen(dir, path)
    }

    fn listen(dir: tempfile::TempDir, path: PathBuf) -> Fake {
        let listener = UnixListener::bind(&path).unwrap();
        let (sent_tx, sent_rx) = mpsc::unbounded_channel();
        let (reply_tx, mut reply_rx) = mpsc::unbounded_channel::<String>();
        let task = tokio::spawn(async move {
            let Ok((stream, _)) = listener.accept().await else {
                return;
            };
            let (read, mut write) = stream.into_split();
            let mut lines = BufReader::new(read).lines();
            let reader = tokio::spawn(async move {
                while let Ok(Some(l)) = lines.next_line().await {
                    if sent_tx.send(l).is_err() {
                        break;
                    }
                }
            });
            while let Some(line) = reply_rx.recv().await {
                if write.write_all(format!("{line}\n").as_bytes()).await.is_err() {
                    break;
                }
            }
            reader.abort();
        });
        Fake { path, dir, sent: sent_rx, reply: reply_tx, task }
    }

    /// 接続を切る。ディレクトリとパスは呼び出し側が持ち、立て直しに使う。
    pub fn stop(self) -> (tempfile::TempDir, PathBuf) {
        let Fake { dir, path, task, .. } = self;
        task.abort();
        let _ = std::fs::remove_file(&path);
        (dir, path)
    }
}

pub type Emitted = Arc<Mutex<Vec<(String, Value)>>>;

/// emit を溜める。Tauri を起動せずに中継のイベントを見るため。
pub fn collector() -> (doctrine_lib::relay::Emit, Emitted) {
    let seen: Emitted = Arc::new(Mutex::new(Vec::new()));
    let sink = seen.clone();
    let emit: doctrine_lib::relay::Emit = Arc::new(move |name: &str, payload: Value| {
        sink.lock().unwrap().push((name.to_string(), payload));
    });
    (emit, seen)
}

/// 条件を満たすまで最大 2 秒待つ。
pub async fn until<F: FnMut() -> bool>(mut f: F, what: &str) {
    for _ in 0..200 {
        if f() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("待っても起きませんでした: {what}");
}

pub fn statuses(seen: &Emitted) -> Vec<String> {
    seen.lock()
        .unwrap()
        .iter()
        .filter(|(n, _)| n == "daemon-connection")
        .filter_map(|(_, v)| v.get("status").and_then(Value::as_str).map(str::to_string))
        .collect()
}
```

- [ ] **Step 3: 失敗するテストを書く**

`app/src-tauri/tests/relay.rs`:

```rust
mod common;

use std::sync::Arc;
use std::time::Duration;

use common::{collector, until, Fake};
use doctrine_lib::relay::{Relay, RelayOptions};
use serde_json::{json, Value};

fn options() -> RelayOptions {
    RelayOptions {
        request_timeout: Duration::from_millis(500),
        backoff_initial: Duration::from_millis(20),
        backoff_max: Duration::from_millis(80),
        spawn_daemon: false, // テストは実物の dctld を起こさない
        spawn_grace: Duration::from_millis(0),
    }
}

#[tokio::test]
async fn 応答が逆順で返ってきても取り違えない() {
    let mut fake = Fake::start().await;
    let (emit, seen) = collector();
    let (relay, driver) = Relay::new(fake.path.clone(), emit, options());
    tokio::spawn(driver);
    until(|| common::statuses(&seen).contains(&"connected".to_string()), "接続").await;

    let a = { let r = relay.clone(); tokio::spawn(async move { r.call("task.list".into(), json!({})).await }) };
    let b = { let r = relay.clone(); tokio::spawn(async move { r.call("project.list".into(), json!({})).await }) };

    // 届いた2本の id を拾い、わざと逆順に返す
    let mut ids = Vec::new();
    for _ in 0..2 {
        let line = fake.sent.recv().await.unwrap();
        let v: Value = serde_json::from_str(&line).unwrap();
        ids.push((v["id"].as_u64().unwrap(), v["method"].as_str().unwrap().to_string()));
    }
    for (id, method) in ids.iter().rev() {
        fake.reply.send(json!({ "id": id, "ok": true, "result": method }).to_string()).unwrap();
    }

    assert_eq!(a.await.unwrap().unwrap(), json!("task.list"));
    assert_eq!(b.await.unwrap().unwrap(), json!("project.list"));
}

#[tokio::test]
async fn イベントは素通しで emit される() {
    let mut fake = Fake::start().await;
    let (emit, seen) = collector();
    let (relay, driver) = Relay::new(fake.path.clone(), emit, options());
    tokio::spawn(driver);
    until(|| common::statuses(&seen).contains(&"connected".to_string()), "接続").await;

    let call = { let r = relay.clone(); tokio::spawn(async move { r.call("task.list".into(), json!({})).await }) };
    let line = fake.sent.recv().await.unwrap();
    let id = serde_json::from_str::<Value>(&line).unwrap()["id"].as_u64().unwrap();

    // 応答の前にイベントを挟んでも、応答の待ちは壊れない
    fake.reply.send(json!({ "event": "task.stateChanged", "task_id": "t1", "from": "running", "to": "suspended" }).to_string()).unwrap();
    fake.reply.send(json!({ "id": id, "ok": true, "result": [] }).to_string()).unwrap();

    assert_eq!(call.await.unwrap().unwrap(), json!([]));
    let events: Vec<Value> = seen.lock().unwrap().iter()
        .filter(|(n, _)| n == "daemon-event").map(|(_, v)| v.clone()).collect();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["event"], json!("task.stateChanged"));
    assert_eq!(events[0]["task_id"], json!("t1"));
}

#[tokio::test]
async fn エラー応答は Err になる() {
    let mut fake = Fake::start().await;
    let (emit, seen) = collector();
    let (relay, driver) = Relay::new(fake.path.clone(), emit, options());
    tokio::spawn(driver);
    until(|| common::statuses(&seen).contains(&"connected".to_string()), "接続").await;

    let call = { let r = relay.clone(); tokio::spawn(async move { r.call("task.get".into(), json!({})).await }) };
    let line = fake.sent.recv().await.unwrap();
    let id = serde_json::from_str::<Value>(&line).unwrap()["id"].as_u64().unwrap();
    fake.reply.send(json!({ "id": id, "ok": false, "error": "タスクがありません" }).to_string()).unwrap();

    assert_eq!(call.await.unwrap().unwrap_err(), "タスクがありません");
}

#[tokio::test]
async fn 壊れた行を飛ばして次の行を処理する() {
    let mut fake = Fake::start().await;
    let (emit, seen) = collector();
    let (relay, driver) = Relay::new(fake.path.clone(), emit, options());
    tokio::spawn(driver);
    until(|| common::statuses(&seen).contains(&"connected".to_string()), "接続").await;

    let call = { let r = relay.clone(); tokio::spawn(async move { r.call("task.list".into(), json!({})).await }) };
    let line = fake.sent.recv().await.unwrap();
    let id = serde_json::from_str::<Value>(&line).unwrap()["id"].as_u64().unwrap();
    fake.reply.send("{ これは JSON ではない".into()).unwrap();
    fake.reply.send(json!({ "id": 99999, "ok": true, "result": "知らない id" }).to_string()).unwrap();
    fake.reply.send(json!({ "id": id, "ok": true, "result": "本命" }).to_string()).unwrap();

    assert_eq!(call.await.unwrap().unwrap(), json!("本命"));
}

#[tokio::test]
async fn 応答が来なければタイムアウトする() {
    let fake = Fake::start().await;
    let (emit, seen) = collector();
    let (relay, driver) = Relay::new(fake.path.clone(), emit, options());
    tokio::spawn(driver);
    until(|| common::statuses(&seen).contains(&"connected".to_string()), "接続").await;

    let err = relay.call("task.list".into(), json!({})).await.unwrap_err();
    assert!(err.contains("応答がありません"), "文言が違う: {err}");
    assert_eq!(relay.pending_count(), 0, "タイムアウトした要求が残っている");
}

#[tokio::test]
async fn 接続していないときの呼び出しは即座に失敗する() {
    let dir = tempfile::tempdir().unwrap();
    let (emit, _seen) = collector();
    // 誰も listen していないパス
    let (relay, driver) = Relay::new(dir.path().join("nope.sock"), emit, options());
    tokio::spawn(driver);

    let err = relay.call("task.list".into(), json!({})).await.unwrap_err();
    assert!(err.contains("接続していません"), "文言が違う: {err}");
}

// Arc<Relay> を clone するために使う
fn _assert_send_sync(_: &Arc<Relay>) {}
```

- [ ] **Step 4: テストが落ちることを確かめる**

Run: `cd app/src-tauri && cargo test --test relay`
Expected: FAIL（`doctrine_lib::relay` が無い）

- [ ] **Step 5: relay.rs を書く**

```rust
use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::sync::{mpsc, oneshot};

use crate::daemon;

/// 中継がフロントエンドへ出す口。Tauri の AppHandle を relay.rs に持ち込まないための注入点。
pub type Emit = Arc<dyn Fn(&str, Value) + Send + Sync>;

#[derive(Clone)]
pub struct RelayOptions {
    pub request_timeout: Duration,
    pub backoff_initial: Duration,
    pub backoff_max: Duration,
    /// ソケットが無いときに dctld を起こすか。テストは false
    pub spawn_daemon: bool,
    /// dctld を起こしてからソケットが現れるまで待つ上限
    pub spawn_grace: Duration,
}

impl Default for RelayOptions {
    fn default() -> Self {
        RelayOptions {
            // dctl の REQUEST_TIMEOUT_MS と揃える
            request_timeout: Duration::from_secs(30),
            backoff_initial: Duration::from_millis(500),
            backoff_max: Duration::from_secs(30),
            spawn_daemon: true,
            spawn_grace: Duration::from_secs(5),
        }
    }
}

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

pub struct Relay {
    next_id: AtomicU64,
    pending: Pending,
    /// 接続中だけ Some。切れている間の call はここで弾く
    writer: Arc<Mutex<Option<mpsc::UnboundedSender<String>>>>,
    options: RelayOptions,
}

impl Relay {
    /// 中継と、それを回す Future を返す。呼び出し側が spawn する
    /// （Tauri は tauri::async_runtime::spawn、テストは tokio::spawn）。
    pub fn new(
        socket: PathBuf,
        emit: Emit,
        options: RelayOptions,
    ) -> (Arc<Relay>, impl Future<Output = ()> + Send + 'static) {
        let relay = Arc::new(Relay {
            next_id: AtomicU64::new(1),
            pending: Arc::new(Mutex::new(HashMap::new())),
            writer: Arc::new(Mutex::new(None)),
            options,
        });
        let driver = supervise(relay.clone(), socket, emit);
        (relay, driver)
    }

    /// Rust は method の中身を見ない。params もそのまま渡す。
    pub async fn call(&self, method: String, params: Value) -> Result<Value, String> {
        let tx = self
            .writer
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| "デーモンに接続していません".to_string())?;

        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (res_tx, res_rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, res_tx);

        let line = json!({ "id": id, "method": method, "params": params }).to_string();
        if tx.send(line).is_err() {
            self.pending.lock().unwrap().remove(&id);
            return Err("デーモンに接続していません".into());
        }

        match tokio::time::timeout(self.options.request_timeout, res_rx).await {
            Ok(Ok(result)) => result,
            // 切断で pending ごと落とされた
            Ok(Err(_)) => Err("接続が切れました".into()),
            Err(_) => {
                // 外しておかないと、切断まで pending に残り続ける
                self.pending.lock().unwrap().remove(&id);
                Err(format!(
                    "デーモンからの応答がありません（{}ミリ秒待ちました）",
                    self.options.request_timeout.as_millis()
                ))
            }
        }
    }

    /// テスト用。待ち中の要求の数。
    pub fn pending_count(&self) -> usize {
        self.pending.lock().unwrap().len()
    }
}

fn emit_status(emit: &Emit, status: &str, detail: Option<String>) {
    emit("daemon-connection", json!({ "status": status, "detail": detail }));
}

fn fail_all(relay: &Arc<Relay>, reason: &str) {
    let waiting: Vec<_> = relay.pending.lock().unwrap().drain().collect();
    for (_, tx) in waiting {
        let _ = tx.send(Err(reason.to_string()));
    }
}

async fn supervise(relay: Arc<Relay>, socket: PathBuf, emit: Emit) {
    let mut backoff = relay.options.backoff_initial;
    let mut announced_connecting = false;

    loop {
        if !announced_connecting {
            emit_status(&emit, "connecting", None);
            announced_connecting = true;
        }

        // ソケットファイルが在るのに繋がらないときは消さない。生きているデーモンを
        // 気づかれずに切り離す危険がある（その判定は dctld の assertSocketNotLive の担当）。
        if !socket.exists() && relay.options.spawn_daemon {
            if let Err(e) = daemon::spawn_dctld() {
                emit_status(&emit, "disconnected", Some(e));
            } else {
                wait_for_socket(&socket, relay.options.spawn_grace).await;
            }
        }

        match UnixStream::connect(&socket).await {
            Ok(stream) => {
                backoff = relay.options.backoff_initial;
                announced_connecting = false;
                emit_status(&emit, "connected", None);
                pump(&relay, stream, &emit).await;
                fail_all(&relay, "接続が切れました");
                emit_status(&emit, "disconnected", None);
                announced_connecting = false;
            }
            Err(e) => {
                emit_status(
                    &emit,
                    "disconnected",
                    Some(format!("{} に接続できません: {e}", socket.display())),
                );
            }
        }

        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(relay.options.backoff_max);
    }
}

async fn wait_for_socket(socket: &PathBuf, grace: Duration) {
    let deadline = tokio::time::Instant::now() + grace;
    while tokio::time::Instant::now() < deadline {
        if socket.exists() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// 1本の接続が生きている間の読み書き。切れたら返る。
async fn pump(relay: &Arc<Relay>, stream: UnixStream, emit: &Emit) {
    let (read_half, mut write_half) = stream.into_split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    *relay.writer.lock().unwrap() = Some(tx);

    // 書き込みは1本にまとめて直列化する（server.ts が書き込み側でしているのと同じ理由）。
    let writer = tokio::spawn(async move {
        while let Some(line) = rx.recv().await {
            if write_half.write_all(line.as_bytes()).await.is_err() {
                break;
            }
            if write_half.write_all(b"\n").await.is_err() {
                break;
            }
        }
    });

    let mut lines = BufReader::new(read_half).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        // 壊れた行で接続ごと落とさない。捨てて次へ進む。
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if value.get("event").is_some() {
            emit("daemon-event", value);
            continue;
        }
        let Some(id) = value.get("id").and_then(Value::as_u64) else {
            continue;
        };
        let Some(sender) = relay.pending.lock().unwrap().remove(&id) else {
            continue;
        };
        let payload = if value.get("ok").and_then(Value::as_bool) == Some(true) {
            Ok(value.get("result").cloned().unwrap_or(Value::Null))
        } else {
            Err(value
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("不明なエラーです")
                .to_string())
        };
        let _ = sender.send(payload);
    }

    *relay.writer.lock().unwrap() = None;
    writer.abort();
}
```

`app/src-tauri/src/lib.rs` に `pub mod relay;` を足す。

- [ ] **Step 6: テストが通ることを確かめる**

Run: `cd app/src-tauri && cargo test --test relay`
Expected: 6 tests PASS

- [ ] **Step 7: commit**

```bash
git add app/src-tauri/src/relay.rs app/src-tauri/src/lib.rs app/src-tauri/tests app/src-tauri/Cargo.toml app/src-tauri/Cargo.lock
git commit -m "feat(app): dctld への中継を Rust に足す

id を採番して応答を対応付け、イベントは素通しする。method の
種類は見ない。"
```

---

### Task 7: Rust — 切断と再接続

デーモンを落として上げ直したらアプリが自動で復帰すること。これが #41 の完了条件の 1 つである。

**Files:**
- Test: `app/src-tauri/tests/relay.rs`（追記のみ。実装は Task 6 で入っている）

**Interfaces:**
- Consumes: Task 6 の `Relay` / `RelayOptions` / `Fake::stop()` / `Fake::restart()`
- Produces: なし（振る舞いの保証）

- [ ] **Step 1: 失敗しうるテストを書く**

`app/src-tauri/tests/relay.rs` の末尾に足す。

```rust
#[tokio::test]
async fn 切断で待ち中の要求が失敗し、立て直すと復帰する() {
    let fake = Fake::start().await;
    let (emit, seen) = collector();
    let (relay, driver) = Relay::new(fake.path.clone(), emit, options());
    tokio::spawn(driver);
    until(|| common::statuses(&seen).contains(&"connected".to_string()), "最初の接続").await;

    // 応答を返さないまま落とす
    let waiting = { let r = relay.clone(); tokio::spawn(async move { r.call("task.list".into(), json!({})).await }) };
    until(|| relay.pending_count() == 1, "要求が届く").await;
    let (dir, path) = fake.stop();

    assert_eq!(waiting.await.unwrap().unwrap_err(), "接続が切れました");
    until(|| common::statuses(&seen).contains(&"disconnected".to_string()), "切断の通知").await;
    assert_eq!(relay.pending_count(), 0, "切断後も要求が残っている");

    // 立て直すと自動で復帰する
    let mut fake = Fake::restart(dir, path);
    until(
        || common::statuses(&seen).iter().filter(|s| *s == "connected").count() == 2,
        "再接続",
    )
    .await;

    let call = { let r = relay.clone(); tokio::spawn(async move { r.call("task.list".into(), json!({})).await }) };
    let line = fake.sent.recv().await.unwrap();
    let id = serde_json::from_str::<Value>(&line).unwrap()["id"].as_u64().unwrap();
    fake.reply.send(json!({ "id": id, "ok": true, "result": "復帰" }).to_string()).unwrap();
    assert_eq!(call.await.unwrap().unwrap(), json!("復帰"));
}

#[tokio::test]
async fn 最初からデーモンが居なくても、後から立てれば繋がる() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("dctld.sock");
    let (emit, seen) = collector();
    let (relay, driver) = Relay::new(path.clone(), emit, options());
    tokio::spawn(driver);

    until(|| common::statuses(&seen).contains(&"disconnected".to_string()), "繋がらない通知").await;
    assert!(relay.call("task.list".into(), json!({})).await.is_err());

    let mut fake = Fake::restart(dir, path);
    until(|| common::statuses(&seen).contains(&"connected".to_string()), "後から接続").await;

    let call = { let r = relay.clone(); tokio::spawn(async move { r.call("task.list".into(), json!({})).await }) };
    let line = fake.sent.recv().await.unwrap();
    let id = serde_json::from_str::<Value>(&line).unwrap()["id"].as_u64().unwrap();
    fake.reply.send(json!({ "id": id, "ok": true, "result": [] }).to_string()).unwrap();
    assert_eq!(call.await.unwrap().unwrap(), json!([]));
}
```

- [ ] **Step 2: テストを走らせる**

Run: `cd app/src-tauri && cargo test --test relay`
Expected: 8 tests PASS。落ちる場合は `supervise` のバックオフと `announced_connecting` の扱いを直す（テストは実装の誤りを見つけるためにある）

- [ ] **Step 3: 何度か繰り返して不安定さを確かめる**

Run: `cd app/src-tauri && for i in 1 2 3 4 5; do cargo test --test relay || break; done`
Expected: 5 回とも PASS（時間に依存するテストなので、たまに落ちるなら `until` の待ちを延ばす）

- [ ] **Step 4: commit**

```bash
git add app/src-tauri/tests/relay.rs
git commit -m "test(app): 切断と再接続を結合テストで確かめる"
```

---

### Task 8: Rust — Tauri への配線

`rpc` コマンドを生やし、emit を `AppHandle` に繋ぐ。

**Files:**
- Modify: `app/src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: Task 4〜7 の `daemon::socket_path()` / `Relay::new` / `RelayOptions::default()`
- Produces: Tauri コマンド `rpc(method: String, params: Value) -> Result<Value, String>`、イベント `daemon-event` と `daemon-connection`

- [ ] **Step 1: lib.rs を書く**

```rust
pub mod daemon;
pub mod relay;

use std::sync::Arc;

use serde_json::Value;
use tauri::{Emitter, Manager, State};

use relay::{Relay, RelayOptions};

/// デーモンへの中継。**method の種類はここでも見ない。**
/// デーモンの API が増えても Rust は変わらない。
#[tauri::command]
async fn rpc(
    method: String,
    params: Value,
    relay: State<'_, Arc<Relay>>,
) -> Result<Value, String> {
    relay.call(method, params).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let handle = app.handle().clone();
            let emit: relay::Emit = Arc::new(move |name: &str, payload: Value| {
                // ウィンドウが閉じている間の emit は失敗しうる。中継を止める理由にはならない。
                let _ = handle.emit(name, payload);
            });
            let socket = daemon::socket_path().map_err(|e| std::io::Error::other(e))?;
            let (relay, driver) = Relay::new(socket, emit, RelayOptions::default());
            // tokio::spawn ではなく Tauri のランタイムに載せる
            tauri::async_runtime::spawn(driver);
            app.manage(relay);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![rpc])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 2: ビルドが通ることを確かめる**

Run: `cd app/src-tauri && cargo check --all-targets && cargo test`
Expected: PASS

- [ ] **Step 3: capabilities を確かめる**

Tauri 2 では**アプリ自身が定義したコマンドは capability の許可を要らない**（許可が要るのはプラグインのコマンド）。フロントエンドからのイベント購読は `core:default` に含まれる `core:event:default` で足りる。

Run: `grep -n "core:default" app/src-tauri/capabilities/default.json`
Expected: 既に入っている。**`capabilities/default.json` は変更しない。** Task 11 で画面から実際にイベントが届くことを確かめ、届かなければここへ戻って `core:event:default` を明示的に足す

- [ ] **Step 4: commit**

```bash
git add app/src-tauri/src/lib.rs
git commit -m "feat(app): rpc コマンドと daemon-event / daemon-connection を配線する"
```

---

### Task 9: フロントエンド — 型付きの薄いクライアント

`protocol.ts` を直接 import する。コピーも生成もしない。

**Files:**
- Create: `app/src/daemon/client.ts`
- Modify: `app/tsconfig.json`
- Modify: `app/vite.config.ts`

**Interfaces:**
- Consumes: Task 3 の `Method` / `ParamsOf` / `ResultOf` / `ServerEvent`、Task 8 の `rpc` コマンドとイベント
- Produces:
  ```ts
  export type ConnectionStatus = {
    status: "connecting" | "connected" | "disconnected";
    detail?: string | null;
  };
  export function rpc<M extends Method>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>>;
  export function onDaemonEvent(fn: (ev: ServerEvent) => void): Promise<() => void>;
  export function onConnection(fn: (c: ConnectionStatus) => void): Promise<() => void>;
  ```

- [ ] **Step 1: app の外を読めるようにする**

`app/tsconfig.json` の `include` を変える。

```json
  "include": ["src", "../src/daemon"],
```

`app/vite.config.ts` の `server` に足す。

```ts
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    // 型の正本はリポジトリルートの src/daemon/protocol.ts にある（app の外）
    fs: { allow: [".."] },
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
```

- [ ] **Step 2: client.ts を書く**

```ts
// デーモンとやりとりする唯一の場所。Tauri の invoke / listen をここだけに閉じる。
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  Method,
  ParamsOf,
  ResultOf,
  ServerEvent,
} from "../../../src/daemon/protocol.ts";

export type ConnectionStatus = {
  status: "connecting" | "connected" | "disconnected";
  detail?: string | null;
};

/** Rust は method を素通しするだけ。どのメソッドがあるかは protocol.ts が持つ */
export function rpc<M extends Method>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>> {
  return invoke<ResultOf<M>>("rpc", { method, params });
}

/**
 * デーモンのイベント。Rust は中身を見ずに流すので、型は protocol.ts の
 * ServerEvent を信じる。知らない event はここを通って reducer が無視する。
 */
export function onDaemonEvent(fn: (ev: ServerEvent) => void): Promise<() => void> {
  return listen<ServerEvent>("daemon-event", (e) => fn(e.payload));
}

export function onConnection(fn: (c: ConnectionStatus) => void): Promise<() => void> {
  return listen<ConnectionStatus>("daemon-connection", (e) => fn(e.payload));
}
```

- [ ] **Step 3: 型検査とビルドが通ることを確かめる**

Run: `cd app && pnpm build`
Expected: PASS（`../../../src/daemon/protocol.ts` が解決でき、`rpc("task.list", {})` の戻り値が `TaskListEntry[]` になる）

- [ ] **Step 4: 型が効いていることを目で確かめる**

`app/src/daemon/client.ts` の末尾に一時的に足して `pnpm build` を流し、**落ちること**を確かめてから消す。

```ts
// 一時確認用（確かめたら消す）
const _bad = rpc("task.reject", { task_id: "x" }); // comment が無いので落ちるはず
```
Expected: `pnpm build` が型エラーで FAIL → 行を消して再度 PASS

- [ ] **Step 5: commit**

```bash
git add app/src/daemon/client.ts app/tsconfig.json app/vite.config.ts
git commit -m "feat(app): 型付きの rpc クライアントを置く

型は src/daemon/protocol.ts を直接 import する（正本は1つ）。"
```

---

### Task 10: フロントエンド — reducer を実データで動かす

reducer は純関数のまま保ち、ここで全部テストする。副作用（取得・購読）は Task 11 の `store.tsx` に閉じる。

**Files:**
- Create: `app/src/fixtures.ts`
- Modify: `app/src/types.ts`
- Modify: `app/src/model.ts`
- Modify: `app/src/model.test.ts`

**Interfaces:**
- Consumes: Task 3 の `TaskListEntry` / `ProjectSummary` / `ServerEvent`、Task 9 の `ConnectionStatus`
- Produces:
  ```ts
  // types.ts
  export type State = { /* workflows を削り、conn を足す */ };
  // model.ts
  export function toProject(p: ProjectSummary): Project;
  export function toTask(row: TaskListEntry, projects: ProjectSummary[], previous?: Task): Task;
  export function projectKey(path: string): string;
  // Action に足すもの
  | { type: "sync"; tasks: Task[]; projects: Project[]; now: number }
  | { type: "daemon"; ev: ServerEvent; now: number }
  | { type: "connection"; conn: ConnectionStatus }
  ```

- [ ] **Step 1: フィクスチャを移す**

`git mv app/src/mock.ts app/src/fixtures.ts` はしない（`mock.ts` はまだ `store.tsx` と `TaskView.tsx` が使っている）。**コピーして作る。**

```bash
cp app/src/mock.ts app/src/fixtures.ts
```

`app/src/fixtures.ts` の先頭のコメントを差し替える。

```ts
// テスト用の標本。画面はこれを使わない（画面のデータはデーモンから来る）
```

`app/src/model.test.ts` の import を `./mock` から `./fixtures` に変える。

Run: `cd app && pnpm test`
Expected: PASS（まだ何も壊していない）

- [ ] **Step 2: 失敗するテストを書く**

`app/src/model.test.ts` の末尾に足す。先頭の import に足す（`import { projectKey, toProject, toTask } from "./model";` は既存の import 文にまとめる。`import type { ProjectSummary, TaskListEntry } from "../../src/daemon/protocol.ts";` も足す）。

```ts
const row = (o: Partial<TaskListEntry> = {}): TaskListEntry => ({
  id: "t-1",
  project_id: 1,
  title: "タイトル",
  prompt: "指示",
  workflow_name: "feature",
  state: "queued",
  current_step_id: null,
  branch: "doctrine/t-1",
  worktree_path: null,
  priority: 2,
  created_at: "2026-09-18T00:00:00.000Z",
  updated_at: "2026-09-18T00:10:00.000Z",
  has_degraded: false,
  ...o,
});

const summary = (o: Partial<ProjectSummary> = {}): ProjectSummary => ({
  id: 1,
  path: "/home/u/git/doctrine",
  default_workflow: "feature",
  max_concurrent: 2,
  base_branch: "main",
  setup: null,
  ...o,
});

const PJ = [summary()];
const t1 = (o: Partial<TaskListEntry> = {}) => toTask(row(o), PJ);

describe("toProject / toTask", () => {
  test("プロジェクトの表示名はパスの末尾", () => {
    expect(toProject(summary()).id).toBe("doctrine");
    expect(toProject(summary({ path: "/home/u/work/shop-api/" })).id).toBe("shop-api");
  });

  test("同じパスからは同じ色が出る", () => {
    expect(toProject(summary()).color).toBe(toProject(summary()).color);
    expect(toProject(summary()).color).not.toBe(toProject(summary({ path: "/x/y" })).color);
  });

  test("project_id を突き合わせて表示名にする", () => {
    expect(t1().project).toBe("doctrine");
    // 取得の前後でずれてプロジェクトが見つからないことはありうる
    expect(toTask(row({ project_id: 99 }), PJ).project).toBe("99");
  });

  test("since は updated_at から作る（待ち始めた時刻の記録は #43）", () => {
    expect(t1().since).toBe(Date.parse("2026-09-18T00:10:00.000Z"));
  });

  test("削除拒否は completed かつ worktree が残っていることで分かる", () => {
    expect(t1({ state: "completed", worktree_path: "/w" }).refused).toBe(true);
    expect(t1({ state: "completed", worktree_path: null }).refused).toBe(false);
    expect(t1({ state: "failed", worktree_path: "/w" }).refused).toBe(false);
  });

  test("has_degraded は degraded に写す", () => {
    expect(t1({ has_degraded: true }).degraded).toBeTruthy();
    expect(t1({ has_degraded: false }).degraded).toBeFalsy();
  });
});

describe("sync", () => {
  test("知らないタスクが増え、消えたタスクは落ちる", () => {
    const s = base({ tasks: [], projects: [], sel: null });
    const a = t1({ id: "a", state: "suspended" });
    const b = t1({ id: "b", state: "suspended" });
    const one = reduce(s, { type: "sync", tasks: [a, b], projects: [], now: 1 });
    expect(one.tasks.map((t) => t.id)).toEqual(["a", "b"]);
    const two = reduce(one, { type: "sync", tasks: [a], projects: [], now: 2 });
    expect(two.tasks.map((t) => t.id)).toEqual(["a"]);
  });

  test("選択中のタスクが消えたら先頭を選び直す", () => {
    const a = t1({ id: "a", state: "suspended" });
    const b = t1({ id: "b", state: "suspended" });
    const s = reduce(base({ tasks: [], projects: [], sel: null }), {
      type: "sync", tasks: [a, b], projects: [], now: 1,
    });
    const picked = reduce(s, { type: "select", id: "b" });
    const after = reduce(picked, { type: "sync", tasks: [a], projects: [], now: 2 });
    expect(after.sel).toBe("a");
  });

  test("選択中のタスクが残っていれば選択は動かない", () => {
    const a = t1({ id: "a", state: "suspended" });
    const b = t1({ id: "b", state: "suspended" });
    const s = reduce(base({ tasks: [], projects: [], sel: null }), {
      type: "sync", tasks: [a, b], projects: [], now: 1,
    });
    const picked = reduce(s, { type: "select", id: "b" });
    expect(reduce(picked, { type: "sync", tasks: [a, b], projects: [], now: 2 }).sel).toBe("b");
  });

  test("消えたタスクの下書きは捨てる", () => {
    const a = t1({ id: "a", state: "suspended" });
    const s = base({
      tasks: [a],
      projects: [],
      sel: "a",
      drafts: { a: { comments: [], overall: "残す" }, gone: { comments: [], overall: "捨てる" } },
    });
    const after = reduce(s, { type: "sync", tasks: [a], projects: [], now: 2 });
    expect(Object.keys(after.drafts)).toEqual(["a"]);
  });
});

describe("daemon イベント", () => {
  const withTask = () => {
    const t = t1({ id: "a", state: "running", current_step_id: "implement" });
    return base({ tasks: [t], projects: [], sel: "a" });
  };

  test("task.stateChanged で状態と経過の起点が動く", () => {
    const after = reduce(withTask(), {
      type: "daemon",
      ev: { event: "task.stateChanged", task_id: "a", from: "running", to: "suspended" },
      now: 999,
    });
    expect(after.tasks[0].state).toBe("suspended");
    expect(after.tasks[0].since).toBe(999);
  });

  test("stepRun.started で今のステップが動く", () => {
    const after = reduce(withTask(), {
      type: "daemon",
      ev: { event: "stepRun.started", task_id: "a", step_run_id: 1, step_id: "test" },
      now: 999,
    });
    expect(after.tasks[0].step).toBe("test");
  });

  test("stepRun.finished の degraded は要確認に入れる", () => {
    const after = reduce(withTask(), {
      type: "daemon",
      ev: {
        event: "stepRun.finished", task_id: "a", step_run_id: 1,
        step_id: "implement", status: "degraded",
      },
      now: 999,
    });
    expect(after.tasks[0].degraded).toBe("implement");
    expect(groupOf(after.tasks[0])).toBe("check");
  });

  test("知らないタスクのイベントは何も壊さない", () => {
    const s = withTask();
    const after = reduce(s, {
      type: "daemon",
      ev: { event: "task.stateChanged", task_id: "知らない", from: "queued", to: "running" },
      now: 999,
    });
    expect(after.tasks).toEqual(s.tasks);
  });

  test("まだ扱わないイベントは無視する", () => {
    const s = withTask();
    const after = reduce(s, {
      type: "daemon",
      ev: { event: "log.line", task_id: "a", step_run_id: 1, line: "x" },
      now: 999,
    });
    expect(after).toEqual(s);
  });
});

describe("connection", () => {
  test("接続状態を持つ", () => {
    const after = reduce(base(), { type: "connection", conn: { status: "disconnected" } });
    expect(after.conn.status).toBe("disconnected");
  });
});
```

`assert_eq_label` は使わない。上のテスト内の 1 行目 2 行を `expect(...).toBe(...)` に直す:

```ts
    expect(toProject(summary()).id).toBe("doctrine");
    expect(toProject(summary({ path: "/home/u/work/shop-api/" })).id).toBe("shop-api");
```

`base()` の定義（ファイル冒頭）から `workflows` を落とし、`conn` を足す。

```ts
const base = (overrides: Partial<State> = {}): State => ({
  tasks: seedTasks(),
  projects: PROJECTS,
  now: NOW,
  view: "tasks",
  project: "all",
  sel: "t-2b91",
  scope: {},
  step: {},
  drafts: {},
  editing: null,
  modal: null,
  toast: null,
  conn: { status: "connected" },
  ...overrides,
});
```

- [ ] **Step 3: テストが落ちることを確かめる**

Run: `cd app && pnpm test`
Expected: FAIL（`toTask` などが無い。`State` に `conn` が無い）

- [ ] **Step 4: types.ts を直す**

`app/src/types.ts` は `State` を持たない（`State` は `model.ts` にある）。`Task` はそのままでよい。何も変えない。

`app/src/model.ts` の `State` を直す。`workflows` を落とし、`conn` を足す。

```ts
export type State = {
  tasks: Task[];
  projects: Project[];
  now: number;
  view: View;
  project: string;
  sel: string | null;
  scope: Record<string, Scope>;
  /** ガイドに沿って読むステップ。未設定ならガイドのあるタスクは最初のステップから、null は全体表示 */
  step: Record<string, number | null>;
  drafts: Record<string, Draft>;
  editing: Editing | null;
  modal: "reject-preview" | null;
  toast: string | null;
  conn: ConnectionStatus;
};
```

- [ ] **Step 5: model.ts に写しとアクションを実装する**

`app/src/model.ts` の先頭に import を足す。

```ts
import type {
  ProjectSummary,
  ServerEvent,
  TaskListEntry,
} from "../../src/daemon/protocol.ts";
import type { ConnectionStatus } from "./daemon/client";
```

`// ---- 変換` の節を足す（`// ---------------- 状態` の直前）。

```ts
// ---------------------------------------------------------------- デーモンの形 → 画面の形

/** プロジェクトの表示名。デーモンはパスしか持たないので末尾を使う */
export function projectKey(path: string): string {
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || path;
}

/** 同じパスからは常に同じ色。色をデーモンに持たせる話は本specでは扱わない */
export function toProject(p: ProjectSummary): Project {
  let h = 0;
  for (const ch of p.path) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return {
    id: projectKey(p.path),
    path: p.path,
    def: p.default_workflow,
    color: `hsl(${h} 45% 38%)`,
  };
}

/**
 * デーモンが持たない欄（diff / guide / reviews など）は空にする。埋めるのは #44〜#47。
 * previous を渡すと、イベントで足した欄（degraded など）を引き継ぐ。
 */
export function toTask(
  row: TaskListEntry,
  projects: ProjectSummary[],
  previous?: Task,
): Task {
  // デーモンは project_id しか返さない。表示名はパスの末尾から作る
  const project = projects.find((p) => p.id === row.project_id);
  return {
    id: row.id,
    wf: row.workflow_name,
    project: project ? projectKey(project.path) : String(row.project_id),
    title: row.title,
    prompt: row.prompt,
    branch: row.branch,
    worktree: row.worktree_path,
    state: row.state,
    step: row.current_step_id,
    attempt: 1,
    prio: row.priority,
    // 「待ち始めた時刻」の記録は #43。それまでは最後に動いた時刻で代える
    since: Date.parse(row.updated_at),
    diff: [],
    reviews: [],
    // 完了したのに worktree が残っているのは、後始末が削除を拒否したということ
    refused: row.state === "completed" && row.worktree_path !== null,
    degraded: row.has_degraded ? (previous?.degraded ?? row.current_step_id ?? "") : undefined,
  };
}
```

`Action` に足す。

```ts
  | { type: "sync"; tasks: Task[]; projects: Project[]; now: number }
  | { type: "daemon"; ev: ServerEvent; now: number }
  | { type: "connection"; conn: ConnectionStatus }
```

`reduce` に足す（`switch` の中）。

```ts
    case "sync": {
      // 取り直しがイベントの取りこぼしを吸収する（レビューアプリ設計spec 4章）。
      // 連番も再送も持たないので、ここが唯一の合わせ込みの場所である。
      const ids = new Set(a.tasks.map((x) => x.id));
      const drafts = Object.fromEntries(
        Object.entries(s.drafts).filter(([id]) => ids.has(id)),
      );
      const next: State = { ...s, tasks: a.tasks, projects: a.projects, now: a.now, drafts };
      if (s.sel !== null && ids.has(s.sel)) return next;
      const first = sidebarOrder(a.tasks, s.view, s.project)[0];
      return { ...next, sel: first ? first.id : null, editing: null };
    }
    case "daemon": {
      const ev = a.ev;
      // 知らない event は無視する。Rust は素通しするだけなので、
      // デーモンが先に増えてもここで落ちない
      if (ev.event === "task.stateChanged") {
        if (!s.tasks.some((x) => x.id === ev.task_id)) return s;
        return {
          ...s,
          now: a.now,
          tasks: updateTask(s, ev.task_id, { state: ev.to as TaskState, since: a.now }),
        };
      }
      if (ev.event === "stepRun.started") {
        if (!s.tasks.some((x) => x.id === ev.task_id)) return s;
        return { ...s, now: a.now, tasks: updateTask(s, ev.task_id, { step: ev.step_id }) };
      }
      if (ev.event === "stepRun.finished" && ev.status === "degraded") {
        if (!s.tasks.some((x) => x.id === ev.task_id)) return s;
        return { ...s, now: a.now, tasks: updateTask(s, ev.task_id, { degraded: ev.step_id }) };
      }
      // log.line は #47、ratelimit.sample は第2段階
      return s;
    }
    case "connection":
      return { ...s, conn: a.conn };
```

`stepDef()` を安全にする。ワークフロー定義を持たなくなったので、常に `undefined` を返す形に縮める。呼び出し側（`ReviewView` / `App`）は `def?.` で受けているので落ちない。

```ts
/**
 * approval ステップの定義。ワークフロー定義を返す口（workflow.list）は #58 なので、
 * 今は何も持たない。呼び出し側は undefined を前提にすること。
 */
export const stepDef = (_s: State, _t: Task): StepDef | undefined => undefined;
```

`approve` / `reject.confirm` / `cancel` の case は Task 13 で書き換えるので、この段では `s.workflows` を参照している `approve` だけ一旦落とす（型が通らないため）。`approve` の case を差し替える。

```ts
    case "approve": {
      // 実際の遷移はデーモンが決め、task.stateChanged で返ってくる（Task 13 で rpc に繋ぐ）
      if (!t || t.state !== "suspended") return s;
      const next = { ...s, drafts: withoutDraft(s, t.id), editing: null };
      return { ...next, sel: selectNextReview(next, t.id), toast: `承認しました: ${t.title}` };
    }
```

`reject.confirm` からも `stepDef` 由来の `step: def?.onReject ?? t.step` と、状態の捏造を落とす。

```ts
    case "reject.confirm": {
      if (!t || t.state !== "suspended") return s;
      const d = draftOf(s, t.id);
      if (!canReject(d)) return s;
      const next = {
        ...s,
        drafts: withoutDraft(s, t.id),
        editing: null,
        modal: null,
      };
      return { ...next, sel: selectNextReview(next, t.id), toast: `差し戻しました: ${t.title}` };
    }
```

`cancel` からも状態の捏造を落とす。

```ts
    case "cancel":
      if (!t || isTerminal(t.state)) return s;
      return { ...s, toast: "中止しました。worktree は残します" };
```

`TaskState` を `model.ts` に import する（`import type { …, TaskState } from "./types";` に足す）。

- [ ] **Step 6: 既存テストのうち捏造に依存していたものを直す**

Run: `cd app && pnpm test`
Expected: `approve` / `reject.confirm` / `cancel` が状態を変えることを期待していたテストが落ちる。**それらは「UI がデーモンの決定を先取りして捏造する」ことを縛っていたテストなので、期待を書き換える。** 落ちたテストの `expect` を、下書きが消えること・次のレビュー待ちが選ばれること・toast が出ることだけに絞る

- [ ] **Step 7: テストが通ることを確かめる**

Run: `cd app && pnpm test && pnpm build`
Expected: PASS

- [ ] **Step 8: commit**

```bash
git add app/src/fixtures.ts app/src/model.ts app/src/model.test.ts
git commit -m "feat(app): reducer をデーモンの形で動かす

sync / daemon / connection のアクションを足し、承認・差し戻し・中止が
状態を捏造するのをやめる（決めるのはデーモン）。"
```

---

### Task 11: フロントエンド — 取得・購読・取り直しと接続バナー

副作用をここに閉じる。

**Files:**
- Modify: `app/src/store.tsx`
- Create: `app/src/components/ConnectionBanner.tsx`
- Modify: `app/src/App.tsx`
- Modify: `app/src/styles.css`

**Interfaces:**
- Consumes: Task 9 の `rpc` / `onDaemonEvent` / `onConnection`、Task 10 の `toTask` / `toProject` と各アクション
- Produces: なし（配線）

- [ ] **Step 1: store.tsx を書き換える**

```tsx
import {
  createContext,
  useContext,
  useEffect,
  useReducer,
  type Dispatch,
  type ReactNode,
} from "react";
import { onConnection, onDaemonEvent, rpc } from "./daemon/client";
import { reduce, toProject, toTask, type Action, type State } from "./model";
import type { Draft } from "./types";

// 送信前の下書きは閉じても消さない。spec ではアプリのデータディレクトリに置くが、localStorage で代える
const DRAFTS_KEY = "doctrine-drafts";

/** 取りこぼしを吸収する保険。dctl add で作られた queued はイベントが飛ばない */
const REFRESH_MS = 15_000;

function loadDrafts(): Record<string, Draft> {
  try {
    return JSON.parse(localStorage.getItem(DRAFTS_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function initialState(): State {
  return {
    tasks: [],
    projects: [],
    now: Date.now(),
    view: "tasks",
    project: "all",
    sel: null,
    scope: {},
    step: {},
    drafts: loadDrafts(),
    editing: null,
    modal: null,
    toast: null,
    conn: { status: "connecting" },
  };
}

const Ctx = createContext<{ s: State; dispatch: Dispatch<Action> } | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [s, dispatch] = useReducer(reduce, undefined, initialState);

  useEffect(() => {
    let alive = true;

    async function refresh() {
      try {
        const [projects, tasks] = await Promise.all([
          rpc("project.list", {}),
          rpc("task.list", {}),
        ]);
        if (!alive) return;
        dispatch({
          type: "sync",
          projects: projects.map(toProject),
          tasks: tasks.map((row) => toTask(row, projects)),
          now: Date.now(),
        });
      } catch {
        // 切断中は失敗して当然。理由はバナーが出している
      }
    }

    const unlisteners: Promise<() => void>[] = [
      onConnection((conn) => {
        dispatch({ type: "connection", conn });
        // 再接続したら取り直す。これがイベントの取りこぼしを吸収する
        if (conn.status === "connected") void refresh();
      }),
      onDaemonEvent((ev) => {
        // 知らないタスクのイベントは、まだ持っていないタスクが動いたということ。
        // reducer は純関数なので取得できない。ここで取り直す
        if ("task_id" in ev && !latest.tasks.some((t) => t.id === ev.task_id)) {
          void refresh();
          return;
        }
        dispatch({ type: "daemon", ev, now: Date.now() });
      }),
    ];

    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);

    return () => {
      alive = false;
      clearInterval(timer);
      for (const u of unlisteners) void u.then((f) => f());
    };
    // 購読は1回だけ張る
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(DRAFTS_KEY, JSON.stringify(s.drafts));
    } catch {
      // 保存できなくても画面は動かす
    }
  }, [s.drafts]);

  useEffect(() => {
    if (!s.toast) return;
    const h = setTimeout(() => dispatch({ type: "toast", message: null }), 2600);
    return () => clearTimeout(h);
  }, [s.toast]);

  return <Ctx.Provider value={{ s, dispatch }}>{children}</Ctx.Provider>;
}

export function useStore() {
  const v = useContext(Ctx);
  if (!v) throw new Error("StoreProvider の外で useStore を呼んでいます");
  return v;
}

/** 第2段階に回した操作のボタンが押されたときに出す */
export function useNotYet() {
  const { dispatch } = useStore();
  return (message: string) => dispatch({ type: "toast", message });
}
```

`latest` は定義していない。イベントハンドラから最新の state を見るために `useRef` を足す。`StoreProvider` の先頭に:

```tsx
  const [s, dispatch] = useReducer(reduce, undefined, initialState);
  const latest = useRef(s);
  latest.current = s;
```

`useEffect` の中の `latest.tasks` を `latest.current.tasks` に直す。`useRef` を import に足す。

- [ ] **Step 2: バナーを書く**

`app/src/components/ConnectionBanner.tsx`:

```tsx
import { useStore } from "../store";

/** 接続が切れていることを見せる。復帰は Rust が勝手にやる（押すボタンは無い） */
export function ConnectionBanner() {
  const { s } = useStore();
  if (s.conn.status === "connected") return null;
  const message = s.conn.status === "connecting"
    ? "dctld に接続しています…"
    : "dctld に接続できません — 再接続しています";
  return (
    <div className="conn-banner" role="status">
      <span>{message}</span>
      {s.conn.detail && <span className="mono hint">{s.conn.detail}</span>}
    </div>
  );
}
```

`app/src/styles.css` の末尾に足す。

```css
.conn-banner {
  display: flex;
  gap: 12px;
  align-items: baseline;
  padding: 6px 12px;
  background: #5a3a12;
  color: #f4e6d2;
  font-size: 13px;
}
.conn-banner .hint { color: #d8c3a5; }
```

- [ ] **Step 3: App.tsx に差す**

`import { ConnectionBanner } from "./components/ConnectionBanner";` を足し、`return` の `<>` 直後に置く。

```tsx
    <>
      <ConnectionBanner />
      <div className="app">
```

あわせて `RejectModal` の `stepDef` 依存を外す。ワークフロー定義を持たないので、戻り先のステップ名は出せない。

```tsx
function RejectModal() {
  const { s, dispatch } = useStore();
  const t = selectedTask(s);
  if (s.modal !== "reject-preview" || !t) return null;
  return (
    <>
      <div className="scrim" onClick={() => dispatch({ type: "modal.close" })} />
      <div className="modal" role="dialog" aria-modal="true">
        <h2>差し戻してエージェントに送る内容</h2>
        <p className="hint">
          行コメントと全体へのコメントを1つの文字列にまとめて{" "}
          <span className="mono">task.reject(comment)</span> で送ります。
          戻り先のステップはワークフローの <span className="mono">onReject.goto</span> が決めます。
        </p>
        <pre className="block">{composeRejection(draftOf(s, t.id))}</pre>
        <div className="actions">
          <button className="btn danger" onClick={() => dispatch({ type: "reject.confirm" })}>
            差し戻す
          </button>
          <button className="btn" onClick={() => dispatch({ type: "modal.close" })}>戻る</button>
        </div>
      </div>
    </>
  );
}
```

`stepDef` の import を `App.tsx` から外す（`noUnusedLocals` が落とす）。

- [ ] **Step 4: ビルドが通ることを確かめる**

Run: `cd app && pnpm build && pnpm test`
Expected: `TaskView.tsx` が `s.workflows` を参照していて FAIL（Task 12 で直す）。それ以外のエラーはここで直す

- [ ] **Step 5: commit**

```bash
git add app/src/store.tsx app/src/components/ConnectionBanner.tsx app/src/App.tsx app/src/styles.css
git commit -m "feat(app): デーモンから取得し、イベントと取り直しで画面を合わせる"
```

---

### Task 12: フロントエンド — 中央の画面からモックを外す

`diff` / `guide` / `reviews` はデーモンから来ないので、中央の画面は空になる。**モックと実データが混ざった画面を残さない。**

**Files:**
- Modify: `app/src/components/TaskView.tsx`
- Modify: `app/src/components/ReviewView.tsx`
- Modify: `app/src/components/Sidebar.tsx`
- Delete: `app/src/mock.ts`

**Interfaces:**
- Consumes: Task 10 の `stepDef`（常に `undefined`）
- Produces: なし

- [ ] **Step 1: TaskView から workflows と偽のログ追従を外す**

`useFakeFollow` 関数ごと消し、`FOLLOW_POOL` の import を消す。`steps` / `idx` / 実行履歴の `<details>` を消す。ステップの表示を「何番目か」抜きにする。

```tsx
export function TaskView({ t }: { t: Task }) {
  const { s, dispatch } = useStore();
  const notYet = useNotYet();
  const [stateName, stateCls] = STATE_PILL[t.state];
  const queuePos = s.tasks
    .filter((x) => x.state === "queued")
    .sort((a, b) => a.prio - b.prio || a.since - b.since)
    .findIndex((x) => x.id === t.id) + 1;
```

ヘッダ行のステップ表示:

```tsx
        {t.step && (
          <span>
            ステップ <span className="mono">{t.step}</span>
          </span>
        )}
```

`failed` の説明文から `{t.attempt}回目` を落とす（試行回数はまだ取れない）。

```tsx
          <h2><span className="mono">{t.step}</span> で失敗しました</h2>
```

`degraded` の節と `refused` の節はそのまま残す（どちらも `task.list` から分かる）。

ログの節を置き換える。

```tsx
      <div className="headrow">
        <b>ログ</b>
        <span className="spacer" />
      </div>
      <div className="box quiet">
        <p>ログの取得と追従はまだありません（<span className="mono">task.logs</span> の follow は #47）。</p>
      </div>
```

`logRef` と `useEffect` によるスクロール、`Task` の `log` 参照を消す。`useRef` / `useEffect` の import が未使用になったら消す。

- [ ] **Step 2: ReviewView の欠落に耐える箇所を直す**

`Crumbs` のプロジェクト参照の `!` を外す。

```tsx
export function Crumbs({ t }: { t: Task }) {
  const { s } = useStore();
  const p = s.projects.find((x) => x.id === t.project);
  return (
    <div className="crumbs">
      {p && <span className="pjdot" style={{ background: p.color }} />}
      <span>{p?.id ?? t.project}</span>
      <span className="mono">{t.wf}</span>
      <span className="mono">{t.id}</span>
      <span className="mono">P{t.prio}</span>
    </div>
  );
}
```

`ReviewView` の見出しのピルは、approval ステップの `title` が取れないので今のステップ id に落とす。

```tsx
          <span className="pill p-attn">◆ {def?.title ?? t.step ?? "レビュー待ち"}</span>
```

「変更」の見出しの説明を、まだ取れないことを言う形に変える。

```tsx
        <div className="headrow">
          <b>変更</b>
          <span className="hint">diff の取得はまだありません（<span className="mono">task.diff</span> は #44）</span>
          <span className="spacer" />
```

`hasSince` は `t.reviews`（常に空）に依るので、切り替えのボタンは出ない。そのままでよい。

- [ ] **Step 3: Sidebar のプロジェクト参照の `!` を外す**

```tsx
function Item({ t }: { t: Task }) {
  const { s, dispatch } = useStore();
  const p = s.projects.find((x) => x.id === t.project);
  return (
    <button className="it" aria-current={s.sel === t.id} onClick={() => dispatch({ type: "select", id: t.id })}>
      <span className="ico"><StateIcon t={t} /></span>
      <span className="t">{t.title}</span>
      <span className="m">
        <span className="pj">
          <span className="pjdot" style={{ background: p?.color ?? "#666" }} />
          {p?.id ?? t.project}
        </span>
        <span className="tm">{timeLabel(t, s.now)}</span>
      </span>
    </button>
  );
}
```

サイドバー最下部のレート制限（`side-foot`）は固定値のモックなので消す。

```tsx
      </div>
    </aside>
```

- [ ] **Step 4: mock.ts を消す**

```bash
git rm app/src/mock.ts
```

- [ ] **Step 5: ビルドとテストが通ることを確かめる**

Run: `cd app && pnpm build && pnpm test`
Expected: PASS。`mock` への参照が残っていれば FAIL するので、指されたところを直す

- [ ] **Step 6: commit**

```bash
git add -A app/src
git commit -m "refactor(app): 画面からモックデータを外す

中央の画面は #44〜#47 が埋めるまで空にする。混ざった画面を残さない。"
```

---

### Task 13: 承認・差し戻し・中止をデーモンへ送る

ボタンが押されたら `rpc` を投げ、画面はデーモンの `task.stateChanged` と取り直しで合わせる。

**Files:**
- Modify: `app/src/store.tsx`
- Modify: `app/src/components/ReviewView.tsx`
- Modify: `app/src/components/TaskView.tsx`
- Modify: `app/src/model.ts`
- Test: `app/src/model.test.ts`

**Interfaces:**
- Consumes: Task 9 の `rpc`、Task 10 の `composeRejection` / `draftOf`
- Produces:
  ```ts
  // store.tsx
  export function useDecide(): {
    approve(taskId: string): void;
    reject(taskId: string, comment: string): void;
    cancel(taskId: string): void;
  };
  ```

- [ ] **Step 1: 差し戻しの文字列を組み立てるテストを確かめる**

`composeRejection` は既にテストされている。ここで縛るのは「下書きが空なら送らない」ことだけ。

`app/src/model.test.ts` に足す。

```ts
test("下書きが空なら差し戻せない（理由の無い却下はコアも拒否する）", () => {
  expect(canReject({ comments: [], overall: "   " })).toBe(false);
  expect(canReject({ comments: [], overall: "直して" })).toBe(true);
});
```

Run: `cd app && pnpm test`
Expected: PASS（既存の実装で通る。回帰の網として置く）

- [ ] **Step 2: store.tsx に送信を足す**

```tsx
import { rpc } from "./daemon/client";

/**
 * 判断をデーモンへ送る。画面の状態はここで書き換えない。
 * デーモンが決めた結果が task.stateChanged と取り直しで返ってくる。
 */
export function useDecide() {
  const { dispatch } = useStore();
  const send = (p: Promise<unknown>, failed: string) => {
    p.catch((e: unknown) => {
      dispatch({ type: "toast", message: `${failed}: ${String(e)}` });
    });
  };
  return {
    approve: (taskId: string) =>
      send(rpc("task.approve", { task_id: taskId }), "承認を送れませんでした"),
    reject: (taskId: string, comment: string) =>
      send(rpc("task.reject", { task_id: taskId, comment }), "差し戻しを送れませんでした"),
    cancel: (taskId: string) =>
      send(rpc("task.cancel", { task_id: taskId }), "中止を送れませんでした"),
  };
}
```

- [ ] **Step 3: ReviewView のボタンを繋ぐ**

`ReviewView` の中で:

```tsx
export function ReviewView({ t }: { t: Task }) {
  const { s, dispatch } = useStore();
  const decide = useDecide();
  const draft = draftOf(s, t.id);
  // …
        <div className="actions">
          <button className="btn danger" disabled={!canReject(draft)} onClick={() => dispatch({ type: "reject.preview" })}>
            差し戻す…
          </button>
          <button
            className="btn primary"
            onClick={() => {
              decide.approve(t.id);
              dispatch({ type: "approve" });
            }}
          >
            承認する
          </button>
        </div>
```

`RejectModal`（`App.tsx`）も同じ形にする。

```tsx
function RejectModal() {
  const { s, dispatch } = useStore();
  const decide = useDecide();
  const t = selectedTask(s);
  if (s.modal !== "reject-preview" || !t) return null;
  const comment = composeRejection(draftOf(s, t.id));
  // …
          <button
            className="btn danger"
            onClick={() => {
              decide.reject(t.id, comment);
              dispatch({ type: "reject.confirm" });
            }}
          >
            差し戻す
          </button>
```

`<pre className="block">{comment}</pre>` に直す。

- [ ] **Step 4: TaskView の中止を繋ぐ**

```tsx
        {!isTerminal(t.state) && (
          <button
            className="btn danger"
            onClick={() => {
              decide.cancel(t.id);
              dispatch({ type: "cancel" });
            }}
          >
            中止
          </button>
        )}
```

`const decide = useDecide();` を `TaskView` の先頭に足し、`useDecide` を import する。

- [ ] **Step 5: ビルドとテストが通ることを確かめる**

Run: `cd app && pnpm build && pnpm test`
Expected: PASS

- [ ] **Step 6: commit**

```bash
git add app/src
git commit -m "feat(app): 承認・差し戻し・中止をデーモンへ送る

画面は結果を捏造せず、task.stateChanged と取り直しで合わせる。"
```

---

### Task 14: 通しで動かして確かめ、記録を残す

自動テストでは確かめられない 4 つ（完了条件）を手で確かめる。

**Files:**
- Modify: `app/README.md`
- Modify: `docs/superpowers/specs/2026-09-18-tauri-dctld-relay-design.md`（状態を「実装済み」に）

**Interfaces:**
- Consumes: Task 1〜13 すべて
- Produces: なし

- [ ] **Step 1: CI と同じ検査を手元で流す**

```bash
deno fmt --check && deno lint && deno task check && deno task test
cd app && pnpm build && pnpm test
cd src-tauri && cargo check --locked --all-targets && cargo test --locked
```
Expected: すべて PASS

- [ ] **Step 2: dctld を入れて、アプリが起こすことを確かめる**

```bash
deno task install            # PATH に dctl / dctld が入る
pkill -f 'dctld' || true     # 動いているデーモンを止める
cd app && pnpm tauri dev
```
Expected: サイドバーが埋まる（タスクが 0 件なら「ありません」）。`~/.local/state/doctrine/dctld.log` に dctld の起動ログが増えている。バナーは出ていない

- [ ] **Step 3: 切り離しを確かめる**

```bash
# アプリを終了してから
pgrep -fl dctld
```
Expected: `dctld` が残っている

`pnpm tauri dev` をもう一度起動し、**ターミナルで Ctrl-C** して止めてから:

```bash
pgrep -fl dctld
```
Expected: `dctld` が残っている（`process_group(0)` が効いている）

- [ ] **Step 4: 再接続を確かめる**

アプリを起動したまま:

```bash
pkill -f dctld
```
Expected: 数秒以内に画面上部へ「dctld に接続できません — 再接続しています」が出る

```bash
dctld >> ~/.local/state/doctrine/dctld.log 2>&1 &
```
Expected: バナーが消え、サイドバーが自動で埋まり直す

- [ ] **Step 5: 本物の応答が返ることを確かめる**

アプリを起動したまま別のターミナルで:

```bash
dctl project-add --path "$(pwd)"
dctl add --project "$(pwd)" --title "中継の確認" --prompt "何もしない"
```
Expected: 15 秒以内にサイドバーの「待ち」に「中継の確認」が出る（`task.create` はイベントを出さないので、取り直しで拾う）

- [ ] **Step 6: README に起動手順を書く**

`app/README.md` の末尾に足す。

```markdown
## デーモン（dctld）との接続

アプリは `$XDG_RUNTIME_DIR/doctrine/dctld.sock`（macOS では
`~/.local/state/doctrine/dctld.sock`）越しに `dctld` と話す。

- 起動時にソケットへ繋がらなければ、アプリが `dctld` を切り離して起こす。
  アプリを終了しても `dctld` は残る
- `dctld` は PATH から探す。`deno task install` で入る。
  別の場所のものを使うときは `DOCTRINE_DCTLD` に絶対パスを置く
- 起こした `dctld` の出力は `~/.local/state/doctrine/dctld.log` に追記される
- 接続が切れると画面上部に出て、間隔を伸ばしながら再接続する。
  繋がり直したときにデータを取り直すので、イベントの取りこぼしはそこで吸収される
```

- [ ] **Step 7: spec の状態を更新する**

`docs/superpowers/specs/2026-09-18-tauri-dctld-relay-design.md` の 4 行目を書き換える。

```markdown
- 状態: 実装済み
```

- [ ] **Step 8: commit**

```bash
git add app/README.md docs/superpowers/specs/2026-09-18-tauri-dctld-relay-design.md
git commit -m "docs: dctld との接続の手順を README に書く"
```

- [ ] **Step 9: PR を出す**

```bash
git push -u origin todokr/tauri-dctld-rpc
gh pr create --base develop --title "Tauri アプリを dctld につなぐ中継とサイドバーの実データ化" --body "$(cat <<'EOF'
## やったこと

- Rust が 1 本のソケット接続を保持し、`invoke("rpc", { method, params })` を中継する。**Rust は method の種類を知らない**
- ソケットから来たイベントは `emit("daemon-event")` で素通しする
- 接続が切れたら指数バックオフで再接続し、`daemon-connection` で状態を流す。画面上部にバナーを出す
- `dctld` は PATH から探し、`process_group(0)` で切り離して起動する。stderr は `~/.local/state/doctrine/dctld.log` へ
- サイドバーを `task.list` / `project.list` とイベントで動かす。15 秒ごとの取り直しが取りこぼしを吸収する
- 承認・差し戻し・中止をデーモンへ送る（画面は結果を捏造しない）

## あわせて直したこと

- **macOS で `dctld` が起動できなかった。** `XDG_RUNTIME_DIR` が無く `/run` は read-only なので、`socketPath()` に macOS 分岐を入れた
- サイドバーの「要確認」に degraded を含めるため、`task.list` に `has_degraded` を足した

## 範囲外

中央の画面（レビュー画面・タスク画面）は #44〜#47 が埋めるまで空にした。モックと実データが混ざった画面を残さないため。

Closes #41
Closes #42

設計: `docs/superpowers/specs/2026-09-18-tauri-dctld-relay-design.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

**1. Spec coverage**

| spec の節 | 実装するタスク |
| --- | --- |
| 3. macOS の socketPath | Task 1 |
| 4. Rust の中継（コマンド・イベント・接続の一生・対応付け・テストできる形） | Task 6・7・8 |
| 5. dctld の探索・切り離し・ログ・パス解決の二重化 | Task 4・5 |
| 6. 薄いクライアント・protocol.ts の直接 import・型の追加 | Task 3・9 |
| 7. サイドバーの取得と反映・割り切り・中央の画面・mock.ts の 3 参照 | Task 10・11・12 |
| 8. デーモン側の変更（socketPath・has_degraded） | Task 1・2 |
| 9. テスト（Rust 結合・vitest・deno test・手で確かめること） | Task 1・2・6・7・10・14 |

抜けなし。

**2. Placeholder scan**

"TBD" / "TODO" / "適切に" / "同様に" は無い。すべてのコード手順に実際のコードが入っている。

**3. Type consistency**

- `resolveSocketPath` / `resolve_socket_path`: TS と Rust で同じ規則。Task 1 と Task 4 で同じ 5 ケースをテストしている
- `TaskListEntry` = `TaskSummary & { has_degraded }`: Task 3 で定義し、Task 10 の `toTask(row, projects, previous?)` が消費する
- `toTask(row, projects, previous?)` の `projects` は `ProjectSummary[]`（rpc の生の応答）である。Task 11 の `store.tsx` は `project.list` の結果をそのまま渡し、Task 10 のテストは `PJ` を渡す
- `Emit` は `Arc<dyn Fn(&str, Value) + Send + Sync>`。Task 6 の `collector()` と Task 8 の `AppHandle` 版が同じ型
- `Relay::new` は `(Arc<Relay>, impl Future)` を返す。テスト（`tokio::spawn`）と Tauri（`tauri::async_runtime::spawn`）が同じ形で使う
- `stepDef(s, t)` は Task 10 以降つねに `undefined`。呼び出し側は `def?.` で受けている（`App.tsx` は Task 11 で参照ごと外す、`ReviewView.tsx` は Task 12 で既定値を入れる）
