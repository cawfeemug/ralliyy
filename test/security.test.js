import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createTestPool } from './helpers.js';

let pool;
const created = [];

before(async () => { pool = await createTestPool(); });
after(async () => {
  await pool.query('DELETE FROM sessions WHERE code = ANY($1)', [created]);
  await pool.end();
});

// Parses "a 'b'; c d" into { a: ["'b'"], c: ['d'] }.
function parseCsp(header) {
  return Object.fromEntries(header.split(';').map((part) => {
    const [name, ...values] = part.trim().split(/\s+/);
    return [name, values];
  }));
}

test('pages carry a content security policy that fits what they load', async () => {
  const app = createApp({ pool, baseUrl: 'https://ralliyy.onrender.com', rateLimits: false });
  const res = await request(app).get('/');
  assert.equal(res.status, 200);

  const csp = parseCsp(res.headers['content-security-policy']);
  // Google Fonts: the stylesheet and the font files it points at.
  assert.ok(csp['style-src'].includes('https://fonts.googleapis.com'));
  assert.ok(csp['font-src'].includes('https://fonts.gstatic.com'));
  // Our own scripts only, and no inline script may run.
  assert.deepEqual(csp['script-src'], ["'self'"]);
  // The Socket.IO connection back to us.
  assert.ok(csp['connect-src'].includes("'self'"));
  assert.ok(csp['connect-src'].includes('wss://ralliyy.onrender.com'));
  // Nobody may frame Ralliyy.
  assert.deepEqual(csp['frame-ancestors'], ["'none'"]);
});

test('the policy leaves out https upgrades and HSTS outside production', async () => {
  const app = createApp({ pool, rateLimits: false });
  const res = await request(app).get('/');
  assert.ok(!('strict-transport-security' in res.headers));
  assert.ok(!res.headers['content-security-policy'].includes('upgrade-insecure-requests'));
});

test('production adds HSTS and upgrades insecure requests', async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const res = await request(createApp({ pool, rateLimits: false })).get('/');
    assert.match(res.headers['strict-transport-security'], /max-age=\d+/);
    assert.ok(res.headers['content-security-policy'].includes('upgrade-insecure-requests'));
  } finally {
    process.env.NODE_ENV = previous;
  }
});

test('responses do not advertise Express and do not sniff content types', async () => {
  const res = await request(createApp({ pool, rateLimits: false })).get('/');
  assert.equal(res.headers['x-powered-by'], undefined);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  // Same refusal as frame-ancestors, for browsers that read this header.
  assert.equal(res.headers['x-frame-options'], 'DENY');
});

test('asking too many questions returns 429 with the usual error shape', async () => {
  const app = createApp({ pool, rateLimits: true });
  const session = (await request(app).post('/api/sessions').send({ title: 'Rate limits' })).body;
  created.push(session.code);
  const participantId = randomUUID();
  await request(app).post(`/api/sessions/${session.code}/join`).set('X-Participant-Id', participantId);

  const ask = () => request(app)
    .post(`/api/sessions/${session.code}/questions`)
    .set('X-Participant-Id', participantId)
    .send({ body: 'Why does the limiter exist?' });

  // The limit is 5 a minute per participant.
  for (let i = 0; i < 5; i += 1) assert.equal((await ask()).status, 201);

  const blocked = await ask();
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error.code, 'rate_limited');
  assert.match(blocked.body.error.message, /wait a moment/i);
  // Draft 7 header, so the browser could tell how long to wait.
  assert.ok(blocked.headers['ratelimit']);
  assert.equal(blocked.headers['x-ratelimit-limit'], undefined);
});

test('one participant hitting the limit does not block another', async () => {
  const app = createApp({ pool, rateLimits: true });
  const session = (await request(app).post('/api/sessions').send({ title: 'Separate buckets' })).body;
  created.push(session.code);

  const noisy = randomUUID();
  const quiet = randomUUID();
  for (const id of [noisy, quiet]) {
    await request(app).post(`/api/sessions/${session.code}/join`).set('X-Participant-Id', id);
  }
  const ask = (id) => request(app)
    .post(`/api/sessions/${session.code}/questions`)
    .set('X-Participant-Id', id)
    .send({ body: 'Does the other person still get through?' });

  for (let i = 0; i < 6; i += 1) await ask(noisy);
  assert.equal((await ask(noisy)).status, 429);
  assert.equal((await ask(quiet)).status, 201);
});

test('reading a session is not rate limited the way writing is', async () => {
  const app = createApp({ pool, rateLimits: true });
  const session = (await request(app).post('/api/sessions').send({ title: 'Reads' })).body;
  created.push(session.code);

  // A phone refetches on every reconnect; 30 reads must stay fine.
  for (let i = 0; i < 30; i += 1) {
    assert.equal((await request(app).get(`/api/sessions/${session.code}`)).status, 200);
  }
});
