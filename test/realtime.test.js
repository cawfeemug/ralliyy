import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { io as connect } from 'socket.io-client';
import { createApp } from '../src/app.js';
import { createRealtime } from '../src/realtime.js';
import { createTestPool } from './helpers.js';

// A real HTTP + Socket.IO server on a random port, as in production.
let pool;
let server;
let realtime;
let url;
const sockets = [];
const created = [];

before(async () => {
  pool = await createTestPool();
  realtime = createRealtime({ pool });
  server = http.createServer(createApp({ pool, realtime }));
  realtime.attach(server);
  await new Promise((resolve) => server.listen(0, resolve));
  url = `http://localhost:${server.address().port}`;
});
after(async () => {
  for (const s of sockets) s.disconnect();
  realtime.close();
  await new Promise((resolve) => server.close(resolve));
  await pool.query('DELETE FROM sessions WHERE code = ANY($1)', [created]);
  await pool.end();
});

function client() {
  const socket = connect(url, { transports: ['websocket'], forceNew: true });
  sockets.push(socket);
  return socket;
}
const joinRoom = (socket, payload) => new Promise((resolve) => socket.emit('session:join', payload, resolve));
const next = (socket, event, ms = 2000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`no ${event} within ${ms} ms`)), ms);
  socket.once(event, (data) => { clearTimeout(timer); resolve(data); });
});

async function setup() {
  const s = (await request(server).post('/api/sessions').send({ title: 'Live test' })).body;
  created.push(s.code);
  return s;
}
const joinSession = async (s) => {
  const pid = randomUUID();
  await request(server).post(`/api/sessions/${s.code}/join`).set('X-Participant-Id', pid);
  return pid;
};

test('session:join acks, recognises the host and rejects unknown codes', async () => {
  const s = await setup();
  const a = client();
  assert.deepEqual(await joinRoom(a, { code: s.code }), { ok: true, isHost: false });
  assert.deepEqual(await joinRoom(a, { code: s.code, hostToken: s.hostToken }), { ok: true, isHost: true });
  assert.equal((await joinRoom(a, { code: 'ZZZZZ2' })).ok, false);
  assert.equal((await joinRoom(a, null)).ok, false);
});

test('a vote on one client reaches the other as poll:results', async () => {
  const s = await setup();
  const voter = client();
  const watcher = client();
  await joinRoom(voter, { code: s.code });
  await joinRoom(watcher, { code: s.code });

  const opened = next(watcher, 'poll:opened');
  const { body: { poll } } = await request(server).post(`/api/sessions/${s.code}/polls`)
    .set('Authorization', `Bearer ${s.hostToken}`).send({ question: 'Tea or coffee?', options: ['Tea', 'Coffee'] });
  assert.equal((await opened).id, poll.id);

  const pid = await joinSession(s);
  const results = next(watcher, 'poll:results');
  await request(server).put(`/api/polls/${poll.id}/vote`).set('X-Participant-Id', pid).send({ optionId: poll.options[1].id });
  const update = await results;
  assert.equal(update.pollId, poll.id);
  assert.equal(update.totalVotes, 1);
  assert.equal(update.counts.find((c) => c.optionId === poll.options[1].id).votes, 1);

  const closed = next(watcher, 'poll:closed');
  await request(server).post(`/api/polls/${poll.id}/close`).set('Authorization', `Bearer ${s.hostToken}`);
  assert.equal((await closed).totalVotes, 1);
});

test('a burst of votes is throttled into few broadcasts with the final counts', async () => {
  const s = await setup();
  const watcher = client();
  await joinRoom(watcher, { code: s.code });
  const { body: { poll } } = await request(server).post(`/api/sessions/${s.code}/polls`)
    .set('Authorization', `Bearer ${s.hostToken}`).send({ question: 'Burst?', options: ['A', 'B'] });
  const pids = await Promise.all(Array.from({ length: 20 }, () => joinSession(s)));

  const updates = [];
  watcher.on('poll:results', (u) => updates.push(u));
  await Promise.all(pids.map((pid) =>
    request(server).put(`/api/polls/${poll.id}/vote`).set('X-Participant-Id', pid).send({ optionId: poll.options[0].id })));
  await new Promise((r) => setTimeout(r, 700));

  assert.ok(updates.length >= 1 && updates.length <= 3, `got ${updates.length} broadcasts`);
  assert.equal(updates.at(-1).totalVotes, 20);
});

test('only the host room hears the participant count', async () => {
  const s = await setup();
  const host = client();
  const guest = client();
  await joinRoom(host, { code: s.code, hostToken: s.hostToken });
  await joinRoom(guest, { code: s.code, hostToken: 'wrong' });
  let guestHeard = false;
  guest.on('session:participants', () => { guestHeard = true; });

  const count = next(host, 'session:participants');
  await joinSession(s);
  assert.deepEqual(await count, { count: 1 });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(guestHeard, false);
});

test('after reconnecting, a client rejoins and receives later events', async () => {
  const s = await setup();
  const socket = client();
  await joinRoom(socket, { code: s.code });
  socket.disconnect();

  // While it was away, a poll opened; the GET it does on reconnect shows it.
  await request(server).post(`/api/sessions/${s.code}/polls`)
    .set('Authorization', `Bearer ${s.hostToken}`).send({ question: 'Missed?', options: ['Yes', 'No'] });
  socket.connect();
  await joinRoom(socket, { code: s.code });
  const state = await request(server).get(`/api/sessions/${s.code}`);
  assert.equal(state.body.polls[0].question, 'Missed?');

  const closed = next(socket, 'poll:closed');
  await request(server).post(`/api/polls/${state.body.polls[0].id}/close`).set('Authorization', `Bearer ${s.hostToken}`);
  assert.equal((await closed).pollId, state.body.polls[0].id);
});

test('questions, upvotes and hiding reach other clients live', async () => {
  const s = await setup();
  const host = client();
  const watcher = client();
  await joinRoom(host, { code: s.code, hostToken: s.hostToken });
  await joinRoom(watcher, { code: s.code });
  const pid = await joinSession(s);

  const posted = next(watcher, 'question:new');
  const hostPosted = next(host, 'question:new');
  const { body: { question } } = await request(server).post(`/api/sessions/${s.code}/questions`)
    .set('X-Participant-Id', pid).send({ body: 'Live question?' });
  const seen = await posted;
  assert.equal(seen.id, question.id);
  assert.equal(seen.body, 'Live question?');
  assert.equal(seen.mine, false); // the broadcast never says who asked
  assert.equal((await hostPosted).id, question.id);

  const upvotes = next(watcher, 'question:upvotes');
  await request(server).put(`/api/questions/${question.id}/upvote`).set('X-Participant-Id', pid);
  assert.deepEqual(await upvotes, { questionId: question.id, count: 1 });

  // The host is in both rooms but hears the event once.
  let hostHeard = 0;
  host.on('question:hidden', () => { hostHeard += 1; });
  const hidden = next(watcher, 'question:hidden');
  await request(server).post(`/api/questions/${question.id}/hide`)
    .set('Authorization', `Bearer ${s.hostToken}`).send({ hidden: true });
  assert.deepEqual(await hidden, { questionId: question.id, hidden: true });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(hostHeard, 1);
});

test('ending and deleting a session reach everyone in it', async () => {
  const s = await setup();
  const watcher = client();
  await joinRoom(watcher, { code: s.code });

  const ended = next(watcher, 'session:ended');
  await request(server).post(`/api/sessions/${s.code}/end`).set('Authorization', `Bearer ${s.hostToken}`);
  assert.deepEqual(await ended, { resultsUrl: `/r/${s.code}` });

  const deleted = next(watcher, 'session:deleted');
  await request(server).delete(`/api/sessions/${s.code}`).set('Authorization', `Bearer ${s.hostToken}`);
  await deleted;
});
