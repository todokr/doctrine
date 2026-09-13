#!/usr/bin/env -S deno run --allow-all
import { dirname, join } from "@std/path";
import { openDb } from "../db/migrate.ts";
import { createClaudeAdapter } from "../adapter/claude.ts";
import { recoverOnStartup, defaultProbe, type WorkflowLookup } from "../core/recovery.ts";
import { findOrphans } from "../core/worktree.ts";
import { getProject, listProjects, listTasks, type TaskRow } from "../db/tasks.ts";
import type { Db } from "../db/schema.ts";
import { DEFAULT_GLOBAL_LIMIT } from "../core/scheduler.ts";
import { parseWorkflow } from "../workflow/schema.ts";
import { withSetupStep } from "../workflow/project.ts";
import { createServer, socketPath } from "./server.ts";
import { createHandler, loadWorkflowFromDisk, tick, type DaemonContext } from "./handlers.ts";
import { homeDir } from "../util/home.ts";

export function stateRoot(): string {
  return Deno.env.get("DOCTRINE_STATE_DIR") ?? join(homeDir(), ".local", "state", "doctrine");
}

/**
 * recoverOnStartup が要求するルックアップ。ワークフローYAMLが消えている・
 * 壊れている・プロジェクトが見当たらない場合は undefined を返す（呼び出し側は
 * 安全側=rerun-command に倒す）。ここで例外を漏らすと1タスクの不備で
 * recoverOnStartup 全体が落ち、他の stale タスクが救済されずに残る。
 */
function buildWorkflowLookup(db: Db): WorkflowLookup {
  return async (task: TaskRow) => {
    try {
      const project = await getProject(db, task.project_id);
      if (!project) return undefined;
      const path = join(project.path, ".doctrine", "workflows", `${task.workflow_name}.yaml`);
      const text = await Deno.readTextFile(path);
      const workflow = parseWorkflow(text).workflow;
      return withSetupStep(workflow, project.setup ?? undefined);
    } catch {
      return undefined;
    }
  };
}

/**
 * server.listen() はソケットパスを無条件に unlink する。既に別のデーモンが
 * 生きたまま同じパスを掴んでいる場合、その unlink は生きているデーモンを
 * 気づかれないまま切り離す一方、そのデーモン自身は動き続け、両方が同じ
 * DB に書き込む事態になる。listen する前に、パスが存在すれば接続を試み、
 * つながれば生きているとみなして起動を拒否する。
 *
 * 「古いソケットファイルだから消してよい」と言えるのは ECONNREFUSED
 * （何も listen していない）と ENOENT（stat と connect の間に消えた）
 * だけである。EACCES（権限で弾かれた）・ENOTSOCK（パスがソケットではない
 * 通常ファイル/ディレクトリ）などは「生きているかどうか判定できない」に
 * すぎず、それを黙って「古い」側に倒すと、まさにこの関数が防ぐべき事態
 * （生きているデーモンを気づかれずに切り離す）が起きる。判定できない
 * 場合は必ず拒否する側に倒す。
 */
async function assertSocketNotLive(path: string): Promise<void> {
  const exists = await Deno.stat(path).then(() => true, () => false);
  if (!exists) return;

  let result: { kind: "live" } | { kind: "stale" } | { kind: "unknown"; code: string };
  try {
    const conn = await Deno.connect({ transport: "unix", path });
    conn.close();
    result = { kind: "live" };
  } catch (err) {
    if (err instanceof Deno.errors.ConnectionRefused || err instanceof Deno.errors.NotFound) {
      result = { kind: "stale" };
    } else {
      result = { kind: "unknown", code: (err as { code?: string }).code ?? String(err) };
    }
  }

  if (result.kind === "live") {
    throw new Error(`デーモンが既に動作しています（ソケット: ${path}）。二重起動はできません。`);
  }
  if (result.kind === "unknown") {
    throw new Error(
      `ソケット (${path}) の状態を判定できませんでした（${result.code}）。` +
      `デーモンが生きている可能性を否定できないため、起動を拒否します。`,
    );
  }
  // 古いソケットファイル。次の listen() が改めて unlink するが、ここで消しておいても害はない。
  await Deno.remove(path).catch(() => {});
}

/**
 * setInterval から呼ばれる1周期ぶんの処理。**この関数は決して reject しない。**
 *
 * `void tick(ctx)` を裸で呼ぶと、tick の reject に持ち主がいない。Node は
 * 未処理の promise rejection でプロセスを落とすので、1周のスケジューリング失敗が
 * 「その周をスキップする」ではなく**デーモンごと落とす**ことになり、実行中の
 * タスクが全部巻き添えになる（子プロセスは孤児として残り、次回起動の
 * recovery 頼みになる）。1周の失敗はスケジューリングを止める理由ではない。
 *
 * ただし黙って飲み込まない。毎周期失敗し続けているデーモンは運用者に見える必要がある。
 */
export async function tickCycle(ctx: DaemonContext): Promise<void> {
  try {
    await tick(ctx);
  } catch (e) {
    console.error(`[tick] スケジューリングの1周に失敗しました（次の周期で再試行します）: ${(e as Error).message}`);
  }
  // 警告は溜めっぱなしにしない。見えていれば直せる。失敗した周でも吐く
  // （tick は途中まで進んで警告を積んでから落ちることがある）。
  try {
    for (const w of ctx.warnings.splice(0)) console.error(`[warn] ${w}`);
  } catch { /* ここで落ちて周期を止める価値のあるものは何もない */ }
}

export async function startDaemon(o: {
  dbPath?: string; socketPath?: string; logRoot?: string; globalLimit?: number; tickMs?: number;
} = {}): Promise<{ stop(): Promise<void> }> {
  const resolvedSocketPath = o.socketPath ?? socketPath();
  await assertSocketNotLive(resolvedSocketPath);

  // SQLite は親ディレクトリを作らない。作らずに開くと "unable to open database file"
  // という原因の分かりにくいエラーで即終了する。ソケット側（server.listen）と揃えて 0o700 で作る。
  const dbPath = o.dbPath ?? join(stateRoot(), "doctrine.db");
  await Deno.mkdir(dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = await openDb(dbPath);

  const ctx: DaemonContext = {
    db,
    adapter: createClaudeAdapter(),
    logRoot: o.logRoot ?? join(stateRoot(), "logs"),
    globalLimit: o.globalLimit ?? DEFAULT_GLOBAL_LIMIT,
    broadcast: () => {},
    loadWorkflow: loadWorkflowFromDisk,
    running: new Set(),
    warnings: [],
  };

  const server = createServer(createHandler(ctx));
  ctx.broadcast = (ev, opts) => server.broadcast(ev, opts);
  await server.listen(resolvedSocketPath);

  // 起動時: running のタスクはすべて古い。子を殺してから queued に戻す。
  // 復帰に失敗したタスクは failed になって返る — ここで漏らさず出力する。
  // 出力しなければ、そのタスクは running のまま両スロットを永久に塞いだまま、
  // 起動ログの1行以外どこにも見えなくなる。
  const recovered = await recoverOnStartup(db, defaultProbe(), buildWorkflowLookup(db));
  for (const r of recovered) {
    if (r.outcome === "recovered") {
      console.error(`[recovery] ${r.taskId}: ${r.action}`);
    } else {
      console.error(`[recovery] ${r.taskId}: 復帰に失敗し failed にしました: ${r.error}`);
    }
  }

  // 孤児の照合（自動削除はしない）
  for (const project of await listProjects(db)) {
    const known = (await listTasks(db, { projectId: project.id }))
      .map((t) => t.worktree_path).filter((p): p is string => p !== null);
    for (const orphan of await findOrphans(project.path, known)) {
      console.error(`[orphan] 対応するタスクのない worktree: ${orphan}`);
    }
  }

  const timer = setInterval(() => { void tickCycle(ctx); }, o.tickMs ?? 1000);
  Deno.unrefTimer(timer);

  return {
    async stop() {
      clearInterval(timer);
      await server.close();
      await db.destroy();
    },
  };
}

if (import.meta.main) {
  await startDaemon();
}
