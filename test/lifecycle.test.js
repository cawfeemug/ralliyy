import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { endIdleSessions } from '../src/lifecycle.js';
import { createTestPool } from './helpers.js';

let pool;
let app;
const created = [];

before(async () => {
  pool = await createTestPool();
  app = createApp({ pool });
});
after(async () => {
  await pool.query('DELETE FROM sessions WHERE code = ANY($1)', [created]);
  await pool.end();
});

async function newSession() {
  const res = await request(app).post('/api/sessions').send({ title: 'Lifecycle tests' });
  created.push(res.body.code);
  return res.body;
}
const auth = (s) => ({ Authorization: `Bearer ${s.hostToken}` });
const end = (s, headers = auth(s)) => request(app).post(`/api/sessions/${s.code}/end`).set(headers);
const remove = (s, headers = auth(s)) => request(app).delete(`/api/sessions/${s.code}`).set(headers);
async function joined(s) {
  const pid = randomUUID();
  await request(app).post(`/api/sessions/${s.code}/join`).set('X-Participant-Id', pid);
  return pid;
}

test('ending a session closes its open poll and blocks further activity', async () => {
  const s = await newSession();
  const pid = await joined(s);
  const { body: { poll } } = await request(app).post(`/api/sessions/${s.code}/polls`).set(auth(s))
    .send({ question: 'Last one?', options: ['Yes', 'No'] });
  const { body: { question } } = await request(app).post(`/api/sessions/${s.code}/questions`)
    .set('X-Participant-Id', pid).send({ body: 'Before the end?' });

  const res = await end(s);
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ended');
  assert.equal(res.body.resultsUrl, `/r/${s.code}`);

  const state = (await request(app).get(`/api/sessions/${s.code}`)).body;
  assert.equal(state.session.status, 'ended');
  assert.ok(state.session.endedAt);
  assert.equal(state.polls[0].status, 'closed');
  // Results stay readable after the end.
  assert.equal(state.questions[0].body, 'Before the end?');

  assert.equal((await request(app).put(`/api/polls/${poll.id}/vote`).set('X-Participant-Id', pid)
    .send({ optionId: poll.options[0].id })).status, 409);
  assert.equal((await request(app).post(`/api/sessions/${s.code}/questions`)
    .set('X-Participant-Id', pid).send({ body: 'After?' })).status, 410);
  assert.equal((await request(app).put(`/api/questions/${question.id}/upvote`).set('X-Participant-Id', pid)).status, 410);
  assert.equal((await request(app).post(`/api/sessions/${s.code}/polls`).set(auth(s))
    .send({ question: 'More?', options: ['A', 'B'] })).status, 410);
  assert.equal((await request(app).post(`/api/sessions/${s.code}/join`).set('X-Participant-Id', randomUUID())).status, 410);
});

test('ending twice returns 410; ending needs the host token', async () => {
  const s = await newSession();
  assert.equal((await end(s, {})).status, 401);
  assert.equal((await end(s, { Authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await request(app).post('/api/sessions/ZZZZZ2/end').set(auth(s))).status, 404);
  assert.equal((await end(s)).status, 200);
  assert.equal((await end(s)).status, 410);
});

test('two simultaneous End clicks end the session once', async () => {
  const s = await newSession();
  const statuses = (await Promise.all([end(s), end(s), end(s)])).map((r) => r.status).sort();
  assert.deepEqual(statuses, [200, 410, 410]);
});

test('ending while votes are arriving neither deadlocks nor counts a vote after the end', async () => {
  const s = await newSession();
  const { body: { poll } } = await request(app).post(`/api/sessions/${s.code}/polls`).set(auth(s))
    .send({ question: 'Race?', options: ['A', 'B'] });
  const pids = await Promise.all(Array.from({ length: 20 }, () => joined(s)));
  const votes = pids.map((pid) => request(app).put(`/api/polls/${poll.id}/vote`)
    .set('X-Participant-Id', pid).send({ optionId: poll.options[0].id }));
  const [endRes, ...voteRes] = await Promise.all([end(s), ...votes]);
  assert.equal(endRes.status, 200);
  for (const r of voteRes) assert.ok([200, 409].includes(r.status), `vote got ${r.status}`);

  const accepted = voteRes.filter((r) => r.status === 200).length;
  const { rows: [{ n, late }] } = await pool.query(
    `SELECT count(*)::int AS n, count(*) FILTER (WHERE v.updated_at > p.closed_at)::int AS late
       FROM votes v JOIN polls p ON p.id = v.poll_id WHERE v.poll_id = $1`, [poll.id]);
  assert.equal(n, accepted);
  assert.equal(late, 0);
});

test('deleting a session removes it and all its data', async () => {
  const s = await newSession();
  const pid = await joined(s);
  const { body: { poll } } = await request(app).post(`/api/sessions/${s.code}/polls`).set(auth(s))
    .send({ question: 'Gone?', options: ['A', 'B'] });
  await request(app).put(`/api/polls/${poll.id}/vote`).set('X-Participant-Id', pid).send({ optionId: poll.options[0].id });
  const { body: { question } } = await request(app).post(`/api/sessions/${s.code}/questions`)
    .set('X-Participant-Id', pid).send({ body: 'Gone too?' });
  await request(app).put(`/api/questions/${question.id}/upvote`).set('X-Participant-Id', pid);

  assert.equal((await remove(s, {})).status, 401);
  assert.equal((await remove(s)).status, 204);
  assert.equal((await request(app).get(`/api/sessions/${s.code}`)).status, 404);
  assert.equal((await remove(s)).status, 404);

  const { rows: [counts] } = await pool.query(
    `SELECT (SELECT count(*) FROM polls WHERE id = $1)::int AS polls,
            (SELECT count(*) FROM poll_options WHERE poll_id = $1)::int AS options,
            (SELECT count(*) FROM votes WHERE poll_id = $1)::int AS votes,
            (SELECT count(*) FROM vote_events WHERE poll_id = $1)::int AS vote_events,
            (SELECT count(*) FROM questions WHERE id = $2)::int AS questions,
            (SELECT count(*) FROM upvotes WHERE question_id = $2)::int AS upvotes,
            (SELECT count(*) FROM session_participants WHERE participant_id = $3)::int AS participants`,
    [poll.id, question.id, pid]);
  assert.deepEqual(counts, { polls: 0, options: 0, votes: 0, vote_events: 0, questions: 0, upvotes: 0, participants: 0 });
});

test('the auto-end query ends only sessions idle for 24 hours (fixed clock)', async () => {
  const idle = await newSession();
  const active = await newSession();
  const ended = await newSession();
  await request(app).post(`/api/sessions/${idle.code}/polls`).set(auth(idle)).send({ question: 'Open?', options: ['A', 'B'] });
  await end(ended);

  const now = new Date('2030-01-02T12:00:00Z');
  await pool.query("UPDATE sessions SET last_activity_at = '2030-01-01T11:59:00Z' WHERE code = $1", [idle.code]); // 24 h 1 min ago
  await pool.query("UPDATE sessions SET last_activity_at = '2030-01-01T12:01:00Z' WHERE code = $1", [active.code]); // 23 h 59 min ago
  await pool.query("UPDATE sessions SET last_activity_at = '2029-12-01T00:00:00Z' WHERE code = $1", [ended.code]);

  const codes = await endIdleSessions(pool, { now });
  assert.ok(codes.includes(idle.code));
  assert.ok(!codes.includes(active.code));
  assert.ok(!codes.includes(ended.code)); // already ended: left alone

  const { rows } = await pool.query(
    `SELECT s.code, s.status, s.ended_at, p.status AS poll_status
       FROM sessions s LEFT JOIN polls p ON p.session_id = s.id WHERE s.code = ANY($1)`,
    [[idle.code, active.code]]);
  const byCode = Object.fromEntries(rows.map((r) => [r.code, r]));
  assert.equal(byCode[idle.code].status, 'ended');
  assert.equal(byCode[idle.code].poll_status, 'closed');
  assert.equal(byCode[idle.code].ended_at.toISOString(), '2030-01-01T11:59:00.000Z'); // ended at its last activity
  assert.equal(byCode[active.code].status, 'live');

  // Running it again finds nothing new.
  assert.ok(!(await endIdleSessions(pool, { now })).includes(idle.code));
});
