// Question queries shared by the REST routes and the real-time broadcasts.
// Upvote counts are computed with COUNT from the upvotes table, never stored.

// Most upvoted first. Ties go to the newer question, so a fresh question is
// seen before older ones nobody has upvoted. The id makes the order fully
// stable, so cards never swap places when nothing changed.
const ORDER = 'upvotes DESC, q.created_at DESC, q.id DESC';

// Questions in a session. Participants get visible ones only; the host also
// gets hidden ones. With a participant ID, each question says whether this
// browser asked it ("mine") and whether it upvoted it.
export async function loadQuestions(db, sessionId, { includeHidden = false, participantId = null } = {}) {
  const { rows } = await db.query(
    `SELECT q.id, q.body, q.hidden, q.created_at,
            (SELECT count(*)::int FROM upvotes u WHERE u.question_id = q.id) AS upvotes,
            (q.participant_id = $2) AS mine,
            EXISTS (SELECT 1 FROM upvotes u WHERE u.question_id = q.id AND u.participant_id = $2) AS upvoted
       FROM questions q
      WHERE q.session_id = $1 AND ($3 OR NOT q.hidden)
      ORDER BY ${ORDER}`,
    [sessionId, participantId, includeHidden],
  );
  return rows.map((r) => toQuestion(r, { mine: r.mine === true, upvoted: r.upvoted }));
}

export async function getUpvoteCount(db, questionId) {
  const { rows: [{ n }] } = await db.query(
    'SELECT count(*)::int AS n FROM upvotes WHERE question_id = $1', [questionId]);
  return n;
}

// The shape sent to browsers. Never includes the author's participant ID.
export function toQuestion(row, { mine = false, upvoted = false } = {}) {
  return {
    id: row.id,
    body: row.body,
    hidden: row.hidden,
    createdAt: row.created_at,
    upvotes: row.upvotes ?? 0,
    mine,
    upvoted,
  };
}
