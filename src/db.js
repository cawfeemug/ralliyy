import pg from 'pg';

const { Pool } = pg;

// One pool per process. A pool keeps a few open connections and lends them
// out per query, which is much faster than connecting for every request.
export function createPool(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }
  const pool = new Pool({ connectionString, max: 10 });
  // An idle connection can die (e.g. the database restarts). Without this
  // listener that error would crash the process.
  pool.on('error', (err) => console.error('Idle database client error:', err.message));
  return pool;
}

// Runs fn inside a transaction on one connection, committing on success and
// rolling back on any error.
export async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
