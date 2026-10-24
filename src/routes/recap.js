import express from 'express';
import { loadPolls } from '../polls.js';
import { loadQuestions } from '../questions.js';
import { loadRecap, voteShifts } from '../recap.js';
import { HttpError, parseCode } from '../validate.js';

// GET /api/sessions/:code/recap
// Public and read-only: the recap page at /r/CODE is the one caller. Hidden
// questions are never included, and no host-only field is returned.
export function createRecapRouter({ pool }) {
  const router = express.Router();

  router.get('/sessions/:code/recap', async (req, res) => {
    const code = parseCode(req.params.code);
    if (!code) throw new HttpError(404, 'not_found', 'Session not found');
    const { rows } = await pool.query(
      `SELECT s.*, (SELECT count(*)::int FROM session_participants p WHERE p.session_id = s.id) AS participant_count
         FROM sessions s WHERE s.code = $1`,
      [code],
    );
    if (rows.length === 0) throw new HttpError(404, 'not_found', 'Session not found');
    const session = rows[0];

    const [polls, questions, recap] = await Promise.all([
      loadPolls(pool, session.id),
      loadQuestions(pool, session.id, { includeHidden: false }),
      loadRecap(pool, session),
    ]);

    res.json({
      session: {
        code: session.code,
        title: session.title,
        hostName: session.host_name,
        status: session.status,
        createdAt: session.created_at,
        endedAt: session.ended_at,
        participantCount: session.participant_count,
      },
      stats: { ...recap.stats, polls: polls.length },
      timeline: recap.timeline,
      polls: polls.map((poll) => ({
        ...poll,
        shifts: voteShifts(recap.shiftsByPoll.get(String(poll.id)) ?? [], poll.options),
      })),
      questions,
    });
  });

  return router;
}
