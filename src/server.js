import http from 'node:http';
import { createApp } from './app.js';
import { createPool } from './db.js';
import { migrate } from './migrate.js';

const PORT = Number(process.env.PORT) || 3000;

const pool = createPool();
await migrate(pool);

const app = createApp({ pool });
// A plain http server wraps Express so Socket.IO can attach to it later.
const server = http.createServer(app);

server.listen(PORT, () => {
  console.log(`Ralliyy listening on port ${PORT}`);
});

// Docker and Railway send SIGTERM before stopping the container. Finish
// in-flight requests and close database connections instead of dying mid-query.
function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
  // Force exit if something keeps the server open too long.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
