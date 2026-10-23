import { api } from './api.js';
import { getParticipantId } from './participant.js';
import { banner, el, emptyState, icon, spinner } from './ui.js';

// Participant page: /s/CODE. One state object; render() redraws from it.
const app = document.getElementById('app');
const code = decodeURIComponent(window.location.pathname.split('/')[2] ?? '').toUpperCase();

const state = {
  view: 'connecting', // connecting | joined | full | ended | notfound | error
  session: null,
  tab: 'poll', // poll | qa
};

function setState(patch) {
  Object.assign(state, patch);
  render();
}

async function load() {
  setState({ view: 'connecting' });
  try {
    // Joining is safe to repeat, so this also covers reloads and QR scans.
    const join = await api('POST', `/api/sessions/${code}/join`, { participantId: getParticipantId() });
    if (join.status === 404) return setState({ view: 'notfound' });

    const info = await api('GET', `/api/sessions/${code}`);
    if (!info.ok) return setState({ view: 'notfound' });
    const session = info.data.session;
    document.title = `${session.title} · Ralliyy`;

    if (join.ok) return setState({ view: 'joined', session });
    if (join.status === 409) return setState({ view: 'full', session });
    if (join.status === 410) return setState({ view: 'ended', session });
    setState({ view: 'error', session });
  } catch {
    setState({ view: 'error' });
  }
}

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

function tabs() {
  const tab = (id, label) => el('button', {
    class: 'tab', type: 'button', role: 'tab', id: `tab-${id}`,
    'aria-selected': state.tab === id ? 'true' : 'false',
    'aria-controls': 'panel',
    onclick: () => setState({ tab: id }),
  }, label);
  return el('div', { class: 'tabs session-tabs', role: 'tablist' }, tab('poll', 'Poll'), tab('qa', 'Q&A'));
}

function pollPanel() {
  return el('div', { class: 'card' },
    emptyState('Waiting for the next poll', 'Your host will launch a poll soon. It will appear here automatically.'),
    el('div', { class: 'panel-footer' }, icon('refresh'), 'No refresh needed. Stay on this page.'));
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
  app.replaceChildren(
    header(session),
    el('div', { class: 'session-banner' }, banner('info', 'Connected · Your host will start a poll soon.')),
    tabs(),
    el('div', { class: 'session-panel', id: 'panel', role: 'tabpanel', 'aria-labelledby': `tab-${state.tab}` },
      state.tab === 'poll' ? pollPanel() : qaPanel()),
    footer());
}

load();
