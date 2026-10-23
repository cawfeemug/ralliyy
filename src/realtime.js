import { Server } from 'socket.io';
import { tokenMatches } from './auth.js';
import { getPollCounts } from './polls.js';
import { parseCode } from './validate.js';

// Collect a burst of votes into one results broadcast at most this often.
const RESULTS_THROTTLE_MS = 250;

// Socket.IO is used only for server-to-browser broadcasts. Every action a
// user takes is a REST call; after the database write succeeds, the route
// calls one of the functions below to tell everyone else.
//
// Rooms: "s:CODE" holds everyone viewing a session; "h:CODE" holds only
// sockets that proved they have the host token.
export function createRealtime({ pool }) {
  let io = null;
  const pendingResults = new Map(); // pollId -> timer

  const emit = (room, event, payload) => io?.to(room).emit(event, payload);

  function attach(httpServer) {
    io = new Server(httpServer, {
      serveClient: true, // serves /socket.io/socket.io.esm.min.js to browsers
      maxHttpBufferSize: 1e4, // clients only ever send tiny messages
    });

    io.on('connection', (socket) => {
      socket.on('session:join', async (payload, ack) => {
        const reply = typeof ack === 'function' ? ack : () => {};
        try {
          const code = parseCode(payload?.code);
          if (!code) return reply({ ok: false, error: 'not_found' });
          const { rows } = await pool.query('SELECT host_token_hash FROM sessions WHERE code = $1', [code]);
          if (rows.length === 0) return reply({ ok: false, error: 'not_found' });

          // A socket follows one session at a time; leave any earlier rooms.
          for (const room of socket.rooms) {
            if (room !== socket.id) socket.leave(room);
          }
          socket.join(`s:${code}`);
          const isHost = tokenMatches(payload?.hostToken, rows[0].host_token_hash);
          if (isHost) socket.join(`h:${code}`);
          reply({ ok: true, isHost });
        } catch (err) {
          console.error('session:join failed', err);
          reply({ ok: false, error: 'server_error' });
        }
      });
    });
    return io;
  }

  return {
    attach,
    close: () => io?.close(),

    pollOpened(code, poll) {
      emit(`s:${code}`, 'poll:opened', poll);
    },

    // Called after every vote. Instead of one broadcast per vote, wait up to
    // 250 ms and send a single update. Counts are read from the database at
    // send time, so the update is never stale even if votes arrived while
    // we waited.
    pollVoted(code, pollId) {
      if (pendingResults.has(pollId)) return;
      const timer = setTimeout(async () => {
        pendingResults.delete(pollId);
        try {
          const counts = await getPollCounts(pool, pollId);
          emit(`s:${code}`, 'poll:results', { pollId, ...counts });
        } catch (err) {
          console.error('poll:results failed', err);
        }
      }, RESULTS_THROTTLE_MS);
      pendingResults.set(pollId, timer);
    },

    pollClosed(code, pollId, counts) {
      // Final counts go out now; drop any throttled update still waiting.
      clearTimeout(pendingResults.get(pollId));
      pendingResults.delete(pollId);
      emit(`s:${code}`, 'poll:closed', { pollId, ...counts });
    },

    participants(code, count) {
      emit(`h:${code}`, 'session:participants', { count });
    },
  };
}

// For tests that exercise REST routes without sockets.
export const noRealtime = {
  attach() {}, close() {}, pollOpened() {}, pollVoted() {}, pollClosed() {}, participants() {},
};
