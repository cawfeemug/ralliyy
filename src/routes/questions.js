import express from 'express';
import { bearerToken, tokenMatches } from '../auth.js';
import { withTransaction } from '../db.js';
import { getUpvoteCount, toQuestion } from '../questions.js';
import { HttpError, LIMITS, cleanText, parseCode, participantIdFrom } from '../validate.js';

const ID_PATTERN = /^[1-9][0-9]{0,17}$/;

function parseId(raw) {
  if (!ID_PATTERN.test(String(raw))) throw new HttpError(404, 'not_found', 'Question not found');
  return String(raw);
}

async function requireJoined(client, sessionId, participantId) {
  const joined = await client.query(
    'SELECT 1 FROM session_participants WHERE session_id = $1 AND participant_id = $2',
    [sessionId, participantId],
  );
  if (joined.rowCount === 0) throw new HttpError(403, 'not_joined', 'Join the session first');
}

export function createQuestionsRouter({ pool, realtime }) {
  const router = express.Router();
  const touchSession = (id) => pool.query('UPDATE sessions SET last_activity_at = now() WHERE id = $1', [id]);

  // Participant: post a question. It is visible to everyone straight away.
  router.post('/sessions/:code/questions', async (req, res) => {
    const participantId = participantIdFrom(req);
    const code = parseCode(req.params.code);
    if (!code) throw new HttpError(404, 'not_found', 'Session not found');
    const body = cleanText(req.body?.body, { field: 'body', max: LIMITS.question, required: true });

    const row = await withTransaction(pool, async (client) => {
      // FOR SHARE: many questions can be posted at once, but ending the
      // session (an UPDATE of this row) waits for them, so nothing is
      // posted after the session has ended.
      const { rows } = await client.query(
        'SELECT id, status FROM sessions WHERE code = $1 FOR SHARE', [code]);
      if (rows.length === 0) throw new HttpError(404, 'not_found', 'Session not found');
      const session = rows[0];
      if (session.status === 'ended') throw new HttpError(410, 'ended', 'This session has ended');
      await requireJoined(client, session.id, participantId);

      const inserted = await client.query(
        `INSERT INTO questions (session_id, participant_id, body) VALUES ($1, $2, $3)
         RETURNING id, body, hidden, created_at`,
        [session.id, participantId, body],
      );
      return { ...inserted.rows[0], session_id: session.id };
    });
    // Outside the transaction on purpose: updating the session row inside
    // it, while other requests hold FOR SHARE on that row, would deadlock.
    await touchSession(row.session_id);

    // Everyone gets the question without "mine"; only the author's own
    // response marks it as theirs.
    realtime.questionPosted(code, toQuestion(row));
    res.status(201).json({ question: toQuestion(row, { mine: true }) });
  });

  // Participant: add (PUT) or remove (DELETE) an upvote. Both are safe to
  // repeat: the primary key (question, participant) allows one upvote each,
  // so a second PUT changes nothing.
  async function setUpvote(req, res, upvoted) {
    const questionId = parseId(req.params.id);
    const participantId = participantIdFrom(req);

    const { code, sessionId, changed } = await withTransaction(pool, async (client) => {
      const { rows } = await client.query(
        `SELECT q.hidden, s.id AS session_id, s.code, s.status
           FROM questions q JOIN sessions s ON s.id = q.session_id
          WHERE q.id = $1 FOR SHARE OF s`,
        [questionId],
      );
      // A hidden question doesn't exist as far as participants can tell.
      if (rows.length === 0 || rows[0].hidden) throw new HttpError(404, 'not_found', 'Question not found');
      const q = rows[0];
      if (q.status === 'ended') throw new HttpError(410, 'ended', 'This session has ended');
      await requireJoined(client, q.session_id, participantId);

      const result = upvoted
        ? await client.query(
          `INSERT INTO upvotes (question_id, participant_id) VALUES ($1, $2)
           ON CONFLICT (question_id, participant_id) DO NOTHING`,
          [questionId, participantId])
        : await client.query(
          'DELETE FROM upvotes WHERE question_id = $1 AND participant_id = $2',
          [questionId, participantId]);
      return { code: q.code, sessionId: q.session_id, changed: result.rowCount > 0 };
    });

    if (changed) {
      await touchSession(sessionId); // after commit, see the note in POST above
      realtime.questionUpvoted(code, questionId);
    }
    res.json({ questionId, upvoted, upvotes: await getUpvoteCount(pool, questionId) });
  }
  router.put('/questions/:id/upvote', (req, res) => setUpvote(req, res, true));
  router.delete('/questions/:id/upvote', (req, res) => setUpvote(req, res, false));

  // Host: hide or unhide a question. Body: { hidden: true | false }.
  router.post('/questions/:id/hide', async (req, res) => {
    const questionId = parseId(req.params.id);
    const { rows } = await pool.query(
      `SELECT s.id AS session_id, s.code, s.host_token_hash
         FROM questions q JOIN sessions s ON s.id = q.session_id WHERE q.id = $1`,
      [questionId],
    );
    if (rows.length === 0) throw new HttpError(404, 'not_found', 'Question not found');
    const { session_id: sessionId, code, host_token_hash: hash } = rows[0];
    if (!tokenMatches(bearerToken(req), hash)) {
      throw new HttpError(401, 'unauthorized', 'Host token is missing or wrong');
    }
    const hidden = req.body?.hidden;
    if (typeof hidden !== 'boolean') throw new HttpError(400, 'invalid_input', 'hidden must be true or false');

    // "IS DISTINCT FROM" skips the write, and the broadcast, when nothing changes.
    const updated = await pool.query(
      'UPDATE questions SET hidden = $2 WHERE id = $1 AND hidden IS DISTINCT FROM $2',
      [questionId, hidden],
    );
    if (updated.rowCount > 0) {
      await touchSession(sessionId);
      realtime.questionHidden(code, questionId, hidden);
    }
    res.json({ questionId, hidden });
  });

  return router;
}
