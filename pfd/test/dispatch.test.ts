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

test("dispatch: 記録にあるタスクが dctl ls に無ければ、何も投入せず何も書かずに失敗する", async () => {
  const s = await setup();
  try {
    const record = await readRecord(s.dir);
    record.tasks["1"] = { task_id: "t1", branch: "doctrine/t1", at: NOW };
    await writeRecord(s.dir, record);
    await assert.rejects(s.run(), /記録にあるタスク t1（プロセス 1）が dctl ls に見当たりません/);
    assert.equal(s.ports.added.length, 0);
    assert.deepEqual(await readRecord(s.dir), record);
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
