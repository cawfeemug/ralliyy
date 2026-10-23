import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
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
  const res = await request(app).post('/api/sessions').send({ title: 'Poll tests' });
  created.push(res.body.code);
  return res.body;
}
const auth = (s) => ({ Authorization: `Bearer ${s.hostToken}` });
const createPoll = (s, body = { question: 'Lunch?', options: ['Pizza', 'Sushi', 'Salad'] }, headers = auth(s)) =>
  request(app).post(`/api/sessions/${s.code}/polls`).set(headers).send(body);
async function joined(s) {
  const pid = randomUUID();
  await request(app).post(`/api/sessions/${s.code}/join`).set('X-Participant-Id', pid);
  return pid;
}
const vote = (pollId, pid, optionId) =>
  request(app).put(`/api/polls/${pollId}/vote`).set('X-Participant-Id', pid).send({ optionId });

test('host creates and opens a poll', async () => {
  const s = await newSession();
  const res = await createPoll(s);
  assert.equal(res.status, 201);
  assert.equal(res.body.poll.status, 'open');
  assert.equal(res.body.poll.number, 1);
  assert.deepEqual(res.body.poll.options.map((o) => o.label), ['Pizza', 'Sushi', 'Salad']);
});

test('creating a poll needs the host token', async () => {
  const s = await newSession();
  assert.equal((await createPoll(s, undefined, {})).status, 401);
  assert.equal((await createPoll(s, undefined, { Authorization: 'Bearer wrong' })).status, 401);
});

test('poll input is validated', async () => {
  const s = await newSession();
  const bad = [
    { question: '', options: ['a', 'b'] },
    { question: 'x'.repeat(201), options: ['a', 'b'] },
    { question: 'Q', options: ['only one'] },
    { question: 'Q', options: ['1', '2', '3', '4', '5', '6', '7'] },
    { question: 'Q', options: ['a', ''] },
    { question: 'Q', options: ['a', 'x'.repeat(81)] },
    { question: 'Q', options: ['Same', 'same'] },
    { question: 'Q', options: 'a,b' },
  ];
  for (const body of bad) {
    assert.equal((await createPoll(s, body)).status, 400, JSON.stringify(body));
  }
});

test('a second open poll is rejected with 409 until the first closes', async () => {
  const s = await newSession();
  const first = await createPoll(s);
  assert.equal((await createPoll(s)).status, 409);
  const close = await request(app).post(`/api/polls/${first.body.poll.id}/close`).set(auth(s));
  assert.equal(close.status, 200);
  assert.equal((await request(app).post(`/api/polls/${first.body.poll.id}/close`).set(auth(s))).status, 409);
  const second = await createPoll(s);
  assert.equal(second.status, 201);
  assert.equal(second.body.poll.number, 2);
});

test('two simultaneous launches open exactly one poll', async () => {
  const s = await newSession();
  const results = await Promise.all([createPoll(s), createPoll(s), createPoll(s)]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409, 409]);
});

test('closing needs the host token and an existing poll', async () => {
  const s = await newSession();
  const { body } = await createPoll(s);
  assert.equal((await request(app).post(`/api/polls/${body.poll.id}/close`)).status, 401);
  assert.equal((await request(app).post('/api/polls/999999999/close').set(auth(s))).status, 404);
  assert.equal((await request(app).post('/api/polls/abc/close').set(auth(s))).status, 404);
});

test('voting, changing a vote and the vote history', async () => {
  const s = await newSession();
  const { body: { poll } } = await createPoll(s);
  const [pizza, sushi] = poll.options;
  const pid = await joined(s);

  const first = await vote(poll.id, pid, pizza.id);
  assert.equal(first.status, 200);
  assert.equal(first.body.totalVotes, 1);
  assert.equal(first.body.counts.find((c) => c.optionId === pizza.id).votes, 1);

  // Changing moves the single vote; it never counts twice.
  const changed = await vote(poll.id, pid, sushi.id);
  assert.equal(changed.body.totalVotes, 1);
  assert.equal(changed.body.counts.find((c) => c.optionId === sushi.id).votes, 1);
  assert.equal(changed.body.counts.find((c) => c.optionId === pizza.id).votes, 0);

  // Re-sending the same choice is not a new event.
  await vote(poll.id, pid, sushi.id);
  const events = await pool.query('SELECT option_id FROM vote_events WHERE poll_id = $1 ORDER BY id', [poll.id]);
  assert.deepEqual(events.rows.map((r) => r.option_id), [pizza.id, sushi.id]);
});

test('vote errors: closed poll, foreign option, not joined, bad input', async () => {
  const s = await newSession();
  const { body: { poll: first } } = await createPoll(s);
  const pid = await joined(s);
  await request(app).post(`/api/polls/${first.id}/close`).set(auth(s));
  assert.equal((await vote(first.id, pid, first.options[0].id)).status, 409);

  const { body: { poll: second } } = await createPoll(s);
  assert.equal((await vote(second.id, pid, first.options[0].id)).status, 400);
  assert.equal((await vote(second.id, randomUUID(), second.options[0].id)).status, 403);
  assert.equal((await vote(second.id, pid, 'nope')).status, 400);
  assert.equal((await vote('999999999', pid, second.options[0].id)).status, 404);
  assert.equal((await request(app).put(`/api/polls/${second.id}/vote`).send({ optionId: second.options[0].id })).status, 400);
});

test('50 participants voting at once are all counted exactly once', async () => {
  const s = await newSession();
  const { body: { poll } } = await createPoll(s);
  const pids = await Promise.all(Array.from({ length: 50 }, () => joined(s)));
  const results = await Promise.all(pids.map((pid, i) => vote(poll.id, pid, poll.options[i % 3].id)));
  assert.ok(results.every((r) => r.status === 200));
  const state = await request(app).get(`/api/sessions/${s.code}`);
  const counts = state.body.polls[0].options.map((o) => o.votes);
  assert.deepEqual(counts, [17, 17, 16]);
  assert.equal(state.body.polls[0].totalVotes, 50);
});

test('session state includes polls and this browser\'s votes', async () => {
  const s = await newSession();
  const { body: { poll } } = await createPoll(s);
  const pid = await joined(s);
  await vote(poll.id, pid, poll.options[1].id);

  const mine = await request(app).get(`/api/sessions/${s.code}`).set('X-Participant-Id', pid);
  assert.equal(mine.body.polls.length, 1);
  assert.deepEqual(mine.body.myVotes, { [poll.id]: poll.options[1].id });
  const anon = await request(app).get(`/api/sessions/${s.code}`);
  assert.deepEqual(anon.body.myVotes, {});
});

test('polls cannot be created in an ended session', async () => {
  const s = await newSession();
  await pool.query("UPDATE sessions SET status = 'ended', ended_at = now() WHERE code = $1", [s.code]);
  assert.equal((await createPoll(s)).status, 410);
});
