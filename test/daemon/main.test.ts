import { test, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { startDaemon, tickCycle } from "../../src/daemon/main.ts";
import { openDb } from "../../src/db/migrate.ts";
import { createMockAdapter } from "../../src/adapter/mock.ts";
import type { DaemonContext } from "../../src/daemon/handlers.ts";

let root: string;
const daemons: { stop(): Promise<void> }[] = [];
const children: ChildProcess[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "doctrine-main-"));
});
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop();
  for (const c of children.splice(0)) { try { c.kill("SIGKILL"); } catch { /* already gone */ } }
  await rm(root, { recursive: true, force: true });
});

/**
 * 子プロセスに Unix ドメインソケットを bind させ、SIGKILL で問答無用に殺す。
 * SIGKILL は JS のクリーンアップ（'close' 時の unlink）を一切実行させないので、
 * ソケットの特殊ファイルだけがディスクに残る。「デーモンが死んだが誰も
 * unlink できなかった」状態を、フェイクではなく実際に再現するための道具。
 * 殺した後、connect() すると本物の ECONNREFUSED が返る。
 */
async function bindAndKill(path: string): Promise<void> {
  const child = spawn(
    process.execPath,
    ["-e", `require("net").createServer(()=>{}).listen(process.argv[1], () => { process.stdout.write("ready\\n"); }); setInterval(() => {}, 60000);`, path],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    child.stdout!.once("data", () => resolve());
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`子プロセスが早期終了しました: code=${code}`)));
  });
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

test("生きているデーモンのソケットは横取りせず、二重起動を拒否する", async () => {
  const sock = join(root, "dctld.sock");
  const d1 = await startDaemon({
    dbPath: join(root, "a.db"), socketPath: sock, logRoot: join(root, "logs-a"), tickMs: 1_000_000,
  });
  daemons.push(d1);

  await assert.rejects(
    () => startDaemon({
      dbPath: join(root, "b.db"), socketPath: sock, logRoot: join(root, "logs-b"), tickMs: 1_000_000,
    }),
    /既に動作しています/,
  );
});

test("ECONNREFUSEDな古いソケットファイルは掃除して起動できる", async () => {
  const sock = join(root, "dctld.sock");

  // 「デーモンが SIGKILL され、ソケットの unlink を実行する機会が無いまま
  // 消えた」状態を実際に再現する（net サーバを正常に listen/close させると
  // node 自身がパスを unlink してしまい、stale な状態を作れない）。
  await bindAndKill(sock);
  // 前提の確認: ソケットの特殊ファイルは残っている。
  await stat(sock);

  const d = await startDaemon({
    dbPath: join(root, "c.db"), socketPath: sock, logRoot: join(root, "logs-c"), tickMs: 1_000_000,
  });
  daemons.push(d);
  assert.ok(d);
});

test("ソケットに繋げるか判定できない（権限拒否など）なら、盗まずに起動を拒否する", async () => {
  const sock = join(root, "dctld.sock");
  // 実際に生きているソケットに対して権限が無く connect(2) できないケースを
  // 再現する（EACCES）。ディレクトリを置くケースは試したところ Linux では
  // connect() が ECONNREFUSED を返し、stale と判定できてしまう（＝この
  // 分岐の再現にならない）ため使わない。EACCES はまさに「そこに何かはある
  // が、生きているか判定できない」を実際に発生させられる。
  await bindAndKill(sock);
  // bindAndKill 後のソケットファイルは通常 connect 可能（ECONNREFUSED）だが、
  // パーミッションを剥がして「判定できない」状態を作る。
  await chmod(sock, 0o000);

  await assert.rejects(
    () => startDaemon({
      dbPath: join(root, "d.db"), socketPath: sock, logRoot: join(root, "logs-d"), tickMs: 1_000_000,
    }),
    (err: Error) => {
      assert.match(err.message, /判定できません/);
      assert.ok(err.message.includes(sock), "パスを名指しする");
      return true;
    },
  );
});

/**
 * setInterval が `void tick(ctx)` を裸で呼んでいると、tick の reject に
 * 持ち主がいない。Node は未処理の rejection でプロセスを落とすので、
 * 1周のスケジューリング失敗がデーモンごと道連れにする。tickCycle は
 * 決して reject せず、代わりに理由を stderr に出す。
 */
test("スケジューリングの1周が失敗してもデーモンは落ちず、理由が出て次の周期は動く", async () => {
  const db = openDb(":memory:");
  const ctx: DaemonContext = {
    db,
    adapter: createMockAdapter({ result: { ok: true, text: "done" } }),
    logRoot: join(root, "logs"),
    globalLimit: 4,
    broadcast: () => {},
    loadWorkflow: async () => { throw new Error("使わない"); },
    running: new Set(),
    warnings: ["前の周で積まれた警告"],
  };

  const logged: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };

  const prepare = db.prepare.bind(db);
  let boom = true;
  (db as unknown as { prepare: typeof prepare }).prepare = ((sql: string) => {
    if (boom && sql.includes("state = 'queued'")) throw new Error("DBが壊れた");
    return prepare(sql);
  }) as typeof prepare;

  try {
    // reject しない（ここで throw すれば、setInterval 上では
    // unhandled rejection になってプロセスが死んでいたということ）。
    await tickCycle(ctx);

    assert.ok(
      logged.some((l) => /\[tick\].*スケジューリングの1周に失敗/.test(l)),
      `失敗は黙って飲み込まず出す。実際: ${JSON.stringify(logged)}`,
    );
    assert.ok(logged.some((l) => /前の周で積まれた警告/.test(l)), "失敗した周でも警告は吐き出す");
    assert.equal(ctx.warnings.length, 0);

    // 次の周期は普通に回る（1周の失敗でスケジューリングを止めない）
    boom = false;
    logged.length = 0;
    await tickCycle(ctx);
    assert.equal(logged.length, 0, `正常な周は何も出さない。実際: ${JSON.stringify(logged)}`);
  } finally {
    console.error = realError;
    db.close();
  }
});
