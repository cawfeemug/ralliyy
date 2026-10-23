import { endIdleSessions } from '../lifecycle.js';

const EVERY_MS = 10 * 60 * 1000;

// Runs at startup and then every 10 minutes. With one app instance (our
// Railway setup) it runs once at a time; even if two instances ran it, the
// single UPDATE in endIdleSessions ends each session only once.
export function startAutoEnd({ pool, realtime, everyMs = EVERY_MS, log = console }) {
  async function run() {
    try {
      const codes = await endIdleSessions(pool);
      for (const code of codes) realtime.sessionEnded(code);
      if (codes.length) log.log(`Auto-ended ${codes.length} idle session(s)`);
    } catch (err) {
      log.error('auto-end failed', err);
    }
  }
  run();
  const timer = setInterval(run, everyMs);
  timer.unref(); // never keeps the process alive on shutdown
  return { stop: () => clearInterval(timer) };
}
