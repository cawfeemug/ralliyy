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
  app = createApp({ pool, baseUrl: 'https://ralliyy.test' });
});
after(async () => {
  await pool.query('DELETE FROM sessions WHERE code = ANY($1)', [created]);
  await pool.end();
});

async function createSession(body = { title: 'Club Q&A', hostName: 'Jun' }) {
  const res = await request(app).post('/api/sessions').send(body);
  assert.equal(res.status, 201);
  created.push(res.body.code);
  return res.body;
}

const join = (code, pid = randomUUID()) =>
  request(app).post(`/api/sessions/${code}/join`).set('X-Participant-Id', pid);

test('without BASE_URL, links use the protocol and host forwarded by the proxy', async () => {
  const behindProxy = createApp({ pool, baseUrl: '' });
  const res = await request(behindProxy).post('/api/sessions')
    .set('X-Forwarded-Proto', 'https')
    .set('Host', 'ralliyy.onrender.com')
    .send({ title: 'Proxy test' });
  assert.equal(res.status, 201);
  created.push(res.body.code);
  assert.equal(res.body.joinUrl, `https://ralliyy.onrender.com/s/${res.body.code}`);
});

test('POST /api/sessions creates a session and returns the host token once', async () => {
  const s = await createSession();
  assert.match(s.code, /^[A-HJKMNP-Z2-9]{6}$/);
  assert.equal(s.hostUrl, `https://ralliyy.test/host/${s.code}#${s.hostToken}`);
  assert.equal(s.joinUrl, `https://ralliyy.test/s/${s.code}`);

  // The token itself is never stored, only its hash.
  const { rows } = await pool.query('SELECT host_token_hash FROM sessions WHERE code = $1', [s.code]);
  assert.notEqual(rows[0].host_token_hash.toString('base64url'), s.hostToken);
});

test('POST /api/sessions validates title and host name', async () => {
  const cases = [
    {},
    { title: '   ' },
    { title: 'x'.repeat(81) },
    { title: 'ok', hostName: 'x'.repeat(41) },
    { title: 42 },
  ];
  for (const body of cases) {
    const res = await request(app).post('/api/sessions').send(body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.error.code, 'invalid_input');
  }
  const ok = await createSession({ title: 'x'.repeat(80) });
  assert.ok(ok.code);
});

test('malformed JSON returns 400 and oversized bodies return 413', async () => {
  const bad = await request(app).post('/api/sessions').set('Content-Type', 'application/json').send('{"title":');
  assert.equal(bad.status, 400);
  const big = await request(app).post('/api/sessions').send({ title: 'x', pad: 'y'.repeat(11_000) });
  assert.equal(big.status, 413);
});

test('GET /api/sessions/:code returns public state and recognises the host', async () => {
  const s = await createSession();
  const pub = await request(app).get(`/api/sessions/${s.code.toLowerCase()}`);
  assert.equal(pub.status, 200);
  assert.equal(pub.body.session.title, 'Club Q&A');
  assert.equal(pub.body.session.hostName, 'Jun');
  assert.equal(pub.body.session.status, 'live');
  assert.equal(pub.body.session.participantCount, 0);
  assert.equal(pub.body.isHost, false);
  assert.equal(JSON.stringify(pub.body).includes('hash'), false);

  const host = await request(app).get(`/api/sessions/${s.code}`).set('Authorization', `Bearer ${s.hostToken}`);
  assert.equal(host.body.isHost, true);
  const wrong = await request(app).get(`/api/sessions/${s.code}`).set('Authorization', 'Bearer nope');
  assert.equal(wrong.body.isHost, false);
});

test('GET /api/sessions/:code returns 404 for unknown or invalid codes', async () => {
  assert.equal((await request(app).get('/api/sessions/ZZZZZ2')).status, 404);
  assert.equal((await request(app).get('/api/sessions/bad')).status, 404);
});

test('join registers a participant once, even when called again', async () => {
  const s = await createSession();
  const pid = randomUUID();
  const first = await join(s.code, pid);
  assert.equal(first.status, 200);
  assert.equal(first.body.participantCount, 1);
  const again = await join(s.code, pid);
  assert.equal(again.body.participantCount, 1);
  const other = await join(s.code);
  assert.equal(other.body.participantCount, 2);
});

test('join rejects a missing or malformed participant ID', async () => {
  const s = await createSession();
  assert.equal((await request(app).post(`/api/sessions/${s.code}/join`)).status, 400);
  assert.equal((await join(s.code, 'not-a-uuid')).status, 400);
});

test('join returns 404 for unknown sessions and 410 for ended ones', async () => {
  assert.equal((await join('ZZZZZ2')).status, 404);
  const s = await createSession();
  await pool.query("UPDATE sessions SET status = 'ended', ended_at = now() WHERE code = $1", [s.code]);
  const res = await join(s.code);
  assert.equal(res.status, 410);
  assert.equal(res.body.error.code, 'ended');
});

test('join returns 409 once 50 participants are in, but returning ones still get in', async () => {
  const s = await createSession();
  const { rows } = await pool.query('SELECT id FROM sessions WHERE code = $1', [s.code]);
  const ids = Array.from({ length: 50 }, () => randomUUID());
  await pool.query(
    'INSERT INTO session_participants (session_id, participant_id) SELECT $1, unnest($2::uuid[])',
    [rows[0].id, ids],
  );
  const full = await join(s.code);
  assert.equal(full.status, 409);
  assert.equal(full.body.error.code, 'full');
  assert.equal((await join(s.code, ids[0])).status, 200);
});

test('60 simultaneous joins admit exactly 50', async () => {
  const s = await createSession();
  const results = await Promise.all(Array.from({ length: 60 }, () => join(s.code)));
  const statuses = results.map((r) => r.status);
  assert.equal(statuses.filter((x) => x === 200).length, 50);
  assert.equal(statuses.filter((x) => x === 409).length, 10);
  const { rows } = await pool.query(
    'SELECT count(*)::int AS n FROM session_participants p JOIN sessions s ON s.id = p.session_id WHERE s.code = $1',
    [s.code],
  );
  assert.equal(rows[0].n, 50);
});

test('QR endpoint returns an SVG for existing sessions only', async () => {
  const s = await createSession();
  const res = await request(app).get(`/api/sessions/${s.code}/qr.svg`);
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /image\/svg\+xml/);
  // Supertest hands image responses back as a Buffer rather than text.
  assert.match(Buffer.from(res.body).toString('utf8'), /<svg/);
  assert.equal((await request(app).get('/api/sessions/ZZZZZ2/qr.svg')).status, 404);
});

test('page routes serve the session, host, results and not-found pages', async () => {
  assert.match((await request(app).get('/s/ABC234')).text, /session\.js/);
  assert.match((await request(app).get('/host/ABC234')).text, /host\.js/);
  assert.match((await request(app).get('/r/ABC234')).text, /results\.js/);
  const missing = await request(app).get('/nope');
  assert.equal(missing.status, 404);
  assert.match(missing.text, /Session not found/);
  assert.equal((await request(app).get('/api/nope')).status, 404);
});
