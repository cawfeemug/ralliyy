import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool } from './db.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

// Any fixed number works; it just has to be the same in every process.
const MIGRATION_LOCK_ID = 727554;

// Applies every migrations/NNN_name.sql file not yet recorded in
// schema_migrations, in filename order, each in its own transaction.
export async function migrate(pool, { log = console.log } = {}) {
  const client = await pool.connect();
  try {
    // If two app instances start at once, only one runs migrations; the
    // other waits here and then finds nothing left to do.
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);

    const { rows } = await client.query('SELECT name FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.name));
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();

    const ran = [];
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${err.message}`);
      }
      log(`Applied migration ${file}`);
      ran.push(file);
    }
    return ran;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => {});
    client.release();
  }
}

// `npm run migrate` runs this file directly.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pool = createPool();
  try {
    const ran = await migrate(pool);
    if (ran.length === 0) console.log('Database is up to date');
  } finally {
    await pool.end();
  }
}
