import { DatabaseSync } from "node:sqlite";
import { Kysely } from "kysely";
import { NodeSqliteDialect } from "./dialect.ts";
import { migrateToLatest } from "./migrations.ts";
import type { Database, Db } from "./schema.ts";

export function openDb(path: string): Promise<Db> {
  const sqlite = new DatabaseSync(path);
  if (path !== ":memory:") sqlite.exec("PRAGMA journal_mode = WAL");
  return openDbOn(sqlite);
}

/**
 * 既に開いた DatabaseSync の上に Kysely を載せ、最新までマイグレーションする。
 * テストが素の接続を手元に残したい（sqlite_master を覗く・prepare に故障を
 * 仕込む）ときはこちらを使う。
 *
 * journal_mode（WAL）は呼び出し側が設定する。ここで設定するのは foreign_keys だけ。
 */
export async function openDbOn(sqlite: DatabaseSync): Promise<Db> {
  // トランザクションの中では切り替えられないので、最初のクエリより前に設定する。
  sqlite.exec("PRAGMA foreign_keys = ON");
  const db = new Kysely<Database>({ dialect: new NodeSqliteDialect(sqlite) });
  try {
    await migrateToLatest(db);
  } catch (e) {
    await db.destroy();
    throw e;
  }
  return db;
}
