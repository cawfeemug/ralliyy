import express from 'express';
import { fileURLToPath } from 'node:url';
import { createPollsRouter } from './routes/polls.js';
import { createQuestionsRouter } from './routes/questions.js';
import { createSessionsRouter } from './routes/sessions.js';
import { noRealtime } from './realtime.js';
import { HttpError } from './validate.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));
const page = (name) => fileURLToPath(new URL(`../public/${name}`, import.meta.url));

// Builds the Express app without starting a server, so tests can pass in
// their own pool and call it through Supertest.
export function createApp({ pool, realtime = noRealtime, baseUrl = process.env.BASE_URL }) {
  const app = express();
  app.disable('x-powered-by');
  // In production Render's proxy terminates HTTPS and forwards the request.
  // Trusting that one hop makes req.protocol 'https' and req.ip the real
  // client address instead of the proxy's.
  app.set('trust proxy', 1);

  // Liveness: the process is up and serving. Render's health check uses this
  // one because it never touches the database, so Neon can scale to zero.
  app.get('/livez', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Readiness: the app can also reach the database. For manual checks.
  app.get('/healthz', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ok', db: 'ok' });
    } catch {
      res.status(503).json({ status: 'error', db: 'unreachable' });
    }
  });

  // JSON bodies only, capped at 10 KB so nobody can send huge payloads.
  app.use('/api', express.json({ limit: '10kb' }));
  app.use('/api/sessions', createSessionsRouter({ pool, realtime, baseUrl: baseUrl?.replace(/\/$/, '') }));
  app.use('/api', createPollsRouter({ pool, realtime }));
  app.use('/api', createQuestionsRouter({ pool, realtime }));
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: 'Not found' } });
  });

  // Page routes. The pages read the code from the URL and fetch data from
  // the API themselves.
  app.get('/s/:code', (_req, res) => res.sendFile(page('session.html')));
  app.get('/host/:code', (_req, res) => res.sendFile(page('host.html')));
  app.get('/r/:code', (_req, res) => res.sendFile(page('results.html')));

  app.use(express.static(PUBLIC_DIR));

  app.use((_req, res) => res.status(404).sendFile(page('404.html')));

  // Express 5 sends errors thrown in async handlers here.
  app.use((err, _req, res, _next) => {
    // Malformed JSON or a body over the size limit, from express.json().
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { code: 'invalid_json', message: 'Request body is not valid JSON' } });
    }
    if (err.type === 'entity.too.large') {
      return res.status(413).json({ error: { code: 'too_large', message: 'Request body is too large' } });
    }
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message } });
    }
    console.error(err);
    res.status(500).json({ error: { code: 'server_error', message: 'Something went wrong' } });
  });

  return app;
}
