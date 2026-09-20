# PFD による Issue の分解 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** GitHub Issue を PFD（成果物とプロセスの図）に分解し、入力が揃ったプロセスだけを doctrine のタスクとして投入する CLI `pfd` と、分解を行う Claude Code のスキルを作る。

**Architecture:** リポジトリのルートに Deno パッケージ `pfd/` を足す。`core/` のソースは import せず、doctrine とは `dctl ls` / `dctl add` をコマンドとして呼ぶことでだけ繋がる。PFD の正本（`pfd.yaml`）と投入の記録（`dispatch.json`）は doctrine の状態ディレクトリ配下に置く。「どのプロセスがどの状態か」は純粋関数 `computeStatus` が決め、外部コマンド（`dctl` / `gh`）は `Ports` インターフェースの裏に隠してテストでは差し替える。

**Tech Stack:** Deno 2.9 / TypeScript、zod、yaml、`@std/path`、`@std/testing/bdd` + `node:assert/strict`、Mermaid（CDN、図の表示だけ）、`gh` CLI、`dctl`

**Spec:** [`docs/superpowers/specs/2026-09-20-pfd-decomposition-design.md`](../specs/2026-09-20-pfd-decomposition-design.md)

## Global Constraints

- **doctrine にはまだ利用者がいない。** 移行のための仕掛け（旧名のエイリアス、古い形式を受け止める分岐）を作らない
- **コードコメントに一般的な実装原則を書かない。** そのコード固有の事実だけ書く。設計の理由は spec の地の文にある
- エラーメッセージ・コメント・CLI の出力は**日本語**
- **`core/` と `app/` のソースを import しない。** `pfd/` から `../core/` `../shared/` への相対 import は 1 つも書かない（spec 5 章）。`core/` `app/` `shared/` のファイルも変更しない
- doctrine との接点は `dctl ls` と `dctl add` の 2 コマンドだけ（spec 1 章）
- `deno fmt` の `lineWidth` は **100**
- 作業ディレクトリは `pfd/`。テストは `deno task test`、型検査は `deno task check`。**両方に加えて `deno fmt --check` と `deno lint` が通ること**が各タスクの完了条件
- テストは `@std/testing/bdd` の `test` と `node:assert/strict` を使う（`core/test/` と同じ書き方）
- テストが状態ディレクトリを使うときは、必ず `DOCTRINE_STATE_DIR` を一時ディレクトリに向け、終わったら元に戻す。利用者の `~/.local/state/doctrine` に触れない
- テストは実物の `dctl` / `gh` を呼ばない。`Run`（Task 4）か `Ports`（Task 7 以降）を差し替える
- タスクのタイトルのキーは `[pfd:<issue>/<process-id>]`（spec 7.1）。この文字列の形を変えない
- コミットメッセージは日本語の一文（例: `pfd: PFD の検証を足す`）

## File Structure

| ファイル | 責務 | タスク |
| --- | --- | --- |
| `pfd/deno.json` / `pfd/deno.lock` | パッケージの設定・依存・タスク | 1 |
| `mise.toml` | `pfd:deps` `pfd:test` `pfd:check` `pfd:install` の委譲タスク、`setup` の依存 | 1 |
| `pfd/src/model.ts` | PFD の型と zod スキーマ、`parsePfd` | 1 |
| `pfd/test/fixture.ts` | テストで共有する PFD の YAML | 1 |
| `pfd/src/validate.ts` | 構造の検証（spec 6.2） | 2 |
| `pfd/src/store.ts` | 状態ディレクトリ・プロジェクトのキー・`dispatch.json` の読み書き・ハッシュ | 3 |
| `pfd/src/exec.ts` | 外部コマンドを走らせて stdout を返す | 4 |
| `pfd/src/ports.ts` | `dctl` / `gh` の窓口（`Ports`）と、その実物 | 4 |
| `pfd/src/key.ts` | タスクのタイトルのキー（作る・探す） | 5 |
| `pfd/src/status.ts` | 各プロセスの状態を決める純粋関数と、事実の収集 | 5 |
| `pfd/src/prompt.ts` | タスクに渡す prompt の組み立て（spec 7.2） | 6 |
| `pfd/test/fakePorts.ts` | メモリ上の `Ports` | 7 |
| `pfd/src/dispatch.ts` | 投入（spec 7 章） | 7 |
| `pfd/src/render.ts` | Mermaid と HTML の生成（spec 9 章） | 8 |
| `pfd/src/cli.ts` | 引数の解釈と 7 つのコマンド | 9 |
| `pfd/skill/pfd-decompose/SKILL.md` | 分解を行うスキル | 10 |
| `.github/workflows/ci.yml` / `README.md` / `docs/overview.md` / spec | CI・文書 | 11 |

依存の向き: `cli → dispatch / render / status / validate / store / ports`、`dispatch → status / prompt / key / store`、`status → key`。`model.ts` は誰にも依存しない。

---

### Task 1: `pfd/` パッケージと PFD の読み込み

**Files:**
- Create: `pfd/deno.json`
- Create: `pfd/src/model.ts`
- Create: `pfd/test/fixture.ts`
- Create: `pfd/test/model.test.ts`
- Modify: `mise.toml`（`[tasks."core:build"]` の後ろにタスクを足す。`[tasks.setup]` の `depends`）

**Interfaces:**
- Consumes: なし
- Produces:
  - `type Artifact = { id: string; name: string; given: boolean; description?: string; verify?: string }`
  - `type Process = { id: string; name: string; actor: "agent" | "human"; inputs: string[]; outputs: string[]; purpose?: string; steps?: string; done_when?: string }`
  - `type Pfd = { issue: number; title: string; goal: string[]; artifacts: Artifact[]; processes: Process[] }`
  - `parsePfd(text: string): Pfd` — 読めなければ日本語のメッセージで `Error` を投げる
  - `EXAMPLE_YAML: string`（`pfd/test/fixture.ts`）— 以後のすべてのテストが使う

- [ ] **Step 1: `pfd/deno.json` を書く**

```json
{
  "fmt": {
    "include": ["src/", "test/"],
    "lineWidth": 100
  },
  "lint": {
    "include": ["src/", "test/"]
  },
  "tasks": {
    "test": "deno test --allow-all test/",
    "check": "deno check src test",
    "install": "deno install -g -A -f --config deno.json -n pfd src/cli.ts"
  },
  "imports": {
    "@std/path": "jsr:@std/path@^1",
    "@std/testing": "jsr:@std/testing@^1.0.20",
    "yaml": "npm:yaml@^2.6.0",
    "zod": "npm:zod@^3.24.0"
  }
}
```

- [ ] **Step 2: `mise.toml` にタスクを足す**

`[tasks."core:build"]` のブロックの直後に足す。

```toml
[tasks."pfd:deps"]
description = "pfd の依存を取る"
dir = "pfd"
run = "deno install --frozen"

[tasks."pfd:test"]
description = "pfd のテスト"
dir = "pfd"
run = "deno task test"

[tasks."pfd:check"]
description = "pfd の型検査"
dir = "pfd"
run = "deno task check"

[tasks."pfd:install"]
description = "pfd を ~/.deno/bin に置く"
dir = "pfd"
run = "deno task install"
```

`[tasks.setup]` の `depends` を次に変える。その上のコメント「実体を 2 つに割って」は「実体を 3 つに割って」に直す。

```toml
depends = ["core:deps", "app:deps", "pfd:deps"]
```

- [ ] **Step 3: 共有するテストデータを書く**

`pfd/test/fixture.ts`:

```ts
/** spec 6.1 の例を、検証（spec 6.2）に通る形で埋めたもの。 */
export const EXAMPLE_YAML = `issue: 123
title: 利用状況の集計を画面に出す
goal: [feature]

artifacts:
  - id: schema
    name: 既存スキーマ
    given: true
  - id: new-table
    name: 集計テーブル
    description: 日次の利用回数を持つテーブルとマイグレーション
    verify: マイグレーションが適用でき、テーブル定義のテストが通る
  - id: metric-definition
    name: 集計の定義
    description: 何を 1 回の利用と数えるか
    verify: 決めた内容が pfd done の note に書かれている
  - id: endpoint
    name: 集計 API
    description: 日次の利用回数を返す GET /usage
    verify: API のテストが通る
  - id: feature
    name: 集計画面
    description: 利用回数のグラフを出す画面
    verify: 画面のテストが通る

processes:
  - id: 1
    name: マイグレーションを書く
    inputs: [schema]
    outputs: [new-table]
    purpose: 集計結果を置く場所を用意する
    steps: 日次の利用回数を持つテーブルのマイグレーションを足す
    done_when: マイグレーションが適用でき、テストが通る
  - id: 2
    name: API を実装する
    inputs: [new-table, metric-definition]
    outputs: [endpoint]
    purpose: 集計テーブルの数字を外から読めるようにする
    steps: GET /usage を足し、集計テーブルを読んで返す
    done_when: API のテストが通る
  - id: 3
    name: 集計の定義を決める
    actor: human
    inputs: [schema]
    outputs: [metric-definition]
    purpose: 何を 1 回の利用と数えるかを決める
    done_when: 定義が文章になっている
  - id: 4
    name: 画面を繋ぐ
    inputs: [endpoint]
    outputs: [feature]
    purpose: 利用者が集計を見られるようにする
    steps: GET /usage を呼び、グラフを描く画面を足す
    done_when: 画面のテストが通る
`;
```

- [ ] **Step 4: 失敗するテストを書く**

`pfd/test/model.test.ts`:

```ts
import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { parsePfd } from "../src/model.ts";
import { EXAMPLE_YAML } from "./fixture.ts";

test("parsePfd: 例を読める", () => {
  const pfd = parsePfd(EXAMPLE_YAML);
  assert.equal(pfd.issue, 123);
  assert.deepEqual(pfd.goal, ["feature"]);
  assert.equal(pfd.artifacts.length, 5);
  assert.equal(pfd.processes.length, 4);
});

test("parsePfd: 引用符なしで書いたプロセスの id を文字列にする", () => {
  const pfd = parsePfd(EXAMPLE_YAML);
  assert.deepEqual(pfd.processes.map((p) => p.id), ["1", "2", "3", "4"]);
});

test("parsePfd: actor と given の既定値を埋める", () => {
  const pfd = parsePfd(EXAMPLE_YAML);
  assert.equal(pfd.processes[0].actor, "agent");
  assert.equal(pfd.processes[2].actor, "human");
  assert.equal(pfd.artifacts[0].given, true);
  assert.equal(pfd.artifacts[1].given, false);
});

test("parsePfd: 知らないキーを、場所を示して拒む", () => {
  const text = EXAMPLE_YAML.replace("    actor: human\n", "    actor: human\n    owner: me\n");
  assert.throws(() => parsePfd(text), /processes\.2/);
});

test("parsePfd: YAML として読めなければ、その旨を言う", () => {
  assert.throws(() => parsePfd("issue: [1"), /YAML として読めません/);
});

test("parsePfd: goal が空なら拒む", () => {
  assert.throws(() => parsePfd(EXAMPLE_YAML.replace("goal: [feature]", "goal: []")), /goal/);
});
```

- [ ] **Step 5: 失敗を確かめる**

Run: `cd pfd && deno install && deno task test`
Expected: FAIL（`../src/model.ts` が無い）。`deno install` は `deno.lock` を作る。

- [ ] **Step 6: 実装する**

`pfd/src/model.ts`:

```ts
import { parse } from "yaml";
import { z } from "zod";

/** YAML では `id: 1` と引用符なしで書かれることが多いので、数値も受けて文字列に揃える。 */
const idSchema = z.union([z.string().min(1), z.number()]).transform((v) => String(v));

const artifactSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  given: z.boolean().default(false),
  description: z.string().optional(),
  verify: z.string().optional(),
}).strict();

const processSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  actor: z.enum(["agent", "human"]).default("agent"),
  inputs: z.array(idSchema),
  outputs: z.array(idSchema),
  purpose: z.string().optional(),
  steps: z.string().optional(),
  done_when: z.string().optional(),
}).strict();

const pfdSchema = z.object({
  issue: z.number().int().positive(),
  title: z.string().min(1),
  goal: z.array(idSchema).min(1),
  artifacts: z.array(artifactSchema),
  processes: z.array(processSchema),
}).strict();

export type Artifact = z.infer<typeof artifactSchema>;
export type Process = z.infer<typeof processSchema>;
export type Pfd = z.infer<typeof pfdSchema>;

export function parsePfd(text: string): Pfd {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (err) {
    throw new Error(`PFD を YAML として読めません: ${(err as Error).message}`);
  }
  const result = pfdSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${i.path.join(".") || "(全体)"}: ${i.message}`);
    throw new Error(`PFD の形が正しくありません:\n${lines.join("\n")}`);
  }
  return result.data;
}
```

- [ ] **Step 7: 通ることを確かめる**

Run: `cd pfd && deno task test && deno task check && deno fmt --check && deno lint`
Expected: すべて成功。`deno fmt --check` が落ちたら `deno fmt` をかける。

- [ ] **Step 8: コミット**

```bash
git add pfd/deno.json pfd/deno.lock pfd/src/model.ts pfd/test/fixture.ts pfd/test/model.test.ts mise.toml
git commit -m "pfd: パッケージを足し、PFD の YAML を読めるようにする"
```

---

### Task 2: 構造の検証

**Files:**
- Create: `pfd/src/validate.ts`
- Create: `pfd/test/validate.test.ts`

**Interfaces:**
- Consumes: `Pfd`、`parsePfd`（Task 1）、`EXAMPLE_YAML`
- Produces:
  - `interface Violation { rule: string; id: string; message: string }`
  - `validatePfd(pfd: Pfd): Violation[]` — 違反が無ければ空配列
  - `rule` の値: `duplicate_artifact` `duplicate_process` `no_input` `no_output` `undefined_artifact` `multiple_producers` `given_has_producer` `no_producer` `unused_artifact` `no_verify` `missing_definition` `cycle` `goal_unreachable`

- [ ] **Step 1: 失敗するテストを書く**

`pfd/test/validate.test.ts`:

```ts
import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { parsePfd, type Pfd } from "../src/model.ts";
import { validatePfd } from "../src/validate.ts";
import { EXAMPLE_YAML } from "./fixture.ts";

function example(): Pfd {
  return parsePfd(EXAMPLE_YAML);
}

function rules(pfd: Pfd): string[] {
  return validatePfd(pfd).map((v) => `${v.rule}:${v.id}`);
}

test("validatePfd: 例には違反が無い", () => {
  assert.deepEqual(validatePfd(example()), []);
});

test("validatePfd: 入力の無いプロセス", () => {
  const pfd = example();
  pfd.processes[3].inputs = [];
  assert.ok(rules(pfd).includes("no_input:4"));
});

test("validatePfd: 出力の無いプロセス", () => {
  const pfd = example();
  pfd.processes[3].outputs = [];
  assert.ok(rules(pfd).includes("no_output:4"));
});

test("validatePfd: 定義されていない成果物を参照している", () => {
  const pfd = example();
  pfd.processes[0].inputs = ["ghost"];
  assert.ok(rules(pfd).includes("undefined_artifact:ghost"));
});

test("validatePfd: goal が定義されていない成果物を指している", () => {
  const pfd = example();
  pfd.goal = ["ghost"];
  assert.ok(rules(pfd).includes("undefined_artifact:ghost"));
});

test("validatePfd: 同じ成果物を 2 つのプロセスが出力している", () => {
  const pfd = example();
  pfd.processes[3].outputs = ["feature", "endpoint"];
  assert.ok(rules(pfd).includes("multiple_producers:endpoint"));
});

test("validatePfd: given の成果物を出力するプロセスがある", () => {
  const pfd = example();
  pfd.processes[0].outputs = ["new-table", "schema"];
  assert.ok(rules(pfd).includes("given_has_producer:schema"));
});

test("validatePfd: given でないのに出力するプロセスが無い", () => {
  const pfd = example();
  pfd.artifacts[0].given = false;
  pfd.artifacts[0].verify = "ある";
  assert.ok(rules(pfd).includes("no_producer:schema"));
});

test("validatePfd: 誰にも使われない成果物", () => {
  const pfd = example();
  pfd.artifacts.push({ id: "orphan", name: "使われないもの", given: true });
  assert.ok(rules(pfd).includes("unused_artifact:orphan"));
});

test("validatePfd: verify の無い成果物", () => {
  const pfd = example();
  delete pfd.artifacts[1].verify;
  assert.ok(rules(pfd).includes("no_verify:new-table"));
});

test("validatePfd: given の成果物に verify は要らない", () => {
  assert.ok(!rules(example()).includes("no_verify:schema"));
});

test("validatePfd: agent のプロセスに定義が欠けている", () => {
  const pfd = example();
  delete pfd.processes[0].steps;
  const v = validatePfd(pfd).find((x) => x.rule === "missing_definition");
  assert.equal(v?.id, "1");
  assert.match(v!.message, /steps/);
});

test("validatePfd: human のプロセスに steps は要らない", () => {
  assert.ok(!rules(example()).some((r) => r === "missing_definition:3"));
});

test("validatePfd: id の重複", () => {
  const pfd = example();
  pfd.processes[1].id = "1";
  pfd.artifacts[1].id = "schema";
  const r = rules(pfd);
  assert.ok(r.includes("duplicate_process:1"));
  assert.ok(r.includes("duplicate_artifact:schema"));
});

test("validatePfd: 循環", () => {
  const pfd = example();
  // 1 が、下流の 4 の出力を入力に取る
  pfd.processes[0].inputs = ["schema", "feature"];
  pfd.goal = ["endpoint"];
  assert.ok(validatePfd(pfd).some((v) => v.rule === "cycle"));
});

test("validatePfd: goal に given から辿り着けない", () => {
  const pfd = example();
  pfd.processes[0].inputs = ["schema", "feature"];
  assert.ok(rules(pfd).includes("goal_unreachable:feature"));
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `cd pfd && deno task test`
Expected: FAIL（`../src/validate.ts` が無い）

- [ ] **Step 3: 実装する**

`pfd/src/validate.ts`:

```ts
import type { Pfd } from "./model.ts";

export interface Violation {
  rule: string;
  id: string;
  message: string;
}

export function validatePfd(pfd: Pfd): Violation[] {
  const out: Violation[] = [];
  const add = (rule: string, id: string, message: string) => out.push({ rule, id, message });

  const artifactIds = new Set<string>();
  for (const a of pfd.artifacts) {
    if (artifactIds.has(a.id)) {
      add("duplicate_artifact", a.id, `成果物の id が重複しています: ${a.id}`);
    }
    artifactIds.add(a.id);
  }
  const processIds = new Set<string>();
  for (const p of pfd.processes) {
    if (processIds.has(p.id)) {
      add("duplicate_process", p.id, `プロセスの id が重複しています: ${p.id}`);
    }
    processIds.add(p.id);
  }

  const producers = new Map<string, string[]>();
  const consumers = new Map<string, string[]>();
  const push = (m: Map<string, string[]>, k: string, v: string) =>
    m.set(k, [...(m.get(k) ?? []), v]);

  for (const p of pfd.processes) {
    if (p.inputs.length === 0) add("no_input", p.id, `プロセス ${p.id} に入力の成果物がありません`);
    if (p.outputs.length === 0) {
      add("no_output", p.id, `プロセス ${p.id} に出力の成果物がありません`);
    }
    for (const ref of [...p.inputs, ...p.outputs]) {
      if (!artifactIds.has(ref)) {
        add(
          "undefined_artifact",
          ref,
          `プロセス ${p.id} が、定義されていない成果物 ${ref} を参照しています`,
        );
      }
    }
    for (const ref of p.inputs) push(consumers, ref, p.id);
    for (const ref of p.outputs) push(producers, ref, p.id);
  }
  for (const g of pfd.goal) {
    if (!artifactIds.has(g)) {
      add("undefined_artifact", g, `goal が、定義されていない成果物 ${g} を指しています`);
    }
  }

  for (const a of pfd.artifacts) {
    const by = producers.get(a.id) ?? [];
    if (by.length > 1) {
      add(
        "multiple_producers",
        a.id,
        `成果物 ${a.id} を複数のプロセスが出力しています: ${by.join(", ")}`,
      );
    }
    if (a.given && by.length > 0) {
      add(
        "given_has_producer",
        a.id,
        `成果物 ${a.id} は given なのに、プロセス ${by.join(", ")} が出力しています`,
      );
    }
    if (!a.given && by.length === 0) {
      add(
        "no_producer",
        a.id,
        `成果物 ${a.id} を出力するプロセスがありません（最初からあるものなら given: true）`,
      );
    }
    if (!pfd.goal.includes(a.id) && (consumers.get(a.id) ?? []).length === 0) {
      add("unused_artifact", a.id, `成果物 ${a.id} は、どのプロセスの入力にもなっていません`);
    }
    if (!a.given && !a.verify) {
      add("no_verify", a.id, `成果物 ${a.id} に verify（確かめ方）がありません`);
    }
  }

  for (const p of pfd.processes) {
    if (p.actor !== "agent") continue;
    const missing = (["purpose", "steps", "done_when"] as const).filter((k) => !p[k]);
    if (missing.length > 0) {
      add("missing_definition", p.id, `プロセス ${p.id} に ${missing.join(", ")} がありません`);
    }
  }

  // プロセス A の出力をプロセス B が入力に取るとき、A → B の辺を張る
  const next = new Map<string, string[]>();
  for (const p of pfd.processes) {
    next.set(p.id, p.outputs.flatMap((o) => consumers.get(o) ?? []));
  }
  const color = new Map<string, "visiting" | "done">();
  const visit = (id: string): boolean => {
    if (color.get(id) === "visiting") return true;
    if (color.get(id) === "done") return false;
    color.set(id, "visiting");
    const found = (next.get(id) ?? []).some(visit);
    color.set(id, "done");
    return found;
  };
  for (const p of pfd.processes) {
    if (color.has(p.id)) continue;
    if (visit(p.id)) add("cycle", p.id, `プロセス ${p.id} を含む循環があります`);
  }

  // given から始めて、入力がすべて手に入るプロセスの出力を足していく
  const available = new Set(pfd.artifacts.filter((a) => a.given).map((a) => a.id));
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of pfd.processes) {
      if (p.inputs.length === 0 || !p.inputs.every((i) => available.has(i))) continue;
      for (const o of p.outputs) {
        if (!available.has(o)) {
          available.add(o);
          grew = true;
        }
      }
    }
  }
  for (const g of pfd.goal) {
    if (artifactIds.has(g) && !available.has(g)) {
      add("goal_unreachable", g, `goal の成果物 ${g} に、given の成果物から辿り着けません`);
    }
  }

  return out;
}
```

- [ ] **Step 4: 通ることを確かめる**

Run: `cd pfd && deno task test && deno task check && deno fmt --check && deno lint`
Expected: すべて成功

- [ ] **Step 5: コミット**

```bash
git add pfd/src/validate.ts pfd/test/validate.test.ts
git commit -m "pfd: PFD の構造を検証する"
```

---

### Task 3: 置き場所と投入の記録

**Files:**
- Create: `pfd/src/store.ts`
- Create: `pfd/test/store.test.ts`

**Interfaces:**
- Consumes: なし
- Produces:
  - `stateRoot(): string` — `DOCTRINE_STATE_DIR`（空文字は未指定扱い）、無ければ `$HOME/.local/state/doctrine`
  - `projectKey(projectPath: string): Promise<string>` — `<ディレクトリ名>-<絶対パスの SHA-256 の先頭 8 文字>`
  - `pfdDir(projectPath: string, issue: number): Promise<string>` — `<stateRoot>/pfd/<key>/<issue>`。作りはしない
  - `interface DispatchRecord { approved: { hash: string; at: string } | null; tasks: Record<string, { task_id: string; branch: string; at: string }>; done: Record<string, { note: string; at: string }> }`（`tasks` と `done` のキーはプロセスの id）
  - `emptyRecord(): DispatchRecord`
  - `readRecord(dir: string): Promise<DispatchRecord>` — `dispatch.json` が無ければ `emptyRecord()`
  - `writeRecord(dir: string, record: DispatchRecord): Promise<void>` — 一時ファイルに書いて rename する
  - `hashOf(text: string): Promise<string>` — SHA-256 の 16 進

- [ ] **Step 1: 失敗するテストを書く**

`pfd/test/store.test.ts`:

```ts
import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { join } from "@std/path";
import {
  emptyRecord,
  hashOf,
  pfdDir,
  projectKey,
  readRecord,
  stateRoot,
  writeRecord,
} from "../src/store.ts";

async function withStateDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const prev = Deno.env.get("DOCTRINE_STATE_DIR");
  const dir = await Deno.makeTempDir();
  Deno.env.set("DOCTRINE_STATE_DIR", dir);
  try {
    await fn(dir);
  } finally {
    if (prev === undefined) Deno.env.delete("DOCTRINE_STATE_DIR");
    else Deno.env.set("DOCTRINE_STATE_DIR", prev);
    await Deno.remove(dir, { recursive: true });
  }
}

test("stateRoot: DOCTRINE_STATE_DIR を使う", async () => {
  await withStateDir((dir) => {
    assert.equal(stateRoot(), dir);
    return Promise.resolve();
  });
});

test("stateRoot: 空文字なら未指定として扱う", () => {
  const prev = Deno.env.get("DOCTRINE_STATE_DIR");
  Deno.env.set("DOCTRINE_STATE_DIR", "");
  try {
    assert.ok(stateRoot().endsWith("/.local/state/doctrine"));
  } finally {
    if (prev === undefined) Deno.env.delete("DOCTRINE_STATE_DIR");
    else Deno.env.set("DOCTRINE_STATE_DIR", prev);
  }
});

test("projectKey: ディレクトリ名とハッシュ 8 文字", async () => {
  assert.match(await projectKey("/work/doctrine"), /^doctrine-[0-9a-f]{8}$/);
});

test("projectKey: 同じ名前でも場所が違えば別のキーになる", async () => {
  assert.notEqual(await projectKey("/a/doctrine"), await projectKey("/b/doctrine"));
});

test("pfdDir: 状態ディレクトリ配下に issue ごとの場所を返す", async () => {
  await withStateDir(async (dir) => {
    const key = await projectKey("/work/doctrine");
    assert.equal(await pfdDir("/work/doctrine", 123), join(dir, "pfd", key, "123"));
  });
});

test("readRecord: ファイルが無ければ空の記録", async () => {
  const dir = await Deno.makeTempDir();
  try {
    assert.deepEqual(await readRecord(dir), emptyRecord());
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("writeRecord → readRecord: 書いたものが読める", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const record = emptyRecord();
    record.approved = { hash: "abc", at: "2026-09-20T00:00:00.000Z" };
    record.tasks["1"] = { task_id: "t1", branch: "doctrine/t1", at: "2026-09-20T00:00:01.000Z" };
    record.done["3"] = { note: "決めた", at: "2026-09-20T00:00:02.000Z" };
    await writeRecord(dir, record);
    assert.deepEqual(await readRecord(dir), record);
    // 一時ファイルを残さない
    const names = [];
    for await (const e of Deno.readDir(dir)) names.push(e.name);
    assert.deepEqual(names, ["dispatch.json"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("hashOf: 同じ文字列は同じハッシュ、違えば違うハッシュ", async () => {
  assert.equal(await hashOf("a"), await hashOf("a"));
  assert.notEqual(await hashOf("a"), await hashOf("b"));
  assert.match(await hashOf("a"), /^[0-9a-f]{64}$/);
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `cd pfd && deno task test`
Expected: FAIL（`../src/store.ts` が無い）

- [ ] **Step 3: 実装する**

`pfd/src/store.ts`:

```ts
import { basename, join } from "@std/path";

/** doctrine（core/src/util/home.ts）と同じ規則。core は import しないので、規則だけを揃えている。 */
export function stateRoot(): string {
  const dir = Deno.env.get("DOCTRINE_STATE_DIR");
  if (dir) return dir;
  const home = Deno.env.get("HOME");
  if (!home) {
    throw new Error(
      "HOME が設定されていません（DOCTRINE_STATE_DIR で状態ディレクトリを指定してください）",
    );
  }
  return join(home, ".local", "state", "doctrine");
}

export async function hashOf(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function projectKey(projectPath: string): Promise<string> {
  return `${basename(projectPath)}-${(await hashOf(projectPath)).slice(0, 8)}`;
}

export async function pfdDir(projectPath: string, issue: number): Promise<string> {
  return join(stateRoot(), "pfd", await projectKey(projectPath), String(issue));
}

export interface DispatchRecord {
  approved: { hash: string; at: string } | null;
  tasks: Record<string, { task_id: string; branch: string; at: string }>;
  done: Record<string, { note: string; at: string }>;
}

export function emptyRecord(): DispatchRecord {
  return { approved: null, tasks: {}, done: {} };
}

export async function readRecord(dir: string): Promise<DispatchRecord> {
  let text: string;
  try {
    text = await Deno.readTextFile(join(dir, "dispatch.json"));
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return emptyRecord();
    throw err;
  }
  return JSON.parse(text) as DispatchRecord;
}

export async function writeRecord(dir: string, record: DispatchRecord): Promise<void> {
  const target = join(dir, "dispatch.json");
  const tmp = `${target}.tmp`;
  await Deno.writeTextFile(tmp, JSON.stringify(record, null, 2) + "\n");
  await Deno.rename(tmp, target);
}
```

- [ ] **Step 4: 通ることを確かめる**

Run: `cd pfd && deno task test && deno task check && deno fmt --check && deno lint`
Expected: すべて成功

- [ ] **Step 5: コミット**

```bash
git add pfd/src/store.ts pfd/test/store.test.ts
git commit -m "pfd: PFD の置き場所と投入の記録を足す"
```

---

### Task 4: `dctl` と `gh` の窓口

**Files:**
- Create: `pfd/src/exec.ts`
- Create: `pfd/src/ports.ts`
- Create: `pfd/test/ports.test.ts`

**Interfaces:**
- Consumes: なし
- Produces:
  - `type Run = (cmd: string, args: string[], cwd?: string) => Promise<string>` — stdout を返す。非 0 終了は例外
  - `runStdout: Run`（`pfd/src/exec.ts`）— 実物
  - `interface TaskFact { id: string; title: string; state: string; branch: string }`
  - `type PrState = "merged" | "open" | "none"`
  - `interface Ports { listTasks(projectPath: string): Promise<TaskFact[]>; addTask(projectPath: string, title: string, prompt: string): Promise<{ id: string; branch: string }>; prState(projectPath: string, branch: string): Promise<PrState>; issue(projectPath: string, issue: number): Promise<{ url: string; title: string }> }`
  - `realPorts(run?: Run): Ports`

前提となる事実（実装者が `core/` を読まなくて済むように）:

- `dctl ls --project <path>` は、タスクの配列を JSON で stdout に出す。各要素は少なくとも `id` `title` `state` `branch` を持つ
- `dctl add --project <path> --title <t> --prompt <p>` は、作ったタスクを JSON で出す。`id` と `branch` を持つ
- `dctl` は `--project` を**登録時のパス文字列との完全一致**で引く
- `gh pr list --head <branch> --state all --json state` は `[{"state":"MERGED"}]` のような配列を出す。値は `OPEN` `CLOSED` `MERGED`
- `gh issue view <n> --json url,title` は `{"url":"...","title":"..."}` を出す
- `gh` は対象リポジトリの中で走らせる必要がある（`cwd` にプロジェクトのパスを渡す）

- [ ] **Step 1: 失敗するテストを書く**

`pfd/test/ports.test.ts`:

```ts
import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { realPorts, type Run } from "../src/ports.ts";

interface Call {
  cmd: string;
  args: string[];
  cwd?: string;
}

function fakeRun(stdout: string): { run: Run; calls: Call[] } {
  const calls: Call[] = [];
  const run: Run = (cmd, args, cwd) => {
    calls.push({ cmd, args, cwd });
    return Promise.resolve(stdout);
  };
  return { run, calls };
}

test("listTasks: dctl ls を呼び、必要な列だけを返す", async () => {
  const { run, calls } = fakeRun(JSON.stringify([
    { id: "t1", title: "[pfd:123/1] x", state: "running", branch: "doctrine/t1-x", prompt: "長い" },
  ]));
  const tasks = await realPorts(run).listTasks("/work/repo");
  assert.deepEqual(calls, [{
    cmd: "dctl",
    args: ["ls", "--project", "/work/repo"],
    cwd: undefined,
  }]);
  assert.deepEqual(tasks, [
    { id: "t1", title: "[pfd:123/1] x", state: "running", branch: "doctrine/t1-x" },
  ]);
});

test("addTask: dctl add を呼び、id と branch を返す", async () => {
  const { run, calls } = fakeRun(JSON.stringify({ id: "t2", branch: "doctrine/t2", warnings: [] }));
  const created = await realPorts(run).addTask("/work/repo", "[pfd:123/2] y", "本文");
  assert.deepEqual(calls[0].args, [
    "add",
    "--project",
    "/work/repo",
    "--title",
    "[pfd:123/2] y",
    "--prompt",
    "本文",
  ]);
  assert.deepEqual(created, { id: "t2", branch: "doctrine/t2" });
});

test("prState: マージ済みの PR が 1 つでもあれば merged", async () => {
  const { run, calls } = fakeRun(JSON.stringify([{ state: "CLOSED" }, { state: "MERGED" }]));
  assert.equal(await realPorts(run).prState("/work/repo", "doctrine/t1"), "merged");
  assert.deepEqual(calls[0], {
    cmd: "gh",
    args: ["pr", "list", "--head", "doctrine/t1", "--state", "all", "--json", "state"],
    cwd: "/work/repo",
  });
});

test("prState: 開いている PR だけなら open", async () => {
  const { run } = fakeRun(JSON.stringify([{ state: "OPEN" }]));
  assert.equal(await realPorts(run).prState("/work/repo", "b"), "open");
});

test("prState: PR が無い、または閉じられた PR だけなら none", async () => {
  assert.equal(await realPorts(fakeRun("[]").run).prState("/work/repo", "b"), "none");
  const closed = fakeRun(JSON.stringify([{ state: "CLOSED" }]));
  assert.equal(await realPorts(closed.run).prState("/work/repo", "b"), "none");
});

test("issue: gh issue view を対象リポジトリの中で呼ぶ", async () => {
  const { run, calls } = fakeRun(
    JSON.stringify({ url: "https://github.com/o/r/issues/123", title: "集計" }),
  );
  const issue = await realPorts(run).issue("/work/repo", 123);
  assert.deepEqual(calls[0], {
    cmd: "gh",
    args: ["issue", "view", "123", "--json", "url,title"],
    cwd: "/work/repo",
  });
  assert.deepEqual(issue, { url: "https://github.com/o/r/issues/123", title: "集計" });
});

test("JSON として読めない出力は、どのコマンドのものかを示して失敗する", async () => {
  await assert.rejects(realPorts(fakeRun("not json").run).listTasks("/work/repo"), /dctl ls/);
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `cd pfd && deno task test`
Expected: FAIL（`../src/ports.ts` が無い）

- [ ] **Step 3: `exec.ts` を実装する**

`pfd/src/exec.ts`:

```ts
import type { Run } from "./ports.ts";

export const runStdout: Run = async (cmd, args, cwd) => {
  let out: Deno.CommandOutput;
  try {
    out = await new Deno.Command(cmd, {
      args,
      cwd,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    })
      .output();
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      throw new Error(`${cmd} が見つかりません（PATH を確認してください）`);
    }
    throw err;
  }
  const decoder = new TextDecoder();
  if (!out.success) {
    throw new Error(`${[cmd, ...args].join(" ")} が失敗しました:\n${decoder.decode(out.stderr)}`);
  }
  return decoder.decode(out.stdout);
};
```

- [ ] **Step 4: `ports.ts` を実装する**

`pfd/src/ports.ts`:

```ts
import { runStdout } from "./exec.ts";

export type Run = (cmd: string, args: string[], cwd?: string) => Promise<string>;

export interface TaskFact {
  id: string;
  title: string;
  state: string;
  branch: string;
}

export type PrState = "merged" | "open" | "none";

export interface Ports {
  listTasks(projectPath: string): Promise<TaskFact[]>;
  addTask(
    projectPath: string,
    title: string,
    prompt: string,
  ): Promise<{ id: string; branch: string }>;
  prState(projectPath: string, branch: string): Promise<PrState>;
  issue(projectPath: string, issue: number): Promise<{ url: string; title: string }>;
}

function parseJson<T>(stdout: string, label: string): T {
  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new Error(`${label} の出力を JSON として読めません: ${stdout.slice(0, 200)}`);
  }
}

export function realPorts(run: Run = runStdout): Ports {
  return {
    async listTasks(projectPath) {
      const rows = parseJson<TaskFact[]>(
        await run("dctl", ["ls", "--project", projectPath]),
        "dctl ls",
      );
      return rows.map((r) => ({ id: r.id, title: r.title, state: r.state, branch: r.branch }));
    },
    async addTask(projectPath, title, prompt) {
      const args = ["add", "--project", projectPath, "--title", title, "--prompt", prompt];
      const row = parseJson<{ id: string; branch: string }>(await run("dctl", args), "dctl add");
      return { id: row.id, branch: row.branch };
    },
    async prState(projectPath, branch) {
      const args = ["pr", "list", "--head", branch, "--state", "all", "--json", "state"];
      const rows = parseJson<{ state: string }[]>(await run("gh", args, projectPath), "gh pr list");
      if (rows.some((r) => r.state === "MERGED")) return "merged";
      if (rows.some((r) => r.state === "OPEN")) return "open";
      return "none";
    },
    async issue(projectPath, issue) {
      const args = ["issue", "view", String(issue), "--json", "url,title"];
      const row = parseJson<{ url: string; title: string }>(
        await run("gh", args, projectPath),
        "gh issue view",
      );
      return { url: row.url, title: row.title };
    },
  };
}
```

- [ ] **Step 5: 通ることを確かめる**

Run: `cd pfd && deno task test && deno task check && deno fmt --check && deno lint`
Expected: すべて成功

- [ ] **Step 6: コミット**

```bash
git add pfd/src/exec.ts pfd/src/ports.ts pfd/test/ports.test.ts
git commit -m "pfd: dctl と gh の窓口を足す"
```

---

### Task 5: 各プロセスの状態を決める

**Files:**
- Create: `pfd/src/key.ts`
- Create: `pfd/src/status.ts`
- Create: `pfd/test/status.test.ts`

**Interfaces:**
- Consumes: `Pfd` `Process`（Task 1）、`DispatchRecord` `emptyRecord`（Task 3）、`Ports` `TaskFact` `PrState`（Task 4）
- Produces:
  - `keyOf(issue: number, processId: string): string` — `[pfd:123/2]`
  - `taskTitle(issue: number, process: Process): string` — `[pfd:123/2] API を実装する`
  - `findTask(tasks: TaskFact[], issue: number, processId: string): TaskFact | undefined` — タイトルが `キー + 半角空白` で始まる最初のタスク
  - `interface Facts { tasks: TaskFact[]; prs: Record<string, PrState> }`（`prs` のキーはブランチ名）
  - `type ProcessState = "done" | "your_turn" | "merged" | "pr_open" | "no_pr" | "task_stopped" | "running" | "ready" | "waiting"`
  - `interface ProcessStatus { id: string; name: string; actor: "agent" | "human"; state: ProcessState; task_id?: string; branch?: string; waiting_for: string[] }`（`waiting_for` は、まだ揃っていない入力の成果物の `name`）
  - `computeStatus(pfd: Pfd, record: DispatchRecord, facts: Facts): ProcessStatus[]` — `pfd.processes` と同じ順
  - `gatherFacts(pfd: Pfd, projectPath: string, ports: Ports): Promise<Facts>` — `listTasks` を 1 回、タスクが見つかったプロセスのブランチごとに `prState` を 1 回呼ぶ

状態の決め方（spec 7 章）:

| 担い手 | 条件 | 状態 |
| --- | --- | --- |
| human | `record.done` に id がある | `done` |
| human | 入力がすべて揃っている | `your_turn` |
| human | それ以外 | `waiting` |
| agent | タスクがあり、そのブランチの PR が merged | `merged` |
| agent | タスクがあり、PR が open | `pr_open` |
| agent | タスクがあり、PR が無く、タスクが `completed` | `no_pr` |
| agent | タスクがあり、PR が無く、タスクが `failed` か `canceled` | `task_stopped` |
| agent | タスクがあり、上のどれでもない | `running` |
| agent | タスクが無く、入力がすべて揃っている | `ready` |
| agent | それ以外 | `waiting` |

成果物が「揃っている」のは、`given` であるか、それを出力するプロセスの状態が `done` または `merged` のとき。

- [ ] **Step 1: 失敗するテストを書く**

`pfd/test/status.test.ts`:

```ts
import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { parsePfd } from "../src/model.ts";
import { emptyRecord } from "../src/store.ts";
import { findTask, keyOf, taskTitle } from "../src/key.ts";
import { computeStatus, type Facts } from "../src/status.ts";
import { EXAMPLE_YAML } from "./fixture.ts";

const pfd = parsePfd(EXAMPLE_YAML);
const noFacts: Facts = { tasks: [], prs: {} };

function stateOf(facts: Facts, record = emptyRecord()): Record<string, string> {
  return Object.fromEntries(computeStatus(pfd, record, facts).map((s) => [s.id, s.state]));
}

function task(processId: string, state: string) {
  return {
    id: `t${processId}`,
    title: taskTitle(123, pfd.processes.find((p) => p.id === processId)!),
    state,
    branch: `doctrine/t${processId}`,
  };
}

test("keyOf / taskTitle: キーの形", () => {
  assert.equal(keyOf(123, "2"), "[pfd:123/2]");
  assert.equal(taskTitle(123, pfd.processes[1]), "[pfd:123/2] API を実装する");
});

test("findTask: 前方一致で別のプロセスを拾わない", () => {
  const tasks = [{ id: "a", title: "[pfd:123/12] x", state: "running", branch: "b" }];
  assert.equal(findTask(tasks, 123, "1"), undefined);
  assert.equal(findTask(tasks, 123, "12")?.id, "a");
});

test("computeStatus: 最初は 1 が着手可能、3 が人の番、2 と 4 は入力待ち", () => {
  assert.deepEqual(stateOf(noFacts), {
    "1": "ready",
    "2": "waiting",
    "3": "your_turn",
    "4": "waiting",
  });
});

test("computeStatus: 入力待ちのプロセスは、何を待っているかを成果物の名前で持つ", () => {
  const p2 = computeStatus(pfd, emptyRecord(), noFacts).find((s) => s.id === "2")!;
  assert.deepEqual(p2.waiting_for, ["集計テーブル", "集計の定義"]);
});

test("computeStatus: タスクがあれば running、task_id と branch を持つ", () => {
  const s = computeStatus(pfd, emptyRecord(), { tasks: [task("1", "running")], prs: {} })[0];
  assert.equal(s.state, "running");
  assert.equal(s.task_id, "t1");
  assert.equal(s.branch, "doctrine/t1");
});

test("computeStatus: PR が開いていれば pr_open", () => {
  const facts: Facts = { tasks: [task("1", "completed")], prs: { "doctrine/t1": "open" } };
  assert.equal(stateOf(facts)["1"], "pr_open");
});

test("computeStatus: completed なのに PR が無ければ no_pr", () => {
  const facts: Facts = { tasks: [task("1", "completed")], prs: { "doctrine/t1": "none" } };
  assert.equal(stateOf(facts)["1"], "no_pr");
});

test("computeStatus: failed / canceled は task_stopped", () => {
  assert.equal(stateOf({ tasks: [task("1", "failed")], prs: {} })["1"], "task_stopped");
  assert.equal(stateOf({ tasks: [task("1", "canceled")], prs: {} })["1"], "task_stopped");
});

test("computeStatus: 1 がマージされただけでは 2 は始まらない（人の成果物を待つ）", () => {
  const facts: Facts = { tasks: [task("1", "completed")], prs: { "doctrine/t1": "merged" } };
  const all = computeStatus(pfd, emptyRecord(), facts);
  assert.equal(all[0].state, "merged");
  assert.equal(all[1].state, "waiting");
  assert.deepEqual(all[1].waiting_for, ["集計の定義"]);
});

test("computeStatus: 1 がマージされ 3 が完了すれば 2 が着手可能になる", () => {
  const facts: Facts = { tasks: [task("1", "completed")], prs: { "doctrine/t1": "merged" } };
  const record = emptyRecord();
  record.done["3"] = { note: "ログイン 1 回を 1 利用と数える", at: "2026-09-20T00:00:00.000Z" };
  assert.deepEqual(stateOf(facts, record), {
    "1": "merged",
    "2": "ready",
    "3": "done",
    "4": "waiting",
  });
});

test("computeStatus: PR が開いているだけでは下流は始まらない", () => {
  const facts: Facts = { tasks: [task("1", "completed")], prs: { "doctrine/t1": "open" } };
  const record = emptyRecord();
  record.done["3"] = { note: "x", at: "2026-09-20T00:00:00.000Z" };
  assert.equal(stateOf(facts, record)["2"], "waiting");
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `cd pfd && deno task test`
Expected: FAIL（`../src/key.ts` が無い）

- [ ] **Step 3: `key.ts` を実装する**

`pfd/src/key.ts`:

```ts
import type { Process } from "./model.ts";
import type { TaskFact } from "./ports.ts";

export function keyOf(issue: number, processId: string): string {
  return `[pfd:${issue}/${processId}]`;
}

export function taskTitle(issue: number, process: Process): string {
  return `${keyOf(issue, process.id)} ${process.name}`;
}

export function findTask(
  tasks: TaskFact[],
  issue: number,
  processId: string,
): TaskFact | undefined {
  const prefix = `${keyOf(issue, processId)} `;
  return tasks.find((t) => t.title.startsWith(prefix));
}
```

- [ ] **Step 4: `status.ts` を実装する**

`pfd/src/status.ts`:

```ts
import { findTask } from "./key.ts";
import type { Pfd, Process } from "./model.ts";
import type { Ports, PrState, TaskFact } from "./ports.ts";
import type { DispatchRecord } from "./store.ts";

export interface Facts {
  tasks: TaskFact[];
  prs: Record<string, PrState>;
}

export type ProcessState =
  | "done"
  | "your_turn"
  | "merged"
  | "pr_open"
  | "no_pr"
  | "task_stopped"
  | "running"
  | "ready"
  | "waiting";

export interface ProcessStatus {
  id: string;
  name: string;
  actor: "agent" | "human";
  state: ProcessState;
  task_id?: string;
  branch?: string;
  waiting_for: string[];
}

/** 入力が揃っているかを見ずに決まる状態。決まらなければ undefined。 */
function settledState(
  p: Process,
  task: TaskFact | undefined,
  record: DispatchRecord,
  facts: Facts,
): ProcessState | undefined {
  if (p.actor === "human") return record.done[p.id] ? "done" : undefined;
  if (!task) return undefined;
  const pr = facts.prs[task.branch] ?? "none";
  if (pr === "merged") return "merged";
  if (pr === "open") return "pr_open";
  if (task.state === "completed") return "no_pr";
  if (task.state === "failed" || task.state === "canceled") return "task_stopped";
  return "running";
}

export function computeStatus(pfd: Pfd, record: DispatchRecord, facts: Facts): ProcessStatus[] {
  const tasks = new Map(pfd.processes.map((p) => [p.id, findTask(facts.tasks, pfd.issue, p.id)]));
  const settled = new Map(
    pfd.processes.map((p) => [p.id, settledState(p, tasks.get(p.id), record, facts)]),
  );

  const ready = new Set(pfd.artifacts.filter((a) => a.given).map((a) => a.id));
  for (const p of pfd.processes) {
    const s = settled.get(p.id);
    if (s === "done" || s === "merged") p.outputs.forEach((o) => ready.add(o));
  }
  const nameOf = new Map(pfd.artifacts.map((a) => [a.id, a.name]));

  return pfd.processes.map((p) => {
    const task = tasks.get(p.id);
    const missing = p.inputs.filter((i) => !ready.has(i));
    const open: ProcessState = missing.length > 0
      ? "waiting"
      : p.actor === "human"
      ? "your_turn"
      : "ready";
    const state = settled.get(p.id) ?? open;
    return {
      id: p.id,
      name: p.name,
      actor: p.actor,
      state,
      task_id: task?.id,
      branch: task?.branch,
      waiting_for: state === "waiting" ? missing.map((i) => nameOf.get(i) ?? i) : [],
    };
  });
}

export async function gatherFacts(pfd: Pfd, projectPath: string, ports: Ports): Promise<Facts> {
  const tasks = await ports.listTasks(projectPath);
  const prs: Record<string, PrState> = {};
  for (const p of pfd.processes) {
    const task = findTask(tasks, pfd.issue, p.id);
    if (task) prs[task.branch] = await ports.prState(projectPath, task.branch);
  }
  return { tasks, prs };
}
```

- [ ] **Step 5: 通ることを確かめる**

Run: `cd pfd && deno task test && deno task check && deno fmt --check && deno lint`
Expected: すべて成功（`gatherFacts` は Task 7 のテストが通す）

- [ ] **Step 6: コミット**

```bash
git add pfd/src/key.ts pfd/src/status.ts pfd/test/status.test.ts
git commit -m "pfd: 各プロセスの状態を決める"
```

---

### Task 6: タスクに渡す prompt

**Files:**
- Create: `pfd/src/prompt.ts`
- Create: `pfd/test/prompt.test.ts`

**Interfaces:**
- Consumes: `Pfd` `Process`（Task 1）、`DispatchRecord`（Task 3）
- Produces:
  - `buildPrompt(pfd: Pfd, process: Process, record: DispatchRecord, issue: { url: string; title: string }): string`
  - 入力の成果物のうち、出力するプロセスが `actor: human` のものは「人が決めたこと」に `record.done[<そのプロセスの id>].note` を載せる。note が無ければ `Error` を投げる。それ以外の入力は「すでに baseBranch にあるもの」に載せる

- [ ] **Step 1: 失敗するテストを書く**

`pfd/test/prompt.test.ts`:

```ts
import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { parsePfd } from "../src/model.ts";
import { buildPrompt } from "../src/prompt.ts";
import { emptyRecord } from "../src/store.ts";
import { EXAMPLE_YAML } from "./fixture.ts";

const pfd = parsePfd(EXAMPLE_YAML);
const issue = { url: "https://github.com/o/r/issues/123", title: "利用状況の集計を画面に出す" };

test("buildPrompt: 人の成果物を入力に取るプロセス", () => {
  const record = emptyRecord();
  record.done["3"] = { note: "ログイン 1 回を 1 利用と数える", at: "2026-09-20T00:00:00.000Z" };

  const expected = `https://github.com/o/r/issues/123 利用状況の集計を画面に出す

この作業は、上の Issue を分解したうちの 1 つである。

## 目的
集計テーブルの数字を外から読めるようにする

## 前提
すでに baseBranch にあるもの:
- 集計テーブル: 日次の利用回数を持つテーブルとマイグレーション

人が決めたこと:
- 集計の定義: ログイン 1 回を 1 利用と数える

## 作るもの
- 集計 API: 日次の利用回数を返す GET /usage
  確かめ方: API のテストが通る

## 手順
GET /usage を足し、集計テーブルを読んで返す

## 完了条件
API のテストが通る

## 範囲
この作業の出力は上の「作るもの」だけである。Issue の残りの部分は別の作業が担う。
`;
  assert.equal(buildPrompt(pfd, pfd.processes[1], record, issue), expected);
});

test("buildPrompt: 人の成果物が無ければ「人が決めたこと」を出さない", () => {
  const text = buildPrompt(pfd, pfd.processes[0], emptyRecord(), issue);
  assert.ok(!text.includes("人が決めたこと"));
  // description の無い成果物は名前だけ
  assert.ok(text.includes("すでに baseBranch にあるもの:\n- 既存スキーマ\n"));
});

test("buildPrompt: 人の成果物の note が無ければ失敗する", () => {
  assert.throws(
    () => buildPrompt(pfd, pfd.processes[1], emptyRecord(), issue),
    /集計の定義.*pfd done/,
  );
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `cd pfd && deno task test`
Expected: FAIL（`../src/prompt.ts` が無い）

- [ ] **Step 3: 実装する**

`pfd/src/prompt.ts`:

```ts
import type { Artifact, Pfd, Process } from "./model.ts";
import type { DispatchRecord } from "./store.ts";

function line(a: Artifact): string {
  return a.description ? `- ${a.name}: ${a.description}` : `- ${a.name}`;
}

export function buildPrompt(
  pfd: Pfd,
  process: Process,
  record: DispatchRecord,
  issue: { url: string; title: string },
): string {
  const artifact = new Map(pfd.artifacts.map((a) => [a.id, a]));
  const humanProducer = new Map<string, string>();
  for (const p of pfd.processes) {
    if (p.actor === "human") p.outputs.forEach((o) => humanProducer.set(o, p.id));
  }

  const onBase: string[] = [];
  const decided: string[] = [];
  for (const id of process.inputs) {
    const a = artifact.get(id)!;
    const by = humanProducer.get(id);
    if (by === undefined) {
      onBase.push(line(a));
      continue;
    }
    const note = record.done[by]?.note;
    if (!note) {
      throw new Error(
        `成果物「${a.name}」の内容がありません（プロセス ${by} を pfd done で完了にしてください）`,
      );
    }
    decided.push(`- ${a.name}: ${note}`);
  }

  const premise: string[] = [];
  if (onBase.length > 0) premise.push(`すでに baseBranch にあるもの:\n${onBase.join("\n")}`);
  if (decided.length > 0) premise.push(`人が決めたこと:\n${decided.join("\n")}`);

  const outputs = process.outputs.map((id) => {
    const a = artifact.get(id)!;
    return `${line(a)}\n  確かめ方: ${a.verify ?? ""}`;
  });

  return [
    `${issue.url} ${issue.title}`,
    "この作業は、上の Issue を分解したうちの 1 つである。",
    `## 目的\n${process.purpose ?? ""}`,
    `## 前提\n${premise.join("\n\n")}`,
    `## 作るもの\n${outputs.join("\n")}`,
    `## 手順\n${process.steps ?? ""}`,
    `## 完了条件\n${process.done_when ?? ""}`,
    "## 範囲\nこの作業の出力は上の「作るもの」だけである。Issue の残りの部分は別の作業が担う。",
  ].join("\n\n") + "\n";
}
```

- [ ] **Step 4: 通ることを確かめる**

Run: `cd pfd && deno task test && deno task check && deno fmt --check && deno lint`
Expected: すべて成功

- [ ] **Step 5: コミット**

```bash
git add pfd/src/prompt.ts pfd/test/prompt.test.ts
git commit -m "pfd: プロセス定義からタスクの prompt を組み立てる"
```

---

### Task 7: 投入

**Files:**
- Create: `pfd/test/fakePorts.ts`
- Create: `pfd/src/dispatch.ts`
- Create: `pfd/test/dispatch.test.ts`

**Interfaces:**
- Consumes: `parsePfd`（Task 1）、`readRecord` `writeRecord` `hashOf` `emptyRecord`（Task 3）、`Ports` `TaskFact` `PrState`（Task 4）、`taskTitle` `computeStatus` `gatherFacts`（Task 5）、`buildPrompt`（Task 6）
- Produces:
  - `interface DispatchInput { pfd: Pfd; text: string; dir: string; projectPath: string; ports: Ports; now: () => string }`（`text` は `pfd.yaml` の中身そのもの。承認時のハッシュと照合する）
  - `interface DispatchResult { created: { process_id: string; task_id: string }[]; adopted: { process_id: string; task_id: string }[] }`
  - `dispatch(input: DispatchInput): Promise<DispatchResult>`
  - `class FakePorts implements Ports`（`pfd/test/fakePorts.ts`）— `tasks: TaskFact[]`、`prs: Record<string, PrState>`、`added: { title: string; prompt: string }[]` を公開する。`addTask` は `tasks` に `state: "queued"` のタスクを足す

振る舞い（spec 7 章）:

1. `record.approved` が無ければ失敗する。`hashOf(text)` が承認時のハッシュと違えば失敗する
2. `gatherFacts` → `computeStatus`
3. タスクがあるのに `record.tasks` に無いプロセスは、記録に書き戻す（`adopted`）
4. `ready` のプロセスを 1 つずつ `addTask` し、**1 つ足すごとに** `writeRecord` する（途中で落ちても、失うのは高々 1 件の記録で、それは次回 3 で書き戻される）

- [ ] **Step 1: メモリ上の `Ports` を書く**

`pfd/test/fakePorts.ts`:

```ts
import type { Ports, PrState, TaskFact } from "../src/ports.ts";

export class FakePorts implements Ports {
  tasks: TaskFact[] = [];
  prs: Record<string, PrState> = {};
  added: { title: string; prompt: string }[] = [];

  listTasks(_projectPath: string): Promise<TaskFact[]> {
    return Promise.resolve([...this.tasks]);
  }

  addTask(_projectPath: string, title: string, prompt: string) {
    const id = `t${this.tasks.length + 1}`;
    const branch = `doctrine/${id}`;
    this.tasks.push({ id, title, state: "queued", branch });
    this.added.push({ title, prompt });
    return Promise.resolve({ id, branch });
  }

  prState(_projectPath: string, branch: string): Promise<PrState> {
    return Promise.resolve(this.prs[branch] ?? "none");
  }

  issue(_projectPath: string, issue: number) {
    return Promise.resolve({
      url: `https://github.com/o/r/issues/${issue}`,
      title: "利用状況の集計を画面に出す",
    });
  }
}
```

- [ ] **Step 2: 失敗するテストを書く**

`pfd/test/dispatch.test.ts`:

```ts
import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { dispatch } from "../src/dispatch.ts";
import { parsePfd } from "../src/model.ts";
import { emptyRecord, hashOf, readRecord, writeRecord } from "../src/store.ts";
import { FakePorts } from "./fakePorts.ts";
import { EXAMPLE_YAML } from "./fixture.ts";

const NOW = "2026-09-20T00:00:00.000Z";

async function setup(approved = true) {
  const dir = await Deno.makeTempDir();
  const ports = new FakePorts();
  if (approved) {
    const record = emptyRecord();
    record.approved = { hash: await hashOf(EXAMPLE_YAML), at: NOW };
    await writeRecord(dir, record);
  }
  const run = (text = EXAMPLE_YAML) =>
    dispatch({
      pfd: parsePfd(text),
      text,
      dir,
      projectPath: "/work/repo",
      ports,
      now: () => NOW,
    });
  return { dir, ports, run, cleanup: () => Deno.remove(dir, { recursive: true }) };
}

test("dispatch: 承認されていなければ失敗し、何も投入しない", async () => {
  const s = await setup(false);
  try {
    await assert.rejects(s.run(), /承認されていません/);
    assert.equal(s.ports.added.length, 0);
  } finally {
    await s.cleanup();
  }
});

test("dispatch: 承認の後に pfd.yaml が変わっていれば失敗する", async () => {
  const s = await setup();
  try {
    await assert.rejects(s.run(EXAMPLE_YAML.replace("集計画面", "集計ページ")), /承認の後に/);
    assert.equal(s.ports.added.length, 0);
  } finally {
    await s.cleanup();
  }
});

test("dispatch: 最初は入力が揃った agent のプロセスだけを投入する", async () => {
  const s = await setup();
  try {
    const result = await s.run();
    assert.deepEqual(result.created, [{ process_id: "1", task_id: "t1" }]);
    assert.deepEqual(s.ports.added.map((a) => a.title), ["[pfd:123/1] マイグレーションを書く"]);
    assert.ok(s.ports.added[0].prompt.includes("## 目的\n集計結果を置く場所を用意する"));
    const record = await readRecord(s.dir);
    assert.deepEqual(record.tasks["1"], { task_id: "t1", branch: "doctrine/t1", at: NOW });
  } finally {
    await s.cleanup();
  }
});

test("dispatch: 続けて 2 回叩いても、同じプロセスを 2 回投入しない", async () => {
  const s = await setup();
  try {
    await s.run();
    const second = await s.run();
    assert.deepEqual(second, { created: [], adopted: [] });
    assert.equal(s.ports.added.length, 1);
  } finally {
    await s.cleanup();
  }
});

test("dispatch: 記録に無くても同じキーのタスクがあれば、投入せず記録に書き戻す", async () => {
  const s = await setup();
  try {
    s.ports.tasks.push({
      id: "lost",
      title: "[pfd:123/1] マイグレーションを書く",
      state: "running",
      branch: "doctrine/lost",
    });
    const result = await s.run();
    assert.deepEqual(result, { created: [], adopted: [{ process_id: "1", task_id: "lost" }] });
    assert.equal(s.ports.added.length, 0);
    assert.equal((await readRecord(s.dir)).tasks["1"].task_id, "lost");
  } finally {
    await s.cleanup();
  }
});

test("dispatch: 上流がマージされ、人のプロセスが完了したら、下流を投入する", async () => {
  const s = await setup();
  try {
    await s.run();
    s.ports.tasks[0].state = "completed";
    s.ports.prs["doctrine/t1"] = "merged";
    const record = await readRecord(s.dir);
    record.done["3"] = { note: "ログイン 1 回を 1 利用と数える", at: NOW };
    await writeRecord(s.dir, record);

    const result = await s.run();
    assert.deepEqual(result.created, [{ process_id: "2", task_id: "t2" }]);
    assert.ok(s.ports.added[1].prompt.includes("- 集計の定義: ログイン 1 回を 1 利用と数える"));
  } finally {
    await s.cleanup();
  }
});

test("dispatch: PR が開いているだけでは下流を投入しない", async () => {
  const s = await setup();
  try {
    await s.run();
    s.ports.tasks[0].state = "completed";
    s.ports.prs["doctrine/t1"] = "open";
    assert.deepEqual((await s.run()).created, []);
  } finally {
    await s.cleanup();
  }
});
```

- [ ] **Step 3: 失敗を確かめる**

Run: `cd pfd && deno task test`
Expected: FAIL（`../src/dispatch.ts` が無い）

- [ ] **Step 4: 実装する**

`pfd/src/dispatch.ts`:

```ts
import { taskTitle } from "./key.ts";
import type { Pfd } from "./model.ts";
import type { Ports } from "./ports.ts";
import { buildPrompt } from "./prompt.ts";
import { computeStatus, gatherFacts } from "./status.ts";
import { hashOf, readRecord, writeRecord } from "./store.ts";

export interface DispatchInput {
  pfd: Pfd;
  text: string;
  dir: string;
  projectPath: string;
  ports: Ports;
  now: () => string;
}

export interface DispatchResult {
  created: { process_id: string; task_id: string }[];
  adopted: { process_id: string; task_id: string }[];
}

export async function dispatch(input: DispatchInput): Promise<DispatchResult> {
  const { pfd, text, dir, projectPath, ports, now } = input;
  const record = await readRecord(dir);
  if (!record.approved) {
    throw new Error("この PFD は承認されていません（pfd approve を実行してください）");
  }
  if (record.approved.hash !== await hashOf(text)) {
    throw new Error(
      "承認の後に pfd.yaml が書き換えられています（内容を確かめて pfd approve をやり直してください）",
    );
  }

  const statuses = computeStatus(pfd, record, await gatherFacts(pfd, projectPath, ports));
  const result: DispatchResult = { created: [], adopted: [] };

  for (const s of statuses) {
    if (!s.task_id || !s.branch || record.tasks[s.id]) continue;
    record.tasks[s.id] = { task_id: s.task_id, branch: s.branch, at: now() };
    result.adopted.push({ process_id: s.id, task_id: s.task_id });
  }
  if (result.adopted.length > 0) await writeRecord(dir, record);

  const ready = statuses.filter((s) => s.state === "ready");
  if (ready.length === 0) return result;

  const issue = await ports.issue(projectPath, pfd.issue);
  for (const s of ready) {
    const process = pfd.processes.find((p) => p.id === s.id)!;
    const prompt = buildPrompt(pfd, process, record, issue);
    const task = await ports.addTask(projectPath, taskTitle(pfd.issue, process), prompt);
    record.tasks[s.id] = { task_id: task.id, branch: task.branch, at: now() };
    await writeRecord(dir, record);
    result.created.push({ process_id: s.id, task_id: task.id });
  }
  return result;
}
```

- [ ] **Step 5: 通ることを確かめる**

Run: `cd pfd && deno task test && deno task check && deno fmt --check && deno lint`
Expected: すべて成功

- [ ] **Step 6: コミット**

```bash
git add pfd/src/dispatch.ts pfd/test/dispatch.test.ts pfd/test/fakePorts.ts
git commit -m "pfd: 入力が揃ったプロセスを doctrine のタスクにする"
```

---

### Task 8: 図

**Files:**
- Create: `pfd/src/render.ts`
- Create: `pfd/test/render.test.ts`

**Interfaces:**
- Consumes: `Pfd`（Task 1）、`ProcessStatus`（Task 5）
- Produces:
  - `toMermaid(pfd: Pfd, statuses?: ProcessStatus[]): string`
  - `toHtml(title: string, mermaid: string): string`

図の決まり（spec 9 章）:

- 成果物は四角（`a0["名前"]`）、プロセスは丸（`p0(("id<br/>名前"))`）。ノードの id は配列の添字から作る（PFD の id には `-` などが入るため）
- `actor: human` のプロセスには `human` クラス（破線）を付ける
- `statuses` があれば、状態でクラスを付ける: `done` `merged` → `finished`、`ready` `your_turn` → `ready`、`running` `pr_open` → `active`、`no_pr` `task_stopped` → `stopped`、`waiting` → 何も付けない
- ラベルの中の `"` は `#quot;` に置き換える

- [ ] **Step 1: 失敗するテストを書く**

`pfd/test/render.test.ts`:

```ts
import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { parsePfd } from "../src/model.ts";
import { toHtml, toMermaid } from "../src/render.ts";
import { computeStatus } from "../src/status.ts";
import { emptyRecord } from "../src/store.ts";
import { EXAMPLE_YAML } from "./fixture.ts";

const pfd = parsePfd(EXAMPLE_YAML);

test("toMermaid: 成果物は四角、プロセスは丸、矢印は成果物とプロセスの間だけ", () => {
  const lines = toMermaid(pfd).split("\n");
  assert.equal(lines[0], "flowchart LR");
  assert.ok(lines.includes('  a0["既存スキーマ"]'));
  assert.ok(lines.includes('  p0(("1<br/>マイグレーションを書く"))'));
  assert.ok(lines.includes("  a0 --> p0"));
  assert.ok(lines.includes("  p0 --> a1"));
  const arrows = lines.filter((l) => l.includes("-->"));
  assert.ok(arrows.every((l) => /^ {2}(a\d+ --> p\d+|p\d+ --> a\d+)$/.test(l)));
});

test("toMermaid: 人のプロセスに human クラスを付ける", () => {
  assert.ok(toMermaid(pfd).split("\n").includes("  class p2 human"));
});

test("toMermaid: 状態を渡さなければ状態のクラスを付けない", () => {
  const stateClass = /^ {2}class p\d+ (finished|ready|active|stopped)$/;
  assert.ok(!toMermaid(pfd).split("\n").some((l) => stateClass.test(l)));
});

test("toMermaid: 状態を渡せば塗り分ける", () => {
  const statuses = computeStatus(pfd, emptyRecord(), { tasks: [], prs: {} });
  const lines = toMermaid(pfd, statuses).split("\n");
  assert.ok(lines.includes("  class p0 ready"));
  assert.ok(lines.includes("  class p2 ready"));
  assert.ok(!lines.some((l) => l.startsWith("  class p1 ")));
});

test("toMermaid: ラベルの引用符を置き換える", () => {
  const quoted = parsePfd(EXAMPLE_YAML.replace("name: 既存スキーマ", 'name: 既存の "users" 表'));
  assert.ok(toMermaid(quoted).includes('a0["既存の #quot;users#quot; 表"]'));
});

test("toHtml: Mermaid の本文を HTML としてエスケープして埋め込む", () => {
  const html = toHtml("#123 <集計>", 'p0(("1<br/>x"))');
  assert.ok(html.includes("<title>#123 &lt;集計&gt;</title>"));
  assert.ok(html.includes('<pre class="mermaid">p0((&quot;1&lt;br/&gt;x&quot;))</pre>'));
  assert.ok(html.includes("https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs"));
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `cd pfd && deno task test`
Expected: FAIL（`../src/render.ts` が無い）

- [ ] **Step 3: 実装する**

`pfd/src/render.ts`:

```ts
import type { Pfd } from "./model.ts";
import type { ProcessState, ProcessStatus } from "./status.ts";

const STATE_CLASS: Partial<Record<ProcessState, string>> = {
  done: "finished",
  merged: "finished",
  ready: "ready",
  your_turn: "ready",
  running: "active",
  pr_open: "active",
  no_pr: "stopped",
  task_stopped: "stopped",
};

function label(text: string): string {
  return text.replaceAll('"', "#quot;");
}

export function toMermaid(pfd: Pfd, statuses?: ProcessStatus[]): string {
  const a = new Map(pfd.artifacts.map((x, i) => [x.id, `a${i}`]));
  const lines = ["flowchart LR"];

  pfd.artifacts.forEach((x, i) => lines.push(`  a${i}["${label(x.name)}"]`));
  pfd.processes.forEach((p, i) => lines.push(`  p${i}(("${label(p.id)}<br/>${label(p.name)}"))`));
  pfd.processes.forEach((p, i) => {
    for (const id of p.inputs) if (a.has(id)) lines.push(`  ${a.get(id)} --> p${i}`);
    for (const id of p.outputs) if (a.has(id)) lines.push(`  p${i} --> ${a.get(id)}`);
  });

  lines.push("  classDef human stroke-dasharray: 5 5");
  lines.push("  classDef finished fill:#c8e6c9,stroke:#2e7d32,color:#000");
  lines.push("  classDef ready fill:#fff9c4,stroke:#f9a825,color:#000");
  lines.push("  classDef active fill:#bbdefb,stroke:#1565c0,color:#000");
  lines.push("  classDef stopped fill:#ffcdd2,stroke:#c62828,color:#000");

  pfd.processes.forEach((p, i) => {
    if (p.actor === "human") lines.push(`  class p${i} human`);
    const cls = STATE_CLASS[statuses?.find((s) => s.id === p.id)?.state ?? "waiting"];
    if (cls) lines.push(`  class p${i} ${cls}`);
  });
  return lines.join("\n");
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function toHtml(title: string, mermaid: string): string {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 24px; }
  .legend span { display: inline-block; margin-right: 16px; padding: 2px 8px; border: 1px solid #999; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<p class="legend">
  <span style="background:#fff9c4">着手可能・あなたの番</span>
  <span style="background:#bbdefb">実行中・PR レビュー待ち</span>
  <span style="background:#c8e6c9">完了</span>
  <span style="background:#ffcdd2">止まっている</span>
  <span style="border-style:dashed">人が行う</span>
</p>
<pre class="mermaid">${escapeHtml(mermaid)}</pre>
<script type="module">
  import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
  mermaid.initialize({ startOnLoad: true });
</script>
</body>
</html>
`;
}
```

- [ ] **Step 4: 通ることを確かめる**

Run: `cd pfd && deno task test && deno task check && deno fmt --check && deno lint`
Expected: すべて成功

- [ ] **Step 5: コミット**

```bash
git add pfd/src/render.ts pfd/test/render.test.ts
git commit -m "pfd: PFD から図を生成する"
```

---

### Task 9: CLI

**Files:**
- Create: `pfd/src/cli.ts`
- Create: `pfd/test/cli.test.ts`

**Interfaces:**
- Consumes: Task 1〜8 のすべて
- Produces:
  - `interface Deps { ports: Ports; out: (line: string) => void; err: (line: string) => void; isTerminal: () => boolean; ask: (question: string) => Promise<string>; open: (path: string) => Promise<void>; now: () => string }`
  - `main(argv: string[], deps: Deps): Promise<number>` — 終了コードを返す
  - `import.meta.main` のとき、実物の `Deps` で `main(Deno.args)` を走らせる

コマンドと振る舞い（spec 5 章・6.3・7 章・9 章）:

| コマンド | 振る舞い | 終了コード |
| --- | --- | --- |
| `path <project> <issue>` | ディレクトリを作り、`pfd.yaml` のパスを出す | 0 |
| `validate <project> <issue>` | 違反を 1 行ずつ `err` に出す。無ければ「違反はありません」 | 違反があれば 1 |
| `render <project> <issue> [--no-open]` | `pfd.html` を書いてパスを出す。承認済みなら状態で塗り分ける。`--no-open` が無ければ開く | 0 |
| `approve <project> <issue>` | 端末でなければ失敗。違反があれば失敗。要約を出し、`y` の入力で承認を記録する | 承認しなければ 1 |
| `dispatch <project> <issue>` | `dispatch()` を呼び、投入したもの・書き戻したものを出す | 0 |
| `status <project> <issue>` | 各プロセスの状態を 1 行ずつ出す | 0 |
| `done <project> <issue> <process-id> --note <t>` / `--note-file <path>` | `actor: human` のプロセスを完了にする | 0 |

- `<project>` は `@std/path` の `resolve` で絶対パスにするだけで、`Deno.realPath` は使わない。`dctl` は登録時のパス文字列との完全一致でプロジェクトを引くので、シンボリックリンクを解決すると一致しなくなる（macOS の `/tmp` → `/private/tmp`）
- `pfd.yaml` の `issue` が引数の `<issue>` と違えば失敗する
- 例外はすべて `err` にメッセージを出して 1 を返す

`status` の表示:

| 状態 | 表示 |
| --- | --- |
| `done` | `完了` |
| `your_turn` | `あなたの番` |
| `merged` | `マージ済み` |
| `pr_open` | `PR レビュー待ち` |
| `no_pr` | `PR がありません（ブランチ <branch>）` |
| `task_stopped` | `タスクが止まっています（<task_id>）` |
| `running` | `実行中（<task_id>）` |
| `ready` | `着手可能（pfd dispatch で投入）` |
| `waiting` | `入力待ち: <成果物の名前を ", " で連結>` |

- [ ] **Step 1: 失敗するテストを書く**

`pfd/test/cli.test.ts`:

```ts
import { test } from "@std/testing/bdd";
import assert from "node:assert/strict";
import { join } from "@std/path";
import { type Deps, main } from "../src/cli.ts";
import { pfdDir, readRecord } from "../src/store.ts";
import { FakePorts } from "./fakePorts.ts";
import { EXAMPLE_YAML } from "./fixture.ts";

interface World {
  project: string;
  ports: FakePorts;
  out: string[];
  err: string[];
  opened: string[];
  answers: string[];
  terminal: boolean;
  run: (...argv: string[]) => Promise<number>;
  writePfd: (text?: string) => Promise<void>;
}

async function world(fn: (w: World) => Promise<void>): Promise<void> {
  const prev = Deno.env.get("DOCTRINE_STATE_DIR");
  const state = await Deno.makeTempDir();
  const project = await Deno.makeTempDir();
  Deno.env.set("DOCTRINE_STATE_DIR", state);
  const w: World = {
    project,
    ports: new FakePorts(),
    out: [],
    err: [],
    opened: [],
    answers: [],
    terminal: true,
    run: (...argv) => main(argv, deps),
    writePfd: async (text = EXAMPLE_YAML) => {
      const dir = await pfdDir(project, 123);
      await Deno.mkdir(dir, { recursive: true });
      await Deno.writeTextFile(join(dir, "pfd.yaml"), text);
    },
  };
  const deps: Deps = {
    ports: w.ports,
    out: (l) => w.out.push(l),
    err: (l) => w.err.push(l),
    isTerminal: () => w.terminal,
    ask: () => Promise.resolve(w.answers.shift() ?? ""),
    open: (p) => {
      w.opened.push(p);
      return Promise.resolve();
    },
    now: () => "2026-09-20T00:00:00.000Z",
  };
  try {
    await fn(w);
  } finally {
    if (prev === undefined) Deno.env.delete("DOCTRINE_STATE_DIR");
    else Deno.env.set("DOCTRINE_STATE_DIR", prev);
    await Deno.remove(state, { recursive: true });
    await Deno.remove(project, { recursive: true });
  }
}

test("path: ディレクトリを作り、pfd.yaml の場所を出す", async () => {
  await world(async (w) => {
    assert.equal(await w.run("path", w.project, "123"), 0);
    const dir = await pfdDir(w.project, 123);
    assert.deepEqual(w.out, [join(dir, "pfd.yaml")]);
    assert.ok((await Deno.stat(dir)).isDirectory);
  });
});

test("issue 番号が数でなければ失敗する", async () => {
  await world(async (w) => {
    assert.equal(await w.run("path", w.project, "abc"), 1);
    assert.match(w.err[0], /issue 番号/);
  });
});

test("validate: 違反が無ければ 0", async () => {
  await world(async (w) => {
    await w.writePfd();
    assert.equal(await w.run("validate", w.project, "123"), 0);
    assert.deepEqual(w.out, ["違反はありません"]);
  });
});

test("validate: 違反があれば 1 行ずつ出して 1", async () => {
  await world(async (w) => {
    await w.writePfd(EXAMPLE_YAML.replace("    verify: API のテストが通る\n", ""));
    assert.equal(await w.run("validate", w.project, "123"), 1);
    assert.ok(w.err.some((l) => l.includes("endpoint") && l.includes("verify")));
  });
});

test("validate: pfd.yaml が無ければ、場所を示して失敗する", async () => {
  await world(async (w) => {
    assert.equal(await w.run("validate", w.project, "123"), 1);
    assert.match(w.err[0], /PFD がありません.*pfd\.yaml/);
  });
});

test("validate: pfd.yaml の issue が引数と違えば失敗する", async () => {
  await world(async (w) => {
    await w.writePfd(EXAMPLE_YAML.replace("issue: 123", "issue: 999"));
    assert.equal(await w.run("validate", w.project, "123"), 1);
    assert.match(w.err[0], /999/);
  });
});

test("approve: 端末でなければ何もせず失敗する", async () => {
  await world(async (w) => {
    await w.writePfd();
    w.terminal = false;
    w.answers = ["y"];
    assert.equal(await w.run("approve", w.project, "123"), 1);
    assert.match(w.err[0], /端末/);
    assert.equal((await readRecord(await pfdDir(w.project, 123))).approved, null);
  });
});

test("approve: 違反があれば承認できない", async () => {
  await world(async (w) => {
    await w.writePfd(EXAMPLE_YAML.replace("    verify: API のテストが通る\n", ""));
    w.answers = ["y"];
    assert.equal(await w.run("approve", w.project, "123"), 1);
    assert.equal((await readRecord(await pfdDir(w.project, 123))).approved, null);
  });
});

test("approve: y 以外なら承認しない", async () => {
  await world(async (w) => {
    await w.writePfd();
    w.answers = ["n"];
    assert.equal(await w.run("approve", w.project, "123"), 1);
    assert.equal((await readRecord(await pfdDir(w.project, 123))).approved, null);
  });
});

test("approve: 要約を出し、y で承認を記録する", async () => {
  await world(async (w) => {
    await w.writePfd();
    w.answers = ["y"];
    assert.equal(await w.run("approve", w.project, "123"), 0);
    assert.ok(w.out.some((l) => l.includes("3 集計の定義を決める") && l.includes("人")));
    const record = await readRecord(await pfdDir(w.project, 123));
    assert.match(record.approved!.hash, /^[0-9a-f]{64}$/);
  });
});

test("dispatch: 承認の後、入力が揃ったプロセスを投入して報告する", async () => {
  await world(async (w) => {
    await w.writePfd();
    w.answers = ["y"];
    await w.run("approve", w.project, "123");
    w.out.length = 0;
    assert.equal(await w.run("dispatch", w.project, "123"), 0);
    assert.deepEqual(w.ports.added.map((a) => a.title), ["[pfd:123/1] マイグレーションを書く"]);
    assert.ok(w.out.some((l) => l.includes("投入") && l.includes("1 マイグレーションを書く")));
  });
});

test("dispatch: 承認されていなければ 1", async () => {
  await world(async (w) => {
    await w.writePfd();
    assert.equal(await w.run("dispatch", w.project, "123"), 1);
    assert.match(w.err[0], /承認されていません/);
  });
});

test("dispatch: 投入するものが無ければ、そう言う", async () => {
  await world(async (w) => {
    await w.writePfd();
    w.answers = ["y"];
    await w.run("approve", w.project, "123");
    await w.run("dispatch", w.project, "123");
    w.out.length = 0;
    assert.equal(await w.run("dispatch", w.project, "123"), 0);
    assert.deepEqual(w.out, ["投入できるプロセスはありません"]);
  });
});

test("status: 各プロセスの状態を出す", async () => {
  await world(async (w) => {
    await w.writePfd();
    assert.equal(await w.run("status", w.project, "123"), 0);
    assert.ok(w.out[0].includes("#123") && w.out[0].includes("未承認"));
    assert.ok(w.out.some((l) => l.includes("1 マイグレーションを書く") && l.includes("着手可能")));
    assert.ok(w.out.some((l) => l.includes("3 集計の定義を決める") && l.includes("あなたの番")));
    assert.ok(
      w.out.some((l) =>
        l.includes("2 API を実装する") && l.includes("入力待ち: 集計テーブル, 集計の定義")
      ),
    );
  });
});

test("status: completed なのに PR が無いプロセスを、ブランチ付きで示す", async () => {
  await world(async (w) => {
    await w.writePfd();
    w.ports.tasks.push({
      id: "t1",
      title: "[pfd:123/1] マイグレーションを書く",
      state: "completed",
      branch: "doctrine/t1",
    });
    await w.run("status", w.project, "123");
    assert.ok(w.out.some((l) => l.includes("PR がありません（ブランチ doctrine/t1）")));
  });
});

test("done: 人のプロセスを note 付きで完了にする", async () => {
  await world(async (w) => {
    await w.writePfd();
    assert.equal(await w.run("done", w.project, "123", "3", "--note", "ログイン 1 回を 1 利用"), 0);
    const record = await readRecord(await pfdDir(w.project, 123));
    assert.equal(record.done["3"].note, "ログイン 1 回を 1 利用");
  });
});

test("done: --note-file から読む", async () => {
  await world(async (w) => {
    await w.writePfd();
    const file = join(w.project, "note.md");
    await Deno.writeTextFile(file, "定義の本文\n");
    assert.equal(await w.run("done", w.project, "123", "3", "--note-file", file), 0);
    const record = await readRecord(await pfdDir(w.project, 123));
    assert.equal(record.done["3"].note, "定義の本文");
  });
});

test("done: note が無ければ失敗する", async () => {
  await world(async (w) => {
    await w.writePfd();
    assert.equal(await w.run("done", w.project, "123", "3"), 1);
    assert.match(w.err[0], /--note/);
  });
});

test("done: agent のプロセスは完了にできない", async () => {
  await world(async (w) => {
    await w.writePfd();
    assert.equal(await w.run("done", w.project, "123", "1", "--note", "x"), 1);
    assert.match(w.err[0], /actor: human/);
  });
});

test("done: 存在しないプロセス", async () => {
  await world(async (w) => {
    await w.writePfd();
    assert.equal(await w.run("done", w.project, "123", "9", "--note", "x"), 1);
    assert.match(w.err[0], /プロセス 9/);
  });
});

test("render: pfd.html を書いて開く", async () => {
  await world(async (w) => {
    await w.writePfd();
    assert.equal(await w.run("render", w.project, "123"), 0);
    const file = join(await pfdDir(w.project, 123), "pfd.html");
    assert.deepEqual(w.opened, [file]);
    assert.deepEqual(w.out, [file]);
    assert.ok((await Deno.readTextFile(file)).includes("flowchart LR"));
  });
});

test("render: --no-open なら開かない", async () => {
  await world(async (w) => {
    await w.writePfd();
    await w.run("render", w.project, "123", "--no-open");
    assert.deepEqual(w.opened, []);
  });
});

test("render: 未承認の間は dctl も gh も呼ばない", async () => {
  await world(async (w) => {
    await w.writePfd();
    w.ports.listTasks = () => Promise.reject(new Error("呼ばれてはいけない"));
    assert.equal(await w.run("render", w.project, "123", "--no-open"), 0);
  });
});

test("未知のコマンドは使い方を出して 1", async () => {
  await world(async (w) => {
    assert.equal(await w.run("frobnicate"), 1);
    assert.match(w.err[0], /未知のコマンド/);
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `cd pfd && deno task test`
Expected: FAIL（`../src/cli.ts` が無い）

- [ ] **Step 3: 実装する**

`pfd/src/cli.ts`:

```ts
import { join, resolve } from "@std/path";
import { dispatch } from "./dispatch.ts";
import { parsePfd, type Pfd } from "./model.ts";
import { type Ports, realPorts } from "./ports.ts";
import { toHtml, toMermaid } from "./render.ts";
import { computeStatus, gatherFacts, type ProcessStatus } from "./status.ts";
import { hashOf, pfdDir, readRecord, writeRecord } from "./store.ts";
import { validatePfd } from "./validate.ts";

export interface Deps {
  ports: Ports;
  out: (line: string) => void;
  err: (line: string) => void;
  isTerminal: () => boolean;
  ask: (question: string) => Promise<string>;
  open: (path: string) => Promise<void>;
  now: () => string;
}

const USAGE = `使い方: pfd <command> <project> <issue> [options]

  path     <project> <issue>              pfd.yaml の場所を表示する（無ければディレクトリを作る）
  validate <project> <issue>              PFD の構造を検証する
  render   <project> <issue> [--no-open]  図を生成してブラウザで開く
  approve  <project> <issue>              PFD を承認する（端末から人が実行する）
  dispatch <project> <issue>              入力が揃った未投入のプロセスを doctrine のタスクにする
  status   <project> <issue>              各プロセスの状態を表示する
  done     <project> <issue> <process-id> (--note <text> | --note-file <path>)
                                          人が行うプロセスを完了にする

<project> は対象リポジトリのルート（dctl project-add に渡したのと同じパス）。`;

const BOOLEAN = new Set(["no-open"]);

function splitArgs(argv: string[]): { flags: Record<string, string | true>; positional: string[] } {
  const flags: Record<string, string | true> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const key = a.slice(2);
    if (BOOLEAN.has(key)) {
      flags[key] = true;
      continue;
    }
    i += 1;
    if (argv[i] === undefined) throw new Error(`--${key} には値が要ります`);
    flags[key] = argv[i];
  }
  return { flags, positional };
}

interface Target {
  issue: number;
  projectPath: string;
  dir: string;
  file: string;
}

async function target(project: string | undefined, issueArg: string | undefined): Promise<Target> {
  if (!project || !issueArg) throw new Error(USAGE);
  const issue = Number(issueArg);
  if (!Number.isInteger(issue) || issue <= 0) {
    throw new Error(`issue 番号が正しくありません: ${issueArg}`);
  }
  const projectPath = resolve(project);
  const dir = await pfdDir(projectPath, issue);
  return { issue, projectPath, dir, file: join(dir, "pfd.yaml") };
}

async function load(t: Target): Promise<{ text: string; pfd: Pfd }> {
  let text: string;
  try {
    text = await Deno.readTextFile(t.file);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) throw new Error(`PFD がありません: ${t.file}`);
    throw err;
  }
  const pfd = parsePfd(text);
  if (pfd.issue !== t.issue) {
    throw new Error(
      `pfd.yaml の issue（${pfd.issue}）が、指定された issue（${t.issue}）と違います`,
    );
  }
  return { text, pfd };
}

function describe(s: ProcessStatus): string {
  switch (s.state) {
    case "done":
      return "完了";
    case "your_turn":
      return "あなたの番";
    case "merged":
      return "マージ済み";
    case "pr_open":
      return "PR レビュー待ち";
    case "no_pr":
      return `PR がありません（ブランチ ${s.branch}）`;
    case "task_stopped":
      return `タスクが止まっています（${s.task_id}）`;
    case "running":
      return `実行中（${s.task_id}）`;
    case "ready":
      return "着手可能（pfd dispatch で投入）";
    case "waiting":
      return `入力待ち: ${s.waiting_for.join(", ")}`;
  }
}

/** 違反を err に出し、違反が無ければ true を返す。 */
function reportViolations(pfd: Pfd, deps: Deps): boolean {
  const violations = validatePfd(pfd);
  for (const v of violations) deps.err(`${v.rule}: ${v.message}`);
  return violations.length === 0;
}

async function run(argv: string[], deps: Deps): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === undefined || cmd === "help" || cmd === "--help" || cmd === "-h") {
    throw new Error(USAGE);
  }
  const { flags, positional } = splitArgs(rest);

  switch (cmd) {
    case "path": {
      const t = await target(positional[0], positional[1]);
      await Deno.mkdir(t.dir, { recursive: true });
      deps.out(t.file);
      return 0;
    }

    case "validate": {
      const { pfd } = await load(await target(positional[0], positional[1]));
      if (!reportViolations(pfd, deps)) return 1;
      deps.out("違反はありません");
      return 0;
    }

    case "render": {
      const t = await target(positional[0], positional[1]);
      const { pfd } = await load(t);
      const record = await readRecord(t.dir);
      // 未承認の間はタスクが 1 つも無い。デーモンが起動していなくても図を見られるようにする
      const statuses = record.approved
        ? computeStatus(pfd, record, await gatherFacts(pfd, t.projectPath, deps.ports))
        : undefined;
      const file = join(t.dir, "pfd.html");
      await Deno.writeTextFile(
        file,
        toHtml(`#${pfd.issue} ${pfd.title}`, toMermaid(pfd, statuses)),
      );
      deps.out(file);
      if (!flags["no-open"]) await deps.open(file);
      return 0;
    }

    case "approve": {
      if (!deps.isTerminal()) {
        throw new Error(
          "pfd approve は、人が端末から実行してください（標準入力が端末ではありません）",
        );
      }
      const t = await target(positional[0], positional[1]);
      const { text, pfd } = await load(t);
      if (!reportViolations(pfd, deps)) return 1;
      deps.out(`#${pfd.issue} ${pfd.title}`);
      for (const p of pfd.processes) {
        deps.out(`  ${p.id} ${p.name}（${p.actor === "human" ? "人" : "エージェント"}）`);
      }
      const answer = await deps.ask("この PFD を承認しますか? [y/N] ");
      if (answer.trim().toLowerCase() !== "y") {
        deps.err("承認しませんでした");
        return 1;
      }
      const record = await readRecord(t.dir);
      record.approved = { hash: await hashOf(text), at: deps.now() };
      await writeRecord(t.dir, record);
      deps.out("承認しました");
      return 0;
    }

    case "dispatch": {
      const t = await target(positional[0], positional[1]);
      const { text, pfd } = await load(t);
      const result = await dispatch({
        pfd,
        text,
        dir: t.dir,
        projectPath: t.projectPath,
        ports: deps.ports,
        now: deps.now,
      });
      const nameOf = (id: string) => `${id} ${pfd.processes.find((p) => p.id === id)?.name ?? ""}`;
      for (const a of result.adopted) {
        deps.out(`既にあるタスクを記録しました: ${nameOf(a.process_id)}（${a.task_id}）`);
      }
      for (const c of result.created) {
        deps.out(`投入しました: ${nameOf(c.process_id)}（${c.task_id}）`);
      }
      if (result.created.length === 0 && result.adopted.length === 0) {
        deps.out("投入できるプロセスはありません");
      }
      return 0;
    }

    case "status": {
      const t = await target(positional[0], positional[1]);
      const { pfd } = await load(t);
      const record = await readRecord(t.dir);
      const facts = await gatherFacts(pfd, t.projectPath, deps.ports);
      deps.out(`#${pfd.issue} ${pfd.title}（${record.approved ? "承認済み" : "未承認"}）`);
      for (const s of computeStatus(pfd, record, facts)) {
        deps.out(`  ${s.id} ${s.name}  ${describe(s)}`);
      }
      return 0;
    }

    case "done": {
      const t = await target(positional[0], positional[1]);
      const processId = positional[2];
      if (!processId) throw new Error(USAGE);
      const { pfd } = await load(t);
      const process = pfd.processes.find((p) => p.id === processId);
      if (!process) throw new Error(`プロセス ${processId} は、この PFD にありません`);
      if (process.actor !== "human") {
        throw new Error(
          `プロセス ${processId} は actor: human ではありません（エージェントのプロセスは PR のマージで完了します）`,
        );
      }
      const note = typeof flags["note-file"] === "string"
        ? (await Deno.readTextFile(flags["note-file"])).trim()
        : typeof flags["note"] === "string"
        ? flags["note"].trim()
        : "";
      if (!note) {
        throw new Error(
          "--note <テキスト> または --note-file <パス> で、決めた内容を渡してください",
        );
      }
      const record = await readRecord(t.dir);
      record.done[processId] = { note, at: deps.now() };
      await writeRecord(t.dir, record);
      deps.out(`完了にしました: ${process.id} ${process.name}`);
      return 0;
    }

    default:
      throw new Error(`未知のコマンドです: ${cmd}\n\n${USAGE}`);
  }
}

export async function main(argv: string[], deps: Deps): Promise<number> {
  try {
    return await run(argv, deps);
  } catch (e) {
    deps.err((e as Error).message);
    return 1;
  }
}

async function openInBrowser(path: string): Promise<void> {
  const cmd = Deno.build.os === "darwin" ? "open" : "xdg-open";
  await new Deno.Command(cmd, { args: [path], stdin: "null", stdout: "null", stderr: "null" })
    .output();
}

if (import.meta.main) {
  Deno.exitCode = await main(Deno.args, {
    ports: realPorts(),
    out: (l) => console.log(l),
    err: (l) => console.error(l),
    isTerminal: () => Deno.stdin.isTerminal(),
    ask: (q) => Promise.resolve(prompt(q) ?? ""),
    open: openInBrowser,
    now: () => new Date().toISOString(),
  });
}
```

- [ ] **Step 4: 通ることを確かめる**

Run: `cd pfd && deno task test && deno task check && deno fmt --check && deno lint`
Expected: すべて成功

- [ ] **Step 5: 実物を手で動かす**

```bash
cd pfd
export DOCTRINE_STATE_DIR="$(mktemp -d)"
FILE="$(deno run -A src/cli.ts path .. 123)"
deno eval 'import { EXAMPLE_YAML } from "./test/fixture.ts"; console.log(EXAMPLE_YAML)' > "$FILE"
deno run -A src/cli.ts validate .. 123      # => 違反はありません
deno run -A src/cli.ts render .. 123        # => ブラウザに図が出る。プロセス 3 だけ破線
echo y | deno run -A src/cli.ts approve .. 123; echo "exit=$?"   # => 端末ではないので exit=1
unset DOCTRINE_STATE_DIR
```

Expected: コメントのとおり。図で、成果物が四角・プロセスが丸になっていること、矢印が成果物とプロセスの間にしか無いことを目で確かめる。

- [ ] **Step 6: コミット**

```bash
git add pfd/src/cli.ts pfd/test/cli.test.ts
git commit -m "pfd: CLI を足す"
```

---

### Task 10: 分解を行うスキル

**Files:**
- Create: `pfd/skill/pfd-decompose/SKILL.md`

**Interfaces:**
- Consumes: CLI のコマンド（Task 9）、PFD の YAML の形（Task 1）、検証の規則（Task 2）
- Produces: Claude Code が読むスキル。`~/.claude/skills/pfd-decompose` にシンボリックリンクを張って使う（Task 11 の README に書く）

このタスクにテストコードは無い。完了条件は Step 2 の確認である。

- [ ] **Step 1: スキルを書く**

`pfd/skill/pfd-decompose/SKILL.md`:

````markdown
---
name: pfd-decompose
description: GitHub Issue を PFD（Process Flow Diagram）で分解し、doctrine に渡せる粒度のプロセスに割る。「Issue を分解して」「PFD を書いて」「doctrine に流す前に割りたい」「pfd decompose」と言われたとき、または大きな Issue を doctrine のタスクにする前に使う。
---

# pfd-decompose

GitHub Issue を、成果物とプロセスの図（PFD）に分解する。書くのは `pfd.yaml` だけである。
検証・図の生成・承認・投入は、すべて `pfd` コマンドが行う。

## してはいけないこと

- **`pfd approve` を実行しない。** 承認は人が端末から行う。あなたが実行しても失敗する
- **`pfd dispatch` と `dctl add` を実行しない。** 投入は承認の後に人が行う
- `pfd.yaml` 以外のファイルを書かない。対象リポジトリのコードを変更しない
- 検証を自分の目で済ませない。必ず `pfd validate` を通す

## 手順

1. **対象を確かめる。** 対象リポジトリのルートのパスと Issue 番号を特定する。分からなければ聞く
2. **Issue を読む。** `gh issue view <番号> --comments` を対象リポジトリの中で実行する
3. **リポジトリを調べる。** Issue が触れる範囲のコード・テスト・既存の設計文書を読む。
   何がすでにあり（`given` の成果物になる）、何を新しく作るのかを区別する
4. **置き場所を得る。** `pfd path <project> <番号>` の出力が `pfd.yaml` のパスである
5. **`pfd.yaml` を書く。** 下の「PFD の書き方」と「粒度」に従う
6. **検証する。** `pfd validate <project> <番号>` を実行し、違反が無くなるまで直す
7. **図を見せる。** `pfd render <project> <番号>` を実行する。ブラウザに図が開く
8. **人に説明して指摘を受ける。** 次を短く伝える
   - プロセスの一覧と、それぞれが何を出力するか
   - 最初に並列で着手できるプロセスはどれか
   - 人の判断が要るとしたプロセス（`actor: human`）と、そう判断した理由
   - 粒度の条件を満たしているか迷ったプロセス
9. 指摘があれば 5 に戻る。無ければ、次に人がやることを伝えて終わる

   ```
   pfd approve <project> <番号>     # 内容を確かめて承認する
   pfd dispatch <project> <番号>    # 入力が揃ったプロセスを doctrine のタスクにする
   ```

## PFD の書き方

要素は成果物とプロセスの 2 種類だけである。プロセスは成果物を入力に取り、別の成果物を出力する。
プロセスは成果物の id だけを参照する。他のプロセスを参照する書き方は無い。

```yaml
issue: 123                 # Issue 番号
title: Issue のタイトル
goal: [feature]            # これがマージされたら Issue は完了、という成果物

artifacts:
  - id: schema
    name: 既存スキーマ
    given: true            # 最初から baseBranch にあるもの。verify は要らない
  - id: new-table
    name: 集計テーブル
    description: 何であるかを 1〜2 文で
    verify: この成果物だけを確かめる方法（テスト・コマンド・目視の手順）

processes:
  - id: 1
    name: マイグレーションを書く     # 「〜を〜する」の形
    inputs: [schema]
    outputs: [new-table]
    purpose: なぜこの作業が要るか
    steps: 何をどの順でやるか
    done_when: 何をもって終わりとするか
  - id: 2
    name: 集計の定義を決める
    actor: human                     # 人の判断が要る。doctrine のタスクにならない
    inputs: [schema]
    outputs: [metric-definition]
    purpose: 何を決めるのか
    done_when: 何が決まっていれば終わりか
```

- **成果物から先に決める。** 「何を作れば Issue が終わるか」を `goal` に置き、それを作るのに
  何が要るかを遡る。作業の一覧から始めない
- 成果物は**もの**である（テーブル、API、部品、決定事項）。「〜の実装」「〜の対応」は成果物ではない
- `purpose` `steps` `done_when` は、その文だけを読んだエージェントが作業できるように書く。
  プロセスを実行するエージェントは、この会話も、他のプロセスの定義も見ない
- 仕様の選択、外部との調整、運用上の判断など、人が決めるべきことは `actor: human` のプロセスにする。
  エージェントに決めさせない

## 粒度 — どこで割るのをやめるか

プロセスは、次の 4 つを**すべて**満たすまで割る。

1. **人が一度でレビューしきれる PR 1 つに収まる**
2. **エージェントが 1 回の実行でやりきれる**（計画 → 実装 → レビューの 1 周で終わる）
3. **単独でマージしても baseBranch が壊れない**
4. **出力の成果物が単独で検証できる**（`verify` に、その成果物だけを確かめる方法が書ける）

成果物は baseBranch へのマージで下流に渡る。下流のプロセスは、上流の PR がマージされるまで始まらない。
だから 3 と 4 が切り方を縛る。

- 悪い切り方: 「API の前半を書く」「API の後半を書く」— 前半だけでは検証できず、マージすれば壊れる
- 良い切れ目: まだ誰も使っていなくてもマージできるもの — テーブル、呼び出し元の無い関数や部品、
  フラグの裏に置いた機能

割りすぎにも注意する。依存の連鎖は、段ごとに人の PR レビューを待つ。1 つの PR で無理なくレビューできる
ものを 3 つに割れば、待ちが 3 倍になる。並列にできる枝を見つけることを優先する。

4 つを満たす切り方が見つからないプロセスが残ったら、無理に埋めず、手順 8 で人に伝える。
````

- [ ] **Step 2: スキルの内容が CLI と食い違っていないことを確かめる**

```bash
cd pfd
grep -o 'pfd [a-z]* <project>[^`#]*' skill/pfd-decompose/SKILL.md | sort -u
deno run -A src/cli.ts help 2>&1 | head -12
```

Expected: スキルに出てくるコマンド（`path` `validate` `render` `approve` `dispatch`）が、すべて CLI の使い方にあり、引数の並びが同じ。

スキルの YAML の例を一時ディレクトリで検証にかけ、形が CLI と合っていることも確かめる。例は説明のために成果物を省いているので、`undefined_artifact` や `unused_artifact` の違反が出るのは正しい。**「PFD の形が正しくありません」（スキーマの誤り）が出ないこと**を確かめる。

```bash
export DOCTRINE_STATE_DIR="$(mktemp -d)"
FILE="$(deno run -A src/cli.ts path .. 123)"
awk '/^```yaml$/{f=1;next} /^```$/{f=0} f' skill/pfd-decompose/SKILL.md > "$FILE"
deno run -A src/cli.ts validate .. 123; echo "exit=$?"
unset DOCTRINE_STATE_DIR
```

Expected: `exit=1`。出力は `undefined_artifact: ...` のような規則の違反だけで、「PFD の形が正しくありません」を含まない。

- [ ] **Step 3: コミット**

```bash
git add pfd/skill/pfd-decompose/SKILL.md
git commit -m "pfd: Issue を PFD に分解するスキルを足す"
```

---

### Task 11: CI と文書

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `README.md`（「既知の制約」の前に章を足す。目次にも足す）
- Modify: `docs/overview.md`（4 章の手順 3）
- Modify: `docs/superpowers/specs/2026-09-20-pfd-decomposition-design.md`（状態）

**Interfaces:**
- Consumes: Task 1〜10 のすべて
- Produces: なし

- [ ] **Step 1: CI に `pfd` のジョブを足す**

`.github/workflows/ci.yml` を 4 箇所変える。

(a) `changes` ジョブの `outputs` に足す:

```yaml
      pfd: ${{ steps.filter.outputs.pfd }}
```

(b) `run_all()` の中、`echo "app=true" >> "$GITHUB_OUTPUT"` の次の行に足す:

```bash
            echo "pfd=true" >> "$GITHUB_OUTPUT"
```

(c) `echo "app=$app" >> "$GITHUB_OUTPUT"` の直前に判定を、直後に出力を足す:

```bash
          pfd=false
          if matches "$common" || matches '^pfd/'; then
            pfd=true
          fi
```

```bash
          echo "pfd=$pfd" >> "$GITHUB_OUTPUT"
```

(d) `app:` ジョブの後ろ、`ci:` ジョブの前にジョブを足す:

```yaml
  # pfd は core のソースを import しないので、core/ の変更では流さない。
  pfd:
    name: pfd（整形・型・テスト）
    needs: changes
    if: needs.changes.outputs.pfd == 'true'
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: pfd
    steps:
      - uses: actions/checkout@v7

      - uses: jdx/mise-action@v4
        with:
          install_args: deno

      - name: Deno の依存をキャッシュ
        uses: actions/cache@v6
        with:
          path: ~/.cache/deno
          key: deno-pfd-${{ runner.os }}-${{ hashFiles('pfd/deno.lock') }}
          restore-keys: deno-pfd-${{ runner.os }}-

      - run: deno install --frozen

      - run: deno fmt --check
      - run: deno lint
      - run: deno task check
      - run: deno task test
```

`ci:` ジョブの `needs` を次に変える:

```yaml
    needs: [changes, core-check, core-test, app, pfd]
```

- [ ] **Step 2: README に章を足す**

目次の `- [既知の制約](#既知の制約)` の前に足す:

```markdown
- [7. 大きな Issue を PFD で分解してから流す](#7-大きな-issue-を-pfd-で分解してから流す)
```

本文の `## 既知の制約` の前に足す:

````markdown
## 7. 大きな Issue を PFD で分解してから流す

1 つのタスクにするには大きい GitHub Issue は、PFD（成果物とプロセスの図）に分解し、
入力が揃ったプロセスから順に doctrine のタスクにする。設計は
[`docs/superpowers/specs/2026-09-20-pfd-decomposition-design.md`](docs/superpowers/specs/2026-09-20-pfd-decomposition-design.md) を参照。

この仕組みは doctrine の外にある。`dctld` は PFD を知らず、`pfd` コマンドが `dctl ls` と
`dctl add` を呼ぶだけである。`gh` CLI が要る。

```bash
mise run pfd:install                                                  # ~/.deno/bin に pfd を置く
ln -s "$PWD/pfd/skill/pfd-decompose" ~/.claude/skills/pfd-decompose   # スキルを Claude Code に見せる
```

流れ:

```bash
# 1. 分解する — 対象リポジトリで Claude Code を開き、「Issue 123 を PFD で分解して」と頼む。
#    スキルが pfd.yaml を書き、検証を通し、図をブラウザに開く

# 2. 承認する — 図と内容を確かめ、端末から自分で実行する
pfd approve /path/to/your/repo 123

# 3. 投入する — 入力が揃ったプロセスだけが doctrine のタスクになる
pfd dispatch /path/to/your/repo 123

# 4. 進み具合を見る
pfd status /path/to/your/repo 123

# 5. PR をマージしたら、もう一度投入する — 下流のプロセスがタスクになる
pfd dispatch /path/to/your/repo 123
```

- **成果物は baseBranch へのマージで下流に渡る。** 下流のプロセスは、上流のタスクのブランチから
  作られた PR がマージされるまで始まらない。doctrine は PR を作ることを保証しないので、ワークフローの
  最後で PR を作るか、タスクが `completed` になった後に残ったブランチから自分で作ること。
  `pfd status` は、`completed` なのに PR が無いプロセスを「PR がありません」と示す
- **`pfd dispatch` は何度叩いてもよい。** 同じプロセスを 2 回タスクにしない。タスクのタイトルの先頭の
  `[pfd:123/2]` がその目印なので、このタイトルを書き換えないこと
- **人の判断が要るプロセス**（`actor: human`）はタスクにならない。`pfd status` に「あなたの番」と出たら、
  決めた内容を渡して完了にする: `pfd done /path/to/your/repo 123 3 --note "..."`。
  その内容は、下流のタスクの prompt にそのまま載る
- **承認の後に `pfd.yaml` を書き換えると、`pfd dispatch` は失敗する。** 内容を確かめて承認し直す
- PFD の正本は `~/.local/state/doctrine/pfd/` 配下にあり、リポジトリにはコミットされない。
  `pfd path /path/to/your/repo 123` で場所が分かる
````

- [ ] **Step 3: overview から spec へ繋ぐ**

`docs/overview.md` の 4 章、手順 3 の段落（「Issue を**並列に実行できる粒度に並べ替え、…**」で始まる項目）の末尾に、同じ項目の続きとして足す:

```markdown
（[PFD による分解](superpowers/specs/2026-09-20-pfd-decomposition-design.md)）
```

- [ ] **Step 4: spec の状態を更新する**

`docs/superpowers/specs/2026-09-20-pfd-decomposition-design.md` の冒頭:

```markdown
- 状態: 実装済み
```

あわせて 10 章「決めていないこと」の「スキルの置き場所と配布」の項目を、決まった内容に書き換える:

```markdown
- **スキルの配布。** スキルは `pfd/skill/pfd-decompose/` に同梱し、利用者が `~/.claude/skills/` へ
  シンボリックリンクを張る。プラグインとして配る形は、利用者が自分以外に増えてから考える
```

- [ ] **Step 5: すべてを通す**

```bash
mise run pfd:test && mise run pfd:check
(cd pfd && deno fmt --check && deno lint)
mise run core:test && mise run core:check
git diff --stat develop -- core app shared
```

Expected: テストと検査はすべて成功。最後の `git diff --stat` は**何も出さない**（`core/` `app/` `shared/` を変更していない）。

- [ ] **Step 6: コミット**

```bash
git add .github/workflows/ci.yml README.md docs/overview.md docs/superpowers/specs/2026-09-20-pfd-decomposition-design.md
git commit -m "pfd: CI に載せ、使い方を README に書く"
```
