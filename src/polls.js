// Poll queries shared by the REST routes and the real-time broadcasts.
// Vote counts are always computed with COUNT from the votes table, never
// stored, so they cannot drift out of step with the votes themselves.

// Every poll in a session, oldest first, with options and live counts.
export async function loadPolls(db, sessionId) {
  const { rows } = await db.query(
    `SELECT p.id, p.question, p.status, p.opened_at, p.closed_at,
            o.id AS option_id, o.label, o.position,
            (SELECT count(*)::int FROM votes v WHERE v.option_id = o.id) AS votes
       FROM polls p
       JOIN poll_options o ON o.poll_id = p.id
      WHERE p.session_id = $1
      ORDER BY p.opened_at, p.id, o.position`,
    [sessionId],
  );

  const polls = [];
  for (const row of rows) {
    let poll = polls.at(-1);
    if (!poll || poll.id !== row.id) {
      poll = {
        id: row.id,
        number: polls.length + 1,
        question: row.question,
        status: row.status,
        openedAt: row.opened_at,
        closedAt: row.closed_at,
        options: [],
        totalVotes: 0,
      };
      polls.push(poll);
    }
    poll.options.push({ id: row.option_id, label: row.label, votes: row.votes });
    poll.totalVotes += row.votes;
  }
  return polls;
}

// Current counts for one poll: { counts: [{ optionId, votes }], totalVotes }.
export async function getPollCounts(db, pollId) {
  const { rows } = await db.query(
    `SELECT o.id AS option_id, count(v.participant_id)::int AS votes
       FROM poll_options o
       LEFT JOIN votes v ON v.option_id = o.id
      WHERE o.poll_id = $1
      GROUP BY o.id, o.position
      ORDER BY o.position`,
    [pollId],
  );
  const counts = rows.map((r) => ({ optionId: r.option_id, votes: r.votes }));
  return { counts, totalVotes: counts.reduce((sum, c) => sum + c.votes, 0) };
}

// This participant's choice in each poll of the session: { pollId: optionId }.
export async function loadMyVotes(db, sessionId, participantId) {
  const { rows } = await db.query(
    `SELECT v.poll_id, v.option_id
       FROM votes v JOIN polls p ON p.id = v.poll_id
      WHERE p.session_id = $1 AND v.participant_id = $2`,
    [sessionId, participantId],
  );
  return Object.fromEntries(rows.map((r) => [r.poll_id, r.option_id]));
}
