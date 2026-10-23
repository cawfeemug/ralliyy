import { api } from './api.js';
import { applyPollEvent, applyQuestionEvent, connectLive, currentPoll, sortQuestions } from './live.js';
import { getParticipantId } from './participant.js';
import {
  banner, dismissibleBanner, el, emptyState, icon, pollNumber, pollTotals, resultCard, spinner, timeAgo, upvotePill,
} from './ui.js';

// Participant page: /s/CODE. One state object; render() redraws from it.
const app = document.getElementById('app');
const code = decodeURIComponent(window.location.pathname.split('/')[2] ?? '').toUpperCase();
const participantId = getParticipantId();

const state = {
  view: 'connecting', // connecting | joined | full | ended | deleted | notfound | error
  connection: 'live', // live | reconnecting
  session: null,
  polls: [],
  myVotes: {}, // pollId -> optionId
  voting: false,
  voteError: null,
  tab: 'poll', // poll | qa
  questions: [], // includes questions hidden while this page was open (hidden: true)
  asking: false,
  askFeedback: null, // { kind, text } shown under the Ask button
  upvoting: new Set(), // question IDs with a request in flight
  hiddenNotice: false, // one of my questions was hidden by the host
};

const QUESTION_MAX = 280;

function setState(patch) {
  Object.assign(state, patch);
  render();
}

// Replace local state with the server's. Used on load and after reconnects.
async function resync() {
  const res = await api('GET', `/api/sessions/${code}`, { participantId });
  if (!res.ok) return setState({ view: 'notfound' });
  const { session, polls, myVotes, questions } = res.data;
  // Ended while we were offline: the missed session:ended event's effect.
  const view = session.status === 'ended' ? 'ended' : state.view;
  setState({ view, session, polls, myVotes, questions });
}

async function load() {
  setState({ view: 'connecting' });
  try {
    // Joining is safe to repeat, so this also covers reloads and QR scans.
    const join = await api('POST', `/api/sessions/${code}/join`, { participantId });
    if (join.status === 404) return setState({ view: 'notfound' });

    const info = await api('GET', `/api/sessions/${code}`, { participantId });
    if (!info.ok) return setState({ view: 'notfound' });
    const { session, polls, myVotes, questions } = info.data;
    document.title = `${session.title} · Ralliyy`;

    if (join.status === 409) return setState({ view: 'full', session });
    if (join.status === 410) return setState({ view: 'ended', session });
    if (!join.ok) return setState({ view: 'error', session });

    setState({ view: 'joined', session, polls, myVotes, questions });
    connectLive({
      code,
      onResync: () => resync().catch(() => {}),
      onStatus: (connection) => setState({ connection }),
      onEvent: (name, data) => {
        if (name === 'session:ended') return setState({ view: 'ended', session: { ...state.session, status: 'ended' } });
        if (name === 'session:deleted') return setState({ view: 'deleted' });
        if (name.startsWith('question:')) onQuestionEvent(name, data);
        else applyPollEvent(state.polls, name, data);
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

function onQuestionEvent(name, data) {
  const question = applyQuestionEvent(state.questions, name, data);
  // Unhidden, but this page never had it (it was hidden before we loaded):
  // fetch the full state to get it.
  if (!question && name === 'question:hidden' && !data.hidden) {
    resync().catch(() => {});
    return;
  }
  if (question?.mine && name === 'question:hidden') state.hiddenNotice = data.hidden;
}

// ---------- Q&A actions ----------

async function askQuestion() {
  const body = qa.input.value.trim();
  if (!body || [...body].length > QUESTION_MAX || state.asking) return;
  setState({ asking: true, askFeedback: null });
  try {
    const res = await api('POST', `/api/sessions/${code}/questions`, { participantId, body: { body } });
    if (res.ok) {
      // The question:new broadcast may have arrived first; either way the
      // question ends up in the list once, marked as mine.
      const question = applyQuestionEvent(state.questions, 'question:new', res.data.question);
      question.mine = true;
      qa.input.value = '';
      qa.resize();
      state.askFeedback = { kind: 'success', text: 'Question posted' };
      clearTimeout(askFeedbackTimer);
      askFeedbackTimer = setTimeout(() => setState({ askFeedback: null }), 4000);
    } else if (res.status === 410) {
      state.view = 'ended';
    } else if (res.status === 429) {
      state.askFeedback = { kind: 'error', text: 'Slow down. You’re asking questions too quickly. Asking is temporarily unavailable; your draft is kept.' };
    } else {
      state.askFeedback = { kind: 'error', text: res.data?.error?.message ?? 'Your question was not posted. Please try again.' };
    }
  } catch {
    state.askFeedback = { kind: 'error', text: "Couldn't send your question. Check your connection; your draft is kept." };
  }
  setState({ asking: false });
}
let askFeedbackTimer;

async function toggleUpvote(question) {
  if (state.upvoting.has(question.id)) return;
  state.upvoting.add(question.id);
  render();
  try {
    const res = await api(question.upvoted ? 'DELETE' : 'PUT', `/api/questions/${question.id}/upvote`, { participantId });
    if (res.ok) {
      question.upvoted = res.data.upvoted;
      question.upvotes = res.data.upvotes;
    } else if (res.status === 404) {
      question.hidden = true; // hidden by the host meanwhile
    } else if (res.status === 410) {
      state.view = 'ended';
    }
  } catch { /* the button simply stays as it was */ }
  state.upvoting.delete(question.id);
  render();
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

// The Q&A tab is built once and kept, so the question being typed (and the
// keyboard on a phone) survives live updates; only its parts are refreshed.
let qa = null;

function buildQa() {
  const input = el('textarea', {
    class: 'input question-input', id: 'question-input', rows: 1,
    placeholder: 'What would you like to ask?', 'aria-describedby': 'question-hint',
  });
  const counter = el('span', { class: 'field__counter' });
  const hint = el('p', { class: 'field__hint', id: 'question-hint' });
  const field = el('div', { class: 'field' },
    el('div', { class: 'field__top' }, el('label', { class: 'field__label', for: 'question-input' }, 'Your question'), counter),
    input, hint);
  const ask = el('button', { class: 'btn btn--primary btn--block qa-ask', type: 'button', onclick: askQuestion }, 'Ask');
  const view = {
    input,
    notice: el('div'),
    feedback: el('div'),
    meta: el('p', { class: 't-meta' }, 'Most upvoted first'),
    list: el('div', { class: 'question-list' }),
    // Grows the box with its text; set through the style object so a
    // strict Content Security Policy still allows it.
    resize() {
      input.style.height = 'auto';
      input.style.height = `${input.scrollHeight + 2}px`;
    },
    // No maxlength on the box: a pasted long question stays visible so the
    // participant can shorten it, and Ask is disabled until it fits.
    refreshField() {
      const length = [...input.value.trim()].length;
      const over = length - QUESTION_MAX;
      counter.textContent = `${[...input.value].length} / ${QUESTION_MAX}`;
      field.classList.toggle('field--error', over > 0);
      hint.textContent = over > 0 ? `Your question is too long. Remove ${over} character${over === 1 ? '' : 's'} to ask.` : '';
      hint.hidden = over <= 0;
      if (state.asking) return;
      ask.disabled = length === 0 || over > 0;
      ask.replaceChildren('Ask');
    },
    ask,
  };
  input.addEventListener('input', () => { view.resize(); view.refreshField(); });
  input.addEventListener('keydown', (e) => {
    // Enter asks; Shift+Enter adds a new line.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      askQuestion();
    }
  });
  view.root = el('div', { class: 'qa' },
    view.notice,
    el('section', { 'aria-labelledby': 'ask-title' },
      el('h2', { class: 't-section', id: 'ask-title' }, 'Ask a question'),
      el('p', { class: 'qa__sub' }, 'Ask anonymously. Upvote questions you’d like the host to answer.'),
      el('div', { class: 'qa__field' }, field),
      ask,
      view.feedback),
    el('section', { class: 'qa__top', 'aria-labelledby': 'top-title' },
      el('h2', { class: 't-section', id: 'top-title' }, 'Top questions'),
      view.meta,
      view.list));
  return view;
}

function questionCard(question, now) {
  const busy = state.upvoting.has(question.id);
  const toggle = () => toggleUpvote(question);
  return el('article', { class: 'question' },
    el('div', { class: 'question__top' },
      el('span', { class: 't-meta' }, timeAgo(question.createdAt, now)),
      question.mine && el('span', { class: 'question__tag' }, 'Yours')),
    el('p', { class: 'question__body' }, question.body),
    el('div', { class: 'question__actions' },
      upvotePill(question, { onclick: toggle, disabled: busy }),
      // The pill is the accessible control; this label is a larger tap target.
      el('button', { class: 'link-btn', type: 'button', tabindex: '-1', 'aria-hidden': 'true', onclick: toggle, disabled: busy },
        question.upvoted ? 'Upvoted' : 'Upvote')));
}

function updateQa() {
  qa.notice.replaceChildren(state.hiddenNotice
    ? el('div', { class: 'qa__notice' }, banner('info', 'Your question was hidden by the host. It is no longer visible to other participants.'))
    : '');

  qa.refreshField();
  if (state.asking) {
    qa.ask.disabled = true;
    qa.ask.replaceChildren(spinner(), 'Asking…');
  }
  const fb = state.askFeedback;
  qa.feedback.replaceChildren(fb
    ? el('div', { class: 'qa__feedback' }, fb.kind === 'success'
      ? dismissibleBanner('success', fb.text, () => setState({ askFeedback: null }))
      : banner(fb.kind, fb.text))
    : '');

  const visible = sortQuestions(state.questions.filter((q) => !q.hidden));
  const now = Date.now();
  qa.meta.hidden = visible.length === 0;
  qa.list.replaceChildren(...(visible.length
    ? visible.map((q) => questionCard(q, now))
    : [el('div', { class: 'card' },
      emptyState('No questions yet', 'Be the first to ask. Your question will appear here for others to upvote.'))]));
}

// Persistent parts of the joined view, so re-rendering doesn't rebuild the
// Q&A box someone is typing in.
let joined = null;

function render() {
  const { view, session } = state;
  if (view !== 'joined') joined = null;

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

  if (view === 'deleted') {
    return app.replaceChildren(
      el('div', { class: 'session-head' }),
      el('section', { class: 'card' },
        emptyState('Session deleted', 'This session and its results were permanently deleted by the host.', { large: true })),
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
  if (!joined) {
    joined = {
      banner: el('div', { class: 'session-banner' }),
      tabs: el('div'),
      panel: el('div', { class: 'session-panel', id: 'panel', role: 'tabpanel' }),
    };
    app.replaceChildren(header(session), joined.banner, joined.tabs, joined.panel, footer());
  }
  const poll = currentPoll(state.polls);
  // The poll status banner belongs to the Poll tab; the Q&A tab only shows
  // the reconnecting banner.
  const top = state.tab === 'poll' || state.connection === 'reconnecting' ? statusBanner(poll) : null;
  joined.banner.hidden = !top;
  joined.banner.replaceChildren(top ?? '');
  joined.tabs.replaceChildren(tabs());
  joined.panel.setAttribute('aria-labelledby', `tab-${state.tab}`);
  if (state.tab === 'poll') {
    joined.panel.replaceChildren(pollPanel(poll));
  } else {
    qa ??= buildQa();
    if (joined.panel.firstChild !== qa.root) {
      joined.panel.replaceChildren(qa.root);
      qa.resize();
    }
    updateQa();
  }
}

// Keep "5 min ago" labels current.
setInterval(() => { if (state.view === 'joined' && state.tab === 'qa') render(); }, 30000);

load();
