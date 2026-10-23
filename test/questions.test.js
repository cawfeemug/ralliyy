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
  const res = await request(app).post('/api/sessions').send({ title: 'Q&A tests' });
  created.push(res.body.code);
  return res.body;
}
const auth = (s) => ({ Authorization: `Bearer ${s.hostToken}` });
async function joined(s) {
  const pid = randomUUID();
  await request(app).post(`/api/sessions/${s.code}/join`).set('X-Participant-Id', pid);
  return pid;
}
const ask = (s, pid, body) =>
  request(app).post(`/api/sessions/${s.code}/questions`).set('X-Participant-Id', pid).send({ body });
const upvote = (id, pid) => request(app).put(`/api/questions/${id}/upvote`).set('X-Participant-Id', pid);
const unupvote = (id, pid) => request(app).delete(`/api/questions/${id}/upvote`).set('X-Participant-Id', pid);
const hide = (s, id, hidden, headers = auth(s)) =>
  request(app).post(`/api/questions/${id}/hide`).set(headers).send({ hidden });
const stateFor = (s, { pid, host } = {}) => {
  const req = request(app).get(`/api/sessions/${s.code}`);
  if (pid) req.set('X-Participant-Id', pid);
  if (host) req.set(auth(s));
  return req;
};

test('a participant posts a question and it is marked as theirs', async () => {
  const s = await newSession();
  const pid = await joined(s);
  const res = await ask(s, pid, '  How will we measure progress?  ');
  assert.equal(res.status, 201);
  assert.equal(res.body.question.body, 'How will we measure progress?');
  assert.equal(res.body.question.mine, true);
  assert.equal(res.body.question.upvotes, 0);
  assert.equal(res.body.question.hidden, false);

  const other = await joined(s);
  const [mine] = (await stateFor(s, { pid })).body.questions;
  const [theirs] = (await stateFor(s, { pid: other })).body.questions;
  assert.equal(mine.mine, true);
  assert.equal(theirs.mine, false);
  assert.equal('participantId' in theirs, false);
});

test('question length is limited to 280 characters', async () => {
  const s = await newSession();
  const pid = await joined(s);
  assert.equal((await ask(s, pid, 'x'.repeat(280))).status, 201);
  assert.equal((await ask(s, pid, 'x'.repeat(281))).status, 400);
  assert.equal((await ask(s, pid, '   ')).status, 400);
  assert.equal((await ask(s, pid, 42)).status, 400);
  // Counted in characters, not bytes: 280 emoji are allowed.
  assert.equal((await ask(s, pid, '🙂'.repeat(280))).status, 201);
});

test('posting needs a joined participant and a live session', async () => {
  const s = await newSession();
  assert.equal((await ask(s, 'not-a-uuid', 'Hi?')).status, 400);
  assert.equal((await ask(s, randomUUID(), 'Hi?')).status, 403);
  assert.equal((await request(app).post('/api/sessions/ZZZZZ2/questions')
    .set('X-Participant-Id', randomUUID()).send({ body: 'Hi?' })).status, 404);

  const pid = await joined(s);
  await pool.query("UPDATE sessions SET status = 'ended', ended_at = now() WHERE code = $1", [s.code]);
  assert.equal((await ask(s, pid, 'Too late?')).status, 410);
});

test('upvotes are one per participant and can be removed', async () => {
  const s = await newSession();
  const author = await joined(s);
  const fan = await joined(s);
  const { body: { question } } = await ask(s, author, 'Upvote me?');

  let res = await upvote(question.id, fan);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { questionId: question.id, upvoted: true, upvotes: 1 });
  // A duplicate upvote changes nothing.
  res = await upvote(question.id, fan);
  assert.equal(res.status, 200);
  assert.equal(res.body.upvotes, 1);
  assert.equal((await upvote(question.id, author)).body.upvotes, 2);

  const [seen] = (await stateFor(s, { pid: fan })).body.questions;
  assert.equal(seen.upvotes, 2);
  assert.equal(seen.upvoted, true);

  res = await unupvote(question.id, fan);
  assert.deepEqual(res.body, { questionId: question.id, upvoted: false, upvotes: 1 });
  assert.equal((await unupvote(question.id, fan)).body.upvotes, 1);
  assert.equal((await stateFor(s, { pid: fan })).body.questions[0].upvoted, false);
});

test('upvote errors: unknown question 404, not joined 403', async () => {
  const s = await newSession();
  const pid = await joined(s);
  const { body: { question } } = await ask(s, pid, 'Q?');
  assert.equal((await upvote('999999999', pid)).status, 404);
  assert.equal((await upvote('abc', pid)).status, 404);
  assert.equal((await upvote(question.id, randomUUID())).status, 403);
});

test('many participants upvoting at once are each counted once', async () => {
  const s = await newSession();
  const author = await joined(s);
  const { body: { question } } = await ask(s, author, 'Popular?');
  const pids = await Promise.all(Array.from({ length: 30 }, () => joined(s)));
  // Every participant upvotes twice, all at the same time.
  await Promise.all([...pids, ...pids].map((pid) => upvote(question.id, pid)));
  assert.equal((await stateFor(s, { pid: author })).body.questions[0].upvotes, 30);
});

test('questions are sorted by upvotes, then newest first', async () => {
  const s = await newSession();
  const pid = await joined(s);
  const a = (await ask(s, pid, 'First')).body.question;
  const b = (await ask(s, pid, 'Second')).body.question;
  const c = (await ask(s, pid, 'Third')).body.question;
  await upvote(a.id, pid);
  const order = (await stateFor(s, { pid })).body.questions.map((q) => q.id);
  assert.deepEqual(order, [a.id, c.id, b.id]);
});

test('hidden questions are left out for participants but shown to the host', async () => {
  const s = await newSession();
  const pid = await joined(s);
  const { body: { question } } = await ask(s, pid, 'Off topic?');
  await ask(s, pid, 'On topic?');

  const res = await hide(s, question.id, true);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { questionId: question.id, hidden: true });

  const participantView = (await stateFor(s, { pid })).body.questions;
  assert.deepEqual(participantView.map((q) => q.body), ['On topic?']);
  // Without any headers (for example the public page) it's hidden too.
  assert.equal((await stateFor(s)).body.questions.length, 1);
  const hostView = (await stateFor(s, { host: true })).body.questions;
  assert.equal(hostView.length, 2);
  assert.equal(hostView.find((q) => q.id === question.id).hidden, true);

  // Participants can't upvote what they can't see.
  assert.equal((await upvote(question.id, pid)).status, 404);

  await hide(s, question.id, false);
  assert.equal((await stateFor(s, { pid })).body.questions.length, 2);
});

test('hiding needs the host token and a boolean', async () => {
  const s = await newSession();
  const pid = await joined(s);
  const { body: { question } } = await ask(s, pid, 'Hide me?');
  assert.equal((await hide(s, question.id, true, {})).status, 401);
  assert.equal((await hide(s, question.id, true, { Authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await hide(s, question.id, 'yes')).status, 400);
  assert.equal((await hide(s, '999999999', true)).status, 404);

  // Another session's host token doesn't work either.
  const other = await newSession();
  assert.equal((await hide(s, question.id, true, auth(other))).status, 401);
});
