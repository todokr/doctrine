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
  openError?: Error;
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
      if (w.openError) return Promise.reject(w.openError);
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

test("approve: 要約に goal と、各プロセスの入出力を出す", async () => {
  await world(async (w) => {
    await w.writePfd();
    w.answers = ["y"];
    assert.equal(await w.run("approve", w.project, "123"), 0);
    assert.ok(w.out.some((l) => l === "goal: 集計画面"));
    assert.ok(
      w.out.some((l) =>
        l === "  2 API を実装する（エージェント）: 集計テーブル, 集計の定義 → 集計 API"
      ),
    );
    assert.ok(w.out.some((l) => l === "  3 集計の定義を決める（人）: 既存スキーマ → 集計の定義"));
  });
});

test("approve: すでに投入済み・完了済みのプロセスがあれば、承認の前に示す", async () => {
  await world(async (w) => {
    await w.writePfd();
    w.answers = ["y"];
    await w.run("approve", w.project, "123");
    await w.run("dispatch", w.project, "123");
    await w.run("done", w.project, "123", "3", "--note", "決めた");
    w.out.length = 0;
    w.answers = ["y"];
    assert.equal(await w.run("approve", w.project, "123"), 0);
    assert.ok(w.out.some((l) => l === "すでに投入済みのプロセス: 1"));
    assert.ok(w.out.some((l) => l === "すでに完了にしたプロセス: 3"));
  });
});

test("status: goal の成果物が揃っていれば、完了を伝える", async () => {
  await world(async (w) => {
    await w.writePfd();
    w.ports.tasks.push({
      id: "t4",
      title: "[pfd:123/4] 画面を繋ぐ",
      state: "completed",
      branch: "doctrine/t4",
    });
    w.ports.prs["doctrine/t4"] = "merged";
    assert.equal(await w.run("status", w.project, "123"), 0);
    assert.ok(w.out.some((l) => l === "goal の成果物がすべて揃いました。Issue #123 は完了です"));
  });
});

test("status: goal の成果物が揃っていなければ、完了を伝えない", async () => {
  await world(async (w) => {
    await w.writePfd();
    assert.equal(await w.run("status", w.project, "123"), 0);
    assert.ok(!w.out.some((l) => l.includes("すべて揃いました")));
  });
});

test("status: 止まったタスクには、やり直し方を添える", async () => {
  await world(async (w) => {
    await w.writePfd();
    w.ports.tasks.push({
      id: "t1",
      title: "[pfd:123/1] マイグレーションを書く",
      state: "failed",
      branch: "doctrine/t1",
    });
    await w.run("status", w.project, "123");
    assert.ok(
      w.out.some((l) =>
        l.includes(
          "タスクが止まっています（t1）。やり直すには pfd.yaml でこのプロセスの id を変え、承認し直して投入する",
        )
      ),
    );
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

test("done: 端末でなければ何もせず失敗する", async () => {
  await world(async (w) => {
    await w.writePfd();
    w.terminal = false;
    assert.equal(await w.run("done", w.project, "123", "3", "--note", "決めた"), 1);
    assert.match(w.err[0], /端末/);
    assert.deepEqual((await readRecord(await pfdDir(w.project, 123))).done, {});
  });
});

test("done: --note と --note-file は同時に指定できない", async () => {
  await world(async (w) => {
    await w.writePfd();
    const file = join(w.project, "note.md");
    await Deno.writeTextFile(file, "本文\n");
    assert.equal(
      await w.run("done", w.project, "123", "3", "--note", "決めた", "--note-file", file),
      1,
    );
    assert.match(w.err[0], /同時に指定できません/);
    assert.deepEqual((await readRecord(await pfdDir(w.project, 123))).done, {});
  });
});

test("done: --note-file のファイルが無ければ、場所を示して失敗する", async () => {
  await world(async (w) => {
    await w.writePfd();
    const file = join(w.project, "missing.md");
    assert.equal(await w.run("done", w.project, "123", "3", "--note-file", file), 1);
    assert.equal(w.err[0], `ファイルがありません: ${file}`);
  });
});

test("done: 2 回目は既存の note を見せ、y でなければ置き換えない", async () => {
  await world(async (w) => {
    await w.writePfd();
    await w.run("done", w.project, "123", "3", "--note", "最初の定義");
    w.out.length = 0;
    w.answers = ["n"];
    assert.equal(await w.run("done", w.project, "123", "3", "--note", "次の定義"), 1);
    assert.ok(w.out.some((l) => l === "すでに完了にしています: 最初の定義"));
    assert.ok(w.err.some((l) => l === "置き換えませんでした"));
    const record = await readRecord(await pfdDir(w.project, 123));
    assert.equal(record.done["3"].note, "最初の定義");
  });
});

test("done: 2 回目でも y なら置き換える", async () => {
  await world(async (w) => {
    await w.writePfd();
    await w.run("done", w.project, "123", "3", "--note", "最初の定義");
    w.answers = ["y"];
    assert.equal(await w.run("done", w.project, "123", "3", "--note", "次の定義"), 0);
    const record = await readRecord(await pfdDir(w.project, 123));
    assert.equal(record.done["3"].note, "次の定義");
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

test("render: ブラウザを開けなくても、場所を示して 0 で終わる", async () => {
  await world(async (w) => {
    await w.writePfd();
    w.openError = new Error("open failed");
    assert.equal(await w.run("render", w.project, "123"), 0);
    const file = join(await pfdDir(w.project, 123), "pfd.html");
    assert.ok(w.err.some((l) => l === `ブラウザを開けませんでした。${file} を開いてください`));
  });
});

test("render: 未承認の間は dctl も gh も呼ばない", async () => {
  await world(async (w) => {
    await w.writePfd();
    w.ports.listTasks = () => Promise.reject(new Error("呼ばれてはいけない"));
    assert.equal(await w.run("render", w.project, "123", "--no-open"), 0);
  });
});

test("help: 使い方を out に出して 0", async () => {
  await world(async (w) => {
    for (const cmd of ["help", "--help", "-h"]) {
      w.out.length = 0;
      w.err.length = 0;
      assert.equal(await w.run(cmd), 0);
      assert.ok(w.out.some((l) => l.includes("使い方: pfd")));
      assert.deepEqual(w.err, []);
    }
  });
});

test("引数が無ければ使い方を err に出して 1", async () => {
  await world(async (w) => {
    assert.equal(await w.run(), 1);
    assert.ok(w.err.some((l) => l.includes("使い方: pfd")));
    assert.deepEqual(w.out, []);
  });
});

test("未知のコマンドは使い方を出して 1", async () => {
  await world(async (w) => {
    assert.equal(await w.run("frobnicate"), 1);
    assert.match(w.err[0], /未知のコマンド/);
  });
});
