import express from 'express';
import QRCode from 'qrcode';
import { bearerToken, generateCode, generateHostToken, hashToken, tokenMatches } from '../auth.js';
import { withTransaction } from '../db.js';
import { loadMyVotes, loadPolls } from '../polls.js';
import { loadQuestions } from '../questions.js';
import { HttpError, LIMITS, cleanText, parseCode, participantIdFrom } from '../validate.js';

const UNIQUE_VIOLATION = '23505';

export function createSessionsRouter({ pool, baseUrl, realtime }) {
  const router = express.Router();

  // BASE_URL in production; in development, whatever host the browser used.
  const siteUrl = (req) => baseUrl || `${req.protocol}://${req.get('host')}`;
  const joinUrl = (req, code) => `${siteUrl(req)}/s/${code}`;

  // Looks up a session by the :code route parameter, or responds 404.
  async function loadSession(req) {
    const code = parseCode(req.params.code);
    if (!code) throw new HttpError(404, 'not_found', 'Session not found');
    const { rows } = await pool.query(
      `SELECT s.*, (SELECT count(*)::int FROM session_participants p WHERE p.session_id = s.id) AS participant_count
         FROM sessions s WHERE s.code = $1`,
      [code],
    );
    if (rows.length === 0) throw new HttpError(404, 'not_found', 'Session not found');
    return rows[0];
  }

  // Create a session. The host token is returned exactly once, here.
  router.post('/', async (req, res) => {
    const body = req.body ?? {};
    const title = cleanText(body.title, { field: 'title', max: LIMITS.title, required: true });
    const hostName = cleanText(body.hostName, { field: 'hostName', max: LIMITS.hostName, required: false });
    const hostToken = generateHostToken();

    // 31^6 is about 887 million codes, so a clash is very rare; if one
    // happens the UNIQUE constraint rejects it and we try a new code.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = generateCode();
      try {
        await pool.query(
          'INSERT INTO sessions (code, title, host_name, host_token_hash) VALUES ($1, $2, $3, $4)',
          [code, title, hostName, hashToken(hostToken)],
        );
        return res.status(201).json({
          code,
          hostToken,
          hostUrl: `${siteUrl(req)}/host/${code}#${hostToken}`,
          joinUrl: joinUrl(req, code),
        });
      } catch (err) {
        if (err.code !== UNIQUE_VIOLATION) throw err;
      }
    }
    throw new Error('Could not generate a unique session code');
  });

  // Full session state. Pages call this on load and after every reconnect,
  // then keep it current from real-time events.
  router.get('/:code', async (req, res) => {
    const s = await loadSession(req);
    // The participant ID is optional here; with it, the response says which
    // option this browser picked in each poll.
    const pid = req.get('x-participant-id') ? participantIdFrom(req) : null;
    const isHost = tokenMatches(bearerToken(req), s.host_token_hash);
    const [polls, myVotes, questions] = await Promise.all([
      loadPolls(pool, s.id),
      pid ? loadMyVotes(pool, s.id, pid) : {},
      // Only the host sees hidden questions.
      loadQuestions(pool, s.id, { includeHidden: isHost, participantId: pid }),
    ]);
    res.json({
      session: {
        code: s.code,
        title: s.title,
        hostName: s.host_name,
        status: s.status,
        createdAt: s.created_at,
        endedAt: s.ended_at,
        participantCount: s.participant_count,
        participantLimit: LIMITS.participantsPerSession,
        joinUrl: joinUrl(req, s.code),
      },
      isHost,
      polls,
      myVotes,
      questions,
    });
  });

  // Register this browser as a participant. Safe to call again on every
  // visit: a returning participant keeps their place and is not counted twice.
  router.post('/:code/join', async (req, res) => {
    const participantId = participantIdFrom(req);
    const code = parseCode(req.params.code);
    if (!code) throw new HttpError(404, 'not_found', 'Session not found');

    const { count, isNew } = await withTransaction(pool, async (client) => {
      // FOR UPDATE locks this session's row until the transaction ends, so
      // two joins for the same session run one after the other. Without it,
      // both could count 49 and both insert, giving 51 participants.
      const { rows } = await client.query(
        'SELECT id, status FROM sessions WHERE code = $1 FOR UPDATE',
        [code],
      );
      if (rows.length === 0) throw new HttpError(404, 'not_found', 'Session not found');
      const session = rows[0];
      if (session.status === 'ended') throw new HttpError(410, 'ended', 'This session has ended');

      const existing = await client.query(
        'SELECT 1 FROM session_participants WHERE session_id = $1 AND participant_id = $2',
        [session.id, participantId],
      );
      const { rows: [{ n }] } = await client.query(
        'SELECT count(*)::int AS n FROM session_participants WHERE session_id = $1',
        [session.id],
      );
      if (existing.rowCount > 0) return { count: n, isNew: false };
      if (n >= LIMITS.participantsPerSession) {
        throw new HttpError(409, 'full', 'This session is full');
      }

      await client.query(
        'INSERT INTO session_participants (session_id, participant_id) VALUES ($1, $2)',
        [session.id, participantId],
      );
      await client.query('UPDATE sessions SET last_activity_at = now() WHERE id = $1', [session.id]);
      return { count: n + 1, isNew: true };
    });

    // Only the host's live head count needs to know about joins.
    if (isNew) realtime.participants(code, count);

    res.json({ participantCount: count, participantLimit: LIMITS.participantsPerSession });
  });

  // QR code for the join link, as an SVG image. Generated on the server so
  // the browser needs no QR library.
  router.get('/:code/qr.svg', async (req, res) => {
    const s = await loadSession(req);
    const svg = await QRCode.toString(joinUrl(req, s.code), { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    res.type('image/svg+xml').set('Cache-Control', 'public, max-age=3600').send(svg);
  });

  return router;
}
