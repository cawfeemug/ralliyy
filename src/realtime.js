import { Server } from 'socket.io';
import { tokenMatches } from './auth.js';
import { getPollCounts } from './polls.js';
import { getUpvoteCount } from './questions.js';
import { parseCode } from './validate.js';

// Collect a burst of votes (or upvotes) into one broadcast at most this often.
const RESULTS_THROTTLE_MS = 250;

// Socket.IO is used only for server-to-browser broadcasts. Every action a
// user takes is a REST call; after the database write succeeds, the route
// calls one of the functions below to tell everyone else.
//
// Rooms: "s:CODE" holds everyone viewing a session; "h:CODE" holds only
// sockets that proved they have the host token.
export function createRealtime({ pool }) {
  let io = null;
  const pending = new Map(); // "poll:ID" or "question:ID" -> timer

  const emit = (room, event, payload) => io?.to(room).emit(event, payload);

  // Runs send() once, RESULTS_THROTTLE_MS after the first call for this key;
  // calls in between are folded into that one send. send() reads counts
  // from the database when it runs, so the broadcast is never stale even if
  // more changes arrived while we waited.
  function throttle(key, send) {
    if (pending.has(key)) return;
    pending.set(key, setTimeout(async () => {
      pending.delete(key);
      try {
        await send();
      } catch (err) {
        console.error(`${key} broadcast failed`, err);
      }
    }, RESULTS_THROTTLE_MS));
  }

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

    // Called after every vote. Instead of one broadcast per vote, send at
    // most one update every 250 ms with counts read fresh at send time.
    pollVoted(code, pollId) {
      throttle(`poll:${pollId}`, async () => {
        const counts = await getPollCounts(pool, pollId);
        emit(`s:${code}`, 'poll:results', { pollId, ...counts });
      });
    },

    pollClosed(code, pollId, counts) {
      // Final counts go out now; drop any throttled update still waiting.
      clearTimeout(pending.get(`poll:${pollId}`));
      pending.delete(`poll:${pollId}`);
      emit(`s:${code}`, 'poll:closed', { pollId, ...counts });
    },

    participants(code, count) {
      emit(`h:${code}`, 'session:participants', { count });
    },

    // The payload carries the results page path; browsers move there.
    sessionEnded(code) {
      emit(`s:${code}`, 'session:ended', { resultsUrl: `/r/${code}` });
    },

    // Everyone still on the page learns the session is gone, then the
    // server drops their sockets from the session's rooms.
    sessionDeleted(code) {
      emit(`s:${code}`, 'session:deleted', {});
      io?.socketsLeave([`s:${code}`, `h:${code}`]);
    },

    questionPosted(code, question) {
      emit(`s:${code}`, 'question:new', question);
    },

    // Same throttling as votes: a burst of upvotes on one question becomes
    // one update with the count read at send time, so updates can never
    // arrive out of order and show an older count last.
    questionUpvoted(code, questionId) {
      throttle(`question:${questionId}`, async () => {
        const count = await getUpvoteCount(pool, questionId);
        emit(`s:${code}`, 'question:upvotes', { questionId, count });
      });
    },

    // Sent to both rooms, as the spec says. The host's socket is in both,
    // but Socket.IO delivers a multi-room emit once per socket.
    questionHidden(code, questionId, hidden) {
      io?.to([`s:${code}`, `h:${code}`]).emit('question:hidden', { questionId, hidden });
    },
  };
}

// For tests that exercise REST routes without sockets.
export const noRealtime = {
  attach() {}, close() {}, pollOpened() {}, pollVoted() {}, pollClosed() {}, participants() {},
  questionPosted() {}, questionUpvoted() {}, questionHidden() {}, sessionEnded() {}, sessionDeleted() {},
};
