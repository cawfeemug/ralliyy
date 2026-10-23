import { api } from './api.js';
import { applyPollEvent, connectLive, currentPoll } from './live.js';
import { getParticipantId } from './participant.js';
import { banner, el, emptyState, icon, pollNumber, pollTotals, resultCard, spinner } from './ui.js';

// Participant page: /s/CODE. One state object; render() redraws from it.
const app = document.getElementById('app');
const code = decodeURIComponent(window.location.pathname.split('/')[2] ?? '').toUpperCase();
const participantId = getParticipantId();

const state = {
  view: 'connecting', // connecting | joined | full | ended | notfound | error
  connection: 'live', // live | reconnecting
  session: null,
  polls: [],
  myVotes: {}, // pollId -> optionId
  voting: false,
  voteError: null,
  tab: 'poll', // poll | qa
};

function setState(patch) {
  Object.assign(state, patch);
  render();
}

// Replace local state with the server's. Used on load and after reconnects.
async function resync() {
  const res = await api('GET', `/api/sessions/${code}`, { participantId });
  if (!res.ok) return setState({ view: 'notfound' });
  setState({ session: res.data.session, polls: res.data.polls, myVotes: res.data.myVotes });
}

async function load() {
  setState({ view: 'connecting' });
  try {
    // Joining is safe to repeat, so this also covers reloads and QR scans.
    const join = await api('POST', `/api/sessions/${code}/join`, { participantId });
    if (join.status === 404) return setState({ view: 'notfound' });

    const info = await api('GET', `/api/sessions/${code}`, { participantId });
    if (!info.ok) return setState({ view: 'notfound' });
    const { session, polls, myVotes } = info.data;
    document.title = `${session.title} · Ralliyy`;

    if (join.status === 409) return setState({ view: 'full', session });
    if (join.status === 410) return setState({ view: 'ended', session });
    if (!join.ok) return setState({ view: 'error', session });

    setState({ view: 'joined', session, polls, myVotes });
    connectLive({
      code,
      onResync: () => resync().catch(() => {}),
      onStatus: (connection) => setState({ connection }),
      onEvent: (name, data) => {
        applyPollEvent(state.polls, name, data);
        render();
      },
    });
  } catch {
    setState({ view: 'error' });
  }
}

async function castVote(poll, option) {
  if (state.voting || state.myVotes[poll.id] === option.id) return;
  setState({ voting: true, voteError: null });
  try {
    const res = await api('PUT', `/api/polls/${poll.id}/vote`, { participantId, body: { optionId: option.id } });
    if (res.ok) {
      applyPollEvent(state.polls, 'poll:results', res.data);
      state.myVotes = { ...state.myVotes, [poll.id]: option.id };
    } else if (res.status === 409) {
      await resync(); // closed meanwhile: show the final results
    } else {
      state.voteError = 'Your vote was not counted. Please try again.';
    }
  } catch {
    state.voteError = "Couldn't send your vote. Check your connection and try again.";
  }
  setState({ voting: false });
}

// ---------- Rendering ----------

function header(session) {
  return el('div', { class: 'session-head' },
    el('h1', { class: 't-page-title' }, session.title),
    el('div', { class: 'session-head__code' },
      el('span', { class: 'session-head__code-label' }, 'Session code'),
      el('span', { class: 'code-chip' }, session.code)));
}

function footer() {
  return el('footer', { class: 'site-footer site-footer--ruled' }, icon('shield'), 'Anonymous. No account needed.');
}

function statusBanner(poll) {
  if (state.connection === 'reconnecting') {
    return banner('info', 'Reconnecting… We’re restoring your connection. Live updates will resume automatically.');
  }
  if (!poll) return banner('info', 'Connected · Your host will start a poll soon.');
  if (poll.status === 'closed') return banner('info', 'Poll closed · Final results. Voting is no longer available.');
  if (state.myVotes[poll.id]) return banner('info', 'Live · Your vote is counted. Results update live.');
  return banner('info', 'Poll open · Choose one option to cast your vote.');
}

function tabs() {
  const tab = (id, label) => el('button', {
    class: 'tab', type: 'button', role: 'tab', id: `tab-${id}`,
    'aria-selected': state.tab === id ? 'true' : 'false',
    'aria-controls': 'panel',
    onclick: () => setState({ tab: id }),
  }, label);
  return el('div', { class: 'tabs session-tabs', role: 'tablist' }, tab('poll', 'Poll'), tab('qa', 'Q&A'));
}

function pollPanel(poll) {
  if (!poll) {
    return el('div', { class: 'card' },
      emptyState('Waiting for the next poll', 'Your host will launch a poll soon. It will appear here automatically.'),
      el('div', { class: 'panel-footer' }, icon('refresh'), 'No refresh needed. Stay on this page.'));
  }

  const open = poll.status === 'open';
  const mine = state.myVotes[poll.id];
  const status = open
    ? el('span', { class: 'poll-meta__status poll-meta__status--open' }, 'Open')
    : el('span', { class: 'poll-meta__status' }, icon('lock'), 'Closed');

  let sub;
  let list;
  if (open && !mine) {
    // Results stay hidden until you vote, so the room's answers don't sway yours.
    sub = 'Choose one option. Results appear after you vote.';
    list = poll.options.map((option) => el('button', {
      class: 'option', type: 'button', disabled: state.voting,
      onclick: () => castVote(poll, option),
    }, el('span', { class: 'option__radio', 'aria-hidden': 'true' }), option.label));
  } else {
    sub = open
      ? 'Your vote is counted. Select another option to change it.'
      : mine ? 'Final results · Thank you for sharing your perspective.' : 'Final results.';
    list = poll.options.map((option) => resultCard(option, {
      total: poll.totalVotes,
      mine: option.id === mine,
      onclick: open ? () => castVote(poll, option) : undefined,
      disabled: state.voting,
    }));
  }

  return el('section', { 'aria-labelledby': 'poll-question' },
    el('div', { class: 'poll-meta' },
      el('span', { class: 'poll-meta__label' }, `Poll ${pollNumber(poll.number)} · Single choice`), status),
    el('h2', { class: 'poll-question', id: 'poll-question' }, poll.question),
    el('p', { class: 'poll-sub' }, sub),
    el('div', { class: 'poll-list', role: 'group', 'aria-label': 'Options' }, list),
    state.voteError && el('div', { class: 'session-banner' }, banner('error', state.voteError)),
    pollTotals(poll.totalVotes, open ? 'Updates live' : 'Final results'),
    open && el('p', { class: 'poll-hint t-meta' }, 'You can change your vote until the poll closes'));
}

function qaPanel() {
  return el('div', { class: 'card' },
    emptyState('No questions yet', 'Questions from the audience will appear here.'));
}

function render() {
  const { view, session } = state;

  if (view === 'connecting') {
    return app.replaceChildren(el('div', { class: 'state-centre' }, spinner(true), 'Connecting to your session…'));
  }

  if (view === 'notfound') {
    return app.replaceChildren(
      el('div', { class: 'session-head' }),
      el('section', { class: 'card' },
        emptyState('Session not found',
          'The code may be incorrect, the session may have been deleted, or the private host link may be broken. Check the link or code with your host.',
          { large: true })),
      el('a', { class: 'btn btn--primary btn--block state-actions', href: '/' }, 'Back home'),
      footer());
  }

  if (view === 'error') {
    return app.replaceChildren(
      el('div', { class: 'session-head' }),
      banner('error', "Couldn't reach Ralliyy. Check your connection and try again."),
      el('button', { class: 'btn btn--primary btn--block state-actions', type: 'button', onclick: load }, 'Try again'));
  }

  if (view === 'full') {
    return app.replaceChildren(
      header(session),
      el('section', { class: 'card session-banner' },
        el('div', { class: 'empty' },
          el('h2', { class: 'empty__title' }, 'Session full'),
          el('p', { class: 'empty__text' }, 'All 50 participant places are taken. You can’t join this session right now.'))),
      el('a', { class: 'btn btn--primary btn--block state-actions', href: '/' }, 'Back to home'));
  }

  if (view === 'ended') {
    return app.replaceChildren(
      header(session),
      el('div', { class: 'session-banner' }, banner('info', 'This session has ended. Voting and questions are now closed.')),
      el('a', { class: 'btn btn--primary btn--block state-actions', href: `/r/${session.code}` }, 'See results'));
  }

  // joined
  const poll = currentPoll(state.polls);
  app.replaceChildren(
    header(session),
    el('div', { class: 'session-banner' }, statusBanner(poll)),
    tabs(),
    el('div', { class: 'session-panel', id: 'panel', role: 'tabpanel', 'aria-labelledby': `tab-${state.tab}` },
      state.tab === 'poll' ? pollPanel(poll) : qaPanel()),
    footer());
}

load();
