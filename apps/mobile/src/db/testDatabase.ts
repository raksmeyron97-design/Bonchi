import { DatabaseSync } from 'node:sqlite';
import { type SqlDatabase, type SqlValue } from './client';
import { MIGRATIONS } from './schema';

/**
 * A real SQLite database for tests.
 *
 * Backed by `node:sqlite`, which ships with Node — so the queries under test run
 * through an actual SQL engine with the app's actual schema, with no extra
 * dependency and no device.
 *
 * This matters for anything whose correctness lives partly in SQL. A hand-written
 * fake repository proves the TypeScript around a query; it cannot catch a wrong
 * JOIN, a predicate that excludes the rows it should include, or a column that
 * does not exist. Those are the failures worth catching here.
 *
 * Test-only. Never imported by application code — `node:sqlite` does not exist in
 * a React Native runtime.
 */
export function createTestDatabase(): SqlDatabase & { close: () => void } {
  const db = new DatabaseSync(':memory:');

  // Off by default in SQLite, and the schema depends on it for the shape the app
  // relies on. Matching the device configuration is the whole point.
  db.exec('PRAGMA foreign_keys = ON');

  for (const migration of MIGRATIONS) {
    for (const statement of migration.statements) {
      db.exec(statement);
    }
  }

  // node:sqlite rejects `undefined` and accepts only null, number, string,
  // bigint and Uint8Array. SqlValue is already narrower than that, but a
  // `params` array built from optional fields can still carry an undefined.
  const bind = (params: readonly SqlValue[]): SqlValue[] =>
    params.map((value) => (value === undefined ? null : value));

  const database: SqlDatabase & { close: () => void } = {
    async run(sql, params = []) {
      const result = db.prepare(sql).run(...bind(params));
      return { changes: Number(result.changes) };
    },

    async all<T>(sql: string, params: readonly SqlValue[] = []): Promise<T[]> {
      return db.prepare(sql).all(...bind(params)) as T[];
    },

    async first<T>(sql: string, params: readonly SqlValue[] = []): Promise<T | null> {
      return (db.prepare(sql).get(...bind(params)) as T | undefined) ?? null;
    },

    async transaction<T>(work: (tx: SqlDatabase) => Promise<T>): Promise<T> {
      db.exec('BEGIN');
      try {
        const result = await work(database);
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },

    close: () => db.close(),
  };

  return database;
}
