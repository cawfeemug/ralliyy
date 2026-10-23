// Ending sessions: by the End button (one session) or by the auto-end job
// (every session idle for 24 hours). Both close any open poll and mark the
// session ended, so an ended session never has a poll still taking votes.

export const IDLE_LIMIT_HOURS = 24;

// Ends one live session inside a transaction the caller provides, with the
// session row already locked FOR UPDATE. Returns when it ended.
export async function endLockedSession(client, sessionId) {
  await client.query(
    "UPDATE polls SET status = 'closed', closed_at = now() WHERE session_id = $1 AND status = 'open'",
    [sessionId],
  );
  const { rows } = await client.query(
    "UPDATE sessions SET status = 'ended', ended_at = now(), last_activity_at = now() WHERE id = $1 RETURNING ended_at",
    [sessionId],
  );
  return rows[0].ended_at;
}

// Ends every live session with no activity for IDLE_LIMIT_HOURS. One
// statement, so it is atomic and safe if it ever ran twice at once.
// ended_at is set to the last activity, not to now: the session really
// stopped then, so its duration on the results page stays meaningful.
// `now` is a parameter so tests can use a fixed clock.
export async function endIdleSessions(db, { now = new Date(), idleHours = IDLE_LIMIT_HOURS } = {}) {
  const { rows } = await db.query(
    `WITH ended AS (
       UPDATE sessions SET status = 'ended', ended_at = last_activity_at
        WHERE status = 'live' AND last_activity_at < $1::timestamptz - make_interval(hours => $2)
        RETURNING id, code, ended_at
     ), closed AS (
       UPDATE polls p SET status = 'closed', closed_at = e.ended_at
         FROM ended e
        WHERE p.session_id = e.id AND p.status = 'open'
     )
     SELECT code FROM ended`,
    [now, idleHours],
  );
  return rows.map((r) => r.code);
}
