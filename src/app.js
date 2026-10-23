import express from 'express';
import { fileURLToPath } from 'node:url';

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));

// Builds the Express app without starting a server, so tests can pass in
// their own pool and call it through Supertest.
export function createApp({ pool }) {
  const app = express();
  app.disable('x-powered-by');

  // Used by Docker and Railway to check the app is alive and can reach the
  // database.
  app.get('/healthz', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ok', db: 'ok' });
    } catch {
      res.status(503).json({ status: 'error', db: 'unreachable' });
    }
  });

  app.use(express.static(PUBLIC_DIR));

  return app;
}
