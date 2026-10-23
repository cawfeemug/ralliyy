// Real-time connection. The server only pushes; this module never sends
// anything except "session:join".
import { io } from '/socket.io/socket.io.esm.min.js';

const EVENTS = [
  'poll:opened', 'poll:results', 'poll:closed', 'session:participants',
  'question:new', 'question:upvotes', 'question:hidden',
];

// onResync: fetch full state again (called after every connect, including
// reconnects, because events sent while offline were missed).
// onEvent(name, data): apply one pushed change.
// onStatus('live' | 'reconnecting'): drive the reconnecting banner.
export function connectLive({ code, hostToken, onResync, onEvent, onStatus }) {
  const socket = io();

  socket.on('connect', () => {
    socket.emit('session:join', { code, hostToken }, (reply) => {
      if (reply?.ok) {
        onStatus('live');
        onResync();
      }
    });
  });
  socket.on('disconnect', () => onStatus('reconnecting'));
  for (const name of EVENTS) socket.on(name, (data) => onEvent(name, data));
  return socket;
}

// Applies a poll event to a list of polls in place. Shared by both pages so
// they always agree on what an event means.
export function applyPollEvent(polls, name, data) {
  if (name === 'poll:opened') {
    if (!polls.some((p) => p.id === data.id)) polls.push(data);
    return;
  }
  const poll = polls.find((p) => p.id === data.pollId);
  if (!poll) return;
  if (name === 'poll:closed') poll.status = 'closed';
  if (name === 'poll:results' || name === 'poll:closed') {
    for (const { optionId, votes } of data.counts) {
      const option = poll.options.find((o) => o.id === optionId);
      if (option) option.votes = votes;
    }
    poll.totalVotes = data.totalVotes;
  }
}

// The poll to show: the open one, otherwise the most recent closed one.
export const currentPoll = (polls) => polls.find((p) => p.status === 'open') ?? polls.at(-1) ?? null;

// Applies a question event to a list of questions in place. Hidden
// questions stay in the list with hidden = true; each page decides whether
// to show them. Returns the affected question, or null if it isn't in the
// list (for example a question unhidden that this page never saw).
export function applyQuestionEvent(questions, name, data) {
  if (name === 'question:new') {
    const known = questions.find((q) => q.id === data.id);
    if (known) return known;
    questions.push(data);
    return data;
  }
  const question = questions.find((q) => q.id === data.questionId);
  if (!question) return null;
  if (name === 'question:upvotes') question.upvotes = data.count;
  if (name === 'question:hidden') question.hidden = data.hidden;
  return question;
}

// Same order as the server: most upvoted, then newest, then by id. A total
// order, so cards only move when a count really changes.
export function sortQuestions(questions) {
  return [...questions].sort((a, b) => b.upvotes - a.upvotes
    || Date.parse(b.createdAt) - Date.parse(a.createdAt)
    || Number(b.id) - Number(a.id));
}
