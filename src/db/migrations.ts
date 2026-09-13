import { type Kysely, type Migration, type MigrationProvider, Migrator, sql } from "kysely";

/**
 * マイグレーションの一覧。キーの辞書順に適用される（Kysely の Migrator の規約）ので、
 * 番号は4桁ゼロ詰めで振る。適用済みの記録は DB の kysely_migration テーブルが持つ。
 *
 * 規則:
 * - **一度コミットしたマイグレーションは書き換えない。** 既に適用されたDBには
 *   二度と流れないので、書き換えても既存DBには反映されず、新旧のDBで形が分かれる。
 *   変更は必ず新しい番号で足す。
 * - 引数の db は Kysely<any> で受ける。src/db/schema.ts の型は「最新の形」で
 *   あり、過去のある時点の形ではないので、マイグレーションから参照してはいけない。
 * - SQLite の ALTER TABLE でできるのは列の追加・改名・削除（制約の無い列のみ）まで。
 *   CHECK 制約の変更や制約付き列の削除はテーブル再構築（新テーブルを作る → 行を
 *   コピー → 旧テーブルを DROP → RENAME）で行う。再構築は外部キーの張り直しを伴うので、
 *   PRAGMA foreign_keys はトランザクション内では切り替えられないことに注意し、
 *   PRAGMA foreign_key_check で整合を確かめてから終える。
 *   https://www.sqlite.org/lang_altertable.html#otheralter
 */
const migrations: Record<string, Migration> = {
  /**
   * 手書き DDL（`CREATE TABLE IF NOT EXISTS`）時代の最終形。
   *
   * マイグレーション機構より前に作られたDBファイルは、テーブルはあるが
   * kysely_migration が無いので、このマイグレーションが「未適用」として流れる。
   * そのため IF NOT EXISTS で冪等にしてある。
   *
   * 手書き DDL 時代に後から足した列は pending_feed だけで、それ以前に作られた
   * DBファイルには無言で存在しない（CREATE TABLE IF NOT EXISTS は既存テーブルに
   * 列を足さない）。ここで足して、全DBをこの形に揃える。
   */
  "0001_baseline": {
    // deno-lint-ignore no-explicit-any
    async up(db: Kysely<any>) {
      await db.schema.createTable("projects").ifNotExists()
        .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
        .addColumn("path", "text", (c) => c.notNull().unique())
        .addColumn("default_workflow", "text", (c) => c.notNull())
        .addColumn("max_concurrent", "integer", (c) => c.notNull().defaultTo(1))
        .addColumn("base_branch", "text", (c) => c.notNull().defaultTo("main"))
        .addColumn("setup", "text")
        .execute();

      await db.schema.createTable("tasks").ifNotExists()
        .addColumn("id", "text", (c) => c.primaryKey())
        .addColumn("project_id", "integer", (c) => c.notNull().references("projects.id"))
        .addColumn("title", "text", (c) => c.notNull())
        .addColumn("prompt", "text", (c) => c.notNull())
        .addColumn("workflow_name", "text", (c) => c.notNull())
        .addColumn("state", "text", (c) =>
          c.notNull().check(
            sql`state IN ('queued','running','suspended','paused','completed','failed','canceled')`,
          ))
        .addColumn("current_step_id", "text")
        .addColumn("attempt_counts", "text", (c) => c.notNull().defaultTo("{}"))
        .addColumn("branch", "text", (c) => c.notNull())
        .addColumn("worktree_path", "text")
        .addColumn("claude_session_id", "text")
        .addColumn("child_pid", "integer")
        .addColumn("child_started_at", "text")
        .addColumn("pending_feed", "text")
        .addColumn("priority", "integer", (c) => c.notNull().defaultTo(2))
        .addColumn("resumed", "integer", (c) => c.notNull().defaultTo(0))
        .addColumn("created_at", "text", (c) => c.notNull())
        .addColumn("updated_at", "text", (c) => c.notNull())
        .execute();
      const taskColumns = await sql<{ name: string }>`PRAGMA table_info(tasks)`.execute(db);
      if (!taskColumns.rows.some((c) => c.name === "pending_feed")) {
        await db.schema.alterTable("tasks").addColumn("pending_feed", "text").execute();
      }
      await db.schema.createIndex("idx_tasks_state").ifNotExists()
        .on("tasks").column("state").execute();
      await db.schema.createIndex("idx_tasks_project").ifNotExists()
        .on("tasks").columns(["project_id", "state"]).execute();

      await db.schema.createTable("step_runs").ifNotExists()
        .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
        .addColumn("task_id", "text", (c) => c.notNull().references("tasks.id"))
        .addColumn("step_id", "text", (c) => c.notNull())
        .addColumn("attempt", "integer", (c) => c.notNull())
        .addColumn("status", "text", (c) =>
          c.notNull().check(sql`status IN ('running','success','failed','degraded')`))
        .addColumn("exit_code", "integer")
        .addColumn("started_at", "text", (c) => c.notNull())
        .addColumn("ended_at", "text")
        .addColumn("log_path", "text", (c) => c.notNull())
        .addColumn("cost_usd", "real")
        .addColumn("num_turns", "integer")
        .addColumn("duration_ms", "integer")
        .execute();
      await db.schema.createIndex("idx_step_runs_task").ifNotExists()
        .on("step_runs").columns(["task_id", "id"]).execute();

      await db.schema.createTable("step_outputs").ifNotExists()
        .addColumn("task_id", "text", (c) => c.notNull().references("tasks.id"))
        .addColumn("step_id", "text", (c) => c.notNull())
        .addColumn("stdout", "text", (c) => c.notNull())
        .addColumn("stderr", "text", (c) => c.notNull())
        .addColumn("exit_code", "integer")
        .addPrimaryKeyConstraint("step_outputs_pk", ["task_id", "step_id"])
        .execute();

      await db.schema.createTable("rate_limit_samples").ifNotExists()
        .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
        .addColumn("observed_at", "text", (c) => c.notNull())
        .addColumn("window", "text", (c) => c.notNull())
        .addColumn("utilization", "real", (c) => c.notNull())
        .addColumn("resets_at", "text")
        .execute();
    },
  },
};

/** ファイルを動的 import しない（権限も要らず、deno check で型検査される）。 */
const provider: MigrationProvider = {
  getMigrations: () => Promise.resolve(migrations),
};

/**
 * 未適用のマイグレーションをすべて流す。1つでも失敗したら例外を投げる
 * （Migrator は結果を返すだけで投げないので、ここで投げ直す）。
 * SQLite の DDL はトランザクションに入るので、失敗したらその回の分は丸ごと巻き戻る。
 */
// deno-lint-ignore no-explicit-any
export async function migrateToLatest(db: Kysely<any>): Promise<void> {
  const { error, results } = await new Migrator({ db, provider }).migrateToLatest();
  if (error !== undefined) {
    const failed = results?.find((r) => r.status === "Error")?.migrationName;
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`マイグレーションに失敗しました${failed ? ` (${failed})` : ""}: ${reason}`, { cause: error });
  }
}
