import { createPool } from '../src/db.js';
import { migrate } from '../src/migrate.js';

// Tests use their own database so they never touch development data.
export async function createTestPool() {
  const pool = createPool(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL);
  await migrate(pool, { log: () => {} });
  return pool;
}

// Inserts a session row directly, for tests that need one before the API exists.
export async function insertSession(pool, code) {
  const { rows } = await pool.query(
    `INSERT INTO sessions (code, title, host_token_hash)
     VALUES ($1, 'Test session', decode(repeat('ab', 32), 'hex'))
     RETURNING id`,
    [code],
  );
  return rows[0].id;
}
