import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(here, 'migrations');

function makeAdapter(query, exec, transaction) {
  return {
    query: async (sql, params = []) => {
      const result = await query(sql, params);
      return result?.rows ?? [];
    },
    exec: async (sql) => {
      await exec(sql);
    },
    transaction,
  };
}

/**
 * PostgreSQL access with two interchangeable drivers:
 *  - node-postgres when DATABASE_URL is set (Railway / managed Postgres)
 *  - PGlite when it is not (local development and tests)
 *
 * Both expose the same query($1, $2...) interface, so the rest of the server
 * does not need to know which one is active.
 */
export async function createDatabase({ config, logger }) {
  let kind;
  let query;
  let exec;
  let transaction;
  let close;

  if (config.databaseUrl) {
    kind = 'postgres';
    const pgModule = await import('pg');
    const { Pool } = pgModule.default || pgModule;
    const pool = new Pool({
      connectionString: config.databaseUrl,
      ssl: config.pgSsl ? { rejectUnauthorized: false } : undefined,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    pool.on('error', (error) => logger?.error({ err: error }, 'PostgreSQL pool error'));
    query = (sql, params) => pool.query(sql, params);
    exec = (sql) => pool.query(sql);
    transaction = async (fn) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const tx = makeAdapter(
          (sql, params) => client.query(sql, params),
          (sql) => client.query(sql),
          null,
        );
        const result = await fn(tx);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    };
    close = () => pool.end();
  } else {
    kind = 'pglite';
    const { PGlite } = await import('@electric-sql/pglite');
    const memory = !config.pgliteDir || config.pgliteDir === 'memory://' || config.pgliteDir === ':memory:';
    if (!memory) await fs.mkdir(path.dirname(config.pgliteDir), { recursive: true });
    const db = memory ? new PGlite() : new PGlite(config.pgliteDir);
    await db.waitReady;
    query = (sql, params) => db.query(sql, params);
    exec = (sql) => db.exec(sql);
    transaction = (fn) =>
      db.transaction(async (tx) =>
        fn(
          makeAdapter(
            (sql, params) => tx.query(sql, params),
            (sql) => tx.exec(sql),
            null,
          ),
        ),
      );
    close = () => db.close();
  }

  const db = makeAdapter(query, exec, transaction);

  async function migrate() {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL
      );
    `);
    const files = (await fs.readdir(MIGRATIONS_DIR))
      .filter((file) => file.endsWith('.sql'))
      .sort();
    const appliedRows = await db.query('SELECT name FROM schema_migrations');
    const applied = new Set(appliedRows.map((row) => row.name));

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      await db.transaction(async (tx) => {
        await tx.exec(sql);
        await tx.query('INSERT INTO schema_migrations (name, applied_at) VALUES ($1, $2)', [
          file,
          new Date().toISOString(),
        ]);
      });
      logger?.info({ migration: file }, 'Applied database migration');
    }
  }

  async function ping() {
    const rows = await db.query('SELECT 1 AS ok');
    return rows[0]?.ok === 1;
  }

  return { ...db, kind, migrate, ping, close };
}
