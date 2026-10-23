import express from 'express';
import { bearerToken, tokenMatches } from '../auth.js';
import { withTransaction } from '../db.js';
import { getPollCounts } from '../polls.js';
import { HttpError, LIMITS, cleanText, parseCode, participantIdFrom } from '../validate.js';

const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';
const ID_PATTERN = /^[1-9][0-9]{0,17}$/;

function requireHost(req, session) {
  if (!tokenMatches(bearerToken(req), session.host_token_hash)) {
    throw new HttpError(401, 'unauthorized', 'Host token is missing or wrong');
  }
}

function parseId(raw) {
  if (!ID_PATTERN.test(String(raw))) throw new HttpError(404, 'not_found', 'Poll not found');
  return String(raw);
}

function parseOptions(raw) {
  if (!Array.isArray(raw)) throw new HttpError(400, 'invalid_input', 'options must be a list');
  const labels = raw.map((label, i) =>
    cleanText(label, { field: `options[${i}]`, max: LIMITS.optionLabel, required: true }));
  if (labels.length < LIMITS.minOptions || labels.length > LIMITS.maxOptions) {
    throw new HttpError(400, 'invalid_input', `A poll needs ${LIMITS.minOptions} to ${LIMITS.maxOptions} options`);
  }
  if (new Set(labels.map((l) => l.toLowerCase())).size !== labels.length) {
    throw new HttpError(400, 'invalid_input', 'Options must be different from each other');
  }
  return labels;
}

export function createPollsRouter({ pool, realtime }) {
  const router = express.Router();

  // Host: create a poll and open it straight away.
  router.post('/sessions/:code/polls', async (req, res) => {
    const code = parseCode(req.params.code);
    if (!code) throw new HttpError(404, 'not_found', 'Session not found');
    const { rows } = await pool.query('SELECT id, status, host_token_hash FROM sessions WHERE code = $1', [code]);
    if (rows.length === 0) throw new HttpError(404, 'not_found', 'Session not found');
    const session = rows[0];
    requireHost(req, session);
    if (session.status === 'ended') throw new HttpError(410, 'ended', 'This session has ended');

    const question = cleanText(req.body?.question, { field: 'question', max: LIMITS.pollQuestion, required: true });
    const labels = parseOptions(req.body?.options);

    let poll;
    try {
      poll = await withTransaction(pool, async (client) => {
        // If another poll is still open, the partial unique index rejects
        // this INSERT. The database is the single source of truth for
        // "one open poll", so two fast clicks can't open two polls.
        const inserted = await client.query(
          'INSERT INTO polls (session_id, question) VALUES ($1, $2) RETURNING id, opened_at',
          [session.id, question],
        );
        const pollRow = inserted.rows[0];
        const options = await client.query(
          `INSERT INTO poll_options (poll_id, label, position)
           SELECT $1, label, ord - 1 FROM unnest($2::text[]) WITH ORDINALITY AS t(label, ord)
           RETURNING id, label`,
          [pollRow.id, labels],
        );
        await client.query('UPDATE sessions SET last_activity_at = now() WHERE id = $1', [session.id]);
        const { rows: [{ n }] } = await client.query(
          'SELECT count(*)::int AS n FROM polls WHERE session_id = $1', [session.id]);
        return {
          id: pollRow.id,
          number: n,
          question,
          status: 'open',
          openedAt: pollRow.opened_at,
          closedAt: null,
          options: options.rows.map((o) => ({ id: o.id, label: o.label, votes: 0 })),
          totalVotes: 0,
        };
      });
    } catch (err) {
      if (err.code === UNIQUE_VIOLATION) throw new HttpError(409, 'poll_open', 'Close the open poll first');
      throw err;
    }

    realtime.pollOpened(code, poll);
    res.status(201).json({ poll });
  });

  // Host: close a poll. Final counts go to everyone.
  router.post('/polls/:id/close', async (req, res) => {
    const pollId = parseId(req.params.id);
    const { rows } = await pool.query(
      `SELECT p.status, s.id AS session_id, s.code, s.host_token_hash
         FROM polls p JOIN sessions s ON s.id = p.session_id WHERE p.id = $1`,
      [pollId],
    );
    if (rows.length === 0) throw new HttpError(404, 'not_found', 'Poll not found');
    requireHost(req, rows[0]);

    // The WHERE status = 'open' makes this safe to race: only one close wins.
    const closed = await pool.query(
      "UPDATE polls SET status = 'closed', closed_at = now() WHERE id = $1 AND status = 'open' RETURNING closed_at",
      [pollId],
    );
    if (closed.rowCount === 0) throw new HttpError(409, 'poll_closed', 'This poll is already closed');
    await pool.query('UPDATE sessions SET last_activity_at = now() WHERE id = $1', [rows[0].session_id]);

    const counts = await getPollCounts(pool, pollId);
    realtime.pollClosed(rows[0].code, pollId, counts);
    res.json({ pollId, status: 'closed', closedAt: closed.rows[0].closed_at, ...counts });
  });

  // Participant: cast or change a vote. One row per (poll, participant).
  router.put('/polls/:id/vote', async (req, res) => {
    const pollId = parseId(req.params.id);
    const participantId = participantIdFrom(req);
    const optionId = req.body?.optionId;
    if (!ID_PATTERN.test(String(optionId ?? ''))) throw new HttpError(400, 'invalid_input', 'optionId is required');

    const code = await withTransaction(pool, async (client) => {
      // FOR SHARE: many votes can hold this lock together, but a close has
      // to wait for them, and a vote that starts after a close sees it. So
      // no vote can slip in after the poll is closed.
      const { rows } = await client.query(
        `SELECT p.status, p.session_id, s.code FROM polls p JOIN sessions s ON s.id = p.session_id
          WHERE p.id = $1 FOR SHARE OF p`,
        [pollId],
      );
      if (rows.length === 0) throw new HttpError(404, 'not_found', 'Poll not found');
      const poll = rows[0];
      if (poll.status !== 'open') throw new HttpError(409, 'poll_closed', 'This poll is closed');

      const joined = await client.query(
        'SELECT 1 FROM session_participants WHERE session_id = $1 AND participant_id = $2',
        [poll.session_id, participantId],
      );
      if (joined.rowCount === 0) throw new HttpError(403, 'not_joined', 'Join the session before voting');

      const previous = await client.query(
        'SELECT option_id FROM votes WHERE poll_id = $1 AND participant_id = $2',
        [pollId, participantId],
      );
      try {
        // Upsert: insert the vote, or if this participant already voted in
        // this poll (same primary key), change it instead. One statement,
        // so there is never a moment with zero or two votes.
        await client.query(
          `INSERT INTO votes (poll_id, participant_id, option_id) VALUES ($1, $2, $3)
           ON CONFLICT (poll_id, participant_id)
           DO UPDATE SET option_id = EXCLUDED.option_id, updated_at = now()`,
          [pollId, participantId, optionId],
        );
      } catch (err) {
        // The composite foreign key rejects an option from another poll.
        if (err.code === FOREIGN_KEY_VIOLATION) throw new HttpError(400, 'invalid_option', 'That option is not in this poll');
        throw err;
      }
      // History for the recap's vote-shift view; only real changes count.
      if (previous.rows[0]?.option_id !== String(optionId)) {
        await client.query(
          'INSERT INTO vote_events (poll_id, participant_id, option_id) VALUES ($1, $2, $3)',
          [pollId, participantId, optionId],
        );
      }
      await client.query('UPDATE sessions SET last_activity_at = now() WHERE id = $1', [poll.session_id]);
      return poll.code;
    });

    realtime.pollVoted(code, pollId);
    const counts = await getPollCounts(pool, pollId);
    res.json({ pollId, optionId: String(optionId), ...counts });
  });

  return router;
}
