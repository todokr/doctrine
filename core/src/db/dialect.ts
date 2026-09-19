import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  CompiledQuery,
  type DatabaseConnection,
  type DatabaseIntrospector,
  type Dialect,
  type DialectAdapter,
  type Driver,
  type Kysely,
  type QueryCompiler,
  type QueryResult,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
} from "kysely";

/**
 * `node:sqlite` の DatabaseSync に Kysely を被せる dialect。
 *
 * Kysely 公式の SqliteDialect は better-sqlite3 前提（パラメータを配列で渡す・
 * `stmt.reader` を見る）で、`node:sqlite` にはそのまま被せられない。
 * SQL の組み立て（adapter / compiler / introspector）は公式のものを使い、
 * 実行する部分だけをここに持つ。
 */
export class NodeSqliteDialect implements Dialect {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  createAdapter(): DialectAdapter {
    return new SqliteAdapter();
  }

  createDriver(): Driver {
    return new NodeSqliteDriver(this.#db);
  }

  createQueryCompiler(): QueryCompiler {
    return new SqliteQueryCompiler();
  }

  // deno-lint-ignore no-explicit-any
  createIntrospector(db: Kysely<any>): DatabaseIntrospector {
    return new SqliteIntrospector(db);
  }
}

class NodeSqliteDriver implements Driver {
  readonly #db: DatabaseSync;
  readonly #connection: NodeSqliteConnection;
  readonly #mutex = new ConnectionMutex();

  constructor(db: DatabaseSync) {
    this.#db = db;
    this.#connection = new NodeSqliteConnection(db);
  }

  async init(): Promise<void> {}

  /**
   * 接続は1本しかない。DatabaseSync 自体は同期APIだが、Kysely のトランザクションは
   * 文と文の間に await を挟む。排他しないと、その隙に別の非同期処理のクエリが
   * 開いているトランザクションの中で実行されてしまい、原子性が崩れる。
   * よってトランザクションは開始から COMMIT / ROLLBACK まで接続を握り続け、
   * その間の他のクエリはすべてここで待つ。
   *
   * 帰結として、トランザクションのコールバック内で `trx` ではなく外側の `db` を
   * 使うと、自分自身の解放を待って永久に止まる。
   */
  async acquireConnection(): Promise<DatabaseConnection> {
    await this.#mutex.lock();
    return this.#connection;
  }

  /**
   * 公式 SqliteDriver は `begin`（DEFERRED）を発行するが、ここでは IMMEDIATE にする。
   * 書き込みロックを最初の文ではなく BEGIN の時点で取るので、別プロセスが同じ DB を
   * 触っていても、途中の文でロック昇格に失敗して半端に終わることがない
   * （従来の手書き実装の `BEGIN IMMEDIATE` と同じ保証）。
   */
  async beginTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("BEGIN IMMEDIATE"));
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("COMMIT"));
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("ROLLBACK"));
  }

  async releaseConnection(): Promise<void> {
    this.#mutex.unlock();
  }

  async destroy(): Promise<void> {
    this.#db.close();
  }
}

class NodeSqliteConnection implements DatabaseConnection {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
    const stmt = this.#db.prepare(compiled.sql);
    // node:sqlite は可変長引数で受け取る（better-sqlite3 のように配列を1つ渡すと
    // 配列そのものが1個目の値として束縛されようとして失敗する）。
    const params = compiled.parameters as SQLInputValue[];
    // 結果列を持つ文（SELECT / RETURNING 付き）だけが行を返す。
    if (stmt.columns().length > 0) {
      return { rows: stmt.all(...params) as R[] };
    }
    const { changes, lastInsertRowid } = stmt.run(...params);
    return { rows: [], numAffectedRows: BigInt(changes), insertId: BigInt(lastInsertRowid) };
  }

  // deno-lint-ignore require-yield
  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error("node:sqlite dialect はストリーミングに対応していません");
  }
}

class ConnectionMutex {
  #promise: Promise<void> | undefined;
  #resolve: (() => void) | undefined;

  async lock(): Promise<void> {
    while (this.#promise) await this.#promise;
    this.#promise = new Promise((resolve) => {
      this.#resolve = resolve;
    });
  }

  unlock(): void {
    const resolve = this.#resolve;
    this.#promise = undefined;
    this.#resolve = undefined;
    resolve?.();
  }
}
