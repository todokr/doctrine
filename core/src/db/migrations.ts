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
        .addColumn(
          "status",
          "text",
          (c) => c.notNull().check(sql`status IN ('running','success','failed','degraded')`),
        )
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
  "0002_task_sessions": {
    // deno-lint-ignore no-explicit-any
    async up(db: Kysely<any>) {
      await db.schema.createTable("task_sessions").ifNotExists()
        .addColumn("task_id", "text", (c) => c.notNull().references("tasks.id"))
        .addColumn("role", "text", (c) => c.notNull())
        .addColumn("session_id", "text", (c) => c.notNull())
        .addPrimaryKeyConstraint("task_sessions_pk", ["task_id", "role"])
        .execute();

      // 既存の tasks.claude_session_id を role "default" として移す。
      // 列自体はここでは消さない（コードから参照しなくなるだけ、spec 5章）。
      await sql`
        INSERT INTO task_sessions (task_id, role, session_id)
        SELECT id, 'default', claude_session_id FROM tasks WHERE claude_session_id IS NOT NULL
      `.execute(db);
    },
  },
  /**
   * レビュー1回を1件の記録にする（spec 2026-09-18-review-record-design.md）。
   *
   * SQLite は CHECK 制約を変えられないので step_runs を再構築する。step_outputs は
   * その step_runs を参照するので、順序は「step_runs を作り直す → step_outputs を
   * 作り直す」でなければならない。この順序なら PRAGMA foreign_keys を切る必要が
   * ない（切ろうにもマイグレーションはトランザクションの中なので切れない）。
   */
  "0003_review_records": {
    // deno-lint-ignore no-explicit-any
    async up(db: Kysely<any>) {
      // --- 1. step_runs の再構築（awaiting / interrupted と review_tree） ---
      await db.schema.createTable("step_runs_new")
        .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
        .addColumn("task_id", "text", (c) => c.notNull().references("tasks.id"))
        .addColumn("step_id", "text", (c) => c.notNull())
        .addColumn("attempt", "integer", (c) => c.notNull())
        .addColumn("status", "text", (c) =>
          c.notNull().check(
            sql`status IN ('running','awaiting','success','failed','degraded','interrupted')`,
          ))
        .addColumn("exit_code", "integer")
        .addColumn("started_at", "text", (c) => c.notNull())
        .addColumn("ended_at", "text")
        .addColumn("log_path", "text", (c) => c.notNull())
        .addColumn("cost_usd", "real")
        .addColumn("num_turns", "integer")
        .addColumn("duration_ms", "integer")
        .addColumn("review_tree", "text")
        .execute();
      // id を含めてコピーする。step_outputs の割り当てがこの id を使う。
      await sql`
        INSERT INTO step_runs_new
          (id, task_id, step_id, attempt, status, exit_code, started_at, ended_at,
           log_path, cost_usd, num_turns, duration_ms, review_tree)
        SELECT id, task_id, step_id, attempt, status, exit_code, started_at, ended_at,
               log_path, cost_usd, num_turns, duration_ms, NULL
        FROM step_runs
      `.execute(db);
      await db.schema.dropTable("step_runs").execute();
      await db.schema.alterTable("step_runs_new").renameTo("step_runs").execute();
      await db.schema.createIndex("idx_step_runs_task")
        .on("step_runs").columns(["task_id", "id"]).execute();

      // --- 2. step_outputs の再構築（主キーを step_run_id に） ---
      await db.schema.createTable("step_outputs_new")
        .addColumn("step_run_id", "integer", (c) => c.primaryKey().references("step_runs.id"))
        .addColumn("stdout", "text", (c) => c.notNull())
        .addColumn("stderr", "text", (c) => c.notNull())
        .addColumn("exit_code", "integer")
        .execute();
      // 既存の1行は、同じ (task_id, step_id) の最新の実行の出力だった。
      // 対応する step_run が無い行は、どの実行の出力か決められないので捨てる。
      await sql`
        INSERT INTO step_outputs_new (step_run_id, stdout, stderr, exit_code)
        SELECT (SELECT r.id FROM step_runs r
                 WHERE r.task_id = o.task_id AND r.step_id = o.step_id
                 ORDER BY r.id DESC LIMIT 1),
               o.stdout, o.stderr, o.exit_code
        FROM step_outputs o
        WHERE EXISTS (SELECT 1 FROM step_runs r
                       WHERE r.task_id = o.task_id AND r.step_id = o.step_id)
      `.execute(db);
      await db.schema.dropTable("step_outputs").execute();
      await db.schema.alterTable("step_outputs_new").renameTo("step_outputs").execute();

      // --- 3. 移行時点で suspended のタスクに awaiting 行を立てる ---
      // suspended は approval でしか起こらないので、current_step_id がそのまま
      // approval ステップの id である。待ち始めた時刻は updated_at（suspended へ
      // 遷移した時刻そのもの）。ツリーは過去に遡れないので NULL。
      const suspended = await sql<
        { id: string; current_step_id: string; attempt_counts: string; updated_at: string }
      >`
        SELECT id, current_step_id, attempt_counts, updated_at FROM tasks
         WHERE state = 'suspended' AND current_step_id IS NOT NULL
      `.execute(db);
      for (const t of suspended.rows) {
        const prior = await sql<{ n: number }>`
          SELECT COUNT(*) AS n FROM step_runs
           WHERE task_id = ${t.id} AND step_id = ${t.current_step_id}
        `.execute(db);
        await sql`
          INSERT INTO step_runs
            (task_id, step_id, attempt, status, exit_code, started_at, ended_at,
             log_path, cost_usd, num_turns, duration_ms, review_tree)
          VALUES (${t.id}, ${t.current_step_id}, ${prior.rows[0].n + 1}, 'awaiting', NULL,
                  ${t.updated_at}, NULL, '', NULL, NULL, NULL, NULL)
        `.execute(db);
        // attempt の確定を待ち始めた時点へ移したので（spec 3.4）、旧コードで
        // 進めていないぶんをここで進める。進めないと移行後の applyApproval が
        // 1つ小さい数を decide に渡し、差し戻しの上限が1回ぶん甘くなる。
        // withAttempt は呼ばない（マイグレーションは最新の形に依存しない）。
        const counts = JSON.parse(t.attempt_counts) as Record<string, number>;
        counts[t.current_step_id] = (counts[t.current_step_id] ?? 0) + 1;
        await sql`
          UPDATE tasks SET attempt_counts = ${JSON.stringify(counts)} WHERE id = ${t.id}
        `.execute(db);
      }

      // 再構築で外部キーが壊れていないことを確かめてから終える。
      const violations = await sql<{ table: string }>`PRAGMA foreign_key_check`.execute(db);
      if (violations.rows.length > 0) {
        throw new Error(
          `外部キーが壊れています: ${violations.rows.map((r) => r.table).join(", ")}`,
        );
      }
    },
  },
  /**
   * step_outputs の stdout / stderr を last_stdout / last_stderr に改名する。
   * 制約に関わらない列なので、テーブル再構築は要らない。
   */
  "0004_step_outputs_last_names": {
    // deno-lint-ignore no-explicit-any
    async up(db: Kysely<any>) {
      await db.schema.alterTable("step_outputs")
        .renameColumn("stdout", "last_stdout").execute();
      await db.schema.alterTable("step_outputs")
        .renameColumn("stderr", "last_stderr").execute();
    },
  },
  /**
   * 利用上限に当たった実行を待って再開する（spec 2026-09-19-rate-limit-wait-design.md）。
   *
   * tasks.state と step_runs.status はどちらも CHECK 制約なので、値を足すには
   * テーブル再構築が要る。tasks は step_runs / step_outputs / task_sessions から
   * 参照される行を持ち得るうえ、openDbOn は PRAGMA foreign_keys = ON で開いている。
   * `DROP TABLE tasks` は暗黙の DELETE を伴うので、そのままでは子テーブルの行が
   * 参照を失って即座に弾かれる。外部キーの検査を止めてから作り直し、
   * PRAGMA foreign_key_check で整合を確かめてから戻す。
   *
   * 検査を止める手は2つ並べてある。Kysely の Migrator は SqliteAdapter が
   * supportsTransactionalDdl: false を返すためマイグレーションをトランザクションに
   * 入れない（`db.connection()` で流す）ので、ここでは PRAGMA foreign_keys が効く。
   * 将来トランザクションの中で流れるようになったら foreign_keys は無視されるが、
   * そのときは defer_foreign_keys の方が効く。
   */
  "0005_rate_limited": {
    // deno-lint-ignore no-explicit-any
    async up(db: Kysely<any>) {
      await sql`PRAGMA foreign_keys = OFF`.execute(db);
      await sql`PRAGMA defer_foreign_keys = ON`.execute(db);

      // --- 1. tasks の再構築（state に rate_limited、rate_limited_until 列） ---
      await db.schema.createTable("tasks_new")
        .addColumn("id", "text", (c) => c.primaryKey())
        .addColumn("project_id", "integer", (c) => c.notNull().references("projects.id"))
        .addColumn("title", "text", (c) => c.notNull())
        .addColumn("prompt", "text", (c) => c.notNull())
        .addColumn("workflow_name", "text", (c) => c.notNull())
        .addColumn("state", "text", (c) =>
          c.notNull().check(
            sql`state IN ('queued','running','suspended','paused','rate_limited','completed','failed','canceled')`,
          ))
        .addColumn("current_step_id", "text")
        .addColumn("attempt_counts", "text", (c) => c.notNull().defaultTo("{}"))
        .addColumn("branch", "text", (c) => c.notNull())
        .addColumn("worktree_path", "text")
        .addColumn("claude_session_id", "text")
        .addColumn("child_pid", "integer")
        .addColumn("child_started_at", "text")
        .addColumn("pending_feed", "text")
        .addColumn("rate_limited_until", "text")
        .addColumn("priority", "integer", (c) => c.notNull().defaultTo(2))
        .addColumn("resumed", "integer", (c) => c.notNull().defaultTo(0))
        .addColumn("created_at", "text", (c) => c.notNull())
        .addColumn("updated_at", "text", (c) => c.notNull())
        .execute();
      await sql`
        INSERT INTO tasks_new
          (id, project_id, title, prompt, workflow_name, state, current_step_id, attempt_counts,
           branch, worktree_path, claude_session_id, child_pid, child_started_at, pending_feed,
           rate_limited_until, priority, resumed, created_at, updated_at)
        SELECT id, project_id, title, prompt, workflow_name, state, current_step_id, attempt_counts,
               branch, worktree_path, claude_session_id, child_pid, child_started_at, pending_feed,
               NULL, priority, resumed, created_at, updated_at
        FROM tasks
      `.execute(db);
      await db.schema.dropTable("tasks").execute();
      await db.schema.alterTable("tasks_new").renameTo("tasks").execute();
      await db.schema.createIndex("idx_tasks_state").on("tasks").column("state").execute();
      await db.schema.createIndex("idx_tasks_project")
        .on("tasks").columns(["project_id", "state"]).execute();

      // --- 2. step_runs の再構築（status に rate_limited） ---
      await db.schema.createTable("step_runs_new")
        .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
        .addColumn("task_id", "text", (c) => c.notNull().references("tasks.id"))
        .addColumn("step_id", "text", (c) => c.notNull())
        .addColumn("attempt", "integer", (c) => c.notNull())
        .addColumn("status", "text", (c) =>
          c.notNull().check(
            sql`status IN ('running','awaiting','success','failed','degraded','interrupted','rate_limited')`,
          ))
        .addColumn("exit_code", "integer")
        .addColumn("started_at", "text", (c) => c.notNull())
        .addColumn("ended_at", "text")
        .addColumn("log_path", "text", (c) => c.notNull())
        .addColumn("cost_usd", "real")
        .addColumn("num_turns", "integer")
        .addColumn("duration_ms", "integer")
        .addColumn("review_tree", "text")
        .execute();
      // id を含めてコピーする。step_outputs.step_run_id がこの id を指している。
      await sql`
        INSERT INTO step_runs_new
          (id, task_id, step_id, attempt, status, exit_code, started_at, ended_at,
           log_path, cost_usd, num_turns, duration_ms, review_tree)
        SELECT id, task_id, step_id, attempt, status, exit_code, started_at, ended_at,
               log_path, cost_usd, num_turns, duration_ms, review_tree
        FROM step_runs
      `.execute(db);
      await db.schema.dropTable("step_runs").execute();
      await db.schema.alterTable("step_runs_new").renameTo("step_runs").execute();
      await db.schema.createIndex("idx_step_runs_task")
        .on("step_runs").columns(["task_id", "id"]).execute();

      const violations = await sql<{ table: string }>`PRAGMA foreign_key_check`.execute(db);
      await sql`PRAGMA foreign_keys = ON`.execute(db);
      if (violations.rows.length > 0) {
        throw new Error(
          `外部キーが壊れています: ${violations.rows.map((r) => r.table).join(", ")}`,
        );
      }
    },
  },
  /**
   * 差し戻し（onFailure / onReject の goto が発火した実行）を、分岐先の無い
   * 本当の失敗と区別できるようにする。status に 'bounced' を足し、戻り先を
   * goto_step_id が持つ。
   *
   * 0003 と違い、ここでの step_outputs.step_run_id は step_runs.id を参照して
   * いる。foreign_keys = ON（migrate.ts）のまま step_runs を DROP すると、
   * 参照している step_outputs の行に暗黙の DELETE が走って出力が消える。
   * defer_foreign_keys は違反の検査を COMMIT まで遅らせるだけで、この DELETE
   * 自体は止められない。そこで step_outputs を外部キーの無い一時テーブルへ
   * 退避してから step_runs を作り直し、後で戻す。
   *
   * 既存の failed 行は遡って直さない。その行が差し戻しだったかは当時の
   * ワークフロー定義が無いと決まらないので、goto_step_id は NULL のままにする。
   */
  "0006_step_run_bounced": {
    // deno-lint-ignore no-explicit-any
    async up(db: Kysely<any>) {
      // --- 1. step_outputs を外部キーの無い一時テーブルへ退避する ---
      // CREATE TABLE ... AS SELECT は制約を引き継がないので、step_runs を
      // drop しても連鎖 DELETE が走らない。
      await sql`CREATE TABLE step_outputs_backup AS SELECT * FROM step_outputs`.execute(db);
      await db.schema.dropTable("step_outputs").execute();

      // --- 2. step_runs の再構築（bounced と goto_step_id） ---
      await db.schema.createTable("step_runs_new")
        .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
        .addColumn("task_id", "text", (c) => c.notNull().references("tasks.id"))
        .addColumn("step_id", "text", (c) => c.notNull())
        .addColumn("attempt", "integer", (c) => c.notNull())
        .addColumn("status", "text", (c) =>
          c.notNull().check(
            sql`status IN ('running','awaiting','success','failed','degraded','interrupted','rate_limited','bounced')`,
          ))
        .addColumn("exit_code", "integer")
        .addColumn("started_at", "text", (c) => c.notNull())
        .addColumn("ended_at", "text")
        .addColumn("log_path", "text", (c) => c.notNull())
        .addColumn("cost_usd", "real")
        .addColumn("num_turns", "integer")
        .addColumn("duration_ms", "integer")
        .addColumn("review_tree", "text")
        .addColumn("goto_step_id", "text")
        // 「分岐先のある失敗」「分岐先の無い差し戻し」という読めない行を入れない。
        .addCheckConstraint(
          "step_runs_goto_step_id_bounced",
          sql`(status = 'bounced') = (goto_step_id IS NOT NULL)`,
        )
        .execute();
      // id を含めてコピーする。step_outputs の参照がこの id を使う。
      await sql`
        INSERT INTO step_runs_new
          (id, task_id, step_id, attempt, status, exit_code, started_at, ended_at,
           log_path, cost_usd, num_turns, duration_ms, review_tree, goto_step_id)
        SELECT id, task_id, step_id, attempt, status, exit_code, started_at, ended_at,
               log_path, cost_usd, num_turns, duration_ms, review_tree, NULL
        FROM step_runs
      `.execute(db);
      await db.schema.dropTable("step_runs").execute();
      await db.schema.alterTable("step_runs_new").renameTo("step_runs").execute();
      await db.schema.createIndex("idx_step_runs_task")
        .on("step_runs").columns(["task_id", "id"]).execute();

      // --- 3. step_outputs を作り直して退避した行を戻す ---
      await db.schema.createTable("step_outputs")
        .addColumn("step_run_id", "integer", (c) => c.primaryKey().references("step_runs.id"))
        .addColumn("last_stdout", "text", (c) => c.notNull())
        .addColumn("last_stderr", "text", (c) => c.notNull())
        .addColumn("exit_code", "integer")
        .execute();
      await sql`
        INSERT INTO step_outputs (step_run_id, last_stdout, last_stderr, exit_code)
        SELECT step_run_id, last_stdout, last_stderr, exit_code FROM step_outputs_backup
      `.execute(db);
      await db.schema.dropTable("step_outputs_backup").execute();

      const violations = await sql<{ table: string }>`PRAGMA foreign_key_check`.execute(db);
      if (violations.rows.length > 0) {
        throw new Error(
          `外部キーが壊れています: ${violations.rows.map((r) => r.table).join(", ")}`,
        );
      }
    },
  },

  /**
   * 権限拒否の中身を残す。CHECK 制約を足さないので、0005 / 0006 のような
   * テーブル再構築は要らない。
   */
  "0007_step_run_permission_denials": {
    // deno-lint-ignore no-explicit-any
    async up(db: Kysely<any>) {
      await db.schema.alterTable("step_runs").addColumn("permission_denials", "text").execute();
    },
  },

  /**
   * status から 'degraded' を落とす。権限で拒否された操作があっても実行の成否は
   * 変わらないので、拒否の有無は permission_denials だけが持つ。
   * 既存の degraded 行は success に直してから CHECK 制約を張り直す。
   *
   * 0006 と同じ理由で step_outputs を退避してから step_runs を作り直す。
   */
  "0008_step_run_drop_degraded": {
    // deno-lint-ignore no-explicit-any
    async up(db: Kysely<any>) {
      await sql`UPDATE step_runs SET status = 'success' WHERE status = 'degraded'`.execute(db);

      // --- 1. step_outputs を外部キーの無い一時テーブルへ退避する ---
      await sql`CREATE TABLE step_outputs_backup AS SELECT * FROM step_outputs`.execute(db);
      await db.schema.dropTable("step_outputs").execute();

      // --- 2. step_runs の再構築（status から degraded を外す） ---
      await db.schema.createTable("step_runs_new")
        .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
        .addColumn("task_id", "text", (c) => c.notNull().references("tasks.id"))
        .addColumn("step_id", "text", (c) => c.notNull())
        .addColumn("attempt", "integer", (c) => c.notNull())
        .addColumn("status", "text", (c) =>
          c.notNull().check(
            sql`status IN ('running','awaiting','success','failed','interrupted','rate_limited','bounced')`,
          ))
        .addColumn("exit_code", "integer")
        .addColumn("started_at", "text", (c) => c.notNull())
        .addColumn("ended_at", "text")
        .addColumn("log_path", "text", (c) => c.notNull())
        .addColumn("cost_usd", "real")
        .addColumn("num_turns", "integer")
        .addColumn("duration_ms", "integer")
        .addColumn("review_tree", "text")
        .addColumn("goto_step_id", "text")
        .addColumn("permission_denials", "text")
        .addCheckConstraint(
          "step_runs_goto_step_id_bounced",
          sql`(status = 'bounced') = (goto_step_id IS NOT NULL)`,
        )
        .execute();
      // id を含めてコピーする。step_outputs の参照がこの id を使う。
      await sql`
        INSERT INTO step_runs_new
          (id, task_id, step_id, attempt, status, exit_code, started_at, ended_at,
           log_path, cost_usd, num_turns, duration_ms, review_tree, goto_step_id, permission_denials)
        SELECT id, task_id, step_id, attempt, status, exit_code, started_at, ended_at,
               log_path, cost_usd, num_turns, duration_ms, review_tree, goto_step_id, permission_denials
        FROM step_runs
      `.execute(db);
      await db.schema.dropTable("step_runs").execute();
      await db.schema.alterTable("step_runs_new").renameTo("step_runs").execute();
      await db.schema.createIndex("idx_step_runs_task")
        .on("step_runs").columns(["task_id", "id"]).execute();

      // --- 3. step_outputs を作り直して退避した行を戻す ---
      await db.schema.createTable("step_outputs")
        .addColumn("step_run_id", "integer", (c) => c.primaryKey().references("step_runs.id"))
        .addColumn("last_stdout", "text", (c) => c.notNull())
        .addColumn("last_stderr", "text", (c) => c.notNull())
        .addColumn("exit_code", "integer")
        .execute();
      await sql`
        INSERT INTO step_outputs (step_run_id, last_stdout, last_stderr, exit_code)
        SELECT step_run_id, last_stdout, last_stderr, exit_code FROM step_outputs_backup
      `.execute(db);
      await db.schema.dropTable("step_outputs_backup").execute();

      const violations = await sql<{ table: string }>`PRAGMA foreign_key_check`.execute(db);
      if (violations.rows.length > 0) {
        throw new Error(
          `外部キーが壊れています: ${violations.rows.map((r) => r.table).join(", ")}`,
        );
      }
    },
  },

  /**
   * Intake（2026-09-21-intake-core-design.md 4 章）。intakes とその回ごとの実行・質問・案・
   * コメント・承認・プロセスの進行、見張りが見た PR の事実を持つ表を足し、tasks に
   * Intake への紐づけの列を足す。
   *
   * tasks の 4 列は ALTER TABLE ADD COLUMN で足せる（0005 のような再構築は要らない）。
   * 既定値の無い列なら REFERENCES を、列に付ける CHECK なら他の列を参照するものも許されるため。
   * CHECK は intake_process_id に付けるので、参照先の intake_id を先に足しておく。
   *
   * intake_process_id には外部キーを張らない。参照先 intake_processes の主キーは
   * (intake_id, process_id) の複合で、ADD COLUMN では複合の外部キーを足せない。
   * intake_processes の行は消さず retired_at を入れるだけなので、参照が切れることはない。
   *
   * 部分 unique index の名前を idx_ で始めないのは、0005 のテストが idx_ の索引の一覧を
   * 固定しているため。
   */
  "0009_intake": {
    // deno-lint-ignore no-explicit-any
    async up(db: Kysely<any>) {
      await db.schema.createTable("intakes")
        .addColumn("id", "text", (c) => c.primaryKey())
        .addColumn("project_id", "integer", (c) => c.notNull().references("projects.id"))
        .addColumn("issue_url", "text", (c) => c.notNull())
        .addColumn("issue_node_id", "text", (c) => c.notNull())
        .addColumn("issue_title", "text", (c) => c.notNull())
        .addColumn("state", "text", (c) =>
          c.notNull().check(
            sql`state IN ('investigating','answering','decomposing','reviewing','active','needs_attention','completed','canceled')`,
          ))
        .addColumn("revising", "integer", (c) => c.notNull().defaultTo(0))
        .addColumn("attention_reason", "text")
        .addColumn("dispatch_paused", "integer", (c) => c.notNull().defaultTo(0))
        .addColumn("worktree_path", "text")
        .addColumn("claude_session_id", "text")
        .addColumn("child_pid", "integer")
        .addColumn("child_started_at", "text")
        .addColumn("rate_limited_until", "text")
        .addColumn("created_at", "text", (c) => c.notNull())
        .addColumn("updated_at", "text", (c) => c.notNull())
        .addColumn("ended_at", "text")
        .execute();
      await sql`
        CREATE UNIQUE INDEX uq_intakes_open_issue ON intakes(issue_url)
        WHERE state NOT IN ('completed','canceled')
      `.execute(db);

      await db.schema.createTable("intake_runs")
        .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
        .addColumn("intake_id", "text", (c) => c.notNull().references("intakes.id"))
        .addColumn(
          "purpose",
          "text",
          (c) => c.notNull().check(sql`purpose IN ('investigate','decompose','revise')`),
        )
        .addColumn("attempt", "integer", (c) => c.notNull())
        .addColumn("status", "text", (c) =>
          c.notNull().check(
            sql`status IN ('queued','running','success','failed','rate_limited','interrupted')`,
          ))
        .addColumn("started_at", "text")
        .addColumn("ended_at", "text")
        .addColumn("log_path", "text", (c) => c.notNull())
        .addColumn("cost_usd", "real")
        .addColumn("num_turns", "integer")
        .addColumn("duration_ms", "integer")
        .addColumn("output", "text")
        .addColumn("issues", "text")
        .addColumn("permission_denials", "text")
        .execute();

      await db.schema.createTable("intake_question_sets")
        .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
        .addColumn("intake_id", "text", (c) => c.notNull().references("intakes.id"))
        .addColumn("run_id", "integer", (c) => c.notNull().references("intake_runs.id"))
        .addColumn("questions", "text", (c) => c.notNull())
        .addColumn("answers", "text")
        .addColumn("created_at", "text", (c) => c.notNull())
        .addColumn("answered_at", "text")
        .execute();

      await db.schema.createTable("intake_drafts")
        .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
        .addColumn("intake_id", "text", (c) => c.notNull().references("intakes.id"))
        .addColumn("seq", "integer", (c) => c.notNull())
        .addColumn("run_id", "integer", (c) => c.notNull().references("intake_runs.id"))
        .addColumn("pfd", "text", (c) => c.notNull())
        .addColumn("hash", "text", (c) => c.notNull())
        .addColumn("replies", "text", (c) => c.notNull())
        .addColumn("created_at", "text", (c) => c.notNull())
        .addUniqueConstraint("intake_drafts_seq", ["intake_id", "seq"])
        .execute();

      await db.schema.createTable("intake_comments")
        .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
        .addColumn("intake_id", "text", (c) => c.notNull().references("intakes.id"))
        .addColumn("draft_id", "integer", (c) => c.notNull().references("intake_drafts.id"))
        .addColumn(
          "target_kind",
          "text",
          (c) => c.notNull().check(sql`target_kind IN ('artifact','process','whole')`),
        )
        .addColumn("target_id", "text")
        .addColumn("body", "text", (c) => c.notNull())
        .addColumn("created_at", "text", (c) => c.notNull())
        .addCheckConstraint(
          "intake_comments_target_id_whole",
          sql`(target_kind = 'whole') = (target_id IS NULL)`,
        )
        .execute();

      await db.schema.createTable("intake_approvals")
        .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
        .addColumn("intake_id", "text", (c) => c.notNull().references("intakes.id"))
        .addColumn("draft_id", "integer", (c) => c.notNull().references("intake_drafts.id"))
        .addColumn("hash", "text", (c) => c.notNull())
        .addColumn("approved_at", "text", (c) => c.notNull())
        .execute();

      await db.schema.createTable("intake_processes")
        .addColumn("intake_id", "text", (c) => c.notNull().references("intakes.id"))
        .addColumn("process_id", "text", (c) => c.notNull())
        .addColumn("sub_issue_url", "text")
        .addColumn("sub_issue_node_id", "text")
        .addColumn("sub_issue_hash", "text")
        .addColumn("sub_issue_closed", "integer", (c) => c.notNull().defaultTo(0))
        .addColumn("current_task_id", "text", (c) => c.references("tasks.id"))
        .addColumn("human_note", "text")
        .addColumn("human_done_at", "text")
        .addColumn("retired_at", "text")
        .addPrimaryKeyConstraint("intake_processes_pk", ["intake_id", "process_id"])
        .execute();

      await db.schema.createTable("pr_observations")
        .addColumn("task_id", "text", (c) => c.primaryKey().references("tasks.id"))
        .addColumn("pr_number", "integer", (c) => c.notNull())
        .addColumn("pr_url", "text", (c) => c.notNull())
        .addColumn(
          "state",
          "text",
          (c) => c.notNull().check(sql`state IN ('OPEN','MERGED','CLOSED')`),
        )
        .addColumn("base_ref", "text", (c) => c.notNull())
        .addColumn("merged_at", "text")
        .addColumn("merge_commit", "text")
        .addColumn("observed_at", "text", (c) => c.notNull())
        .execute();

      await db.schema.alterTable("tasks")
        .addColumn("intake_id", "text", (c) => c.references("intakes.id"))
        .execute();
      await db.schema.alterTable("tasks")
        .addColumn(
          "intake_process_id",
          "text",
          (c) => c.check(sql`(intake_id IS NULL) = (intake_process_id IS NULL)`),
        )
        .execute();
      await db.schema.alterTable("tasks").addColumn("issue_url", "text").execute();
      await db.schema.alterTable("tasks").addColumn("parent_issue_url", "text").execute();
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
    throw new Error(`マイグレーションに失敗しました${failed ? ` (${failed})` : ""}: ${reason}`, {
      cause: error,
    });
  }
}
