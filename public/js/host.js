import { api } from './api.js';
import { applyPollEvent, applyQuestionEvent, connectLive, currentPoll, sortQuestions } from './live.js';
import {
  banner, bindCounter, confirmModal, copyText, el, emptyState, icon, pollTotals, resultCard, setBusy, showToast, spinner,
  timeAgo, upvotePill,
} from './ui.js';

// Host page: /host/CODE#token. The token sits after the # so browsers never
// send it to the server in the URL or in Referer headers; only our own API
// calls send it, in the Authorization header.
const app = document.getElementById('app');
const code = decodeURIComponent(window.location.pathname.split('/')[2] ?? '').toUpperCase();
const hostToken = window.location.hash.slice(1);
const DRAFT_KEY = `ralliyy.draft.${code}`;
const MAX_OPTIONS = 6;
const MIN_OPTIONS = 2;

const state = {
  view: 'loading', // loading | ready | notfound | deleted | error
  connection: 'live',
  session: null,
  polls: [],
  questions: [], // all questions, hidden ones included
  composerOpen: false,
  justClosed: false,
  presenting: false,
  draft: loadDraft(),
};

// ---------- Draft persistence ----------
// The composer's text is kept in sessionStorage so a reload, or launching
// being blocked by an open poll, never loses what the host typed.

function loadDraft() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(DRAFT_KEY));
    if (saved && typeof saved.question === 'string' && Array.isArray(saved.options)) return saved;
  } catch { /* storage blocked or bad JSON: start fresh */ }
  return { question: '', options: ['', ''] };
}

function saveDraft() {
  try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(state.draft)); } catch { /* ignore */ }
}

// ---------- Data ----------

async function fetchState() {
  const res = await api('GET', `/api/sessions/${code}`, { hostToken });
  // A wrong or missing token looks the same as a missing session, so a
  // broken link reveals nothing about whether the session exists.
  if (!res.ok || !res.data.isHost) return null;
  return res.data;
}

async function load() {
  state.view = 'loading';
  renderPage();
  try {
    const data = await fetchState();
    if (!data) {
      state.view = 'notfound';
      return renderPage();
    }
    Object.assign(state, { view: 'ready', session: data.session, polls: data.polls, questions: data.questions });
    document.title = `Host · ${data.session.title} · Ralliyy`;
    renderPage();
    connectLive({
      code,
      hostToken,
      onResync: async () => {
        const fresh = await fetchState().catch(() => null);
        if (fresh) {
          Object.assign(state, { session: fresh.session, polls: fresh.polls, questions: fresh.questions });
          renderLive();
          renderQa();
        }
      },
      onStatus: (connection) => { state.connection = connection; renderLive(); },
      onEvent: (name, data) => {
        if (name === 'session:deleted') return showDeleted();
        // Ended (by this tab, another tab or the 24-hour timer): reload
        // the state and redraw the page in its ended, read-only form.
        if (name === 'session:ended') return reloadEnded();
        if (name.startsWith('question:')) {
          applyQuestionEvent(state.questions, name, data);
          return renderQa();
        }
        if (name === 'session:participants') state.session.participantCount = data.count;
        else applyPollEvent(state.polls, name, data);
        renderLive();
        // A first poll launched from another tab: swap the "No polls yet"
        // placeholder for the composer. Never rebuilds a composer in use.
        if (name === 'poll:opened' && state.polls.length === 1 && !state.composerOpen) renderComposer();
      },
    });
  } catch {
    state.view = 'error';
    renderPage();
  }
}

// ---------- Actions ----------

async function launchPoll(button, feedback) {
  const question = state.draft.question.trim();
  const options = state.draft.options.map((o) => o.trim());
  const problems = [];
  if (!question) problems.push('Add a question.');
  if (options.some((o) => !o)) problems.push('Fill in every option or remove the empty ones.');
  if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) problems.push('Each option must be different.');
  if (problems.length) {
    feedback.replaceChildren(banner('error', problems.join(' ')));
    return;
  }

  setBusy(button, true, 'Launching…');
  try {
    const res = await api('POST', `/api/sessions/${code}/polls`, { hostToken, body: { question, options } });
    if (res.ok) {
      applyPollEvent(state.polls, 'poll:opened', res.data.poll);
      state.draft = { question: '', options: ['', ''] };
      saveDraft();
      state.justClosed = false;
      renderLive();
      renderComposer();
      return;
    }
    feedback.replaceChildren(banner(res.status === 409 ? 'info' : 'error',
      res.status === 409 ? 'Close the live poll before launching another. Your draft is saved.'
        : res.data?.error?.message ?? 'Could not launch the poll. Please try again.'));
  } catch {
    feedback.replaceChildren(banner('error', "Couldn't reach Ralliyy. Your draft is saved; try again."));
  }
  setBusy(button, false);
}

async function closePoll(poll, button) {
  setBusy(button, true, 'Closing…');
  try {
    const res = await api('POST', `/api/polls/${poll.id}/close`, { hostToken });
    if (res.ok || res.status === 409) {
      if (res.ok) applyPollEvent(state.polls, 'poll:closed', res.data);
      else poll.status = 'closed';
      state.justClosed = true;
      renderLive();
      renderComposer();
      return;
    }
  } catch { /* fall through */ }
  setBusy(button, false);
  showToast('Could not close the poll. Please try again.');
}

async function setHidden(question, button) {
  setBusy(button, true, question.hidden ? 'Unhiding…' : 'Hiding…');
  try {
    const res = await api('POST', `/api/questions/${question.id}/hide`, { hostToken, body: { hidden: !question.hidden } });
    if (res.ok) {
      question.hidden = res.data.hidden;
      return renderQa();
    }
  } catch { /* fall through */ }
  setBusy(button, false);
  showToast('Could not update the question. Please try again.');
}

// ---------- Ending and deleting ----------

async function reloadEnded() {
  const fresh = await fetchState().catch(() => null);
  if (!fresh) return;
  Object.assign(state, { session: fresh.session, polls: fresh.polls, questions: fresh.questions });
  exitPresent();
  renderPage();
}

function showDeleted() {
  exitPresent();
  document.querySelector('.modal-backdrop')?.remove();
  state.view = 'deleted';
  renderPage();
}

function askEnd() {
  confirmModal({
    title: 'End session?',
    body: `Voting will stop for ${state.session.title}. Final results will remain publicly accessible.`,
    confirmLabel: 'End session',
    danger: true,
    busyTitle: 'Ending session…',
    busyBody: 'Please wait while voting closes and final results are saved.',
    busyLabel: 'Ending session…',
    onConfirm: async () => {
      const res = await api('POST', `/api/sessions/${code}/end`, { hostToken });
      if (!res.ok && res.status !== 410) return res.data?.error?.message ?? 'Could not end the session. Please try again.';
      await reloadEnded();
      return null;
    },
  });
}

function askDelete() {
  confirmModal({
    title: 'Delete session?',
    body: `Permanently delete ${state.session.title} and all its polls, questions and results. This cannot be undone.`,
    confirmLabel: 'Delete',
    danger: true,
    busyTitle: 'Deleting session…',
    busyBody: 'Please wait while everything in this session is removed.',
    busyLabel: 'Deleting…',
    onConfirm: async () => {
      const res = await api('DELETE', `/api/sessions/${code}`, { hostToken });
      if (!res.ok && res.status !== 404) return res.data?.error?.message ?? 'Could not delete the session. Please try again.';
      showDeleted();
      return null;
    },
  });
}

// ---------- Present mode ----------
// A full-screen view for a projector: join details, the current poll and
// the top 3 questions. It reuses the page's live state, so it updates with
// the same events as the dashboard.

let presentRoot = null;

function enterPresent() {
  state.presenting = true;
  presentRoot = el('div', { class: 'present', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Present mode' });
  document.body.append(presentRoot);
  document.body.classList.add('is-presenting');
  // Full screen when the browser allows it; the view works without it too.
  document.documentElement.requestFullscreen?.().catch(() => {});
  renderPresent();
}

function exitPresent() {
  if (!state.presenting) return;
  state.presenting = false;
  presentRoot?.remove();
  presentRoot = null;
  document.body.classList.remove('is-presenting');
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  slots.presentButton?.focus();
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.presenting) exitPresent();
});
// In full screen the browser uses Esc itself to leave full screen, so the
// key never reaches the page; leaving full screen also leaves present mode.
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && state.presenting) exitPresent();
});

function renderPresent() {
  if (!state.presenting) return;
  const { session } = state;
  const poll = currentPoll(state.polls);
  const top = sortQuestions(state.questions.filter((q) => !q.hidden)).slice(0, 3);
  const votes = (n) => `${n} vote${n === 1 ? '' : 's'}`;

  const pollArea = poll
    ? el('section', { class: 'present__poll', 'aria-label': 'Current poll' },
      el('h2', { class: 'present__question' }, poll.question),
      el('div', { class: 'present__options' },
        poll.options.map((option) => resultCard(option, { total: poll.totalVotes, bar: false }))),
      el('div', { class: 'present__totals' },
        el('span', {}, `${poll.totalVotes} total vote${poll.totalVotes === 1 ? '' : 's'}`),
        el('span', { class: 'present__status' }, poll.status === 'open' ? 'Open · Live results' : 'Closed · Final results')))
    : el('section', { class: 'present__waiting' },
      el('h2', {}, 'Next poll coming up'),
      el('p', {}, 'Stay connected. Your host will launch the next poll soon.'));

  presentRoot.replaceChildren(
    el('header', { class: 'present__head' },
      el('div', {},
        el('div', { class: 'present__logo' }, document.querySelector('.logo svg').cloneNode(true), 'Ralliyy'),
        el('h1', { class: 'present__title' }, session.title)),
      el('div', { class: 'present__join' },
        el('div', {},
          el('p', { class: 'present__join-label' }, 'Join the conversation'),
          el('p', { class: 'present__code' }, session.code),
          el('p', { class: 'present__url' }, session.joinUrl.replace(/^https?:\/\//, ''))),
        el('img', { class: 'present__qr', src: `/api/sessions/${session.code}/qr.svg`, alt: `QR code linking to ${session.joinUrl}` }))),
    el('div', { class: 'present__body' },
      pollArea,
      el('section', { class: 'present__questions', 'aria-labelledby': 'present-q-title' },
        el('h2', { id: 'present-q-title' }, 'Top audience questions'),
        el('p', { class: 'present__meta' }, 'Most votes first'),
        top.length
          ? top.map((q) => el('article', { class: 'present__q' },
            el('p', { class: 'present__q-body' }, q.body),
            el('p', { class: 'present__q-votes' }, votes(q.upvotes))))
          : el('p', { class: 'present__meta' }, 'No questions yet. Scan the code to ask one.'))),
    el('footer', { class: 'present__foot' },
      el('button', { class: 'present__exit', type: 'button', onclick: exitPresent }, 'Esc to exit presentation')));
}

// ---------- Rendering ----------
// The page is built once. Live updates redraw only the parts that change
// (counts, poll cards), so the composer the host is typing in is never
// rebuilt underneath them.

const slots = {};

function pollCard(poll, kind) {
  const open = poll.status === 'open';
  const closeBtn = open && el('button', { class: 'btn btn--secondary btn--block', type: 'button' }, 'Close poll');
  if (closeBtn) closeBtn.addEventListener('click', () => closePoll(poll, closeBtn));
  return el('section', { class: 'card host-card' },
    el('div', { class: 'poll-meta' },
      el('span', { class: 'poll-meta__label' }, `${kind} poll · Single choice`),
      el('span', { class: open ? 'poll-meta__status poll-meta__status--open' : 'poll-meta__status' },
        open ? 'Open · Live results' : 'Closed · Final results')),
    el('h3', { class: 'poll-question' }, poll.question),
    el('div', { class: 'poll-list' },
      poll.options.map((option) => resultCard(option, { total: poll.totalVotes, bar: false }))),
    pollTotals(poll.totalVotes, open ? 'Updates live' : 'Voting has ended'),
    closeBtn);
}

function renderLive() {
  const { session, polls } = state;
  slots.count.textContent = `${session.participantCount} / ${session.participantLimit} participants`;
  slots.connection.replaceChildren(state.connection === 'reconnecting'
    ? banner('info', 'Reconnecting… Live updates will resume automatically.') : '');

  const current = currentPoll(polls);
  slots.current.hidden = !current;
  slots.current.replaceChildren(
    state.justClosed && current?.status === 'closed'
      ? banner('info', 'Poll closed. Final results are available to everyone in the session.') : '',
    current ? pollCard(current, 'Current') : '');

  const previous = polls.filter((p) => p !== current).reverse();
  slots.previous.replaceChildren(previous.length
    ? el('div', { class: 'previous-list' }, previous.map((p) => pollCard(p, 'Previous')))
    : el('section', { class: 'card' }, emptyState('No previous polls',
      polls.length ? 'Closed polls and their final results will stay here throughout the session.'
        : state.session.status === 'ended' ? 'No polls were run in this session.'
          : 'Your first poll is a draft. Launch it when you’re ready for participants to vote.')));

  // Launch is only possible while no poll is open.
  const blocked = polls.some((p) => p.status === 'open');
  if (slots.launch && !slots.launch.hasAttribute('aria-busy')) slots.launch.disabled = blocked;
  slots.blockedNote?.replaceChildren(blocked
    ? banner('info', 'Close the live poll before launching another. Your draft is saved.') : '');
  renderPresent();
}

function questionCard(question, now) {
  const button = el('button', { class: 'btn btn--secondary btn--small', type: 'button' }, question.hidden ? 'Unhide' : 'Hide');
  button.addEventListener('click', () => setHidden(question, button));
  return el('article', { class: question.hidden ? 'question question--hidden' : 'question' },
    el('div', { class: 'question__top' },
      el('span', { class: 't-meta' }, timeAgo(question.createdAt, now)),
      el('span', { class: 'question__tag' }, question.hidden ? 'Hidden from participants' : 'Visible to participants')),
    el('p', { class: 'question__body' }, question.body),
    el('div', { class: 'question__actions' }, upvotePill(question), button));
}

function renderQa() {
  const sorted = sortQuestions(state.questions);
  const hidden = sorted.filter((q) => q.hidden).length;
  slots.qaMeta.textContent = sorted.length
    ? `Sorted by most votes · ${sorted.length - hidden} visible · ${hidden} hidden`
    : 'Sorted by most votes · 0 questions';
  const now = Date.now();
  slots.qaList.replaceChildren(sorted.length
    ? el('div', { class: 'question-list' }, sorted.map((q) => questionCard(q, now)))
    : el('section', { class: 'card' },
      emptyState('No questions yet', 'Questions from participants will appear here. You can hide them from participants.')));
  renderPresent();
}

function renderComposer() {
  slots.launch = null;
  slots.blockedNote = null;
  if (state.session.status === 'ended') {
    slots.composer.replaceChildren();
    return renderLive();
  }
  if (!state.polls.length && !state.composerOpen) {
    slots.composer.replaceChildren(
      el('section', { class: 'card' },
        emptyState('No polls yet', 'Create your first poll to hear from the room. Results will appear here when voting starts.')),
      el('button', {
        class: 'btn btn--primary btn--block', type: 'button',
        onclick: () => { state.composerOpen = true; renderComposer(); slots.composer.querySelector('textarea, input')?.focus(); },
      }, 'Create poll'));
    return;
  }

  const { draft } = state;
  const question = el('input', { class: 'input', id: 'poll-question-input', maxlength: 200, placeholder: 'What would you like to ask?', autocomplete: 'off' });
  question.value = draft.question;
  question.addEventListener('input', () => { draft.question = question.value; saveDraft(); });
  const counter = el('span', { class: 'field__counter' });
  bindCounter(question, counter);

  const optionFields = draft.options.map((value, i) => {
    const input = el('input', { class: 'input', id: `poll-option-${i}`, maxlength: 80, placeholder: `Option ${i + 1}`, autocomplete: 'off' });
    input.value = value;
    input.addEventListener('input', () => { draft.options[i] = input.value; saveDraft(); });
    return el('div', { class: 'field' },
      el('label', { class: 'field__label', for: `poll-option-${i}` }, `Option ${i + 1}`),
      el('div', { class: 'composer__option' }, input,
        el('button', {
          class: 'link-btn', type: 'button', disabled: draft.options.length <= MIN_OPTIONS,
          'aria-label': `Remove option ${i + 1}`,
          onclick: () => { draft.options.splice(i, 1); saveDraft(); renderComposer(); },
        }, 'Remove')));
  });

  const feedback = el('div');
  const launch = el('button', { class: 'btn btn--primary', type: 'button' }, 'Launch poll');
  launch.addEventListener('click', () => launchPoll(launch, feedback));
  slots.launch = launch;
  slots.blockedNote = el('div');

  slots.composer.replaceChildren(el('section', { class: 'card composer', 'aria-labelledby': 'composer-title' },
    el('h3', { class: 'card__title', id: 'composer-title' }, state.polls.length ? 'Next poll' : 'Create a poll'),
    el('p', { class: 'card__subtitle' }, 'Single choice · Add 2–6 options.'),
    el('div', { class: 'field' },
      el('div', { class: 'field__top' },
        el('label', { class: 'field__label', for: 'poll-question-input' }, 'Question'), counter),
      question),
    optionFields,
    el('div', { class: 'composer__actions' },
      el('button', {
        class: 'btn btn--secondary', type: 'button', disabled: draft.options.length >= MAX_OPTIONS,
        onclick: () => { draft.options.push(''); saveDraft(); renderComposer(); slots.composer.querySelector(`#poll-option-${draft.options.length - 1}`)?.focus(); },
      }, 'Add option'),
      launch),
    el('p', { class: 'composer__foot t-meta' },
      `${draft.options.length} of ${MAX_OPTIONS} options · ${draft.options.length < MIN_OPTIONS ? 'At least two options are required.' : 'Participants can vote after you launch.'}`),
    slots.blockedNote,
    feedback));
  renderLive();
}

function shareCard(session) {
  return el('section', { class: 'card share', 'aria-label': 'Join this session' },
    el('h2', { class: 'share__heading' }, 'Join this session'),
    el('p', { class: 'share__code' }, session.code),
    el('div', { class: 'share__qr' },
      el('img', { src: `/api/sessions/${session.code}/qr.svg`, alt: `QR code linking to ${session.joinUrl}`, width: 160, height: 160 })),
    el('p', { class: 'share__url t-meta' }, session.joinUrl.replace(/^https?:\/\//, '')),
    el('button', {
      class: 'btn btn--secondary btn--block', type: 'button',
      onclick: async () => { if (await copyText(session.joinUrl)) showToast('Copied to clipboard'); },
    }, 'Copy link'));
}

function renderPage() {
  const { view, session } = state;

  if (view === 'loading') {
    return app.replaceChildren(el('div', { class: 'state-centre' }, spinner(true), 'Loading your session…'));
  }

  if (view === 'deleted') {
    document.getElementById('host-label').textContent = 'Host';
    return app.replaceChildren(el('div', { class: 'column notfound' },
      el('section', { class: 'card' }, emptyState('Session deleted',
        'This session and its results were permanently deleted.', { large: true })),
      el('a', { class: 'btn btn--primary btn--block state-actions', href: '/' }, 'Back home')));
  }

  if (view === 'notfound' || view === 'error') {
    return app.replaceChildren(el('div', { class: 'column notfound' },
      view === 'error'
        ? banner('error', "Couldn't reach Ralliyy. Check your connection and try again.")
        : el('section', { class: 'card' }, emptyState('Session not found',
          'The code may be incorrect, the session may have been deleted, or the private host link may be broken. Check the link or code with your host.',
          { large: true })),
      view === 'error'
        ? el('button', { class: 'btn btn--primary btn--block state-actions', type: 'button', onclick: load }, 'Try again')
        : el('a', { class: 'btn btn--primary btn--block state-actions', href: '/' }, 'Back home')));
  }

  document.getElementById('host-label').textContent = session.hostName ? `Host · ${session.hostName}` : 'Host';
  slots.count = el('span', {});
  slots.connection = el('div');
  slots.current = el('div', { class: 'stack' });
  slots.composer = el('div', { class: 'stack' });
  slots.previous = el('div');
  slots.qaMeta = el('p', { class: 't-meta' });
  slots.qaList = el('div');

  const live = session.status === 'live';
  slots.presentButton = live ? el('button', { class: 'btn btn--secondary', type: 'button', onclick: enterPresent }, 'Present') : null;

  app.replaceChildren(
    el('div', { class: 'host-top' },
      el('div', {},
        el('h1', { class: 't-page-title' }, session.title),
        el('div', { class: 'host-top__meta' },
          el('span', { class: live ? 'badge' : 'badge badge--ended' }, live ? 'LIVE' : 'ENDED'),
          slots.count)),
      live && el('div', { class: 'host-top__actions' },
        slots.presentButton,
        el('button', { class: 'btn btn--secondary', type: 'button', onclick: askEnd }, 'End session'))),
    // A wrapper, because replaceChildren() would print a bare false or null.
    el('div', {}, live ? null : el('div', { class: 'host-ended' },
      banner('info', 'This session has ended. Voting and questions are closed, and the results are public.',
        el('a', { class: 'banner__link', href: `/r/${session.code}` }, 'See results →')))),
    slots.connection,
    el('div', { class: 'host-grid' },
      el('div', { class: 'host-grid__polls' },
        el('h2', { class: 'host-section-title' }, 'Polls'),
        slots.current,
        slots.composer,
        el('h2', { class: 'host-section-title' }, 'Previous polls'),
        slots.previous),
      el('div', { class: 'host-grid__share' }, shareCard(session)),
      el('div', { class: 'host-grid__qa' },
        el('h2', { class: 'host-section-title' }, 'Q&A'),
        slots.qaMeta,
        slots.qaList)),
    el('footer', { class: 'host-bottom t-meta' },
      el('span', {}, icon('shield'), ' Keep your private host link safe.'),
      el('button', { class: 'link-btn link-btn--danger', type: 'button', onclick: askDelete }, 'Delete session')));

  renderComposer();
  renderQa();
}

// Keep "5 min ago" labels current.
setInterval(() => { if (state.view === 'ready') renderQa(); }, 30000);

load();
