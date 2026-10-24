import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createTestPool } from './helpers.js';

let pool;
before(async () => { pool = await createTestPool(); });
after(async () => { await pool.end(); });

test('GET /livez answers without touching the database', async () => {
  const noDbPool = { query: async () => { throw new Error('should not be called'); } };
  const res = await request(createApp({ pool: noDbPool, rateLimits: false })).get('/livez');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { status: 'ok' });
});

test('GET /healthz reports ok when the database answers', async () => {
  const res = await request(createApp({ pool, rateLimits: false })).get('/healthz');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { status: 'ok', db: 'ok' });
});

test('GET /healthz returns 503 when the database is unreachable', async () => {
  const brokenPool = { query: async () => { throw new Error('connection refused'); } };
  const res = await request(createApp({ pool: brokenPool, rateLimits: false })).get('/healthz');
  assert.equal(res.status, 503);
  assert.equal(res.body.db, 'unreachable');
});

test('static home page is served', async () => {
  const res = await request(createApp({ pool, rateLimits: false })).get('/');
  assert.equal(res.status, 200);
  assert.match(res.text, /Ralliyy/);
});
