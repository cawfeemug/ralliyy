// Recap maths and queries for GET /api/sessions/:code/recap.
// The pure functions below are exported so the tests can check the maths
// with fixed data, without a database.

// Timeline buckets: aim for 8 to 12 bars whatever the session length, using
// a step a reader recognises rather than an odd number of seconds.
const STEPS_MINUTES = [1, 2, 5, 10, 15, 30, 60, 120, 240, 480, 1440];
const TARGET_BUCKETS = 10;

export function bucketMinutesFor(durationMs) {
  const minutes = Math.max(1, Math.ceil(durationMs / 60000));
  const ideal = minutes / TARGET_BUCKETS;
  return STEPS_MINUTES.find((step) => step >= ideal) ?? STEPS_MINUTES.at(-1);
}

// Counts votes and questions into equal buckets from the session's start.
// `events` is [{ at: Date|string, kind: 'vote'|'question' }] in any order.
export function buildTimeline(events, { startedAt, endedAt, bucketMinutes } = {}) {
  const start = new Date(startedAt).getTime();
  const end = new Date(endedAt).getTime();
  const durationMs = Math.max(0, end - start);
  const step = bucketMinutes ?? bucketMinutesFor(durationMs);
  const stepMs = step * 60000;
  // At least one bucket, so a session with no measurable length still draws.
  const count = Math.max(1, Math.ceil(durationMs / stepMs));
  const buckets = Array.from({ length: count }, (_, i) => ({ minute: i * step, votes: 0, questions: 0 }));

  for (const event of events) {
    const offset = new Date(event.at).getTime() - start;
    if (!Number.isFinite(offset)) continue;
    // Clamp: an event a moment after ended_at belongs in the last bucket.
    const index = Math.min(count - 1, Math.max(0, Math.floor(offset / stepMs)));
    if (event.kind === 'vote') buckets[index].votes += 1;
    else if (event.kind === 'question') buckets[index].questions += 1;
  }
  return { bucketMinutes: step, buckets };
}

// The share of people who joined and then did something: voted or asked.
// Null when nobody joined, because 0/0 is not 0%.
export function participationRate({ participants, engaged }) {
  if (!participants) return null;
  return Math.round((engaged / participants) * 100);
}

// How many voters changed their mind in a poll, and the single biggest move.
// `events` is every vote action in time order: [{ participantId, optionId }].
// A participant's last action is their final answer; earlier ones are changes.
export function voteShifts(events, options) {
  const first = new Map();
  const last = new Map();
  for (const { participantId, optionId } of events) {
    if (!first.has(participantId)) first.set(participantId, optionId);
    last.set(participantId, optionId);
  }

  const moves = new Map(); // "from>to" -> count
  let changedVoters = 0;
  for (const [participantId, from] of first) {
    const to = last.get(participantId);
    if (from === to) continue;
    changedVoters += 1;
    const key = `${from}>${to}`;
    moves.set(key, (moves.get(key) ?? 0) + 1);
  }

  let topMove = null;
  for (const [key, count] of moves) {
    if (topMove && count <= topMove.count) continue;
    const [from, to] = key.split('>');
    topMove = { from, to, count };
  }
  if (topMove) {
    const label = (id) => options.find((o) => String(o.id) === String(id))?.label ?? null;
    topMove = { ...topMove, fromLabel: label(topMove.from), toLabel: label(topMove.to) };
  }
  return { voters: first.size, changedVoters, topMove };
}

// Everything the recap page needs, in as few round trips as sensible.
export async function loadRecap(db, session) {
  const endedAt = session.ended_at ?? new Date().toISOString();

  const [counts, events, voteEvents] = await Promise.all([
    db.query(
      `SELECT
         (SELECT count(*)::int FROM session_participants WHERE session_id = $1) AS participants,
         (SELECT count(*)::int FROM (
            SELECT participant_id FROM votes v
              JOIN polls p ON p.id = v.poll_id WHERE p.session_id = $1
            UNION
            SELECT participant_id FROM questions WHERE session_id = $1
          ) AS took_part)                                                      AS engaged,
         (SELECT count(*)::int FROM votes v
            JOIN polls p ON p.id = v.poll_id WHERE p.session_id = $1)          AS votes_cast,
         (SELECT count(*)::int FROM vote_events v
            JOIN polls p ON p.id = v.poll_id WHERE p.session_id = $1)          AS vote_actions,
         (SELECT count(*)::int FROM questions WHERE session_id = $1)           AS questions_asked,
         (SELECT count(*)::int FROM questions
            WHERE session_id = $1 AND NOT hidden)                              AS questions_visible`,
      [session.id],
    ),
    // One ordered stream of everything that happened, for the timeline.
    db.query(
      `SELECT v.created_at AS at, 'vote' AS kind
         FROM vote_events v JOIN polls p ON p.id = v.poll_id
        WHERE p.session_id = $1
        UNION ALL
       SELECT created_at AS at, 'question' AS kind FROM questions WHERE session_id = $1`,
      [session.id],
    ),
    // Every vote action per poll, oldest first, for the vote-shift maths.
    db.query(
      `SELECT v.poll_id, v.participant_id, v.option_id
         FROM vote_events v JOIN polls p ON p.id = v.poll_id
        WHERE p.session_id = $1
        ORDER BY v.created_at, v.id`,
      [session.id],
    ),
  ]);

  const c = counts.rows[0];
  const byPoll = new Map();
  for (const row of voteEvents.rows) {
    const key = String(row.poll_id);
    if (!byPoll.has(key)) byPoll.set(key, []);
    byPoll.get(key).push({ participantId: row.participant_id, optionId: String(row.option_id) });
  }

  return {
    stats: {
      participants: c.participants,
      engaged: c.engaged,
      participationRate: participationRate({ participants: c.participants, engaged: c.engaged }),
      votesCast: c.votes_cast,
      voteActions: c.vote_actions,
      questionsAsked: c.questions_asked,
      questionsVisible: c.questions_visible,
    },
    timeline: {
      startedAt: session.created_at,
      endedAt,
      ...buildTimeline(events.rows, { startedAt: session.created_at, endedAt }),
    },
    shiftsByPoll: byPoll,
  };
}
