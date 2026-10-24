import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { bucketMinutesFor, buildTimeline, participationRate, voteShifts } from '../src/recap.js';
import { createTestPool } from './helpers.js';

// --- the maths, with fixed data and no database ------------------------------

test('bucket size keeps the chart to about ten bars at any session length', () => {
  assert.equal(bucketMinutesFor(10 * 60000), 1); // 10 minutes -> 1-minute bars
  assert.equal(bucketMinutesFor(45 * 60000), 5); // 45 minutes -> 5-minute bars
  assert.equal(bucketMinutesFor(3 * 60 * 60000), 30); // 3 hours -> half-hour bars
  assert.equal(bucketMinutesFor(0), 1); // a session with no length still draws one bar
});

test('timeline counts votes and questions into the right minute', () => {
  const startedAt = '2026-10-24T10:00:00.000Z';
  const endedAt = '2026-10-24T10:03:00.000Z';
  const at = (s) => new Date(Date.parse(startedAt) + s * 1000).toISOString();
  const { bucketMinutes, buckets } = buildTimeline([
    { at: at(0), kind: 'vote' },
    { at: at(59), kind: 'vote' },
    { at: at(60), kind: 'question' },
    { at: at(125), kind: 'vote' },
    { at: at(130), kind: 'question' },
  ], { startedAt, endedAt });

  assert.equal(bucketMinutes, 1);
  assert.deepEqual(buckets, [
    { minute: 0, votes: 2, questions: 0 },
    { minute: 1, votes: 0, questions: 1 },
    { minute: 2, votes: 1, questions: 1 },
  ]);
});

test('an event just after the end lands in the last bucket, not off the chart', () => {
  const startedAt = '2026-10-24T10:00:00.000Z';
  const endedAt = '2026-10-24T10:02:00.000Z';
  const { buckets } = buildTimeline([
    { at: '2026-10-24T10:02:00.500Z', kind: 'vote' },
    { at: '2026-10-24T09:59:59.000Z', kind: 'vote' },
  ], { startedAt, endedAt });

  assert.equal(buckets.length, 2);
  assert.equal(buckets[0].votes, 1); // the early one
  assert.equal(buckets.at(-1).votes, 1); // the late one
});

test('participation rate is the share who voted or asked, and null with nobody', () => {
  assert.equal(participationRate({ participants: 32, engaged: 24 }), 75);
  assert.equal(participationRate({ participants: 3, engaged: 1 }), 33);
  assert.equal(participationRate({ participants: 0, engaged: 0 }), null);
});

test('vote shifts count the people who changed their mind, and the biggest move', () => {
  const options = [{ id: '1', label: 'Tea' }, { id: '2', label: 'Coffee' }];
  const shifts = voteShifts([
    { participantId: 'a', optionId: '1' },
    { participantId: 'b', optionId: '1' },
    { participantId: 'c', optionId: '2' },
    { participantId: 'a', optionId: '2' }, // a changed: Tea -> Coffee
    { participantId: 'b', optionId: '2' }, // b changed: Tea -> Coffee
    { participantId: 'c', optionId: '1' }, // c changed: Coffee -> Tea
  ], options);

  assert.equal(shifts.voters, 3);
  assert.equal(shifts.changedVoters, 3);
  assert.deepEqual(shifts.topMove, { from: '1', to: '2', count: 2, fromLabel: 'Tea', toLabel: 'Coffee' });
});

test('changing back to your first answer does not count as a change', () => {
  const options = [{ id: '1', label: 'Yes' }, { id: '2', label: 'No' }];
  const shifts = voteShifts([
    { participantId: 'a', optionId: '1' },
    { participantId: 'a', optionId: '2' },
    { participantId: 'a', optionId: '1' },
  ], options);

  assert.equal(shifts.voters, 1);
  assert.equal(shifts.changedVoters, 0);
  assert.equal(shifts.topMove, null);
});

// --- the endpoint, against a seeded session ----------------------------------

let pool;
let app;
const created = [];

before(async () => {
  pool = await createTestPool();
  app = createApp({ pool, rateLimits: false });
});
after(async () => {
  await pool.query('DELETE FROM sessions WHERE code = ANY($1)', [created]);
  await pool.end();
});

// Builds a session with 3 participants, one poll with a changed vote, and
// two questions, one of them hidden.
async function seed() {
  const s = (await request(app).post('/api/sessions').send({ title: 'Club Q&A', hostName: 'Jun' })).body;
  created.push(s.code);
  const auth = { Authorization: `Bearer ${s.hostToken}` };
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  for (const id of ids) {
    await request(app).post(`/api/sessions/${s.code}/join`).set('X-Participant-Id', id);
  }

  const poll = (await request(app).post(`/api/sessions/${s.code}/polls`)
    .set(auth).send({ question: 'Tea or coffee?', options: ['Tea', 'Coffee'] })).body.poll;
  const [tea, coffee] = poll.options;

  const vote = (id, optionId) => request(app).put(`/api/polls/${poll.id}/vote`)
    .set('X-Participant-Id', id).send({ optionId });
  await vote(ids[0], tea.id);
  await vote(ids[1], tea.id);
  await vote(ids[0], coffee.id); // changed their mind

  const ask = (id, body) => request(app).post(`/api/sessions/${s.code}/questions`)
    .set('X-Participant-Id', id).send({ body });
  const shown = (await ask(ids[0], 'Will there be snacks?')).body.question;
  const hidden = (await ask(ids[1], 'Please hide this one')).body.question;
  await request(app).post(`/api/questions/${hidden.id}/hide`).set(auth).send({ hidden: true });

  return { s, auth, ids, poll, tea, coffee, shown };
}

test('the recap of a seeded session reports numbers that match what happened', async () => {
  const { s, auth, tea, coffee, shown } = await seed();
  await request(app).post(`/api/sessions/${s.code}/end`).set(auth);

  const res = await request(app).get(`/api/sessions/${s.code}/recap`);
  assert.equal(res.status, 200);
  const { session, stats, timeline, polls, questions } = res.body;

  assert.equal(session.status, 'ended');
  assert.equal(session.title, 'Club Q&A');
  // 3 joined; 2 of them voted or asked.
  assert.equal(stats.participants, 3);
  assert.equal(stats.engaged, 2);
  assert.equal(stats.participationRate, 67);
  // Two final votes, three vote actions, because one person changed.
  assert.equal(stats.votesCast, 2);
  assert.equal(stats.voteActions, 3);
  assert.equal(stats.questionsAsked, 2);
  assert.equal(stats.questionsVisible, 1);
  assert.equal(stats.polls, 1);

  // One poll: Tea 1, Coffee 1, with one voter having moved Tea -> Coffee.
  assert.equal(polls.length, 1);
  const byId = Object.fromEntries(polls[0].options.map((o) => [o.id, o.votes]));
  assert.equal(byId[tea.id], 1);
  assert.equal(byId[coffee.id], 1);
  assert.equal(polls[0].shifts.voters, 2);
  assert.equal(polls[0].shifts.changedVoters, 1);
  assert.equal(polls[0].shifts.topMove.fromLabel, 'Tea');
  assert.equal(polls[0].shifts.topMove.toLabel, 'Coffee');

  // The hidden question is absent, and the visible one is there.
  assert.deepEqual(questions.map((q) => q.body), [shown.body]);

  // Everything happened within a second, so it all lands in one bucket.
  assert.equal(timeline.bucketMinutes, 1);
  assert.equal(timeline.buckets.length, 1);
  assert.equal(timeline.buckets[0].votes, 3);
  assert.equal(timeline.buckets[0].questions, 2);
});

test('a live session has a recap too, ending at now', async () => {
  const { s } = await seed();
  const res = await request(app).get(`/api/sessions/${s.code}/recap`);
  assert.equal(res.status, 200);
  assert.equal(res.body.session.status, 'live');
  assert.equal(res.body.session.endedAt, null);
  assert.ok(res.body.timeline.endedAt, 'the timeline still needs an end to measure against');
  assert.equal(res.body.stats.votesCast, 2);
});

test('the recap never exposes the host token or hidden questions', async () => {
  const { s } = await seed();
  const res = await request(app).get(`/api/sessions/${s.code}/recap`);
  const body = JSON.stringify(res.body);
  assert.ok(!body.includes('hostToken'));
  assert.ok(!body.includes('host_token_hash'));
  assert.ok(!body.includes('Please hide this one'));
});

test('an unknown or malformed code returns 404', async () => {
  assert.equal((await request(app).get('/api/sessions/ZZZZZ2/recap')).status, 404);
  assert.equal((await request(app).get('/api/sessions/nope/recap')).status, 404);
});

test('a session with no activity reports zeroes rather than failing', async () => {
  const s = (await request(app).post('/api/sessions').send({ title: 'Nobody came' })).body;
  created.push(s.code);
  const res = await request(app).get(`/api/sessions/${s.code}/recap`);

  assert.equal(res.status, 200);
  assert.equal(res.body.stats.participants, 0);
  assert.equal(res.body.stats.participationRate, null);
  assert.equal(res.body.stats.votesCast, 0);
  assert.deepEqual(res.body.polls, []);
  assert.deepEqual(res.body.questions, []);
  assert.equal(res.body.timeline.buckets.length, 1);
});
