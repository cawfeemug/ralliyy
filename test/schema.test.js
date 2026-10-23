import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { migrate } from '../src/migrate.js';
import { createTestPool, insertSession } from './helpers.js';

let pool;
before(async () => {
  pool = await createTestPool();
  await pool.query("DELETE FROM sessions WHERE code LIKE 'T%'");
});
after(async () => {
  await pool.query("DELETE FROM sessions WHERE code LIKE 'T%'");
  await pool.end();
});

test('migrations are idempotent', async () => {
  const ran = await migrate(pool, { log: () => {} });
  assert.deepEqual(ran, []);
});

test('session code must use the 31-character alphabet', async () => {
  // 0, O, 1, I and L are excluded because they are easy to misread.
  await assert.rejects(insertSession(pool, 'TABC0O'), { code: '23514' });
  await assert.rejects(insertSession(pool, 'tabcde'), { code: '23514' });
});

test('only one poll per session can be open', async () => {
  const sessionId = await insertSession(pool, 'TPAAA2');
  await pool.query("INSERT INTO polls (session_id, question) VALUES ($1, 'First?')", [sessionId]);
  // 23505 = unique_violation from the partial index.
  await assert.rejects(
    pool.query("INSERT INTO polls (session_id, question) VALUES ($1, 'Second?')", [sessionId]),
    { code: '23505' },
  );
  // Once the first poll is closed, a new one can open.
  await pool.query("UPDATE polls SET status = 'closed', closed_at = now() WHERE session_id = $1", [sessionId]);
  await pool.query("INSERT INTO polls (session_id, question) VALUES ($1, 'Second?')", [sessionId]);
});

test('a vote must point at an option of the same poll', async () => {
  const sessionId = await insertSession(pool, 'TVAAA2');
  const polls = await pool.query(
    `INSERT INTO polls (session_id, question, status, closed_at)
     VALUES ($1, 'A?', 'closed', now()), ($1, 'B?', 'open', NULL) RETURNING id`,
    [sessionId],
  );
  const [pollA, pollB] = polls.rows.map((r) => r.id);
  const opt = await pool.query(
    "INSERT INTO poll_options (poll_id, label, position) VALUES ($1, 'Yes', 0) RETURNING id",
    [pollA],
  );
  // 23503 = foreign_key_violation: the option belongs to poll A, not B.
  await assert.rejects(
    pool.query('INSERT INTO votes (poll_id, participant_id, option_id) VALUES ($1, gen_random_uuid(), $2)', [pollB, opt.rows[0].id]),
    { code: '23503' },
  );
});

test('deleting a session removes all its data', async () => {
  const sessionId = await insertSession(pool, 'TDAAA2');
  const poll = await pool.query("INSERT INTO polls (session_id, question) VALUES ($1, 'Q?') RETURNING id", [sessionId]);
  await pool.query("INSERT INTO poll_options (poll_id, label, position) VALUES ($1, 'A', 0)", [poll.rows[0].id]);
  await pool.query("INSERT INTO questions (session_id, participant_id, body) VALUES ($1, gen_random_uuid(), 'Hi?')", [sessionId]);

  await pool.query('DELETE FROM sessions WHERE id = $1', [sessionId]);

  const left = await pool.query(
    `SELECT (SELECT count(*) FROM polls WHERE session_id = $1)::int AS polls,
            (SELECT count(*) FROM questions WHERE session_id = $1)::int AS questions,
            (SELECT count(*) FROM poll_options WHERE poll_id = $2)::int AS options`,
    [sessionId, poll.rows[0].id],
  );
  assert.deepEqual(left.rows[0], { polls: 0, questions: 0, options: 0 });
});
